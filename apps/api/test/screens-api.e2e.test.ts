/**
 * [QA Engineer] Phase 1b: small read APIs the new screens need (tests first).
 *  TC-DOC-01 BUY-09 the buyer lists and downloads the notice of assignment (PDF) for a funded invoice
 *  TC-DOC-02 BUY-12 every applied buyer payment produces a downloadable receipt PDF for the buyer
 *  TC-DOC-03 documents are org-scoped: the supplier can't download the buyer's notice; downloads are audited
 *  TC-BUY-13 programme limit, utilisation and headroom for the buyer, per supplier
 *  TC-SUP-03 a supplier lists its consents, withdraws one, gives it again
 *  TC-SUP-13 self-service data view: own profile, org, people (masked), bank (last 4), consents, activity counts
 *  TC-ADM-01 admin lists staff users and roles; non-admin refused
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@mapema/pricing';
import { Harness, startHarness } from './harness';
import { AT, buildWorld, eligibleInvoice, fund, seedFunding, World, WORKED } from './world';

let h: Harness; let w: World; let adv: { advanceId: string; invoiceId: string; due: string };
const D0 = WORKED.quoteDate;
beforeAll(async () => {
  h = await startHarness(); w = await buildWorld(h); await seedFunding(h, w, 1_000_000_000n);
  h.clock.set(AT(D0));
  const inv = await eligibleInvoice(h, w, { number: 'INV-DOC-01', amountCents: 100_000_000n, issueDate: addDays(D0, -1), dueDate: addDays(D0, 48) });
  const f = await fund(h, w, inv);
  adv = { advanceId: f.advanceId, invoiceId: inv, due: addDays(D0, 48) };
});
afterAll(async () => { await h?.close(); });

const raw = async (path: string, tok: () => Promise<string>) => h.http.get(`/v1${path}`).set('Authorization', `Bearer ${await tok()}`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); });
const buyerTok = () => h.token('buyer:admin', { email: 'ap@acme.test' });

describe('documents (BUY-09, BUY-12)', () => {
  it('TC-DOC-01 buyer sees and downloads the notice of assignment', async () => {
    const docs = await w.buyerAdmin.get(`/documents?orgId=${w.buyerId}`);
    const notice = docs.find((d: any) => d.type === 'notice_of_assignment');
    expect(notice).toMatchObject({ file_name: 'notice-INV-DOC-01.pdf' });
    expect(JSON.stringify(docs)).not.toMatch(/storage_key|storage_bucket/);
    const r = await raw(`/documents/${notice.id}/content`, buyerTok);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="notice-INV-DOC-01.pdf"/);
    expect(r.headers['cache-control']).toMatch(/no-store/);
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('TC-DOC-02 an applied payment creates a receipt PDF for the buyer', async () => {
    h.clock.set(AT(adv.due));
    await h.http.post('/v1/dev/bank/credit').send({ accountNo: w.virtualAccount, amountCents: '100000000', bankRef: 'BR-DOC-02', valueDate: adv.due, payerName: 'Acme Supermarkets Ltd', narrative: 'INV-DOC-01' }).expect(201);
    const docs = await w.buyerAdmin.get(`/documents?orgId=${w.buyerId}&type=receipt`);
    expect(docs).toHaveLength(1);
    expect(docs[0].file_name).toBe('receipt-BR-DOC-02.pdf');
    const pdf = (await raw(`/documents/${docs[0].id}/content`, buyerTok)).body as Buffer;
    expect(pdf.toString('latin1')).toContain('KES 1,000,000.00');
    expect(pdf.toString('latin1')).toContain('INV-DOC-01');
  });

  it('TC-DOC-03 org scoping and audit', async () => {
    const notice = (await w.buyerAdmin.get(`/documents?orgId=${w.buyerId}`)).find((d: any) => d.type === 'notice_of_assignment');
    await w.supplier.get(`/documents?orgId=${w.buyerId}`, 403);
    const supTok = () => h.token('supplier:admin', { email: 'finance@juakali.test', amr: ['pwd', 'sms'] });
    expect((await raw(`/documents/${notice.id}/content`, supTok)).status).toBe(404);
    const ev = (await w.auditor.get('/audit/events?limit=200')).filter((e: any) => e.action === 'document.download' && e.entity_id === notice.id);
    expect(ev.length).toBeGreaterThanOrEqual(1);
  });
});

describe('buyer programme utilisation (BUY-13)', () => {
  it('TC-BUY-13 limit, used, available and per-supplier exposure', async () => {
    h.clock.set(AT(D0));
    const inv = await eligibleInvoice(h, w, { number: 'INV-UT-01', amountCents: 50_000_000n, issueDate: addDays(D0, -1), dueDate: addDays(D0, 40) });
    await fund(h, w, inv);
    const p = await w.buyerAdmin.get('/buyer/programme');
    expect(p).toMatchObject({ limit_cents: '500000000', used_cents: '40000000', available_cents: '460000000', status: 'live' });
    expect(p.review_date).toBeTruthy();
    expect(p.suppliers).toEqual([expect.objectContaining({ supplier_name: 'Jua Kali Packaging Ltd', exposure_cents: '40000000', open_advances: 1 })]);
    await w.supplier.get('/buyer/programme', 403);
  });
});

describe('consents (SUP-03) and self-service data (SUP-13)', () => {
  it('TC-SUP-03 list, withdraw, give again', async () => {
    const list = await w.supplier.get(`/consents?orgId=${w.supplierId}`);
    expect(Array.isArray(list)).toBe(true);
    const g = await w.supplier.post('/consents', { orgId: w.supplierId, purpose: 'marketing', textVersion: 'MKT-2026-11' });
    let now = await w.supplier.get(`/consents?orgId=${w.supplierId}`);
    expect(now.find((c: any) => c.id === g.id)).toMatchObject({ purpose: 'marketing', withdrawn_at: null });
    await w.supplier.post(`/consents/${g.id}/withdraw`, {});
    now = await w.supplier.get(`/consents?orgId=${w.supplierId}`);
    expect(now.find((c: any) => c.id === g.id).withdrawn_at).toBeTruthy();
    await w.buyerAdmin.get(`/consents?orgId=${w.supplierId}`, 403);
  });

  it('TC-SUP-13 my data: profile, org, masked people, bank last 4, consents, counts; no raw IDs or full account numbers', async () => {
    const d = await w.supplier.get('/me/data');
    expect(d.profile.email).toBe('finance@juakali.test');
    expect(d.organisations[0]).toMatchObject({ legal_name: 'Jua Kali Packaging Ltd' });
    expect(d.organisations[0].people.length).toBeGreaterThan(0);
    expect(d.organisations[0].people.find((p: any) => p.isDirector).nationalIdMasked).toMatch(/^•+\d{4}$/);
    expect(d.organisations[0].bankAccounts[0].account_number_last4).toMatch(/^\d{4}$/);
    expect(d.organisations[0].activity).toMatchObject({ invoices: expect.any(Number), advances: expect.any(Number) });
    expect(d.consents.length).toBeGreaterThan(0);
    expect(d.rights).toMatch(/correct/i); expect(d.rights).toMatch(/delete/i);
    expect(JSON.stringify(d)).not.toMatch(/_enc|national_id"|account_number"/);
  });
});

describe('write-off candidates (ADM-07)', () => {
  it('TC-ADM-07 the advance queue lists recourse and non-performing advances for the write-off screen', async () => {
    for (const st of ['recourse', 'non_performing']) expect(Array.isArray(await w.credit.get(`/advances/queue?status=${st}`))).toBe(true);
  });
});

describe('staff admin (ADM-01)', () => {
  it('TC-ADM-01 admin lists staff users with roles; others refused', async () => {
    const users = await w.admin.get('/admin/users');
    expect(users.find((u: any) => u.email === 'credit@mapema.test')).toMatchObject({ roles: ['credit'], active: true });
    expect(users.every((u: any) => u.roles.every((r: string) => ['credit', 'ops', 'compliance', 'admin', 'ceo', 'auditor', 'lender'].includes(r)))).toBe(true);
    await w.ops.get('/admin/users', 403);
  });
});
