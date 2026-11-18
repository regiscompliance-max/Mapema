/**
 * [QA Engineer] Phase 4 security (P4-1..P4-8), written from docs/phase-4-security/stories.md before the code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@mapema/pricing';
import { Harness, startHarness } from './harness';
import { AT, buildWorld, eligibleInvoice, fund, recordRegistrySearch, samplePdfB64, seedFunding, World, WORKED } from './world';

let h: Harness; let w: World;
beforeAll(async () => {
  h = await startHarness();
  w = await buildWorld(h, { supplierLimitCents: 200_000_000n, tag: 'p4' });
  await seedFunding(h, w, 1_000_000_000n);
});
afterAll(async () => { await h?.close(); });
const D0 = WORKED.quoteDate;
function uniqueAmount(n: string) {
  let h = 0;
  for (const c of n) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return 10_000_000n + BigInt(h % 4_000_000);
}
const ev = (number: string) => eligibleInvoice(h, w, { number, amountCents: uniqueAmount(number), dueDate: addDays(D0, 40) });

describe('P4-1 registry search before funding and filing after (D-73)', () => {
  it('TC-P4-REG-01 funding is blocked when no approved registry search is on file', async () => {
    h.clock.set(AT(D0));
    const inv = await ev('INV-P4-NS-1');
    const q = await w.supplier.post(`/invoices/${inv}/quote`);
    const acc = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': 'accept-p4-ns-1' });
    const r = await w.credit.post(`/advances/${acc.advances[0].advanceId}/decision`, { decision: 'approve', reason: 'x' }, 422);
    expect(r.title).toBe('CHECKS_FAILED');
    expect(r.failedChecks.map((c: any) => c.code)).toEqual(['REGISTRY_SEARCH']);
    expect(r.failedChecks[0].detail).toMatch(/no approved registry search/i);
  });

  it('TC-P4-REG-02 a clear search, approved by a second credit officer, lets funding proceed and stores the evidence', async () => {
    h.clock.set(AT(D0));
    const inv = await ev('INV-P4-OK-1');
    const { release } = await fund(h, w, inv);
    expect(release.status).toBe('funded');
    const searches = await w.credit.get(`/invoices/${inv}/registry-searches`);
    expect(searches[0]).toMatchObject({ result: 'clear', status: 'approved' });
    expect(searches[0].evidence_document_id).toBeTruthy();
  });

  it('TC-P4-REG-03 the person who recorded the search cannot approve it', async () => {
    h.clock.set(AT(D0));
    const inv = await ev('INV-P4-4E-1');
    const r = await w.credit.post(`/invoices/${inv}/registry-search`, {
      result: 'clear', notes: 'portal clear', searchedOn: D0, fileName: 'search.pdf', mimeType: 'application/pdf', contentBase64: samplePdfB64(),
    });
    expect((await w.credit.post(`/approvals/${r.approval.id}/approve`, { reason: 'self' }, 403)).title).toBe('FOUR_EYES');
  });

  it('TC-P4-REG-04 an unwaived conflict blocks funding', async () => {
    h.clock.set(AT(D0));
    const inv = await ev('INV-P4-CF-1');
    const r = await w.credit.post(`/invoices/${inv}/registry-search`, {
      result: 'conflict', notes: 'prior filing visible on the portal', searchedOn: D0, fileName: 'search.pdf', mimeType: 'application/pdf', contentBase64: samplePdfB64(),
    });
    await w.approve(r.approval.id, w.credit2);
    const q = await w.supplier.post(`/invoices/${inv}/quote`);
    const acc = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': 'accept-p4-cf-1' });
    const d = await w.credit.post(`/advances/${acc.advances[0].advanceId}/decision`, { decision: 'approve', reason: 'x' }, 422);
    expect(d.failedChecks.map((c: any) => c.code)).toEqual(['REGISTRY_SEARCH']);
    expect(d.failedChecks[0].detail).toMatch(/not been waived/i);
  });

  it('TC-P4-REG-05 a waived conflict with a note allows funding', async () => {
    h.clock.set(AT(D0));
    const inv = await ev('INV-P4-WV-1');
    await recordRegistrySearch(w, inv, 'conflict_waived', 'Prior filing is Mapema’s own notice on a refinanced invoice');
    const { release } = await fund(h, w, inv);
    expect(release.status).toBe('funded');
  });

  it('TC-P4-REG-06 after funding an ops filing task opens; approved filing stores the registration number and closes the task', async () => {
    h.clock.set(AT(D0));
    const inv = await ev('INV-P4-FL-1');
    const { advanceId } = await fund(h, w, inv);
    const tasks = await w.ops.get('/ops/tasks?kind=registry_filing_due&status=open');
    expect(tasks.some((t: any) => t.advance_id === advanceId)).toBe(true);
    const f = await w.ops.post(`/advances/${advanceId}/registry-filing`, {
      registrationNo: 'MPSRA-2027-00041', notes: 'Filed at the Nairobi registry office', filedOn: D0,
      fileName: 'filing.pdf', mimeType: 'application/pdf', contentBase64: samplePdfB64(),
    });
    expect((await w.ops.post(`/approvals/${f.approval.id}/approve`, { reason: 'self' }, 403)).title).toBe('FOUR_EYES');
    await w.approve(f.approval.id, w.ops2);
    const got = await w.ops.get(`/advances/${advanceId}`);
    expect(got.registry_registration_no).toBe('MPSRA-2027-00041');
    expect(got.registryFiling.status).toBe('approved');
    const open = await w.ops.get('/ops/tasks?kind=registry_filing_due&status=open');
    expect(open.some((t: any) => t.advance_id === advanceId)).toBe(false);
  });
});

describe('P4-2 notifications, unique eTIMS CU, similar-invoice flag (D-74)', () => {
  it('TC-P4-DUP-01 buyer and supplier are notified when an invoice is submitted', async () => {
    h.clock.set(AT(D0));
    const inv = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-P4-NT-1', amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 40), etimsCuInvoiceNo: 'KRACUP4NT1' });
    const n = await h.admin.query(
      `SELECT count(*)::int AS n FROM mapema.notification WHERE template_key = 'invoice.submitted' AND entity_id = $1`, [inv.id]);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(2); // at least one user at each org
  });

  it('TC-P4-DUP-02 a second invoice with the same eTIMS control-unit number is refused', async () => {
    h.clock.set(AT(D0));
    await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-P4-CU-1', amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 40), etimsCuInvoiceNo: 'KRACUP4SAME' });
    const r = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-P4-CU-2', amountCents: '11000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 41), etimsCuInvoiceNo: 'kracuP4same' }, 409);
    expect(r.title).toBe('DUPLICATE_ETIMS_CU');
  });

  it('TC-P4-DUP-03 same supplier PIN + amount + date with a different number is flagged for review, not blocked', async () => {
    h.clock.set(AT(D0));
    const a = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-P4-SM-1', amountCents: '15500000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 40), etimsCuInvoiceNo: 'KRACUP4SM1' });
    expect(a.similar_review).toBe(false);
    const b = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-P4-SM-2', amountCents: '15500000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 40), etimsCuInvoiceNo: 'KRACUP4SM2' });
    expect(b.similar_review).toBe(true);
    const got = await w.buyerAdmin.get(`/invoices/${b.id}`);
    expect(got.similarInvoices.map((s: any) => s.invoice_number)).toContain('INV-P4-SM-1');
  });
});

describe('P4-5 goods-received attestation (D-77)', () => {
  it('TC-P4-ATT-01 confirmation without the attestation is refused', async () => {
    h.clock.set(AT(D0));
    const inv = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-P4-AT-1', amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 40), etimsCuInvoiceNo: 'KRACUP4AT1' });
    const r = await w.buyerChecker.post(`/invoices/${inv.id}/decision`, { decision: 'approve' }, 422);
    expect(r.title).toBe('ATTESTATION_REQUIRED');
  });

  it('TC-P4-ATT-02 confirming with goodsReceived true (optional PO/GRN) works', async () => {
    h.clock.set(AT(D0));
    const inv = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-P4-AT-2', amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 40), etimsCuInvoiceNo: 'KRACUP4AT2', poReference: 'PO-9' });
    const r = await w.buyerChecker.post(`/invoices/${inv.id}/decision`, { decision: 'approve', goodsReceived: true, poReference: 'GRN-44' });
    expect(r.status).toBe('confirmed');
    const got = await w.buyerChecker.get(`/invoices/${inv.id}`);
    expect(got.goods_received).toBe(true);
    expect(got.po_reference).toBe('GRN-44');
  });

  it('TC-P4-ATT-03 confirming without receipt requires a reason', async () => {
    h.clock.set(AT(D0));
    const inv = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-P4-AT-3', amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 40), etimsCuInvoiceNo: 'KRACUP4AT3' });
    expect((await w.buyerChecker.post(`/invoices/${inv.id}/decision`, { decision: 'approve', goodsReceived: false }, 422)).title).toBe('GOODS_RECEIVED_NOTE_REQUIRED');
    const r = await w.buyerChecker.post(`/invoices/${inv.id}/decision`, { decision: 'approve', goodsReceived: false, goodsReceivedNote: 'Contractual milestone 2 of 3' });
    expect(r.status).toBe('confirmed');
  });
});

describe('P4-6 eTIMS unavailable cannot proceed to funding (D-78)', () => {
  it('TC-P4-ETIMS-01 an unavailable invoice can be confirmed but is not eligible and cannot be funded', async () => {
    h.clock.set(AT(D0));
    const inv = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'DOWN-P4-1', amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 40), etimsCuInvoiceNo: 'KRACUP4DN1' });
    expect(inv.etims_status).toBe('unavailable');
    await w.buyerChecker.post(`/invoices/${inv.id}/decision`, { decision: 'approve', goodsReceived: true });
    const conf = await w.buyerChecker.post('/confirmations', { invoiceIds: [inv.id] });
    await h.http.post(`/v1/dev/esign/${conf.envelopeId}/complete`).expect(201);
    const got = await w.supplier.get(`/invoices/${inv.id}`);
    expect(got.status).toBe('ilu_signed');
    expect(got.etimsBlocksFunding).toBe(true);
    expect((await w.supplier.post(`/invoices/${inv.id}/quote`, undefined, 409)).title).toBe('NOT_ELIGIBLE');
  });

  it('TC-P4-ETIMS-02 a maker-checker override makes the invoice eligible; funding then needs a registry search as usual', async () => {
    h.clock.set(AT(D0));
    const inv = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'DOWN-P4-2', amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 40), etimsCuInvoiceNo: 'KRACUP4DN2' });
    await w.buyerChecker.post(`/invoices/${inv.id}/decision`, { decision: 'approve', goodsReceived: true });
    const conf = await w.buyerChecker.post('/confirmations', { invoiceIds: [inv.id] });
    await h.http.post(`/v1/dev/esign/${conf.envelopeId}/complete`).expect(201);
    const ov = await w.credit.post(`/invoices/${inv.id}/etims-override`, { reason: 'KRA portal outage confirmed; invoice cross-checked against the buyer ERP' });
    expect((await w.credit.post(`/approvals/${ov.approval.id}/approve`, { reason: 'self' }, 403)).title).toBe('FOUR_EYES');
    await w.approve(ov.approval.id, w.credit2);
    const got = await w.supplier.get(`/invoices/${inv.id}`);
    expect(got.status).toBe('eligible');
    expect(got.etims_status).toBe('overridden');
    const { release } = await fund(h, w, inv.id);
    expect(release.status).toBe('funded');
  });
});

describe('P4-8 government-payer flag; no CRB change (D-80)', () => {
  it('TC-P4-GOV-01 a programme proposal without the government-payer flag is refused', async () => {
    const r = await w.credit.post(`/organisations/${w.buyerId}/programme`, { limitCents: '100000000', advanceRateBps: 8000, startDate: WORKED.issueDate, reviewDate: addDays(D0, 700), decisionReason: 'retry' }, 400);
    expect(String(r.detail ?? r.title)).toMatch(/governmentPayerDependent/i);
  });

  it('TC-P4-GOV-02 construction or a true flag requires a comment; the flag is on the credit file', async () => {
    const r = await w.credit.post(`/organisations/${w.buyerId}/government-payer`, { dependent: true }, 422);
    expect(r.title).toBe('GOVERNMENT_PAYER_NOTE_REQUIRED');
    await w.credit.post(`/organisations/${w.buyerId}/government-payer`, { dependent: true, note: 'Ministry of Health is a material payer of this buyer.' });
    const file = await w.credit.get(`/organisations/${w.buyerId}/credit-file`);
    expect(file.governmentPayerDependent).toBe(true);
    expect(file.governmentPayerNote).toMatch(/Ministry of Health/);
    expect(file.sectorCode).toBe('FMCG');
  });

  it('TC-P4-GOV-03 the CRB file still reports the supplier as borrower and does not add the buyer (D-38, D-45, D-80)', () => {
    const code = readFileSync(join(__dirname, '../src/modules/regulatory.ts'), 'utf8');
    expect(code).toMatch(/borrower: l\.supplierName/);
    expect(code).toMatch(/l\.supplierKraPin/);
    expect(code).not.toMatch(/borrower: l\.buyerName/);
    expect(code).not.toMatch(/buyer as borrower/i);
  });
});
