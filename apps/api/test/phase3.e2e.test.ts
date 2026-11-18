/**
 * [QA Engineer] Phase 3 "Growth" end to end through the HTTP API, written from docs/phase-3/stories.md
 * BEFORE the code (TC-P3-*). Runs on the MockLedger by default and on a real Apache Fineract with
 * E2E_LEDGER=fineract. ERP: a local FakeOdoo JSON-RPC server and a CSV drop folder (sandbox mode, no
 * remote hosts). M-Pesa: MockMpesa (Daraja shape callbacks). No live provider calls.
 *
 * Done-when: the first buyer submits invoices automatically from its ERP (ERP-01) and advances are
 * tagged to a funding source (FUND-02..05).
 *
 * Amounts (Q = quote date; all tagging happens on Q):
 *   ODOO-1 KES 500,000 due Q+30 -> advance 400,000 -> FAC-A, later re-tagged to EQUITY
 *   F90    KES 500,000 due Q+90 -> advance 400,000 -> EQUITY (tenor > 60)
 *   F1     KES 1,000,000 due Q+45 -> 800,000 -> FAC-A (40% of the 2m facility)
 *   F2     KES 750,000 due Q+45 -> 600,000 -> EQUITY (FAC-A buyer concentration would be 70% > 60%)
 *   M-Pesa: KES 150,000 invoices -> 120,000 advances (cap KES 180,000 after MP-02); 250,000 -> 200,000 by bank
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, kes } from '@mapema/pricing';
import { FakeOdoo, MockMpesa } from '@mapema/adapters';
import { Harness, startHarness } from './harness';
import { AT, buildWorld, eligibleInvoice, LEDGER_ENV, REAL_LEDGER, seedFunding, World, WORKED } from './world';

let h: Harness; let w: World; let odoo: FakeOdoo; let odooUrl: string;
const Q = WORKED.quoteDate;
const DROP = mkdtempSync(join(tmpdir(), 'mapema-drop-'));
const ids: Record<string, string> = {};
const mp = () => (h.adapters as any).mpesa as MockMpesa;
const adv = async (id: string) => (await h.admin.query(`SELECT a.*, fs.code AS funding_code FROM mapema.advance a LEFT JOIN mapema.funding_source fs ON fs.id = a.funding_source_id WHERE a.id = $1`, [id])).rows[0];
const payoutOf = async (advanceId: string) => (await h.admin.query(`SELECT * FROM mapema.payout WHERE advance_id = $1 AND type = 'advance' ORDER BY created_at DESC LIMIT 1`, [advanceId])).rows[0];
const odooBill = (id: number, o: Record<string, unknown> = {}) => ({
  id, name: `BILL/${id}`, ref: `ODOO-${id}`, move_type: 'in_invoice', state: 'posted', partner_id: [42, 'Jua Kali Packaging Ltd'], amount_total: 500000.0, currency_id: [1, 'KES'],
  invoice_date: addDays(Q, -2), invoice_date_due: addDays(Q, 30), x_etims_cu_invoice_no: `KRACUODOO${id}`, write_date: `${addDays(Q, -1)} 08:00:0${id}`, ...o,
});
/** quote + accept (+ optional credit approval with a named funding source) */
async function request(invoiceId: string) {
  const q = await w.supplier.post(`/invoices/${invoiceId}/quote`);
  const acc = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': `acc-${invoiceId}` });
  return acc.advances[0].advanceId as string;
}
const approve = (advanceId: string, extra: Record<string, unknown> = {}, status?: number) => w.credit.post(`/advances/${advanceId}/decision`, { decision: 'approve', reason: 'All checks green', ...extra }, status);
const release = (advanceId: string, status?: number) => w.ops.post(`/advances/${advanceId}/release`, undefined, status, { 'Idempotency-Key': `rel-${advanceId}-${Date.now()}` });
async function fundNew(number: string, amountCents: bigint, due: string, extra: Record<string, unknown> = {}) {
  const inv = await eligibleInvoice(h, w, { number, amountCents, dueDate: due });
  const a = await request(inv);
  await approve(a, extra);
  const r = await release(a);
  return { invoiceId: inv, advanceId: a, release: r };
}
const mpesaPost = (kind: 'result' | 'timeout', body: unknown, token = 'test-mpesa-callback-token-1234') => h.http.post(`/v1/webhooks/mpesa/b2c/${kind}/${token}`).send(body as object);

beforeAll(async () => {
  odoo = new FakeOdoo({ db: 'acme', login: 'api@acme.test', apiKey: 'k-acme-odoo' });
  odoo.addPartner(42, 'Jua Kali Packaging Ltd', 'P051111111B');
  odoo.addPartner(43, 'Unknown Traders Ltd', 'P059999999Z');
  odooUrl = await odoo.listen();
  h = await startHarness({ ...LEDGER_ENV, ADAPTER_MODE_ERP: 'sandbox', ERP_DROP_ROOT: DROP, ERP_SECRET_ACME_ODOO: 'k-acme-odoo',
    MPESA_CALLBACK_TOKEN: 'test-mpesa-callback-token-1234', MPESA_RESULT_TIMEOUT_MINUTES: '30' });
  w = await buildWorld(h, { floatCents: 10_000_000_000n, supplierLimitCents: 1_000_000_000n, tag: 'p3' });
  await seedFunding(h, w, 1_000_000_000n, 'EQ-P3-0001');
  const p = await w.ops.post('/reconciliation/baseline', { note: 'Phase 3 opening balances (shared test tenant)' });
  await w.approve(p.id, w.ops2);
});
afterAll(async () => { await h?.close(); await odoo?.close(); });

describe(`Phase 3 [ledger=${REAL_LEDGER ? 'real Fineract' : 'mock'}]`, () => {
  // ------------------------------------------------------------------ ERP
  it('TC-P3-ERP-05 a connection needs an approved field mapping: ops creates, a second ops user approves; buyers cannot approve', async () => {
    const c = await w.ops.post('/erp/connections', { buyerId: w.buyerId, kind: 'odoo', name: 'Acme Odoo 17', config: { baseUrl: odooUrl, database: 'acme', username: 'api@acme.test' }, secretEnv: 'ERP_SECRET_ACME_ODOO' });
    expect(c.status).toBe('pending_mapping');
    expect(c.mapping).toMatchObject({ version: 1, status: 'pending' });
    ids.odoo = c.id;
    await w.ops.post(`/erp/connections/${c.id}/run`, {}, 409); // not active yet
    await w.buyerAdmin.post(`/approvals/${c.mapping.approvalId}/approve`, { reason: 'x' }, 403);
    await w.ops.post(`/approvals/${c.mapping.approvalId}/approve`, { reason: 'x' }, 403); // four eyes
    await w.approve(c.mapping.approvalId, w.ops2);
    const got = await w.buyerAdmin.get(`/erp/connections/${c.id}`);
    expect(got.status).toBe('active');
    expect(got.mapping).toMatchObject({ version: 1, status: 'active' });
    expect(JSON.stringify(got)).not.toContain('k-acme-odoo'); // the secret never leaves the env
    // secrets can only come from ERP_SECRET_* variables, never e.g. DATABASE_URL
    await w.ops.post('/erp/connections', { buyerId: w.buyerId, kind: 'odoo', name: 'x', config: { baseUrl: odooUrl, database: 'acme', username: 'u' }, secretEnv: 'DATABASE_URL' }, 400);
  });

  it('TC-P3-ERP-01 approved Odoo vendor bills become invoices through the same checks; the buyer confirms; the advance is funded (done-when part 1)', async () => {
    h.clock.set(AT(Q));
    await eligibleInvoice(h, w, { number: 'ODOO-5', amountCents: kes(300_000), dueDate: addDays(Q, 30) }); // uploaded by hand earlier
    odoo.addMove(odooBill(1));
    odoo.addMove(odooBill(2, { partner_id: [43, 'Unknown Traders Ltd'] }));
    odoo.addMove(odooBill(3, { currency_id: [2, 'USD'] }));
    odoo.addMove(odooBill(4, { state: 'draft' }));
    odoo.addMove(odooBill(5, { amount_total: 300000.0 }));
    const r = await w.buyerAdmin.post(`/erp/connections/${ids.odoo}/run`);
    expect(r).toMatchObject({ status: 'completed', fetched: 4, created: 1, errors: 3, duplicates: 0 });
    const byId = Object.fromEntries(r.items.map((i: any) => [i.externalId, i]));
    expect(byId['2'].errorCode).toBe('SUPPLIER_NOT_LINKED');
    expect(byId['3'].errorCode).toBe('CURRENCY_NOT_KES');
    expect(byId['5'].errorCode).toBe('DUPLICATE_INVOICE');
    expect(byId['4']).toBeUndefined(); // drafts are never fetched
    const inv = (await h.admin.query(`SELECT * FROM mapema.invoice WHERE id = $1`, [byId['1'].invoiceId])).rows[0];
    expect(inv).toMatchObject({ invoice_number: 'ODOO-1', source: 'erp', status: 'awaiting_confirmation', etims_status: 'valid', amount_cents: String(kes(500_000)) });
    // the buyer's human checker confirms (four eyes against the integration user) and signs the ILU
    await w.buyerChecker.post(`/invoices/${inv.id}/decision`, { decision: 'approve' });
    const conf = await w.buyerChecker.post('/confirmations', { invoiceIds: [inv.id] });
    await h.http.post(`/v1/dev/esign/${conf.envelopeId}/complete`).expect(201);
    ids.odooInvoice = inv.id;
    const audit = (await h.admin.query(`SELECT count(*)::int AS n FROM mapema.audit_event WHERE action = 'erp.import_run' AND entity_id = $1`, [ids.odoo])).rows[0].n;
    expect(audit).toBe(1);
  });

  it('TC-P3-ERP-03 idempotent: a re-run creates nothing; a fixed record is retried; an edit after import is flagged, never applied', async () => {
    const again = await w.ops.post(`/erp/connections/${ids.odoo}/run`);
    expect(again).toMatchObject({ fetched: 0, created: 0 });
    odoo.updateMove(2, { partner_id: [42, 'Jua Kali Packaging Ltd'], ref: 'ODOO-2', write_date: `${Q} 09:00:00` }); // AP fixed the supplier
    odoo.updateMove(1, { amount_total: 450000.0, write_date: `${Q} 09:00:01` }); // edited after we imported it
    const r = await w.ops.post(`/erp/connections/${ids.odoo}/run`);
    expect(r).toMatchObject({ fetched: 2, created: 1, changed: 1 });
    const changed = r.items.find((i: any) => i.externalId === '1');
    expect(changed).toMatchObject({ status: 'changed_after_import', invoiceId: ids.odooInvoice });
    expect((await h.admin.query(`SELECT amount_cents FROM mapema.invoice WHERE id = $1`, [ids.odooInvoice])).rows[0].amount_cents).toBe(String(kes(500_000)));
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM mapema.erp_import_item WHERE connection_id = $1 AND external_id = '1'`, [ids.odoo])).rows[0].n).toBe(1);
    const items = await w.ops.get(`/erp/connections/${ids.odoo}/items?status=changed_after_import`);
    expect(items.map((i: any) => i.external_id)).toEqual(['1']);
  });

  it('TC-P3-ERP-04 error mapping: Odoo down keeps the cursor; three auth failures pause the connection until ops resumes it', async () => {
    const before = (await h.admin.query(`SELECT cursor FROM mapema.erp_connection WHERE id = $1`, [ids.odoo])).rows[0].cursor;
    odoo.failNext = 'unavailable';
    const down = await w.ops.post(`/erp/connections/${ids.odoo}/run`);
    expect(down).toMatchObject({ status: 'failed', errorCode: 'ERP_UNAVAILABLE' });
    expect((await h.admin.query(`SELECT cursor FROM mapema.erp_connection WHERE id = $1`, [ids.odoo])).rows[0].cursor).toBe(before);
    for (let i = 0; i < 3; i++) { odoo.failNext = 'auth'; expect((await w.ops.post(`/erp/connections/${ids.odoo}/run`)).errorCode).toBe('ERP_AUTH_FAILED'); }
    expect((await w.ops.get(`/erp/connections/${ids.odoo}`)).status).toBe('paused');
    await w.ops.post(`/erp/connections/${ids.odoo}/run`, {}, 409);
    await w.buyerAdmin.post(`/erp/connections/${ids.odoo}/resume`, {}, 403);
    await w.ops.post(`/erp/connections/${ids.odoo}/resume`, { reason: 'Acme rotated the API key' });
    expect((await w.ops.post(`/erp/connections/${ids.odoo}/run`)).status).toBe('completed');
  });

  it('TC-P3-ERP-05b a mapping change is maker-checker and versioned; imports record the version used', async () => {
    const m = await w.ops.get(`/erp/connections/${ids.odoo}`);
    const next = { ...m.mapping.definition, fields: { ...m.mapping.definition.fields, poReference: { path: 'invoice_origin', transform: ['trim'] } } };
    const p = await w.buyerAdmin.post(`/erp/connections/${ids.odoo}/mapping`, { mapping: next, reason: 'Map PO numbers' });
    expect(p.status).toBe('pending');
    await w.buyerAdmin.post(`/erp/connections/${ids.odoo}/mapping`, { mapping: { fields: { invoiceNumber: { path: 'ref', transform: ['shout'] } } }, reason: 'bad' }, 400);
    await w.approve(p.id, w.ops); // proposer was the buyer admin; any ops user may check
    const after = await w.ops.get(`/erp/connections/${ids.odoo}`);
    expect(after.mapping).toMatchObject({ version: 2, status: 'active' });
    odoo.addMove(odooBill(6, { invoice_origin: 'PO-77', ref: 'ODOO-6', write_date: `${Q} 10:00:00` }));
    const r = await w.ops.post(`/erp/connections/${ids.odoo}/run`);
    expect(r.created).toBe(1);
    const row = (await h.admin.query(`SELECT i.po_reference, e.mapping_version FROM mapema.erp_import_item e JOIN mapema.invoice i ON i.id = e.invoice_id WHERE e.connection_id = $1 AND e.external_id = '6'`, [ids.odoo])).rows[0];
    expect(row).toEqual({ po_reference: 'PO-77', mapping_version: 2 });
  });

  it('TC-P3-ERP-02 CSV drop: valid rows become invoices, bad rows are itemised, the file is archived and an identical re-drop is refused', async () => {
    const c = await w.ops.post('/erp/connections', { buyerId: w.buyerId, kind: 'csv_sftp', name: 'Acme SFTP drop', config: {} });
    await w.approve(c.mapping.approvalId, w.ops2);
    ids.csv = c.id;
    const dir = join(DROP, c.id, 'incoming');
    mkdirSync(dir, { recursive: true });
    const body = ['external_id,supplier_kra_pin,invoice_number,amount_kes,currency,issue_date,due_date,etims_cu_invoice_no,status',
      `C-1,P051111111B,INV-P3-CSV-1,"200,000.00",KES,${addDays(Q, -2)},${addDays(Q, 40)},KRACUCSV1,approved`,
      `C-2,P051111111B,INV-P3-CSV-2,100000,KES,${addDays(Q, -2)},${addDays(Q, 200)},KRACUCSV2,approved`,
      `C-3,P051111111B,INV-P3-CSV-3,100000,KES,${addDays(Q, -2)},${addDays(Q, 40)},,pending`].join('\n');
    writeFileSync(join(dir, 'acme.csv'), body);
    const r = await w.ops.post(`/erp/connections/${c.id}/run`);
    expect(r).toMatchObject({ status: 'completed', fetched: 3, created: 1, errors: 1, skipped: 1 });
    expect(r.items.find((i: any) => i.externalId === 'C-2').errorCode).toBe('TENOR_OUT_OF_RANGE');
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(join(DROP, c.id, 'processed'))).toHaveLength(1);
    writeFileSync(join(dir, 'acme-again.csv'), body);
    const r2 = await w.ops.post(`/erp/connections/${c.id}/run`);
    expect(r2).toMatchObject({ created: 0, files: [{ name: 'acme-again.csv', status: 'duplicate_file' }] });
    const inv = (await h.admin.query(`SELECT amount_cents, source FROM mapema.invoice WHERE invoice_number = 'INV-P3-CSV-1'`)).rows[0];
    expect(inv).toEqual({ amount_cents: String(kes(200_000)), source: 'erp' });
  });

  it('TC-P3-ERP-06 buyers see only their own connections; suppliers see none', async () => {
    expect((await w.buyerAdmin.get('/erp/connections')).map((c: any) => c.id).sort()).toEqual([ids.odoo, ids.csv].sort());
    await w.supplier.get('/erp/connections', 403);
  });

  // ------------------------------------------------------------------ funding sources
  it('TC-P3-FUND-01 funding sources are maker-checker (admin proposes, CEO approves) and appear in Fineract as funds', async () => {
    const eq = await w.admin.post('/funding-sources', { code: 'EQUITY', name: 'Founder equity', type: 'equity', limitCents: null, priority: 100, eligibility: {}, covenants: {}, reason: 'Default source' });
    const fa = await w.admin.post('/funding-sources', { code: 'FAC-A', name: 'Debt facility A', type: 'debt_facility', limitCents: String(kes(2_000_000)), priority: 10,
      eligibility: { sectorCodes: ['FMCG'], maxTenorDays: 60, maxAdvanceCents: String(kes(1_000_000)), requireEtimsValid: true },
      covenants: { maxBuyerConcentrationBps: 6000, maxNplRatioBps: 500 }, reason: 'Facility A signed (term sheet v3)' });
    await w.admin.post(`/approvals/${fa.id}/approve`, { reason: 'x' }, 403);
    await w.approve(fa.id, w.credit).catch(() => undefined); // wrong role is refused
    expect((await h.admin.query(`SELECT status FROM mapema.approval_request WHERE id = $1`, [fa.id])).rows[0].status).toBe('pending');
    await w.approve(eq.id); await w.approve(fa.id);
    await w.admin.post('/funding-sources', { code: 'bad code', name: 'x', type: 'debt_facility', limitCents: null, priority: 1, eligibility: {}, covenants: {}, reason: 'x' }, 400);
    const list = await w.credit.get('/funding-sources');
    expect(list.map((s: any) => [s.code, s.active, s.utilisation.outstandingCents])).toEqual([['FAC-A', true, '0'], ['EQUITY', true, '0']]);
    expect(list[0].fineractFundId).toBeTruthy();
  });

  it('TC-P3-FUND-02 tagging: auto-pick at release by priority and eligibility; a named ineligible source is refused at approval (done-when part 2)', async () => {
    h.clock.set(AT(Q));
    const a = await request(ids.odooInvoice);
    await approve(a);
    const rel = await release(a);
    expect(rel.status).toBe('funded');
    expect(rel.funding_source_code).toBe('FAC-A');
    ids.advOdoo = a;
    const loan = Number((await adv(a)).fineract_loan_id);
    const fac = (await w.ops.get('/funding-sources')).find((s: any) => s.code === 'FAC-A');
    if (!REAL_LEDGER) expect(await h.adapters.ledger.getFundingTag(loan)).toEqual({ fundId: Number(fac.fineractFundId), tagCode: 'FAC-A' });
    const inv90 = await eligibleInvoice(h, w, { number: 'INV-P3-F90', amountCents: kes(500_000), dueDate: addDays(Q, 90) });
    const a90 = await request(inv90);
    const refused = await approve(a90, { fundingSource: 'FAC-A' }, 422);
    expect(refused.title).toBe('FUNDING_SOURCE_INELIGIBLE');
    expect(refused.evaluations).toEqual([{ code: 'FAC-A', ok: false, reasons: ['TENOR_ABOVE_MAX'] }]);
    await approve(a90);
    const r90 = await release(a90);
    expect(r90.funding_source_code).toBe('EQUITY');
    ids.adv90 = a90;
    const hist = await w.ops.get(`/advances/${a}/funding-tags`);
    expect(hist.map((x: any) => [x.to_code, x.reason])).toEqual([['FAC-A', 'auto at release (priority 10)']]);
  });

  it('TC-P3-FUND-03 re-tagging is maker-checker (credit proposes, CEO approves), moves the Fineract tag, and the consistency check agrees', async () => {
    await w.credit.post(`/advances/${ids.adv90}/funding-tag`, { sourceCode: 'FAC-A', reason: 'move' }, 422); // still ineligible
    const p = await w.credit.post(`/advances/${ids.advOdoo}/funding-tag`, { sourceCode: 'EQUITY', reason: 'Free facility A headroom for FMCG pipeline' });
    await w.approve(p.id, w.credit2).catch(() => undefined);
    expect((await h.admin.query(`SELECT status FROM mapema.approval_request WHERE id = $1`, [p.id])).rows[0].status).toBe('pending');
    await w.approve(p.id);
    expect((await adv(ids.advOdoo)).funding_code).toBe('EQUITY');
    const hist = await w.ops.get(`/advances/${ids.advOdoo}/funding-tags`);
    expect(hist.map((x: any) => [x.from_code, x.to_code])).toEqual([[null, 'FAC-A'], ['FAC-A', 'EQUITY']]);
    const cons = await w.ops.get('/funding/consistency');
    expect(cons).toMatchObject({ checked: 2, mismatches: [] });
    if (!REAL_LEDGER) {
      await h.adapters.ledger.setFundingTag(Number((await adv(ids.advOdoo)).fineract_loan_id), 'FAC-A', Q); // someone edits Fineract directly
      const bad = await w.ops.get('/funding/consistency');
      expect(bad.mismatches).toEqual([{ advanceId: ids.advOdoo, platform: 'EQUITY', ledger: 'FAC-A' }]);
      await h.adapters.ledger.setFundingTag(Number((await adv(ids.advOdoo)).fineract_loan_id), 'EQUITY', Q);
    }
  });

  it('TC-P3-FUND-04 covenants: buyer concentration is checked pro forma; the next advance falls through to equity; utilisation to the cent', async () => {
    h.clock.set(AT(Q));
    const f1 = await fundNew('INV-P3-F1', kes(1_000_000), addDays(Q, 45));
    expect(f1.release.funding_source_code).toBe('FAC-A');
    ids.advF1 = f1.advanceId;
    const inv2 = await eligibleInvoice(h, w, { number: 'INV-P3-F2', amountCents: kes(750_000), dueDate: addDays(Q, 45) });
    const a2 = await request(inv2);
    const refused = await approve(a2, { fundingSource: 'FAC-A' }, 422);
    expect(refused.evaluations[0].reasons).toEqual(['COVENANT_BUYER_CONCENTRATION']);
    await approve(a2);
    expect((await release(a2)).funding_source_code).toBe('EQUITY');
    const fac = (await w.ceo.get('/funding-sources')).find((s: any) => s.code === 'FAC-A');
    expect(fac.utilisation).toEqual({ outstandingCents: String(kes(800_000)), limitCents: String(kes(2_000_000)), headroomCents: String(kes(1_200_000)), usedBps: 4000, count: 1 });
    expect(fac.covenantStatus).toEqual([{ code: 'BUYER_CONCENTRATION', limitBps: 6000, actualBps: 4000, ok: true }, { code: 'NPL_RATIO', limitBps: 500, actualBps: 0, ok: true }]);
  });

  // ------------------------------------------------------------------ M-Pesa B2C
  it('TC-P3-MP-02 the M-Pesa cap defaults to KES 150,000 and changes only with CEO approval', async () => {
    expect((await w.ops.get('/mpesa/settings')).capCents).toBe(String(kes(150_000)));
    await w.admin.post('/mpesa/cap', { capCents: String(kes(300_000)), reason: 'too high' }, 400); // above the Daraja B2C maximum of KES 250,000
    const p = await w.admin.post('/mpesa/cap', { capCents: String(kes(180_000)), reason: 'Most supplier invoices are below KES 225,000' });
    expect((await w.ops.get('/mpesa/settings')).capCents).toBe(String(kes(150_000)));
    await w.approve(p.id);
    expect((await w.ops.get('/mpesa/settings')).capCents).toBe(String(kes(180_000)));
  });

  it('TC-P3-MP-01 small advances go to a verified M-Pesa wallet; the result callback confirms with the receipt; duplicates are ignored', async () => {
    h.clock.set(AT(Q));
    await h.http.post('/v1/dev/mpesa/fund').send({ amountCents: String(kes(2_000_000)), reference: 'MPFLOAT-P3-1', valueDate: Q }).expect(201);
    await w.ceo.post('/funding', { amountCents: String(kes(2_000_000)), source: 'M-Pesa B2C float top-up from equity', reference: 'MPFLOAT-P3-1', valueDate: Q });
    mp().chargeCents = kes(15);
    const wal = await w.supplier.post(`/organisations/${w.supplierId}/mpesa-wallet`, { msisdn: '254712345678', accountName: 'Peter Kamau' });
    await w.supplier.post(`/organisations/${w.supplierId}/mpesa-wallet`, { msisdn: '0712345678', accountName: 'x' }, 400);
    const v = await w.ops.post(`/bank-accounts/${wal.id}/verify`, { callBackNote: 'Called Peter on CR12 number; confirmed the Safaricom line is his' });
    await w.approve(v.id, w.ops2);
    // over the cap -> bank
    const big = await fundNew('INV-P3-MPBIG', kes(250_000), addDays(Q, 70));
    expect((await payoutOf(big.advanceId)).rail).toBe('pesalink');
    // under the cap -> M-Pesa; the advance stays released until Safaricom's result arrives
    const inv = await eligibleInvoice(h, w, { number: 'INV-P3-MP1', amountCents: kes(150_000), dueDate: addDays(Q, 70) });
    const a = await request(inv);
    await approve(a);
    const rel = await release(a);
    expect(rel.status).toBe('released');
    const p = await payoutOf(a);
    expect(p).toMatchObject({ rail: 'mpesa_b2c', mpesa_state: 'accepted', amount_cents: String(kes(120_000)) });
    expect(mp().requests.map((r) => [r.msisdn, r.amountCents])).toEqual([['254712345678', kes(120_000)]]);
    await mpesaPost('result', mp().complete(p.idempotency_key, { receiverName: 'PETER KAMAU', date: Q }), 'wrong-token').expect(401);
    const body = mp().complete(p.idempotency_key, { receiverName: 'PETER KAMAU', date: Q });
    const ok = await mpesaPost('result', body).expect(200);
    expect(ok.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    await mpesaPost('result', body).expect(200); // Safaricom retries: idempotent
    const p2 = await payoutOf(a);
    expect(p2).toMatchObject({ status: 'confirmed', mpesa_state: 'completed' });
    expect(p2.bank_ref).toMatch(/^[A-Z0-9]{10}$/);
    expect((await adv(a)).status).toBe('funded');
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM mapema.aml_flag WHERE entity_id = $1`, [p2.id])).rows[0].n).toBe(0);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM mapema.audit_event WHERE action = 'advance.funded' AND entity_id = $1`, [a])).rows[0].n).toBe(1);
    ids.mpOk = a;
  });

  it('TC-P3-MP-03 a failed result undoes the ledger disbursal and frees the invoice; nothing is resent', async () => {
    const inv = await eligibleInvoice(h, w, { number: 'INV-P3-MP2', amountCents: kes(150_000), dueDate: addDays(Q, 70) });
    const a = await request(inv);
    await approve(a);
    await release(a);
    const p = await payoutOf(a);
    const loanBefore = (await adv(a)).fineract_loan_id;
    expect(loanBefore).toBeTruthy();
    await mpesaPost('result', mp().fail(p.idempotency_key, 2001, 'The initiator information is invalid.')).expect(200);
    const after = await adv(a);
    expect(after).toMatchObject({ status: 'release_failed', fineract_loan_id: null });
    expect((await payoutOf(a))).toMatchObject({ status: 'failed', mpesa_state: 'failed', failure_reason: 'MPESA_2001: The initiator information is invalid.' });
    expect((await h.admin.query(`SELECT status FROM mapema.invoice WHERE id = $1`, [inv])).rows[0].status).toBe('eligible');
    if (!REAL_LEDGER) expect((await h.adapters.ledger.getLoan(Number(loanBefore))).status).toBe('approved');
    expect(mp().requests.filter((r) => r.idempotencyKey === p.idempotency_key)).toHaveLength(1);
  });

  it('TC-P3-MP-04 timeout: a status query runs, an unknown state is left for ops (never auto-resent), and a later completion is applied; a name mismatch raises an AML flag', async () => {
    const inv = await eligibleInvoice(h, w, { number: 'INV-P3-MP3', amountCents: kes(150_000), dueDate: addDays(Q, 70) });
    const a = await request(inv);
    await approve(a);
    await release(a);
    const p = await payoutOf(a);
    mp().statusOverride.set(p.idempotency_key, 'unknown');
    await mpesaPost('timeout', mp().timeoutBody(p.idempotency_key)).expect(200);
    expect(await payoutOf(a)).toMatchObject({ status: 'released', mpesa_state: 'unknown' });
    expect((await adv(a)).status).toBe('released');
    const task = (await h.admin.query(`SELECT count(*)::int AS n FROM mapema.notification WHERE template_key = 'mpesa.unknown'`)).rows[0].n;
    expect(task).toBeGreaterThan(0);
    // still unknown 30+ minutes later: the job asks again and still does not resend
    h.clock.set(new Date(new Date(AT(Q)).getTime() + 31 * 60_000).toISOString());
    const chk = await w.ops.post('/mpesa/payouts/check');
    expect(chk).toMatchObject({ checked: 1, unknown: 1 });
    // Safaricom later reports it completed (to a different registered name)
    mp().statusOverride.delete(p.idempotency_key);
    mp().complete(p.idempotency_key, { receiverName: 'JOHN DOE', date: Q });
    expect(await w.ops.post('/mpesa/payouts/check')).toMatchObject({ checked: 1, completed: 1 });
    expect(await payoutOf(a)).toMatchObject({ status: 'confirmed', mpesa_state: 'completed' });
    expect((await adv(a)).status).toBe('funded');
    expect((await h.admin.query(`SELECT rule_code FROM mapema.aml_flag WHERE entity_id = $1`, [p.id])).rows.map((r) => r.rule_code)).toEqual(['MPESA_NAME_MISMATCH']);
    expect(mp().requests.filter((r) => r.idempotencyKey === p.idempotency_key)).toHaveLength(1);
    // and an M-Pesa payout that is still pending (no callback yet) for the reconciliation below
    const inv4 = await eligibleInvoice(h, w, { number: 'INV-P3-MP4', amountCents: kes(150_000), dueDate: addDays(Q, 70) });
    const a4 = await request(inv4); await approve(a4); await release(a4);
    ids.mpPending = a4;
    h.clock.set(AT(Q));
  });

  it('TC-P3-MP-05 daily reconciliation includes the M-Pesa float: receipts match, B2C charges are explained, the pending payout is timing', async () => {
    const run = await w.ops.post(`/reconciliation/run?date=${Q}`);
    const breaks = run.breaks;
    const okReceipt = (await payoutOf(ids.mpOk)).bank_ref;
    expect(breaks.filter((b: any) => String(b.item_key).includes(okReceipt) && b.category !== 'bank_charge')).toEqual([]);
    const charges = breaks.filter((b: any) => b.category === 'bank_charge');
    expect(charges.length).toBe(2); // two completed B2C payouts at KES 15 each
    expect(charges.every((b: any) => b.difference_cents === String(-kes(15)) && b.classification === 'explained')).toBe(true);
    const pend = breaks.find((b: any) => b.category === 'payout_in_transit');
    expect(pend).toMatchObject({ classification: 'timing', difference_cents: String(-kes(120_000)) });
    expect(breaks.filter((b: any) => b.classification === 'unexplained')).toEqual([]);
    expect(run).toMatchObject({ status: 'explained', unexplained_count: 0 });
  });

  // ------------------------------------------------------------------ bulk tools
  it('TC-P3-BULK-01 buyer bulk confirmation: per-item results, one ILU for all approved invoices', async () => {
    h.clock.set(AT(Q));
    const csv = ['supplier_kra_pin,invoice_number,amount_cents,currency,issue_date,due_date,etims_cu_invoice_no',
      ...[1, 2, 3].map((n) => `P051111111B,INV-P3-B${n},${kes(300_000)},KES,${addDays(Q, -2)},${addDays(Q, 70)},KRACUB${n}`),
      `P051111111B,INV-P3-B4,${kes(100_000)},KES,${addDays(Q, -2)},${addDays(Q, 70)},KRACUB4`].join('\n');
    const up = await w.buyerAdmin.post('/invoices/csv', { csv });
    const invIds = up.results.map((r: any) => r.invoiceId);
    expect(invIds).toHaveLength(4);
    const r = await w.buyerChecker.post('/invoices/bulk-decision', { invoiceIds: [...invIds, ids.odooInvoice], decision: 'approve' });
    expect(r.results.map((x: any) => x.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'error']);
    expect(r.results[4].error).toBe('BAD_STATE');
    await w.buyerAdmin.post('/invoices/bulk-decision', { invoiceIds: invIds, decision: 'approve' }, 403); // makers cannot check
    const conf = await w.buyerChecker.post('/confirmations', { invoiceIds: invIds });
    await h.http.post(`/v1/dev/esign/${conf.envelopeId}/complete`).expect(201);
    ids.bulk = JSON.stringify(invIds);
  });

  it('TC-P3-BULK-02 supplier bulk quotes and one acceptance for several advances', async () => {
    const invIds: string[] = JSON.parse(ids.bulk);
    const q = await w.supplier.post('/invoices/bulk-quote', { invoiceIds: [...invIds, ids.odooInvoice] });
    expect(q.results.map((x: any) => x.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'error']);
    expect(q.totals).toEqual({ invoices: 4, advanceCents: String(kes(800_000)), totalCostCents: q.totals.totalCostCents });
    expect(q.results[0].quote.advanceCents).toBe(String(kes(240_000)));
    const acc = await w.supplier.post('/advances', { disclosureIds: q.results.slice(0, 4).map((x: any) => x.quote.disclosureId), acceptTerms: true }, undefined, { 'Idempotency-Key': 'bulk-accept-1' });
    expect(acc.advances).toHaveLength(4);
    for (const x of acc.advances) await approve(x.advanceId);
    ids.batchAdv = JSON.stringify(acc.advances.map((x: any) => x.advanceId));
  });

  it('TC-P3-BULK-03 payout batch: maker-checker at batch and item level; one item rejected, one fails at M-Pesa, the rest release; full audit trail', async () => {
    const advIds: string[] = JSON.parse(ids.batchAdv);
    const b = await w.ops.post('/payout-batches', { advanceIds: advIds, note: 'Thursday batch' });
    expect(b).toMatchObject({ status: 'pending_approval', totalCents: String(kes(800_000)), itemCount: 4 });
    expect(b.items.map((i: any) => i.rail)).toEqual(['pesalink', 'pesalink', 'pesalink', 'mpesa_b2c']);
    await release(advIds[0], 409); // in a pending batch
    await w.ops.post(`/payout-batches/${b.id}/approve`, { rejectItems: [] }, 403); // maker cannot approve
    await w.credit.post(`/payout-batches/${b.id}/approve`, { rejectItems: [] }, 403); // wrong role
    mp().failNext = 'MPESA_REJECTED';
    const done = await w.ops2.post(`/payout-batches/${b.id}/approve`, { rejectItems: [{ itemId: b.items[1].id, reason: 'Supplier asked to hold this one' }] });
    expect(done.status).toBe('partially_failed');
    expect(done.items.map((i: any) => i.status)).toEqual(['released', 'rejected', 'released', 'failed']);
    expect(done.items[3].errorCode).toBe('MPESA_REJECTED');
    expect(done.releasedCents).toBe(String(kes(480_000)));
    expect((await adv(advIds[0])).status).toBe('funded');
    expect((await adv(advIds[1])).status).toBe('approved');
    expect((await adv(advIds[3])).status).toBe('release_failed');
    const acts = (await h.admin.query(`SELECT action FROM mapema.audit_event WHERE entity_type IN ('payout_batch','payout_batch_item') ORDER BY id`)).rows.map((r) => r.action);
    expect(acts).toEqual(['payout_batch.create', 'payout_batch.approve', 'payout_batch.item_released', 'payout_batch.item_rejected', 'payout_batch.item_released', 'payout_batch.item_failed', 'payout_batch.completed']);
    ids.held = advIds[1];
  });

  it('TC-P3-BULK-04 limits are re-checked per item at release: after the supplier limit is cut, a batch item fails SUPPLIER_LIMIT and nothing is paid', async () => {
    const link = (await h.admin.query(`SELECT id FROM mapema.supplier_link WHERE supplier_id = $1`, [w.supplierId])).rows[0];
    const sl = await w.credit.post(`/supplier-links/${link.id}/limit`, { limitCents: String(kes(1_000_000)), reason: 'Reduce after review' });
    await w.approve(sl.id, w.credit2);
    const bankBefore = await h.adapters.bank.getBalance();
    const b = await w.ops.post('/payout-batches', { advanceIds: [ids.held], note: 'Held item' });
    const done = await w.ops2.post(`/payout-batches/${b.id}/approve`, { rejectItems: [] });
    expect(done.status).toBe('failed');
    expect(done.items[0]).toMatchObject({ status: 'failed', errorCode: 'CHECKS_FAILED' });
    expect(done.items[0].failedChecks).toContain('SUPPLIER_LIMIT');
    expect(await h.adapters.bank.getBalance()).toBe(bankBefore);
  });

  // ------------------------------------------------------------------ per-funder lender pack
  it('TC-P3-FUND-05 per-funder lender pack: facility A sees only its loans (tag at month end), reproducible to the byte', async () => {
    const monthEnd = (() => { const d = new Date(`${Q}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); })();
    const after = addDays(monthEnd, 1) > addDays(Q, 5) ? addDays(monthEnd, 1) : addDays(Q, 5);
    h.clock.set(AT(after));
    const snap = await w.compliance.post('/reports/snapshots', { period: Q.slice(0, 7) });
    const g = await w.ceo.post(`/reports/snapshots/${snap.id}/generate`, { kind: 'lender_pack', fundingSource: 'FAC-A' });
    expect(g).toMatchObject({ fundingSource: 'FAC-A', loans: 1 });
    expect(g.artifacts.map((a: any) => a.filename)).toEqual(expect.arrayContaining([expect.stringContaining('FAC-A')]));
    const again = await w.ceo.post(`/reports/snapshots/${snap.id}/generate`, { kind: 'lender_pack', fundingSource: 'FAC-A' });
    expect(again.artifacts.map((a: any) => a.sha256)).toEqual(g.artifacts.map((a: any) => a.sha256));
    const tape = (await h.admin.query(`SELECT convert_from(content, 'UTF8') AS t FROM mapema.report_artifact WHERE id = $1`, [g.artifacts.find((a: any) => /loan-tape/.test(a.filename)).id])).rows[0].t;
    expect(tape).toContain('INV-P3-F1');
    expect(tape).not.toContain('ODOO-1');
    const eq = await w.ceo.post(`/reports/snapshots/${snap.id}/generate`, { kind: 'lender_pack', fundingSource: 'EQUITY' });
    expect(eq.loans).toBeGreaterThanOrEqual(3);
    await w.ceo.post(`/reports/snapshots/${snap.id}/generate`, { kind: 'lender_pack', fundingSource: 'NOPE' }, 404);
    await w.buyerAdmin.post(`/reports/snapshots/${snap.id}/generate`, { kind: 'lender_pack', fundingSource: 'FAC-A' }, 403);
  });

  it('TC-P3-AUD-01 the audit chain still verifies after Phase 3 activity', async () => {
    const v = await w.auditor.get('/audit/verify');
    expect(v.ok).toBe(true);
  });
});
