/**
 * [QA Engineer] Builds the worked-example world through the public HTTP API only:
 * pricing (CBK ref) -> float -> lending switch -> buyer onboarding, CRB, programme (CEO) ->
 * programme agreement (e-sign) -> supplier invitation, KYC, master agreement, bank call-back,
 * supplier limit -> invoice -> buyer maker-checker -> ILU e-sign -> eligible.
 */
import { addDays, todayEAT } from '@mapema/pricing';
import { client, Harness } from './harness';

/** Real Fineract rejects future-dated transactions, so the real-ledger run uses past dates. */
export const REAL_LEDGER = process.env.E2E_LEDGER === 'fineract';
const QUOTE_DATE = REAL_LEDGER ? addDays(todayEAT(), -500) : '2027-01-04'; // scenarios span ~480 days
export const WORKED = { invoiceCents: 100_000_000n, days: 48, quoteDate: QUOTE_DATE, dueDate: addDays(QUOTE_DATE, 48), issueDate: addDays(QUOTE_DATE, -2) };
export const LEDGER_ENV: Record<string, string> = REAL_LEDGER
  ? { ADAPTER_MODE_LEDGER: 'sandbox', FINERACT_BASE_URL: process.env.FINERACT_BASE_URL ?? 'http://localhost:8443/fineract-provider/api/v1', FINERACT_TENANT: 'default',
      FINERACT_USERNAME: process.env.FINERACT_USERNAME ?? 'mifos', FINERACT_PASSWORD: process.env.FINERACT_PASSWORD ?? 'password' } // Fineract's documented local demo login
  : { ADAPTER_MODE_LEDGER: 'mock' };
export const AT = (date: string) => `${date}T07:00:00.000Z`; // 10:00 EAT

export interface World {
  ceo: ReturnType<typeof client>; credit: ReturnType<typeof client>; credit2: ReturnType<typeof client>; ops: ReturnType<typeof client>; ops2: ReturnType<typeof client>;
  admin: ReturnType<typeof client>; compliance: ReturnType<typeof client>; auditor: ReturnType<typeof client>;
  buyerAdmin: ReturnType<typeof client>; buyerChecker: ReturnType<typeof client>; supplier: ReturnType<typeof client>;
  buyerId: string; supplierId: string; virtualAccount: string; supplierKraPin: string;
  approve: (approvalId: string, who?: ReturnType<typeof client>) => Promise<any>;
}

export async function buildWorld(h: Harness, o: { floatCents?: bigint; supplierLimitCents?: bigint; supplierAccount?: string; tag?: string } = {}): Promise<World> {
  const tag = o.tag ?? 'a';
  h.clock.set(AT(WORKED.quoteDate));
  const s = (n: string) => client(h, h.staff[n].token);
  const w: Partial<World> = { ceo: s('ceo'), credit: s('credit'), credit2: s('credit2'), ops: s('ops'), ops2: s('ops2'), admin: s('admin'), compliance: s('compliance'), auditor: s('auditor') };
  w.approve = (id: string, who = w.ceo!) => who.post(`/approvals/${id}/approve`, { reason: 'checked' });

  // --- platform set-up (ADM-02/03/05): pricing with CBK reference, float, lending switch
  const pv = await w.admin!.post('/admin/pricing-versions', { code: `STD-TEST-${tag}`, advanceRateBps: 8000, discountRateBpsPer30d: 350, verificationFeeCents: 250000, minDays: 1, maxDays: 120 });
  const pa = await w.admin!.post(`/admin/pricing-versions/${pv.id}/activate`, { cbkApprovalRef: 'CBK/DEMO/0001', customerNoticeSentAt: '2026-10-01T00:00:00Z', effectiveFrom: '2026-11-01' });
  await w.approve(pa.id);
  const fl = await w.admin!.post('/admin/float', { amountCents: String(o.floatCents ?? 1_000_000_000n), basisNote: 'Equity KES 10m' });
  await w.approve(fl.id);
  const le = await w.admin!.post('/admin/lending/enable', { cbkLicenceNo: 'DEMO-LICENCE-001' });
  await w.approve(le.id);

  // --- buyer onboarding (OPS-01, BUY-01..03, CRD-01..03)
  const buyer = await w.ops!.post('/organisations', { type: 'buyer', legalName: 'Acme Supermarkets Ltd', kraPin: 'P051234567A', registrationNo: 'PVT-ACME01', sectorCode: 'FMCG' });
  w.buyerId = buyer.id;
  const bi = await w.ops!.post('/invitations', { kind: 'buyer_admin', orgId: buyer.id, email: 'ap@acme.test' });
  const baTok = () => h.token('buyer:admin', { email: 'ap@acme.test' });
  await h.http.post('/v1/invitations/accept').set('Authorization', `Bearer ${await baTok()}`).send({ token: bi.devToken, displayName: 'Achieng AP' }).expect(201);
  w.buyerAdmin = client(h, baTok);
  await w.buyerAdmin.post(`/organisations/${buyer.id}/persons`, { fullName: 'Jane Wanjiru', nationalId: '22334455', isDirector: true, isAuthorisedSignatory: true, email: 'jane@acme.test' });
  await w.buyerAdmin.post(`/organisations/${buyer.id}/bank-accounts`, { bankCode: '01', accountName: 'Acme Supermarkets Ltd', accountNumber: '1100223344' });
  await w.buyerAdmin.post('/consents', { orgId: buyer.id, purpose: 'crb_enquiry_and_reporting', textVersion: 'CRB-2026-11' });
  await w.buyerAdmin.post(`/organisations/${buyer.id}/submit`);
  await w.credit!.post(`/organisations/${buyer.id}/crb-pull`);
  const prog = await w.credit!.post(`/organisations/${buyer.id}/programme`, { limitCents: '500000000', advanceRateBps: 8000, startDate: WORKED.issueDate, reviewDate: addDays(WORKED.quoteDate, 600), decisionReason: 'Strong CRB, 10y trading' });
  await w.approve(prog.approval.id);
  const pe = await w.buyerAdmin.post(`/organisations/${buyer.id}/agreements`);
  await h.http.post(`/v1/dev/esign/${pe.envelopeId}/complete`).expect(201);
  await h.http.post('/v1/dev/jobs/run').expect(201); // opens the virtual collection account
  w.virtualAccount = (await h.admin.query(`SELECT virtual_account_no FROM mapema.collection_account WHERE buyer_id = $1`, [buyer.id])).rows[0].virtual_account_no;

  const ci = await w.buyerAdmin.post('/invitations', { kind: 'buyer_user', orgId: buyer.id, email: 'checker@acme.test', role: 'buyer_checker' });
  const bcTok = () => h.token('buyer:checker', { email: 'checker@acme.test' });
  await h.http.post('/v1/invitations/accept').set('Authorization', `Bearer ${await bcTok()}`).send({ token: ci.devToken, displayName: 'Otieno Checker' }).expect(201);
  w.buyerChecker = client(h, bcTok);

  // --- supplier onboarding (SUP-01..05, OPS bank call-back, CRD supplier limit)
  w.supplierKraPin = 'P051111111B';
  const si = await w.buyerAdmin.post('/invitations', { kind: 'supplier', email: 'finance@juakali.test', supplier: { legalName: 'Jua Kali Packaging Ltd', kraPin: w.supplierKraPin, registrationNo: 'PVT-JUA001' } });
  w.supplierId = si.orgId;
  const supTok = () => h.token('supplier:admin', { email: 'finance@juakali.test', amr: ['pwd', 'sms'] }); // suppliers may use SMS OTP (D-12)
  await h.http.post('/v1/invitations/accept').set('Authorization', `Bearer ${await supTok()}`).send({ token: si.devToken, displayName: 'Wanjiku Finance', phone: '+254712345678' }).expect(201);
  w.supplier = client(h, supTok);
  await w.supplier.post(`/organisations/${w.supplierId}/persons`, { fullName: 'Peter Kamau', nationalId: '33445566', isDirector: true, isAuthorisedSignatory: true, email: 'peter@juakali.test' });
  const acct = await w.supplier.post(`/organisations/${w.supplierId}/bank-accounts`, { bankCode: '11', accountName: 'Jua Kali Packaging Ltd', accountNumber: o.supplierAccount ?? '0123456789' });
  const sub = await w.supplier.post(`/organisations/${w.supplierId}/submit`);
  if (sub.status !== 'kyc_passed') throw new Error(`supplier KYC ${sub.status}`);
  const se = await w.supplier.post(`/organisations/${w.supplierId}/agreements`);
  await h.http.post(`/v1/dev/esign/${se.envelopeId}/complete`).expect(201);
  const bv = await w.ops!.post(`/bank-accounts/${acct.id}/verify`, { callBackNote: 'Called director on CR12 number, confirmed account' });
  await w.approve(bv.id, w.ops2);
  const link = (await h.admin.query(`SELECT id FROM mapema.supplier_link WHERE supplier_id = $1`, [w.supplierId])).rows[0];
  const sl = await w.credit!.post(`/supplier-links/${link.id}/limit`, { limitCents: String(o.supplierLimitCents ?? 100_000_000n), reason: 'Two years of invoices with Acme' });
  await w.approve(sl.id, w.credit2);
  return w as World;
}

/** BUY-04/05 + ILU: an eligible invoice. */
export async function eligibleInvoice(h: Harness, w: World, inv: { number: string; amountCents: bigint; issueDate?: string; dueDate: string }) {
  const i = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: inv.number, amountCents: String(inv.amountCents), currency: 'KES',
    issueDate: inv.issueDate ?? WORKED.issueDate, dueDate: inv.dueDate, etimsCuInvoiceNo: `KRACU${inv.number.replace(/\W/g, '')}` });
  await w.buyerChecker.post(`/invoices/${i.id}/decision`, { decision: 'approve' });
  const conf = await w.buyerChecker.post('/confirmations', { invoiceIds: [i.id] });
  await h.http.post(`/v1/dev/esign/${conf.envelopeId}/complete`).expect(201);
  return i.id as string;
}

/** SUP-07 quote+accept, CRD approve, OPS release (two different staff). */
export async function fund(h: Harness, w: World, invoiceId: string) {
  const q = await w.supplier.post(`/invoices/${invoiceId}/quote`);
  const acc = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': `accept-${invoiceId}` });
  const advanceId = acc.advances[0].advanceId as string;
  await w.credit.post(`/advances/${advanceId}/decision`, { decision: 'approve', reason: 'All checks green' });
  const rel = await w.ops.post(`/advances/${advanceId}/release`, undefined, undefined, { 'Idempotency-Key': `release-${advanceId}` });
  return { quote: q, advanceId, release: rel };
}

export async function seedFunding(h: Harness, w: World, cents: bigint, ref = 'EQ-0001') {
  await h.http.post('/v1/dev/bank/fund').send({ amountCents: String(cents) }).expect(201);
  await w.ceo.post('/funding', { amountCents: String(cents), source: 'Founder equity', reference: ref, valueDate: WORKED.quoteDate });
}
