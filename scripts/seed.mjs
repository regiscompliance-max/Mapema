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
 *  5. Phase 2: with SEED_DEMO_MONTH=YYYY-MM, a full month of activity instead (see seedDemoMonth).
 *  6. Phase 3: with SEED_DEMO_GROWTH=true, the demo world plus ERP, funding sources, M-Pesa and a payout batch (see seedDemoGrowth).
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

export async function seedDemoWorld(base, o = {}) {
  const a = apiClient(base);
  const S = (n) => `${n}@mapema.test`;
  const approve = (id, who = 'ceo') => a.post(`/approvals/${id}/approve`, S(who), { reason: 'seed: checked' });
  const settings = await a.get('/admin/settings', S('admin'));
  if (settings.pricing.some((p) => p.code === 'DEMO-STD')) { console.log('demo world already seeded - skipping'); return; }
  const today = o.today ?? todayEAT();

  const pv = await a.post('/admin/pricing-versions', S('admin'), { code: 'DEMO-STD', advanceRateBps: 8000, discountRateBpsPer30d: 350, verificationFeeCents: 250000, minDays: 1, maxDays: 120 });
  await approve((await a.post(`/admin/pricing-versions/${pv.id}/activate`, S('admin'), { cbkApprovalRef: 'CBK/DEMO/0001', customerNoticeSentAt: `${addDays(today, -30)}T00:00:00Z`, effectiveFrom: today })).id);
  await approve((await a.post('/admin/float', S('admin'), { amountCents: o.floatCents ?? '1000000000', basisNote: o.floatCents ? 'DEMO equity' : 'DEMO equity KES 10m' })).id);
  await approve((await a.post('/admin/lending/enable', S('admin'), { cbkLicenceNo: 'DEMO-LICENCE-001' })).id);
  console.log(`pricing DEMO-STD (CBK/DEMO/0001), float KES ${(Number(o.floatCents ?? '1000000000') / 100).toLocaleString('en-KE')}, lending ON (DEMO-LICENCE-001)`);

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
  await approve((await a.post(`/supplier-links/${linkId}/limit`, S('credit'), { limitCents: o.supplierLimitCents ?? '100000000', reason: 'DEMO supplier limit' })).id, 'credit2');
  console.log('supplier Jua Kali Packaging Ltd: finance@juakali.test (SMS factor)');

  const inv = await a.post('/invoices', 'ap@acme.test', { supplierKraPin: 'P051111111B', invoiceNumber: 'DEMO-INV-0001', amountCents: '100000000', currency: 'KES', issueDate: addDays(today, -2), dueDate: addDays(today, 48), etimsCuInvoiceNo: 'KRACUDEMO0001' });
  await a.post(`/invoices/${inv.id}/decision`, 'checker@acme.test', { decision: 'approve' });
  const conf = await a.post('/confirmations', 'checker@acme.test', { invoiceIds: [inv.id] });
  await a.post(`/dev/esign/${conf.envelopeId}/complete`);
  await a.post('/dev/jobs/run');
  console.log('invoice DEMO-INV-0001 KES 1,000,000 due in 48 days: eligible (the supplier can now get paid early)');
  return { a, S, approve, buyerId: buyer.id, supplierId: si.orgId, invoiceW: inv.id };
}

/**
 * [QA + Compliance] Demo month (Phase 2): SEED_DEMO_MONTH=YYYY-MM builds one full month of activity through the API
 * on the dev business clock so the month-end snapshot, CBK return (DRAFT), CRB file (DRAFT) and lender pack all come
 * out of the system with no manual edits. Development only (needs DEV_IDP_ENABLED and the mock ledger/bank).
 *   Q = 1st of the month two months before. Advances funded at Q: W = worked example (KES 1,000,000, 48 days, paid on
 *   the due date), E = KES 300,000 due Q+75 and paid on time (in the month), B = KES 500,000 due Q+45 (late -> recourse
 *   to the supplier at 30 DPD in the month, maker-checker), C = KES 100,000 due Q+21 (short term -> NPL at 30 DPD),
 *   D = KES 2,000,000 due Q+110 (current at month end).
 *   Every day: collections (reminders, ladder, NPL), reconciliation for the previous day, accounting push, CRM import,
 *   and on the 1st the month-end reports. Then the clock is handed back to real time.
 */
export async function seedDemoMonth(base, month) {
  const [y, m] = month.split('-').map(Number);
  const Q = new Date(Date.UTC(y, m - 3, 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const until = [todayEAT(), addDays(monthEnd, 1)].sort().pop();
  const clock = (d) => fetch(`${base}/v1/dev/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ iso: d ? `${d}T07:00:00.000Z` : null }) });
  await clock(Q);
  try {
    const w = await seedDemoWorld(base, { today: Q, floatCents: '5000000000', supplierLimitCents: '500000000' });
    if (!w) return;
    const { a, S, approve } = w;
    const sup = 'finance@juakali.test';
    await a.post('/consents', sup, { orgId: w.supplierId, purpose: 'crb_enquiry_and_reporting', textVersion: 'CRB-2026-11' }, 'sms');
    await a.post('/dev/bank/fund', undefined, { amountCents: '5000000000', reference: 'EQ-DEMO-0001', valueDate: Q });
    await a.post('/funding', S('ceo'), { amountCents: '5000000000', source: 'DEMO founder equity', reference: 'EQ-DEMO-0001', valueDate: Q });
    await approve((await a.post('/reconciliation/baseline', S('ops'), { note: 'DEMO go-live opening balances' })).id, 'ops2');
    const eligible = async (n, cents, due) => {
      const i = await a.post('/invoices', 'ap@acme.test', { supplierKraPin: 'P051111111B', invoiceNumber: n, amountCents: cents, currency: 'KES', issueDate: addDays(Q, -2), dueDate: due, etimsCuInvoiceNo: `KRACU${n.replace(/\W/g, '')}` });
      await a.post(`/invoices/${i.id}/decision`, 'checker@acme.test', { decision: 'approve' });
      const conf = await a.post('/confirmations', 'checker@acme.test', { invoiceIds: [i.id] });
      await a.post(`/dev/esign/${conf.envelopeId}/complete`);
      return i.id;
    };
    const fund = async (invoiceId) => {
      const q = await a.post(`/invoices/${invoiceId}/quote`, sup, {}, 'sms');
      const acc = await a.post('/advances', sup, { disclosureIds: [q.disclosureId], acceptTerms: true }, 'sms');
      const id = acc.advances[0].advanceId;
      await a.post(`/advances/${id}/decision`, S('credit'), { decision: 'approve', reason: 'DEMO checks green' });
      await a.post(`/advances/${id}/release`, S('ops'));
      return id;
    };
    const plan = { W: ['DEMO-INV-0001', '100000000', addDays(Q, 48)], E: ['DEMO-INV-0005', '30000000', addDays(Q, 75)], B: ['DEMO-INV-0002', '50000000', addDays(Q, 45)],
      C: ['DEMO-INV-0003', '10000000', addDays(Q, 21)], D: ['DEMO-INV-0004', '200000000', addDays(Q, 110)] };
    const ids = {};
    for (const [k, [n, cents, due]] of Object.entries(plan)) ids[k] = await fund(k === 'W' ? w.invoiceW : await eligible(n, cents, due));
    console.log(`demo month ${month}: funded W/E/B/C/D at ${Q}`);
    const acct = (await a.get(`/dashboards/buyer?orgId=${w.buyerId}`, 'ap@acme.test')).collectionAccount;
    const pay = async (k, d) => {
      await a.post('/dev/bank/credit', undefined, { accountNo: acct, amountCents: plan[k][1], bankRef: `FT-DEMO-${k}`, valueDate: d, payerName: 'ACME SUPERMARKETS LIMITED', narrative: `PAYMENT ${plan[k][0]}` });
      for (const p of await a.get('/payouts?status=proposed', S('ops'))) await a.post(`/payouts/${p.id}/release`, S('ops'));
    };
    for (let d = addDays(Q, 1); d <= until; d = addDays(d, 1)) {
      await clock(d);
      if (d === plan.W[2]) await pay('W', d);
      if (d === plan.E[2]) await pay('E', d);
      const r = await a.post('/dev/jobs/daily');
      await a.post('/dev/jobs/run');
      const due = (await a.get('/recourse-cases', S('credit'))).filter((c) => c.status === 'due' && c.advance_id === ids.B);
      if (due.length) await approve((await a.post(`/advances/${ids.B}/recourse`, S('credit'), { reason: 'DEMO: buyer 30 days past due, recourse under the master agreement' })).id, 'credit2');
      if (r.monthEnd) console.log(`month-end ${r.monthEnd.period}: snapshot + CBK (DRAFT) + CRB (DRAFT) + lender pack generated`);
    }
    console.log(`demo month ${month} complete through ${until}`);
  } finally { await clock(null); }
}

/**
 * [QA + Ops] Phase 3 demo (SEED_DEMO_GROWTH=true): demo world plus
 *   - funding sources EQUITY (priority 100) and FAC-A (KES 5m debt facility, FMCG, <= 60 days, buyer concentration <= 60%), CEO approved
 *   - an Odoo connection for Acme in MOCK mode (no remote host) with 3 vendor bills pushed: 2 import, 1 is refused
 *     (unknown supplier PIN) - the field mapping is approved by a second ops user
 *   - a verified M-Pesa wallet for Jua Kali, the M-Pesa float topped up, one KES 100,000 invoice paid by M-Pesa (callback applied)
 *   - two ERP invoices confirmed in bulk by the checker, quoted and accepted in bulk by the supplier, approved by credit,
 *     and put in a payout batch waiting for the second ops user
 * Mock adapters only (ADAPTER_MODE_ERP / ADAPTER_MODE_MPESA = mock). All names, PINs and numbers are fictitious.
 */
export async function seedDemoGrowth(base) {
  const w = await seedDemoWorld(base, { floatCents: '5000000000', supplierLimitCents: '500000000' });
  if (!w) return;
  const { a, S, approve } = w;
  const today = todayEAT();
  const sup = 'finance@juakali.test';
  await a.post('/dev/bank/fund', undefined, { amountCents: '5000000000', reference: 'EQ-DEMO-0001', valueDate: today });
  await a.post('/funding', S('ceo'), { amountCents: '5000000000', source: 'DEMO founder equity', reference: 'EQ-DEMO-0001', valueDate: today });
  await approve((await a.post('/reconciliation/baseline', S('ops'), { note: 'DEMO go-live opening balances' })).id, 'ops2');
  await approve((await a.post('/funding-sources', S('admin'), { code: 'EQUITY', name: 'DEMO founder equity', type: 'equity', limitCents: null, priority: 100, eligibility: {}, covenants: {}, reason: 'DEMO default source' })).id);
  await approve((await a.post('/funding-sources', S('admin'), { code: 'FAC-A', name: 'DEMO debt facility A', type: 'debt_facility', limitCents: '500000000', priority: 10,
    eligibility: { sectorCodes: ['FMCG'], maxTenorDays: 60, maxAdvanceCents: '200000000', requireEtimsValid: true }, covenants: { maxBuyerConcentrationBps: 6000, maxNplRatioBps: 500 }, reason: 'DEMO facility A' })).id);
  console.log('funding sources EQUITY + FAC-A (KES 5m) approved by the CEO');

  const c = await a.post('/erp/connections', S('ops'), { buyerId: w.buyerId, kind: 'odoo', name: 'Acme Odoo 17 (DEMO mock)', config: { baseUrl: 'https://odoo.acme.test', database: 'acme', username: 'api@acme.test' }, secretEnv: 'ERP_SECRET_DEMO_ODOO' });
  await approve(c.mapping.approvalId, 'ops2');
  const bill = (id, ref, kes, pin, due) => ({ externalId: String(id), version: `${today} 08:00:0${id}|${id}`, data: { id, ref, move_type: 'in_invoice', state: 'posted', partner_vat: pin, amount_total: kes, currency: 'KES',
    invoice_date: addDays(today, -2), invoice_date_due: addDays(today, due), x_etims_cu_invoice_no: `KRACUODOODEMO${id}` } });
  await a.post(`/dev/erp/${c.id}/push`, undefined, { records: [bill(1, 'ODOO-DEMO-1', 600000, 'P051111111B', 40), bill(2, 'ODOO-DEMO-2', 400000, 'P051111111B', 55), bill(3, 'ODOO-DEMO-3', 90000, 'P059999999Z', 30)] });
  const run = await a.post(`/erp/connections/${c.id}/run`, 'ap@acme.test');
  console.log(`ERP import: fetched ${run.fetched}, created ${run.created}, errors ${run.errors}`);

  // M-Pesa wallet + float, one small advance paid by M-Pesa
  const wal = await a.post(`/organisations/${w.supplierId}/mpesa-wallet`, sup, { msisdn: '254712345678', accountName: 'Peter Kamau' }, 'sms');
  await approve((await a.post(`/bank-accounts/${wal.id}/verify`, S('ops'), { callBackNote: 'DEMO call-back: Safaricom line confirmed by the director' })).id, 'ops2');
  await a.post('/dev/mpesa/fund', undefined, { amountCents: '100000000', reference: 'MPFLOAT-DEMO-1', valueDate: today });
  await a.post('/funding', S('ceo'), { amountCents: '100000000', source: 'DEMO M-Pesa float top-up', reference: 'MPFLOAT-DEMO-1', valueDate: today });
  const small = await a.post('/invoices', 'ap@acme.test', { supplierKraPin: 'P051111111B', invoiceNumber: 'DEMO-INV-MP1', amountCents: '12500000', currency: 'KES', issueDate: addDays(today, -3), dueDate: addDays(today, 30), etimsCuInvoiceNo: 'KRACUDEMOMP1' });
  await a.post(`/invoices/${small.id}/decision`, 'checker@acme.test', { decision: 'approve' });
  const sc = await a.post('/confirmations', 'checker@acme.test', { invoiceIds: [small.id] });
  await a.post(`/dev/esign/${sc.envelopeId}/complete`);
  const q = await a.post(`/invoices/${small.id}/quote`, sup, {}, 'sms');
  const acc = await a.post('/advances', sup, { disclosureIds: [q.disclosureId], acceptTerms: true }, 'sms');
  const mpAdv = acc.advances[0].advanceId;
  await a.post(`/advances/${mpAdv}/decision`, S('credit'), { decision: 'approve', reason: 'DEMO checks green' });
  await a.post(`/advances/${mpAdv}/release`, S('ops'));
  const mp = (await a.get('/mpesa/payouts', S('ops')))[0];
  await a.post('/dev/mpesa/complete', undefined, { conversationId: mp.bank_ref, outcome: 'success' });
  console.log('M-Pesa: wallet verified, KES 100,000 advance paid and confirmed by the result callback');

  // bulk: checker confirms the ERP invoices, supplier quotes + accepts in bulk, credit approves, ops builds a batch
  const pending = (await a.get('/invoices?status=awaiting_confirmation', 'checker@acme.test')).map((i) => i.id);
  await a.post('/invoices/bulk-decision', 'checker@acme.test', { invoiceIds: pending, decision: 'approve' });
  const bc = await a.post('/confirmations', 'checker@acme.test', { invoiceIds: pending });
  await a.post(`/dev/esign/${bc.envelopeId}/complete`);
  const bq = await a.post('/invoices/bulk-quote', sup, { invoiceIds: pending }, 'sms');
  const ba = await a.post('/advances', sup, { disclosureIds: bq.results.filter((r) => r.status === 'ok').map((r) => r.quote.disclosureId), acceptTerms: true }, 'sms');
  for (const x of ba.advances) await a.post(`/advances/${x.advanceId}/decision`, S('credit'), { decision: 'approve', reason: 'DEMO checks green' });
  await a.post('/payout-batches', S('ops'), { advanceIds: ba.advances.map((x) => x.advanceId), note: 'DEMO ERP batch' });
  await a.post('/dev/jobs/run');
  console.log(`bulk: ${pending.length} ERP invoices confirmed, quoted and accepted in bulk; payout batch waiting for ops2@mapema.test`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (env.APP_ENV === 'production') { console.error('seed refuses to run with APP_ENV=production'); process.exit(1); }
  const adminUrl = env.DATABASE_ADMIN_URL;
  if (!adminUrl) { console.error('DATABASE_ADMIN_URL is required'); process.exit(1); }
  seedDatabase(adminUrl, env.APP_DB_LOGIN_PASSWORD)
    .then(() => (!env.SEED_API_URL ? console.log('SEED_API_URL not set - demo world skipped') : env.SEED_DEMO_GROWTH === 'true' ? seedDemoGrowth(env.SEED_API_URL) : env.SEED_DEMO_MONTH ? seedDemoMonth(env.SEED_API_URL, env.SEED_DEMO_MONTH) : seedDemoWorld(env.SEED_API_URL)))
    .then(() => console.log('seed complete'), (e) => { console.error(e.message); process.exit(1); });
}
