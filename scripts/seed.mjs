#!/usr/bin/env node
/**
 * [DevOps + QA] Local/staging-demo seed. NEVER run against production (refuses APP_ENV=production).
 *
 *  1. Applies migrations (DATABASE_ADMIN_URL).
 *  2. Creates login role mapema_api (member of mapema_app, not a superuser) with APP_DB_LOGIN_PASSWORD.
 *  3. Creates demo staff: ceo, credit, credit2, ops, ops2, compliance, admin, auditor @mapema.test
 *     (two of each approving role so maker-checker can be exercised).
 *  4. If SEED_API_URL is set and the API runs with DEV_IDP_ENABLED=true, builds the demo world THROUGH
 *     THE API (same path as the E2E worked example): DEMO pricing with CBK ref CBK/DEMO/0001, float
 *     KES 10m, lending switched on with licence DEMO-LICENCE-001 (second-person approved), buyer
 *     Acme Supermarkets Ltd with a checker, supplier Jua Kali Packaging Ltd, and one eligible
 *     KES 1,000,000 invoice due in 48 days. All names, PINs and numbers are fictitious.
 *
 * Usage: DATABASE_ADMIN_URL=... APP_DB_LOGIN_PASSWORD=... [SEED_API_URL=http://localhost:4000] node scripts/seed.mjs
 */
import pg from 'pg';
import { migrate } from './migrate.mjs';

const STAFF = ['ceo', 'credit', 'credit2', 'ops', 'ops2', 'compliance', 'admin', 'auditor'];
const env = process.env;

export async function seedDatabase(adminUrl, appPassword) {
  await migrate(adminUrl, (m) => console.log(m));
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    if (appPassword) {
      const exists = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'mapema_api'`)).rowCount;
      const pw = appPassword.replace(/'/g, "''");
      await c.query(exists ? `ALTER ROLE mapema_api LOGIN PASSWORD '${pw}'` : `CREATE ROLE mapema_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${pw}'`);
      await c.query('GRANT mapema_app TO mapema_api');
      console.log('login role mapema_api ready (member of mapema_app)');
    }
    for (const name of STAFF) {
      const role = name.replace(/\d$/, '');
      const email = `${name}@mapema.test`;
      const u = await c.query(
        `INSERT INTO mapema.user_account (idp_subject, email, display_name, mfa_enabled, mfa_methods, access_expires_at)
         VALUES ($1,$2,$3,true,'{totp}',$4) ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
        [`dev:${email}`, email, `Demo ${name}`, role === 'auditor' ? new Date(Date.now() + 90 * 864e5) : null]);
      await c.query(`INSERT INTO mapema.user_role_assignment (user_id, role) SELECT $1, $2 WHERE NOT EXISTS
        (SELECT 1 FROM mapema.user_role_assignment WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL)`, [u.rows[0].id, role]);
    }
    console.log(`staff: ${STAFF.map((s) => `${s}@mapema.test`).join(', ')}`);
  } finally {
    await c.end();
  }
}

/** Minimal API client using the dev IdP (development/test only). */
function apiClient(base) {
  const tokens = new Map();
  const tok = async (email, factor = 'otp') => {
    if (!tokens.has(email)) {
      const r = await fetch(`${base}/v1/dev-idp/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, factor }) });
      if (!r.ok) throw new Error(`dev token for ${email}: ${r.status} (is DEV_IDP_ENABLED=true?)`);
      tokens.set(email, (await r.json()).accessToken);
    }
    return tokens.get(email);
  };
  const call = async (method, path, email, body, factor) => {
    const headers = { 'content-type': 'application/json' };
    if (email) headers.authorization = `Bearer ${await tok(email, factor)}`;
    if (path === '/advances' || path.endsWith('/release')) headers['idempotency-key'] = `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r = await fetch(`${base}/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} as ${email ?? 'anonymous'} -> ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  return { post: (p, email, b = {}, f) => call('POST', p, email, b, f), get: (p, email) => call('GET', p, email) };
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const todayEAT = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

export async function seedDemoWorld(base) {
  const a = apiClient(base);
  const S = (n) => `${n}@mapema.test`;
  const approve = (id, who = 'ceo') => a.post(`/approvals/${id}/approve`, S(who), { reason: 'seed: checked' });
  const settings = await a.get('/admin/settings', S('admin'));
  if (settings.pricing.some((p) => p.code === 'DEMO-STD')) { console.log('demo world already seeded - skipping'); return; }
  const today = todayEAT();

  const pv = await a.post('/admin/pricing-versions', S('admin'), { code: 'DEMO-STD', advanceRateBps: 8000, discountRateBpsPer30d: 350, verificationFeeCents: 250000, minDays: 1, maxDays: 120 });
  await approve((await a.post(`/admin/pricing-versions/${pv.id}/activate`, S('admin'), { cbkApprovalRef: 'CBK/DEMO/0001', customerNoticeSentAt: new Date().toISOString(), effectiveFrom: today })).id);
  await approve((await a.post('/admin/float', S('admin'), { amountCents: '1000000000', basisNote: 'DEMO equity KES 10m' })).id);
  await approve((await a.post('/admin/lending/enable', S('admin'), { cbkLicenceNo: 'DEMO-LICENCE-001' })).id);
  console.log('pricing DEMO-STD (CBK/DEMO/0001), float KES 10,000,000, lending ON (DEMO-LICENCE-001)');

  const buyer = await a.post('/organisations', S('ops'), { type: 'buyer', legalName: 'Acme Supermarkets Ltd', kraPin: 'P051234567A', registrationNo: 'PVT-ACME01', sectorCode: 'FMCG' });
  const bi = await a.post('/invitations', S('ops'), { kind: 'buyer_admin', orgId: buyer.id, email: 'ap@acme.test' });
  await a.post('/invitations/accept', 'ap@acme.test', { token: bi.devToken, displayName: 'Achieng AP' });
  await a.post(`/organisations/${buyer.id}/persons`, 'ap@acme.test', { fullName: 'Jane Wanjiru', nationalId: '22334455', isDirector: true, isAuthorisedSignatory: true, email: 'jane@acme.test' });
  await a.post(`/organisations/${buyer.id}/bank-accounts`, 'ap@acme.test', { bankCode: '01', accountName: 'Acme Supermarkets Ltd', accountNumber: '1100223344' });
  await a.post('/consents', 'ap@acme.test', { orgId: buyer.id, purpose: 'crb_enquiry_and_reporting', textVersion: 'CRB-2026-11' });
  await a.post(`/organisations/${buyer.id}/submit`, 'ap@acme.test');
  await a.post(`/organisations/${buyer.id}/crb-pull`, S('credit'));
  const prog = await a.post(`/organisations/${buyer.id}/programme`, S('credit'), { limitCents: '500000000', advanceRateBps: 8000, startDate: today, reviewDate: addDays(today, 365), decisionReason: 'DEMO programme' });
  await approve(prog.approval.id);
  const pe = await a.post(`/organisations/${buyer.id}/agreements`, 'ap@acme.test');
  await a.post(`/dev/esign/${pe.envelopeId}/complete`);
  await a.post('/dev/jobs/run');
  const ci = await a.post('/invitations', 'ap@acme.test', { kind: 'buyer_user', orgId: buyer.id, email: 'checker@acme.test', role: 'buyer_checker' });
  await a.post('/invitations/accept', 'checker@acme.test', { token: ci.devToken, displayName: 'Otieno Checker' });
  console.log('buyer Acme Supermarkets Ltd: ap@acme.test (admin/maker), checker@acme.test (checker)');

  const si = await a.post('/invitations', 'ap@acme.test', { kind: 'supplier', email: 'finance@juakali.test', supplier: { legalName: 'Jua Kali Packaging Ltd', kraPin: 'P051111111B', registrationNo: 'PVT-JUA001' } });
  const sup = 'finance@juakali.test';
  await a.post('/invitations/accept', sup, { token: si.devToken, displayName: 'Wanjiku Finance', phone: '+254712345678' }, 'sms');
  await a.post(`/organisations/${si.orgId}/persons`, sup, { fullName: 'Peter Kamau', nationalId: '33445566', isDirector: true, isAuthorisedSignatory: true, email: 'peter@juakali.test' }, 'sms');
  const acct = await a.post(`/organisations/${si.orgId}/bank-accounts`, sup, { bankCode: '11', accountName: 'Jua Kali Packaging Ltd', accountNumber: '0123456789' }, 'sms');
  await a.post(`/organisations/${si.orgId}/submit`, sup, {}, 'sms');
  const se = await a.post(`/organisations/${si.orgId}/agreements`, sup, {}, 'sms');
  await a.post(`/dev/esign/${se.envelopeId}/complete`);
  await approve((await a.post(`/bank-accounts/${acct.id}/verify`, S('ops'), { callBackNote: 'DEMO call-back to director' })).id, 'ops2');
  const supOrg = await a.get(`/organisations/${si.orgId}`, S('credit'));
  const linkId = supOrg.supplierLinks[0].id;
  await approve((await a.post(`/supplier-links/${linkId}/limit`, S('credit'), { limitCents: '100000000', reason: 'DEMO limit KES 1,000,000' })).id, 'credit2');
  console.log('supplier Jua Kali Packaging Ltd: finance@juakali.test (SMS factor)');

  const inv = await a.post('/invoices', 'ap@acme.test', { supplierKraPin: 'P051111111B', invoiceNumber: 'DEMO-INV-0001', amountCents: '100000000', currency: 'KES', issueDate: addDays(today, -2), dueDate: addDays(today, 48), etimsCuInvoiceNo: 'KRACUDEMO0001' });
  await a.post(`/invoices/${inv.id}/decision`, 'checker@acme.test', { decision: 'approve' });
  const conf = await a.post('/confirmations', 'checker@acme.test', { invoiceIds: [inv.id] });
  await a.post(`/dev/esign/${conf.envelopeId}/complete`);
  await a.post('/dev/jobs/run');
  console.log('invoice DEMO-INV-0001 KES 1,000,000 due in 48 days: eligible (the supplier can now get paid early)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (env.APP_ENV === 'production') { console.error('seed refuses to run with APP_ENV=production'); process.exit(1); }
  const adminUrl = env.DATABASE_ADMIN_URL;
  if (!adminUrl) { console.error('DATABASE_ADMIN_URL is required'); process.exit(1); }
  seedDatabase(adminUrl, env.APP_DB_LOGIN_PASSWORD)
    .then(() => (env.SEED_API_URL ? seedDemoWorld(env.SEED_API_URL) : console.log('SEED_API_URL not set - demo world skipped')))
    .then(() => console.log('seed complete'), (e) => { console.error(e.message); process.exit(1); });
}
