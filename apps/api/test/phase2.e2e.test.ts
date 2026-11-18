/**
 * [QA Engineer] Phase 2 "Scale and reporting" end to end through the HTTP API, written from
 * docs/phase-2/stories.md BEFORE the code (TC-P2-*). Runs on the MockLedger by default and on a real
 * Apache Fineract with E2E_LEDGER=fineract (npm run test:e2e:fineract): reconciliation is then proven
 * by movement against an approved baseline because the Fineract tenant is shared (REC-05/06).
 *
 * Timeline (mock dates; the real-ledger run shifts everything ~500 days into the past):
 *   Q = quote date. W = worked example (KES 1,000,000, 48 days). B = KES 500,000 due Q+40 (late ->
 *   recourse). C = KES 100,000 due Q+21 (short term: NPL at 30 DPD; in duplum cap).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@mapema/pricing';
import { MockAccounting, MockCrm, MockSiteLeadSource } from '@mapema/adapters';
import { addBusinessDays } from '../src/modules/recon-engine';
import { Harness, startHarness } from './harness';
import { AT, buildWorld, eligibleInvoice, fund, LEDGER_ENV, REAL_LEDGER, seedFunding, World, WORKED } from './world';

let h: Harness; let w: World;
const Q = WORKED.quoteDate;
const DUE_W = WORKED.dueDate; const DUE_B = addDays(Q, 40); const DUE_C = addDays(Q, 21);
const ids: Record<string, string> = {};
const dayRun = async (date: string) => { h.clock.set(AT(date)); return w.ops.post('/collections/run'); };
const status = async (id: string) => (await h.admin.query(`SELECT status FROM mapema.advance WHERE id = $1`, [id])).rows[0].status;
const notes = async (role: string, key: string) => (await h.admin.query(`SELECT count(*)::int AS n FROM mapema.notification n WHERE n.template_key = $2 AND n.user_id IN (SELECT user_id FROM mapema.user_role_assignment WHERE role = $1)`, [role, key])).rows[0].n;
const orgNotes = async (orgId: string, key: string) => (await h.admin.query(`SELECT count(*)::int AS n FROM mapema.notification n WHERE n.template_key = $2 AND n.user_id IN (SELECT user_id FROM mapema.user_role_assignment WHERE org_id = $1)`, [orgId, key])).rows[0].n;
const monthOf = (d: string) => d.slice(0, 7);

beforeAll(async () => {
  h = await startHarness(LEDGER_ENV);
  if (!REAL_LEDGER) (h.adapters.ledger as any).postMaturityInterest = true; // test hook: lets the in duplum cap bite (COL-03)
  w = await buildWorld(h, { floatCents: 10_000_000_000n, supplierLimitCents: 1_000_000_000n, tag: 'p2' });
  await seedFunding(h, w, 1_000_000_000n);
});
afterAll(async () => { await h?.close(); });

describe(`Phase 2 [ledger=${REAL_LEDGER ? 'real Fineract' : 'mock'}]`, () => {
  it('TC-P2-REC-04 opening baseline is maker-checker: ops proposes, cannot self-approve, a second ops user approves', async () => {
    const p = await w.ops.post('/reconciliation/baseline', { note: 'Go-live opening balances (shared test tenant)' });
    expect(p.status).toBe('pending');
    await w.ops.post(`/approvals/${p.id}/approve`, {}, 403);
    await w.approve(p.id, w.ops2);
    const b = await w.ops.get('/reconciliation/baseline');
    expect(b.bank_cents).toBe('1000000000');
    expect(b.platform_cents).toBe('1000000000');
    if (!REAL_LEDGER) expect(b.fineract_cents).toBe('1000000000');
  });

  it('funds W (worked example), B and C', async () => {
    for (const [k, amount, due] of [['W', WORKED.invoiceCents, DUE_W], ['B', 50_000_000n, DUE_B], ['C', 10_000_000n, DUE_C]] as const) {
      h.clock.set(AT(Q));
      const inv = await eligibleInvoice(h, w, { number: `INV-P2-${k}`, amountCents: amount, dueDate: due });
      const r = await fund(h, w, inv);
      expect(r.release.status).toBe('funded');
      ids[k] = r.advanceId;
    }
  });

  it('TC-P2-COL-01 reminders before the due date, once per step, SMS + email via the adapters', async () => {
    const r = await dayRun(addDays(DUE_B, -7));
    expect(r.reminders.filter((x: any) => x.advanceId === ids.B).map((x: any) => x.key)).toEqual(['pre_7']);
    expect(await orgNotes(w.buyerId, 'reminder.pre_due')).toBeGreaterThan(0);
    const again = await dayRun(addDays(DUE_B, -7));
    expect(again.reminders).toEqual([]);
    await h.http.post('/v1/dev/jobs/run').expect(201);
    expect(h.adapters.email.outbox.some((m: any) => /INV-P2-B/.test(m.text) && /due on/.test(m.text))).toBe(true);
  });

  it('TC-P2-COL-02 a missed day catches up with the latest step only; status moves to late at 1 DPD', async () => {
    const r = await dayRun(addDays(DUE_B, 1));
    expect(r.reminders.filter((x: any) => x.advanceId === ids.B).map((x: any) => x.key)).toEqual(['od_1']);
    expect(r.skipped.filter((x: any) => x.advanceId === ids.B).map((x: any) => x.key)).toEqual(['pre_1', 'due_0']);
    expect(await status(ids.B)).toBe('late');
    expect(await status(ids.C)).toBe('late'); // C due earlier
    expect(await status(ids.W)).toBe('funded');
  });

  it('TC-P2-REC-01 worked example settles; daily recon balances with zero breaks; rerun is idempotent', async () => {
    h.clock.set(AT(DUE_W));
    await h.http.post('/v1/dev/bank/credit').send({ accountNo: w.virtualAccount, amountCents: '100000000', bankRef: 'FT-P2-W', valueDate: DUE_W, payerName: 'ACME SUPERMARKETS LIMITED', narrative: 'PAYMENT INV-P2-W' }).expect(201);
    const alloc = (await h.admin.query(`SELECT principal_cents, fees_charges_cents, interest_cents, supplier_balance_cents FROM mapema.payment_allocation WHERE advance_id = $1`, [ids.W])).rows[0];
    expect(alloc).toEqual({ principal_cents: '80000000', fees_charges_cents: '250000', interest_cents: '4480000', supplier_balance_cents: '15270000' });
    const p = (await w.ops.get('/payouts?status=proposed')).find((x: any) => x.amount_cents === '15270000');
    await w.ops.post(`/payouts/${p.id}/release`);
    const run = await w.ops.post(`/reconciliation/run?date=${DUE_W}`);
    expect(run).toMatchObject({ status: 'balanced', unexplained_count: 0 });
    expect(run.breaks).toEqual([]);
    expect(run.movements).toEqual({ bankCents: run.movements.platformCents, fineractCents: run.movements.platformCents, platformCents: run.movements.platformCents });
    const again = await w.ops.post(`/reconciliation/run?date=${DUE_W}`);
    expect(again.id).toBe(run.id);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM mapema.audit_event WHERE action = 'reconciliation.run'`)).rows[0].n).toBe(2);
  });

  it('TC-P2-REC-02 breaks are classified; unexplained ones alert ops AND compliance', async () => {
    const bank = h.adapters.bank;
    bank.creditReceived(700_000n, { bankRef: 'UNKNOWN-1', valueDate: addDays(DUE_W, -3) });   // nobody ingested it, 3 days old
    bank.creditReceived(5_000_000n, { bankRef: 'LATE-ARRIVAL-1', valueDate: DUE_W });         // arrived today after ingestion
    bank.bankCharge(2_500n, 'CHG-1', DUE_W, 'PesaLink charge');                                // bank charge
    await h.adapters.ledger.postJournal({ requestId: 'rogue' }, { date: DUE_W, debit: 'bank', credit: 'suspense', amountCents: 12_345n, reference: `rogue-${h.dbName}`, note: 'TEST: unexplained ledger entry' });
    const opsBefore = await notes('ops', 'recon.unexplained'); const compBefore = await notes('compliance', 'recon.unexplained');
    const run = await w.ops.post(`/reconciliation/run?date=${DUE_W}`);
    const by = Object.fromEntries(run.breaks.map((b: any) => [b.item_key, b]));
    expect(by['bank:UNKNOWN-1']).toMatchObject({ classification: 'unexplained', category: 'unknown_bank_item', difference_cents: '700000' });
    expect(by['bank:LATE-ARRIVAL-1']).toMatchObject({ classification: 'timing', category: 'credit_not_yet_ingested', expected_clear_by: addBusinessDays(DUE_W, 1) });
    expect(by['bank:CHG-1']).toMatchObject({ classification: 'explained', category: 'bank_charge', difference_cents: '-2500' });
    expect(by['residual:fineract_vs_platform']).toMatchObject({ classification: 'unexplained', difference_cents: '12345' });
    expect(run).toMatchObject({ status: 'breaks', unexplained_count: 2 });
    expect(await notes('ops', 'recon.unexplained')).toBeGreaterThan(opsBefore);
    expect(await notes('compliance', 'recon.unexplained')).toBeGreaterThan(compBefore);
    ids.unknownBreak = by['bank:UNKNOWN-1'].id; ids.rogueBreak = by['residual:fineract_vs_platform'].id;
  });

  it('TC-P2-REC-03 resolution is maker-checker with an audit trail; carried-forward items are explained on rerun', async () => {
    const p1 = await w.ops.post(`/reconciliation/breaks/${ids.unknownBreak}/resolve`, { resolution: 'explained', carryForward: true, note: 'Buyer prepayment for next invoice, confirmed with Acme AP' });
    await w.ops.post(`/approvals/${p1.id}/approve`, {}, 403); // four-eyes
    await w.credit.post(`/approvals/${p1.id}/approve`, {}, 403); // needs ops
    await w.approve(p1.id, w.ops2);
    const p2 = await w.ops.post(`/reconciliation/breaks/${ids.rogueBreak}/resolve`, { resolution: 'explained', carryForward: true, note: 'Test journal posted by QA; reversal booked next day' });
    await w.approve(p2.id, w.ops2);
    const run = await w.ops.post(`/reconciliation/run?date=${DUE_W}`);
    expect(run).toMatchObject({ status: 'explained', unexplained_count: 0 });
    expect(run.breaks.find((b: any) => b.item_key === 'bank:UNKNOWN-1')).toMatchObject({ classification: 'explained', category: 'carried_forward', status: 'explained' });
    const audit = (await w.auditor.get('/audit/events?limit=200')).map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['approval.propose.reconciliation_break_resolve', 'approval.approve.reconciliation_break_resolve', 'reconciliation.break_resolved']));
    const breaks = await w.ops.get(`/reconciliation/runs/${run.id}/breaks`);
    expect(breaks.length).toBe(run.breaks.length);
  });

  it('TC-P2-REC-06 the next day the un-ingested credit is no longer timing: it is unexplained', async () => {
    const run = await w.ops.post(`/reconciliation/run?date=${addBusinessDays(DUE_W, 2)}`);
    expect(run.breaks.find((b: any) => b.item_key === 'bank:LATE-ARRIVAL-1')).toMatchObject({ classification: 'unexplained', category: 'unknown_bank_item' });
    // ingest it (statement import) and rerun: gone
    h.clock.set(AT(addBusinessDays(DUE_W, 2)));
    await h.http.post('/v1/dev/bank/ingest-statement').send({ bankRef: 'LATE-ARRIVAL-1' }).expect(201);
    const r2 = await w.ops.post(`/reconciliation/run?date=${addBusinessDays(DUE_W, 2)}`);
    expect(r2.breaks.find((b: any) => b.item_key === 'bank:LATE-ARRIVAL-1')).toBeUndefined();
  });

  it('TC-P2-COL-03 NPL for the short-term advance at 30 DPD (snapshot for the cap); B is recourse-due at 30 DPD', async () => {
    const r = await dayRun(addDays(DUE_C, 30));
    expect(r.moves).toEqual(expect.arrayContaining([{ advanceId: ids.C, from: 'late', to: 'non_performing' }]));
    const c = (await h.admin.query(`SELECT status, npl_at, npl_principal_cents, npl_charges_cents FROM mapema.advance WHERE id = $1`, [ids.C])).rows[0];
    expect(c.status).toBe('non_performing');
    expect(c.npl_principal_cents).toBe('8000000');
    expect(await notes('compliance', 'collections.npl')).toBeGreaterThan(0);
    const r2 = await dayRun(addDays(DUE_B, 30));
    expect(r2.recourseCases).toEqual([{ advanceId: ids.B, status: 'due' }]);
    expect(await status(ids.B)).toBe('late');
    const cases = await w.credit.get('/recourse-cases');
    expect(cases.find((x: any) => x.advance_id === ids.B)).toMatchObject({ status: 'due' });
  });

  it('TC-P2-COL-05 recourse to the supplier is maker-checker; approval demands the ledger payoff from the supplier', async () => {
    const p = await w.credit.post(`/advances/${ids.B}/recourse`, { reason: 'Acme 30 days late on INV-P2-B; recourse per master agreement cl. 9' });
    expect(p.status).toBe('pending');
    expect(await status(ids.B)).toBe('late');
    await w.credit.post(`/approvals/${p.id}/approve`, {}, 403);
    await w.ops.post(`/approvals/${p.id}/approve`, {}, 403);
    await w.approve(p.id, w.credit2);
    expect(await status(ids.B)).toBe('recourse');
    const cs = (await w.credit.get('/recourse-cases')).find((x: any) => x.advance_id === ids.B);
    expect(cs.status).toBe('demanded');
    expect(BigInt(cs.amount_demanded_cents)).toBeGreaterThanOrEqual(40_000_000n + 250_000n); // principal + fee + interest to date
    expect(await orgNotes(w.supplierId, 'recourse.demand')).toBeGreaterThan(0);
  });

  it('TC-P2-COL-06 collections policy changes are maker-checker (credit proposes, CEO approves)', async () => {
    const pol = await w.credit.get('/collections/policy');
    expect(pol).toMatchObject({ recourseAfterDays: 30, nplDaysShortTerm: 30, nplDaysLongTerm: 90, counselConfirmed: false });
    await w.credit.post('/collections/policy', { ...pol, recourseAfterDays: 0 }, 400);
    const p = await w.credit.post('/collections/policy', { ...pol, overdueDays: [1, 7, 14, 21] });
    await w.approve(p.id, w.ceo);
    expect((await w.credit.get('/collections/policy')).overdueDays).toEqual([1, 7, 14, 21]);
  });

  it('TC-P2-DSH-01 staff dashboard: utilisation vs 25/10/35 limits, ageing, late/recourse/NPL, float, recon', async () => {
    const d = await w.ceo.get('/dashboards/staff');
    expect(d.floatCents).toBe('10000000000');
    expect(d.portfolio.outstandingPrincipalCents).toBe('48000000');
    const buyer = d.utilisation.buyers.find((x: any) => x.orgId === w.buyerId);
    expect(buyer).toMatchObject({ exposureCents: '48000000', capCents: '2500000000', limitBps: 2500, usedBps: 192, breach: false });
    expect(d.utilisation.suppliers[0]).toMatchObject({ capCents: '1000000000', limitBps: 1000 });
    expect(d.utilisation.sectors.find((x: any) => x.code === 'FMCG')).toMatchObject({ capCents: '3500000000', limitBps: 3500 });
    expect(d.ageing.dpd_1_30.count + d.ageing.dpd_31_60.count + d.ageing.dpd_61_90.count + d.ageing.dpd_91_plus.count).toBe(2);
    expect(d.recourse).toEqual({ count: 1, principalCents: '40000000' });
    expect(d.npl).toEqual({ count: 1, principalCents: '8000000' });
    expect(d.nplRatioBps).toBe(1667);
    expect(d.reconciliation.status).toBeDefined();
    await w.buyerAdmin.get('/dashboards/staff', 403);
  });

  it('TC-P2-DSH-02/03 buyer and supplier dashboards are scoped to their organisation', async () => {
    const b = await w.buyerAdmin.get('/dashboards/buyer');
    expect(b.orgId).toBe(w.buyerId);
    expect(b.overdueTotalCents).toBe('60000000');
    expect(b.overdue.map((x: any) => x.invoiceNumber).sort()).toEqual(['INV-P2-B', 'INV-P2-C']);
    expect(b.invoicesByStatus.settled).toBe(1);
    const s = await w.supplier.get('/dashboards/supplier');
    expect(s.orgId).toBe(w.supplierId);
    expect(s.fundedOutstandingCents).toBe('48000000');
    expect(s.recourseDemands).toHaveLength(1);
    await w.supplier.get(`/dashboards/buyer?orgId=${w.buyerId}`, 403);
    await w.buyerAdmin.get(`/dashboards/supplier?orgId=${w.supplierId}`, 403);
  });

  it('TC-P2-RPT-01 month-end snapshot from system data only; same month returns the same snapshot; restatement needs a reason', async () => {
    h.clock.set(AT(addDays(DUE_B, 31)));
    const period = monthOf(DUE_W);
    const s = await w.compliance.post('/reports/snapshots', { period });
    expect(s).toMatchObject({ period, version: 1 });
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    const again = await w.compliance.post('/reports/snapshots', { period });
    expect(again.id).toBe(s.id);
    const data = (await w.compliance.get(`/reports/snapshots/${s.id}`)).data;
    const wRow = data.loans.find((l: any) => l.invoiceNumber === 'INV-P2-W');
    expect(wRow).toMatchObject({ principalCents: '80000000', discountFeeCents: '4480000', verificationFeeCents: '250000', principalRepaidCents: '80000000', interestRepaidCents: '4480000', feesRepaidCents: '250000', supplierBalanceCents: '15270000', outstandingPrincipalCents: '0', statusAtMonthEnd: 'settled' });
    expect(BigInt(data.aggregates.repaidInMonth.principalCents)).toBeGreaterThanOrEqual(80_000_000n);
    expect(data.aggregates.incomeInMonth).toMatchObject({ interestCents: '4480000', feesCents: '250000' });
    const pg = (await import('pg')).default; // append-only: the API's own role cannot rewrite a snapshot
    const appPool = new pg.Pool({ connectionString: h.appUrl, max: 1 });
    await expect(appPool.query(`UPDATE mapema.report_snapshot SET data = '{}'::jsonb WHERE id = $1`, [s.id])).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`DELETE FROM mapema.report_snapshot WHERE id = $1`, [s.id])).rejects.toThrow(/permission denied/);
    await appPool.end();
    await w.compliance.post('/reports/snapshots', { period, restate: true }, 400);
    const r = await w.compliance.post('/reports/snapshots', { period, restate: true, reason: 'Late bank statement line booked' });
    expect(r.version).toBe(2);
    ids.snapshot = r.id;
  });

  it('TC-P2-RPT-04 lender pack CSV + PDF are reproducible byte-for-byte; worked example numbers exact', async () => {
    const g1 = await w.ceo.post(`/reports/snapshots/${ids.snapshot}/generate`, { kind: 'lender_pack' });
    const g2 = await w.ceo.post(`/reports/snapshots/${ids.snapshot}/generate`, { kind: 'lender_pack' });
    expect(g1.artifacts.map((a: any) => a.format).sort()).toEqual(['csv', 'csv', 'pdf']);
    expect(g2.artifacts.map((a: any) => a.sha256)).toEqual(g1.artifacts.map((a: any) => a.sha256));
    const tape = g1.artifacts.find((a: any) => a.filename.includes('loan-tape'));
    const res = await h.http.get(`/v1/reports/artifacts/${tape.id}/download`).set('Authorization', `Bearer ${await h.staff.ceo.token()}`).expect(200);
    const csv = res.text;
    expect(csv).toMatch(/INV-P2-W,.*800000\.00,44800\.00,2500\.00,.*152700\.00/);
    const pdf = g1.artifacts.find((a: any) => a.format === 'pdf');
    const pres = await h.http.get(`/v1/reports/artifacts/${pdf.id}/download`).set('Authorization', `Bearer ${await h.staff.ceo.token()}`).buffer(true).parse((r: any, cb: any) => { const b: Buffer[] = []; r.on('data', (c: Buffer) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
    expect(pres.body.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pres.body.toString('latin1')).toMatch(/Lender portfolio pack/);
  });

  it('TC-P2-RPT-02 CBK return comes from the template layer and is marked DRAFT (assumed layout)', async () => {
    const g = await w.compliance.post(`/reports/snapshots/${ids.snapshot}/generate`, { kind: 'cbk_return' });
    expect(g.draft).toBe(true);
    const csv = g.artifacts.find((a: any) => a.format === 'csv');
    const res = await h.http.get(`/v1/reports/artifacts/${csv.id}/download`).set('Authorization', `Bearer ${await h.staff.compliance.token()}`).expect(200);
    expect(res.text.split('\n')[0]).toMatch(/DRAFT - ASSUMED LAYOUT - NOT AN OFFICIAL CBK FORMAT/);
    expect(res.text).toMatch(/assumed/i);
  });

  it('TC-P2-RPT-03 CRB file: one record per facility; borrowers without CRB consent are excluded and listed as exceptions', async () => {
    const g = await w.compliance.post(`/reports/snapshots/${ids.snapshot}/generate`, { kind: 'crb_file' });
    expect(g.draft).toBe(true);
    expect(g.records).toBe(0);
    expect(g.exceptions).toEqual([expect.objectContaining({ reason: 'no_crb_consent_on_file' })]);
    // supplier consents; a new snapshot (another month) includes the facilities
    await w.supplier.post('/consents', { orgId: w.supplierId, purpose: 'crb_enquiry_and_reporting', textVersion: 'CRB-2026-11' });
    const s = await w.compliance.post('/reports/snapshots', { period: monthOf(Q) });
    const g2 = await w.compliance.post(`/reports/snapshots/${s.id}/generate`, { kind: 'crb_file' });
    expect(g2.records).toBe(3);
    expect(g2.exceptions).toEqual([]);
  });

  it('TC-P2-RPT-05 a new report template only takes effect after maker-checker', async () => {
    const tpls = await w.compliance.get('/reports/templates');
    const cbk = tpls.find((t: any) => t.kind === 'cbk_return' && t.active);
    expect(cbk.status).toBe('assumed_draft');
    const p = await w.compliance.post('/reports/templates', { kind: 'cbk_return', version: 'TEST-OFFICIAL-1', status: 'official', sourceRef: 'QA fixture - not a real CBK format', mapping: cbk.mapping });
    await w.compliance.post(`/approvals/${p.id}/approve`, {}, 403);
    await w.approve(p.id, w.ceo);
    const g = await w.compliance.post(`/reports/snapshots/${ids.snapshot}/generate`, { kind: 'cbk_return' });
    expect(g.draft).toBe(false);
  });

  it('TC-P2-RPT-06 auditors read but cannot create; suppliers cannot read', async () => {
    expect((await w.auditor.get('/reports/snapshots')).length).toBeGreaterThan(0);
    await w.auditor.post('/reports/snapshots', { period: monthOf(Q) }, 403);
    await w.supplier.get('/reports/snapshots', 403);
  });

  it('TC-P2-ACC-01 daily journal push to the accounting adapter is idempotent; first run captures the opening TB', async () => {
    const acc = h.adapters.accounting as MockAccounting;
    const d1 = addDays(DUE_B, 31);
    const r1 = await w.ops.post(`/integrations/accounting/push?date=${d1}`);
    expect(r1.status).toBe('opening_captured');
    await h.http.post('/v1/dev/bank/fund').send({ amountCents: '5000000', reference: 'EQ-P2-ACC', valueDate: d1 }).expect(201);
    await w.ceo.post('/funding', { amountCents: '5000000', source: 'Founder equity top-up', reference: 'EQ-P2-ACC', valueDate: d1 });
    const d2 = addDays(d1, 1);
    const r2 = await w.ops.post(`/integrations/accounting/push?date=${d2}`);
    expect(r2.status).toBe('pushed');
    expect(acc.journals).toHaveLength(1);
    const lines = acc.journals[0].lines;
    expect(lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0n)).toBe(0n);
    expect(lines.find((l) => l.description.includes('bank'))!.debitCents).toBe(5_000_000n);
    const r3 = await w.ops.post(`/integrations/accounting/push?date=${d2}`);
    expect(r3).toMatchObject({ status: 'pushed', duplicate: true, providerRef: r2.providerRef });
    expect(acc.journals).toHaveLength(1);
  });

  it('TC-P2-ACC-02 fee-invoice hook fired at settlement but is disabled pending tax advice (D-24)', async () => {
    const r = (await h.admin.query(`SELECT status FROM mapema.fee_invoice_hook WHERE advance_id = $1`, [ids.W])).rows;
    expect(r).toEqual([{ status: 'skipped_disabled' }]);
    expect((h.adapters.accounting as MockAccounting).invoices).toHaveLength(0);
    const st = await w.admin.get('/integrations/status');
    expect(st.accounting.feeInvoices).toMatch(/disabled/);
  });

  it('TC-P2-CRM-01/02 buyer leads from the site D1 form go to the CRM once; suppliers and erasure requests are skipped', async () => {
    const src = h.adapters.leads as MockSiteLeadSource;
    src.rows.push(
      { id: 'L1', created_at: '2026-11-18T06:00:00.000Z', contact_name: 'Amina Otieno', company: 'Duka Bora Ltd', email: 'amina@dukabora.test', phone: '+254700000001', role: 'buyer', privacy_notice_version: 'PN-2026-11', lang: 'sw' },
      { id: 'L2', created_at: '2026-11-18T06:05:00.000Z', contact_name: 'Juma', company: 'Juma Supplies', email: 'juma@supplies.test', phone: null, role: 'supplier', privacy_notice_version: 'PN-2026-11', lang: 'en' },
      { id: 'L3', created_at: '2026-11-18T06:10:00.000Z', contact_name: 'Gone', company: 'Gone Ltd', email: 'gone@gone.test', phone: null, role: 'buyer', privacy_notice_version: 'PN-2026-11', lang: 'en' },
    );
    src.erasures.push({ email: 'gone@gone.test', type: 'deletion', created_at: '2026-11-18T07:00:00.000Z' });
    const r = await w.ops.post('/integrations/crm/import');
    expect(r).toMatchObject({ imported: 1, skipped: 2 });
    const crm = h.adapters.crm as MockCrm;
    expect(crm.contacts.size).toBe(1);
    expect([...crm.contacts.values()][0]).toMatchObject({ email: 'amina@dukabora.test', marketingOptIn: false, basis: 'request_to_be_contacted' });
    const rows = (await h.admin.query(`SELECT source_id, status, reason FROM mapema.crm_sync ORDER BY source_id`)).rows;
    expect(rows).toEqual([{ source_id: 'L1', status: 'synced', reason: null }, { source_id: 'L2', status: 'skipped', reason: 'not_buyer' }, { source_id: 'L3', status: 'skipped', reason: 'erasure_requested' }]);
    expect(await w.ops.post('/integrations/crm/import')).toMatchObject({ imported: 0, skipped: 0 });
  });

  it('TC-P2-WRK-01 daily jobs endpoint runs collections, reconciliation (previous day), accounting and CRM', async () => {
    const r = await h.http.post('/v1/dev/jobs/daily').send({}).expect(201);
    expect(Object.keys(r.body).sort()).toEqual(['accounting', 'collections', 'crm', 'monthEnd', 'reconciliation']);
    expect(r.body.reconciliation.as_of_date).toBe(addDays(h.clock.today(), -1));
  });

  it.skipIf(REAL_LEDGER)('TC-P2-COL-04 in duplum: charges after NPL never exceed the principal at NPL (waived in the ledger, to the cent)', async () => {
    // C: principal 80,000.00 at 3.5%/30d -> 93.33.../day. 900 days after NPL: 951 days of interest = 88,760.00, + 2,500 fee.
    // charges at NPL (51 days): 4,760.00 + 2,500 = 7,260.00 -> since NPL 84,000.00 -> waive 4,000.00
    const at = addDays(DUE_C, 30 + 900);
    const r = await dayRun(at);
    expect(r.waivers).toEqual([{ advanceId: ids.C, waivedCents: '400000' }]);
    const loanId = Number((await h.admin.query(`SELECT fineract_loan_id FROM mapema.advance WHERE id = $1`, [ids.C])).rows[0].fineract_loan_id);
    const l = await h.adapters.ledger.getLoan(loanId, at);
    expect(l.principalOutstandingCents).toBe(8_000_000n);
    expect(l.interestChargedCents - (l.interestWaivedCents ?? 0n) + 250_000n - 726_000n).toBe(8_000_000n); // exactly at the cap
    expect((await dayRun(at)).waivers).toEqual([]); // idempotent
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM mapema.audit_event WHERE action = 'collections.in_duplum_waiver'`)).rows[0].n).toBe(1);
  });

  it('audit chain still verifies after all Phase 2 activity', async () => {
    const v = await w.compliance.get('/audit/verify');
    expect(v.ok).toBe(true);
  });
});

