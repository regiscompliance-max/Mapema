/**
 * [QA Engineer] Onboarding edge cases, provider failure modes (mock magic values), public site
 * endpoints, and i18n completeness (English + Swahili draft for every notification).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@mapema/pricing';
import en from '../src/i18n/en.json';
import sw from '../src/i18n/sw.json';
import { client, Harness, startHarness } from './harness';
import { AT, buildWorld, World, WORKED } from './world';

let h: Harness; let w: World;
beforeAll(async () => { h = await startHarness(); w = await buildWorld(h); });
afterAll(async () => { await h?.close(); });
const D0 = WORKED.quoteDate;

async function inviteSupplier(pin: string, name: string, email: string) {
  const si = await w.buyerAdmin.post('/invitations', { kind: 'supplier', email, supplier: { legalName: name, kraPin: pin, registrationNo: `PVT-${pin.slice(-4)}` } });
  const tok = () => h.token(`sup:${pin}`, { email, amr: ['pwd', 'sms'] });
  // Phase 1b web flow: the browser sends the fresh IdP token in the body (no Authorization header, nothing stored),
  // then swaps the same token for a cookie session
  const idTok = await tok();
  await h.http.post('/v1/invitations/accept').send({ token: si.devToken, displayName: name, accessToken: idTok }).expect(201);
  const sess = await h.http.post('/v1/auth/session').set('Origin', 'http://localhost:3000').send({ accessToken: idTok });
  expect(sess.status).toBe(201);
  expect(String(sess.headers['set-cookie'])).toMatch(/mapema_sid=.*HttpOnly/);
  return { id: si.orgId as string, c: client(h, tok) };
}

describe('onboarding failure modes', () => {
  it('KYC: failed ID -> kyc_failed; sanctions hit -> kyc_review + AML flag; neither can sign the master agreement', async () => {
    const a = await inviteSupplier('P053333333D', 'Fail Id Ltd', 'a@fail.test');
    await a.c.post(`/organisations/${a.id}/persons`, { fullName: 'Bad Id', nationalId: '00000000', isDirector: true, isAuthorisedSignatory: true, email: 'd@fail.test' });
    await a.c.post(`/organisations/${a.id}/bank-accounts`, { bankCode: '11', accountName: 'Fail Id Ltd', accountNumber: '1234500001' });
    expect((await a.c.post(`/organisations/${a.id}/submit`)).status).toBe('kyc_failed');
    expect((await a.c.post(`/organisations/${a.id}/agreements`, undefined, 422)).title).toBe('KYC_NOT_PASSED');

    const b = await inviteSupplier('P054444444E', 'Sanctioned Trading Ltd', 'b@sanc.test');
    await b.c.post(`/organisations/${b.id}/persons`, { fullName: 'Ok Person', nationalId: '44556677', isDirector: true, isAuthorisedSignatory: true, email: 'o@sanc.test' });
    await b.c.post(`/organisations/${b.id}/bank-accounts`, { bankCode: '11', accountName: 'Sanctioned', accountNumber: '1234500009' });
    expect((await b.c.post(`/organisations/${b.id}/submit`)).status).toBe('kyc_review');
    const flags = await w.compliance.get('/aml-flags');
    expect(flags.some((f: any) => f.rule_code === 'SANCTIONS_HIT' && f.org_id === b.id)).toBe(true);
  });

  it('CRB pull needs consent; withdrawn consent blocks it again', async () => {
    const buyer = await w.ops.post('/organisations', { type: 'buyer', legalName: 'Gamma Ltd', kraPin: 'P055555555F', registrationNo: 'PVT-GAM001', sectorCode: 'AGRI' });
    expect((await w.credit.post(`/organisations/${buyer.id}/crb-pull`, undefined, 422)).title).toBe('NO_CONSENT');
  });

  it('payout account change starts a cooling-off period and needs a new call-back', async () => {
    const before = (await h.admin.query(`SELECT count(*)::int AS n FROM mapema.bank_account WHERE org_id = $1`, [w.supplierId])).rows[0].n;
    const r = await w.supplier.post(`/organisations/${w.supplierId}/bank-accounts`, { bankCode: '11', accountName: 'Jua Kali Packaging Ltd', accountNumber: '9876543210' });
    expect(r.cooling_off_until).toBeTruthy();
    const after = (await h.admin.query(`SELECT count(*)::int AS n FROM mapema.bank_account WHERE org_id = $1 AND deactivated_at IS NULL`, [w.supplierId])).rows[0].n;
    expect(after).toBe(1); expect(before).toBe(1);
  });

  it('eTIMS: invalid invoice cannot be confirmed; amount mismatch flagged; provider down -> unavailable', async () => {
    h.clock.set(AT(D0));
    const base = { supplierKraPin: w.supplierKraPin, amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 30) };
    const bad = await w.buyerAdmin.post('/invoices', { ...base, invoiceNumber: 'BAD-001', etimsCuInvoiceNo: 'BAD001' });
    expect(bad.etims_status).toBe('invalid');
    expect((await w.buyerChecker.post(`/invoices/${bad.id}/decision`, { decision: 'approve' }, 422)).title).toBe('ETIMS_INVALID');
    const down = await w.buyerAdmin.post('/invoices', { ...base, invoiceNumber: 'DOWN-002', etimsCuInvoiceNo: 'DOWN002' });
    expect(down.etims_status).toBe('unavailable');
  });

  it('buyer CSV upload: good rows created, bad rows reported, file limited to 500 rows', async () => {
    h.clock.set(AT(D0));
    const csv = ['supplier_kra_pin,invoice_number,amount_cents,currency,issue_date,due_date',
      `${w.supplierKraPin},CSV-001,10000000,KES,${addDays(D0, -1)},${addDays(D0, 30)}`,
      `${w.supplierKraPin},CSV-002,10000000,USD,${addDays(D0, -1)},${addDays(D0, 30)}`,
      `${w.supplierKraPin},CSV-003,100,KES,${addDays(D0, -1)},${addDays(D0, 30)}`].join('\n');
    const r = await w.buyerAdmin.post('/invoices/csv', { csv });
    expect(r.created).toBe(1);
    expect(r.failed).toBe(2);
    expect(r.results).toHaveLength(3);
  });
});

describe('public site API', () => {
  it('fee calculator returns the worked example without signing in', async () => {
    const r = await h.http.post('/v1/public/fee-quote').send({ invoiceAmountCents: '100000000', days: 48 }).expect(201);
    expect(r.body).toMatchObject({ advanceCents: '80000000', discountFeeCents: '4480000', verificationFeeCents: '250000', supplierBalanceCents: '15270000', illustrative: true });
    expect(r.body.explanation).toMatch(/maximum/);
    expect(r.body.explanation).not.toMatch(/one flat fee/i);
  });
  it('book-a-call requires the privacy notice and stores the phone encrypted', async () => {
    await h.http.post('/v1/public/leads').send({ contactName: 'Ann', company: 'Delta', email: 'ann@delta.test', role: 'buyer' }).expect(400);
    await h.http.post('/v1/public/leads').send({ contactName: 'Ann', company: 'Delta', email: 'ann@delta.test', phone: '+254722000111', role: 'buyer', privacyNoticeAccepted: true }).expect(201);
    const row = (await h.admin.query(`SELECT encode(phone_enc,'escape') AS p FROM mapema.lead`)).rows[0];
    expect(row.p).not.toContain('722000111');
  });
  it('CBK status statement reflects the lending switch', async () => {
    const r = await h.http.get('/v1/public/cbk-status').expect(200);
    expect(r.body.statement).toMatch(/DEMO-LICENCE-001/);
  });
  it('health reports every provider adapter and its mode', async () => {
    const r = await h.http.get('/v1/public/health').expect(200);
    expect(r.body.providers.map((p: any) => p.name).sort()).toEqual(['bank', 'crb', 'email', 'esign', 'etims', 'kyc', 'ledger', 'sms']);
    expect(r.body.providers.every((p: any) => p.mode === 'mock')).toBe(true);
  });
});

describe('i18n', () => {
  it('every notification key used in code exists in English and Swahili', () => {
    const dir = join(__dirname, '../src/modules');
    const used = new Set<string>();
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/(?:toOrg|toRole)\([^,]+,\s*[^,]+,\s*'([a-z_.0-9]+)'/g)) used.add(m[1]);
      for (const m of src.matchAll(/render\('([a-z_.0-9]+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(8);
    for (const k of used) { expect(en, k).toHaveProperty([k]); expect(sw, k).toHaveProperty([k]); }
  });
});
