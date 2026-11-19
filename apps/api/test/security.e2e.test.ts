/**
 * [Security Engineer + QA Engineer] Security & control tests (Phase 0 security checklist / threat model):
 * authentication + MFA, step-up, RBAC, org scoping (IDOR), maker-checker / four-eyes, lending
 * switch, limits enforced at approval AND release (with concurrency), idempotency, KES-only,
 * duplicates, append-only audit at the DB-privilege level, PII encrypted at rest, prod guards.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@mapema/pricing';
import { createAdapters } from '@mapema/adapters';
import { loadConfig } from '../src/common/config';
import { client, Harness, startHarness } from './harness';
import { AT, buildWorld, eligibleInvoice, recordRegistrySearch, seedFunding, World, WORKED } from './world';

let h: Harness; let w: World;
beforeAll(async () => { h = await startHarness(); w = await buildWorld(h, { supplierLimitCents: 200_000_000n }); await seedFunding(h, w, 1_000_000_000n); });
afterAll(async () => { await h?.close(); });
const D0 = WORKED.quoteDate;
const raw = async (path: string, token?: string, method: 'get' | 'post' = 'get', body?: unknown) => {
  let r = h.http[method](`/v1${path}`);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body as object) : r;
};

describe('authentication & MFA', () => {
  it('rejects missing, forged and single-factor tokens', async () => {
    expect((await raw('/me')).status).toBe(401);
    expect((await raw('/me', 'not.a.jwt')).status).toBe(401);
    const pwdOnly = await h.token(h.staff.ops.sub, { amr: ['pwd'] });
    const r = await raw('/me', pwdOnly);
    expect(r.status).toBe(401); expect(r.body.title).toBe('MFA_REQUIRED');
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
  });
  it('staff and buyers need a strong factor; SMS OTP is accepted only for supplier users (D-12)', async () => {
    const r = await raw('/me', await h.token(h.staff.ops.sub, { amr: ['pwd', 'sms'] }));
    expect(r.body.title).toBe('STRONG_MFA_REQUIRED');
    const b = await raw('/me', await h.token('buyer:admin', { email: 'ap@acme.test', amr: ['pwd', 'sms'] }));
    expect(b.body.title).toBe('STRONG_MFA_REQUIRED');
    expect((await raw('/me', await h.token('supplier:admin', { email: 'finance@juakali.test', amr: ['pwd', 'sms'] }))).status).toBe(200);
  });
  it('money-moving and approval actions need a fresh sign-in (step-up, 300 s)', async () => {
    const old = await h.token(h.staff.ceo.sub, { authAgeSec: 900 });
    const fl = await w.admin.post('/admin/float', { amountCents: '1000000000', basisNote: 'no change' });
    const r = await raw(`/approvals/${fl.id}/approve`, old, 'post', {});
    expect(r.status).toBe(401); expect(r.body.title).toBe('STEP_UP_REQUIRED');
    await w.approve(fl.id); // fresh token works
  });
  it('time-boxed auditor access expires', async () => {
    await h.admin.query(`UPDATE mapema.user_account SET access_expires_at = now() - interval '1 minute' WHERE id = $1`, [h.staff.auditor.id]);
    const r = await raw('/reports/portfolio', await h.staff.auditor.token());
    expect(r.body.title).toBe('ACCESS_EXPIRED');
    await h.admin.query(`UPDATE mapema.user_account SET access_expires_at = now() + interval '1 day' WHERE id = $1`, [h.staff.auditor.id]);
  });
});

describe('authorisation (RBAC + org scoping)', () => {
  it('auditor is read-only; supplier cannot use staff endpoints', async () => {
    await w.auditor.get('/reports/portfolio');
    await w.auditor.post('/admin/float', { amountCents: '1', basisNote: 'x' }, 403);
    await w.supplier.get('/advances/queue', 403);
    await w.supplier.post('/admin/lending/disable', { reason: 'x' }, 403);
    await w.buyerAdmin.post('/funding', { amountCents: '1', source: 'x', reference: 'xx1', valueDate: D0 }, 403);
  });
  it('a second supplier cannot see or quote the first supplier\'s invoice (IDOR)', async () => {
    h.clock.set(AT(D0));
    const inv = await eligibleInvoice(h, w, { number: 'INV-IDOR-1', amountCents: 10_000_000n, dueDate: addDays(D0, 30) });
    const si = await w.buyerAdmin.post('/invitations', { kind: 'supplier', email: 'boss@other.test', supplier: { legalName: 'Other Supplies Ltd', kraPin: 'P059999999Z', registrationNo: 'PVT-OTH001' } });
    const tok = () => h.token('supplier:other', { email: 'boss@other.test', amr: ['pwd', 'sms'] });
    await h.http.post('/v1/invitations/accept').set('Authorization', `Bearer ${await tok()}`).send({ token: si.devToken, displayName: 'Other Boss' }).expect(201);
    const other = client(h, tok);
    await other.get(`/invoices/${inv}`, [403, 404]);
    await other.post(`/invoices/${inv}/quote`, undefined, [403, 404]);
    await other.get(`/organisations/${w.supplierId}`, [403, 404]);
    const list = await other.get('/invoices');
    expect(list.map((x: any) => x.id)).not.toContain(inv);
  });
  it('invitation tokens are single-use and email-bound', async () => {
    const i = await w.ops.post('/invitations', { kind: 'auditor', email: 'ext@audit.test', accessExpiresAt: new Date(Date.now() + 864e5).toISOString() });
    await w.approve(i.approvalId); // staff/auditor role grants are maker-checker (ADM-01)
    const wrong = await h.token('x:wrong', { email: 'someone@else.test' });
    expect((await h.http.post('/v1/invitations/accept').set('Authorization', `Bearer ${wrong}`).send({ token: i.devToken, displayName: 'X' })).status).toBe(403);
    const ok = await h.token('x:audit', { email: 'ext@audit.test' });
    await h.http.post('/v1/invitations/accept').set('Authorization', `Bearer ${ok}`).send({ token: i.devToken, displayName: 'Ext Auditor' }).expect(201);
    expect((await h.http.post('/v1/invitations/accept').set('Authorization', `Bearer ${ok}`).send({ token: i.devToken, displayName: 'Again' })).status).toBe(410);
    await w.ops.post('/invitations', { kind: 'auditor', email: 'noexpiry@audit.test' }, 400); // auditors must be time-boxed
  });
});

describe('maker-checker / four-eyes', () => {
  it('staff and auditor role grants need a second person before the invitation works (ADM-01)', async () => {
    const i = await w.admin.post('/invitations', { kind: 'staff', role: 'credit', email: 'new.credit@mapema.test' });
    expect(i.approvalId).toBeTruthy();
    const tok = await h.token('x:newcredit', { email: 'new.credit@mapema.test' });
    const early = await h.http.post('/v1/invitations/accept').set('Authorization', `Bearer ${tok}`).send({ token: i.devToken, displayName: 'New Credit' });
    expect(early.status).toBe(403);
    expect(early.body.title).toBe('INVITATION_NOT_APPROVED');
    expect((await w.admin.post(`/approvals/${i.approvalId}/approve`, {}, 403)).title).toBe('FOUR_EYES');
    await w.approve(i.approvalId); // CEO
    await h.http.post('/v1/invitations/accept').set('Authorization', `Bearer ${tok}`).send({ token: i.devToken, displayName: 'New Credit' }).expect(201);
    const me = await client(h, () => Promise.resolve(tok)).get('/me');
    expect(me.roles.map((r: any) => r.role)).toEqual(['credit']);
  });

  it('nobody approves their own request (service + DB constraint)', async () => {
    const pa = await w.ops.post('/organisations', { type: 'buyer', legalName: 'Beta Ltd', kraPin: 'P052222222C', registrationNo: 'PVT-BETA01', sectorCode: 'MFG' });
    const acct = await w.ops.post(`/organisations/${pa.id}/bank-accounts`, { bankCode: '01', accountName: 'Beta', accountNumber: '5566778899' }).catch(() => null);
    if (acct) {
      const ap = await w.ops.post(`/bank-accounts/${acct.id}/verify`, { callBackNote: 'called' });
      const r = await w.ops.post(`/approvals/${ap.id}/approve`, {}, 403);
      expect(r.title).toBe('FOUR_EYES');
    }
    await expect(h.admin.query(`UPDATE mapema.approval_request SET checker_id = maker_id, status = 'approved', decided_at = now() WHERE status = 'pending'`)).rejects.toThrow(/four_eyes/);
  });
  it('invoice uploader cannot approve it; credit approver cannot release the payout', async () => {
    h.clock.set(AT(D0));
    const i = await w.buyerAdmin.post('/invoices', { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-4EYES-1', amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 20) });
    expect((await w.buyerAdmin.post(`/invoices/${i.id}/decision`, { decision: 'approve' }, 403)).title).toBe('FOUR_EYES');
    // give the credit officer the ops role too: release must still be refused
    await h.admin.query(`INSERT INTO mapema.user_role_assignment (user_id, role) VALUES ($1,'ops')`, [h.staff.credit.id]);
    const inv = await eligibleInvoice(h, w, { number: 'INV-4EYES-2', amountCents: 10_000_000n, dueDate: addDays(D0, 20) });
    const q = await w.supplier.post(`/invoices/${inv}/quote`);
    const acc = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': 'acc-4eyes-2' });
    const id = acc.advances[0].advanceId;
    await recordRegistrySearch(w, inv);
    await w.credit.post(`/advances/${id}/decision`, { decision: 'approve', reason: 'ok' });
    expect((await w.credit.post(`/advances/${id}/release`, undefined, 403, { 'Idempotency-Key': 'rel-4eyes-2' })).title).toBe('FOUR_EYES');
    await h.admin.query(`DELETE FROM mapema.user_role_assignment WHERE user_id = $1 AND role = 'ops'`, [h.staff.credit.id]);
    const rel = await w.ops.post(`/advances/${id}/release`, undefined, undefined, { 'Idempotency-Key': 'rel-4eyes-2b' });
    expect(rel.status).toBe('funded');
  });
});

describe('money controls', () => {
  it('KES only, integer cents only, minimum invoice, duplicates blocked', async () => {
    const base = { supplierKraPin: w.supplierKraPin, invoiceNumber: 'INV-MC-1', amountCents: '10000000', currency: 'KES', issueDate: addDays(D0, -1), dueDate: addDays(D0, 20) };
    expect((await w.buyerAdmin.post('/invoices', { ...base, currency: 'USD' }, 400)).title).toBe('VALIDATION');
    await w.buyerAdmin.post('/invoices', { ...base, amountCents: '100000.5' }, 400);
    await w.buyerAdmin.post('/invoices', { ...base, amountCents: 10000000.5 }, 400);
    expect((await w.buyerAdmin.post('/invoices', { ...base, amountCents: '4999999' }, 422)).title).toBe('BELOW_MINIMUM_INVOICE');
    expect((await w.buyerAdmin.post('/invoices', { ...base, dueDate: addDays(D0, 121) }, 422)).title).toBe('TENOR_OUT_OF_RANGE');
    await w.buyerAdmin.post('/invoices', base);
    expect((await w.buyerAdmin.post('/invoices', { ...base, invoiceNumber: 'inv mc 1' }, 409)).title).toBe('DUPLICATE_INVOICE');
  });

  it('lending switch: off -> no quotes; enabling needs a CBK licence number and a second person', async () => {
    h.clock.set(AT(D0));
    const inv = await eligibleInvoice(h, w, { number: 'INV-SW-1', amountCents: 10_000_000n, dueDate: addDays(D0, 20) });
    await w.compliance.post('/admin/lending/disable', { reason: 'test' });
    expect((await w.supplier.post(`/invoices/${inv}/quote`, undefined, 422)).title).toBe('LENDING_DISABLED');
    const pub = (await h.http.get('/v1/public/cbk-status')).body;
    expect(pub.lendingEnabled).toBe(false);
    const p = await w.admin.post('/admin/lending/enable', { cbkLicenceNo: 'DEMO-LICENCE-001' });
    expect((await w.admin.post(`/approvals/${p.id}/approve`, {}, 403)).title).toBe('FOUR_EYES');
    expect((await w.ops.post(`/approvals/${p.id}/approve`, {}, 403)).title).toBe('ROLE_REQUIRED'); // only the CEO approves
    await w.approve(p.id);
    await w.supplier.post(`/invoices/${inv}/quote`);
  });

  it('pricing cannot go live without a CBK approval reference (DB constraint)', async () => {
    const pv = await w.admin.post('/admin/pricing-versions', { code: 'NO-CBK', advanceRateBps: 8000, discountRateBpsPer30d: 400, verificationFeeCents: 250000 });
    await w.admin.post(`/admin/pricing-versions/${pv.id}/activate`, { customerNoticeSentAt: '2026-10-01T00:00:00Z', effectiveFrom: '2026-11-01' }, 400);
    await expect(h.admin.query(`UPDATE mapema.pricing_version SET status = 'active' WHERE id = $1`, [pv.id])).rejects.toThrow(/pricing_live_needs_cbk/);
  });

  it('limits are re-checked at release: lowering the float after approval blocks the payout', async () => {
    h.clock.set(AT(D0));
    const inv = await eligibleInvoice(h, w, { number: 'INV-LIM-1', amountCents: 100_000_000n, dueDate: addDays(D0, 40) });
    const q = await w.supplier.post(`/invoices/${inv}/quote`);
    const acc = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': 'acc-lim-1' });
    const id = acc.advances[0].advanceId;
    await recordRegistrySearch(w, inv);
    await w.credit.post(`/advances/${id}/decision`, { decision: 'approve', reason: 'ok' });
    const fl = await w.admin.post('/admin/float', { amountCents: '100000000', basisNote: 'facility withdrawn' }); // KES 1m float -> buyer cap 250k
    await w.approve(fl.id);
    const sentBefore = h.adapters.bank.sent.length;
    const r = await w.ops.post(`/advances/${id}/release`, undefined, 422, { 'Idempotency-Key': 'rel-lim-1' });
    expect(r.title).toBe('CHECKS_FAILED');
    expect(r.failedChecks.map((c: any) => c.code)).toEqual(expect.arrayContaining(['BUYER_LIMIT']));
    expect(h.adapters.bank.sent.length).toBe(sentBefore);
    const back = await w.admin.post('/admin/float', { amountCents: '1000000000', basisNote: 'restored' });
    await w.approve(back.id);
    await w.ops.post(`/advances/${id}/release`, undefined, undefined, { 'Idempotency-Key': 'rel-lim-1b' });
  });

  it('concurrent approvals cannot jointly breach a limit (serialised)', async () => {
    h.clock.set(AT(D0));
    // supplier cap = min(link KES 2m, 10% of KES 10m float) = KES 1m; KES 880k already funded -> one KES 100k advance fits, two do not
    const ids: string[] = [];
    for (const [n, amt] of [['INV-CC-1', 12_500_000n], ['INV-CC-2', 12_600_000n]] as const) {
      const inv = await eligibleInvoice(h, w, { number: n, amountCents: amt, dueDate: addDays(D0, 40) });
      const q = await w.supplier.post(`/invoices/${inv}/quote`);
      ids.push((await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': `acc-${n}` })).advances[0].advanceId);
      await recordRegistrySearch(w, inv);
    }
    const tok = await h.staff.credit.token();
    const res = await Promise.all(ids.map((id) => h.http.post(`/v1/advances/${id}/decision`).set('Authorization', `Bearer ${tok}`).send({ decision: 'approve', reason: 'race' })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 422]);
    const refused = res.find((r) => r.status === 422)!.body;
    expect(refused.failedChecks.map((c: any) => c.code)).toEqual(['SUPPLIER_LIMIT']);
  });

  it('Idempotency-Key: replaying accept returns the same advance; reuse with a different body is refused', async () => {
    h.clock.set(AT(D0));
    const inv = await eligibleInvoice(h, w, { number: 'INV-IDEM-1', amountCents: 10_000_000n, dueDate: addDays(D0, 20) });
    const q = await w.supplier.post(`/invoices/${inv}/quote`);
    const a1 = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': 'idem-key-0001' });
    const a2 = await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, undefined, { 'Idempotency-Key': 'idem-key-0001' });
    expect(a2).toEqual(a1);
    const reuse = await w.supplier.post('/advances', { disclosureIds: ['00000000-0000-4000-8000-000000000001'], acceptTerms: true }, 422, { 'Idempotency-Key': 'idem-key-0001' });
    expect(reuse.title).toBe('IDEMPOTENCY_KEY_REUSED');
    await w.supplier.post('/advances', { disclosureIds: [q.disclosureId], acceptTerms: true }, 400); // key required
  });

  it('accepted price disclosure is immutable', async () => {
    await expect(h.admin.query(`UPDATE mapema.price_disclosure SET discount_fee_cents = 1 WHERE accepted_at IS NOT NULL`)).rejects.toThrow(/immutable/);
  });
});

describe('data protection & audit', () => {
  it('the API database role cannot update/delete audit events or delete business records', async () => {
    const c = new pg.Client({ connectionString: h.appUrl }); await c.connect();
    try {
      await expect(c.query(`UPDATE mapema.audit_event SET action = 'x' WHERE id = 1`)).rejects.toThrow(/permission denied|append-only/);
      await expect(c.query(`DELETE FROM mapema.audit_event`)).rejects.toThrow(/permission denied|append-only/);
      await expect(c.query(`DELETE FROM mapema.invoice`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`DELETE FROM mapema.payment_allocation`)).rejects.toThrow(/permission denied/);
    } finally { await c.end(); }
    await expect(h.admin.query(`UPDATE mapema.audit_event SET action = 'x' WHERE id = 1`)).rejects.toThrow(/append-only/); // even a superuser hits the trigger
  });
  it('PII is encrypted at rest and never in the outbox', async () => {
    const ba = (await h.admin.query(`SELECT encode(account_number_enc,'escape') AS e, account_number_last4 FROM mapema.bank_account WHERE org_id = $1`, [w.supplierId])).rows[0];
    expect(ba.e).not.toContain('0123456789');
    const p = (await h.admin.query(`SELECT encode(national_id_enc,'escape') AS e FROM mapema.person WHERE full_name = 'Peter Kamau'`)).rows[0];
    expect(p.e).not.toContain('33445566');
    const ob = (await h.admin.query(`SELECT payload::text AS t FROM mapema.outbox`)).rows.map((r) => r.t).join('\n');
    expect(ob).not.toMatch(/\+2547\d{8}|0123456789|33445566/);
    expect(ob).not.toMatch(/token=/); // invitation links scrubbed once sent
  });
  it('audit export: CSV + chain verification, and the export itself is audited', async () => {
    const r = await h.http.get('/v1/audit/export').set('Authorization', `Bearer ${await h.staff.compliance.token()}`).expect(200);
    expect(r.headers['x-audit-chain-ok']).toBe('true');
    expect(r.text.split('\n')[0]).toBe('id,occurred_at,actor_user_id,actor_role,action,entity_type,entity_id,request_id,prev_hash,row_hash');
    const n = (await h.admin.query(`SELECT count(*)::int AS n FROM mapema.audit_event WHERE action = 'audit.export'`)).rows[0].n;
    expect(n).toBe(1);
  });
  it('security headers and problem+json on errors', async () => {
    const r = await h.http.get('/v1/public/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-request-id']).toBeTruthy();
  });
});

describe('production guards', () => {
  const base = { DATABASE_URL: 'postgres://x', PII_ENCRYPTION_KEY: 'a'.repeat(64), PII_BLIND_INDEX_KEY: 'b'.repeat(64), STORAGE_ENCRYPTION_KEY: 'c'.repeat(64), BANK_WEBHOOK_SECRET: 'x'.repeat(16), ESIGN_WEBHOOK_SECRET: 'y'.repeat(16) };
  it('dev IdP cannot be enabled in production', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'production', DEV_IDP_ENABLED: 'true' })).toThrow(/DEV_IDP_ENABLED/);
  });
  it('mock providers are refused in production; live providers refused outside production', () => {
    expect(() => createAdapters({ APP_ENV: 'production' })).toThrow(/not allowed in production/);
    expect(() => createAdapters({ APP_ENV: 'staging', ADAPTER_MODE_BANK: 'live' })).toThrow(/only allowed in production/);
  });
  it('missing secrets fail fast', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x' })).toThrow(/PII_ENCRYPTION_KEY/);
  });
});
