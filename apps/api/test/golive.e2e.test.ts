/**
 * [QA Engineer + Security Engineer + Compliance] Go-live hardening, end to end through the HTTP API:
 *  S-09 report artefacts encrypted at rest   S-12 M-Pesa callback token masking / rotation / IP allow-list
 *  S-13 ERP host allow-list at creation      S-14 integration users out of staff lists, cannot sign in
 *  D-66 Kenyan public holidays: computed Schedule + gazetted days under maker-checker
 * (S-15 batch step-up window lives in phase3.e2e; D-32 BFF login in oidc-bff.e2e.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, Harness, startHarness } from './harness';
import { AT, buildWorld, World, WORKED } from './world';
import { redactUrl } from '../src/common/redact';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptLegacyArtifacts } = require('../../../scripts/encrypt-report-artifacts.mjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { restoreCheck } = require('../../../scripts/restore-check.mjs');

let h: Harness; let w: World;
const TOKEN = 'golive-callback-token-current-0001';
const PREV = 'golive-callback-token-previous-001';
beforeAll(async () => {
  h = await startHarness({
    MPESA_CALLBACK_TOKEN: TOKEN, MPESA_CALLBACK_TOKEN_PREVIOUS: PREV, MPESA_CALLBACK_ALLOWED_IPS: '196.201.214.0/24, 196.201.213.114',
    ADAPTER_MODE_ERP: 'sandbox', ERP_DROP_ROOT: '/tmp/mapema-golive-drop', ERP_SECRET_GL_ODOO: 'k-gl', ERP_ALLOWED_HOSTS: 'erp.acme.example,*.odoo.com',
  });
  w = await buildWorld(h, { tag: 'gl' });
});
afterAll(async () => { await h?.close(); });

describe('go-live hardening', () => {
  // ------------------------------------------------------------------ S-09
  it('TC-GL-S09 report artefacts are AES-256-GCM encrypted in the database; download decrypts; tampering is detected; legacy rows can be migrated', async () => {
    h.clock.set(AT(WORKED.quoteDate));
    const snap = await w.compliance.post('/reports/snapshots', { period: WORKED.quoteDate.slice(0, 7) });
    const g = await w.ceo.post(`/reports/snapshots/${snap.id}/generate`, { kind: 'cbk_return' });
    const csv = g.artifacts.find((a: any) => a.format === 'csv');
    const raw = (await h.admin.query(`SELECT content, encrypted, plain_bytes, sha256 FROM mapema.report_artifact WHERE id = $1`, [csv.id])).rows[0];
    expect(raw.encrypted).toBe(true);
    expect(raw.content.subarray(0, 4).toString()).toBe('MRA1');
    const dl = await h.http.get(`/v1/reports/artifacts/${csv.id}/download`).set('Authorization', `Bearer ${await h.staff.ceo.token()}`).expect(200);
    expect(dl.text.length).toBe(raw.plain_bytes);
    expect(csv.bytes).toBe(raw.plain_bytes);
    expect(raw.content.includes(Buffer.from(dl.text.slice(0, 20)))).toBe(false); // no plaintext in the row
    // reproducible: regenerating gives the same plaintext hash although the ciphertext differs (random IV)
    const again = await w.ceo.post(`/reports/snapshots/${snap.id}/generate`, { kind: 'cbk_return' });
    expect(again.artifacts.map((a: any) => a.sha256)).toEqual(g.artifacts.map((a: any) => a.sha256));
    // moving ciphertext to another row breaks the AAD binding -> integrity error, never wrong content
    const pdf = g.artifacts.find((a: any) => a.format === 'pdf');
    await h.admin.query(`UPDATE mapema.report_artifact SET content = (SELECT content FROM mapema.report_artifact WHERE id = $1) WHERE id = $2`, [csv.id, pdf.id]);
    const bad = await h.http.get(`/v1/reports/artifacts/${pdf.id}/download`).set('Authorization', `Bearer ${await h.staff.ceo.token()}`).expect(409);
    expect(bad.body.title).toBe('ARTIFACT_INTEGRITY');
    // the app role still cannot rewrite artefacts (append-only)
    const app = new (await import('pg')).default.Client({ connectionString: h.appUrl }); await app.connect();
    await expect(app.query(`UPDATE mapema.report_artifact SET encrypted = false WHERE id = $1`, [csv.id])).rejects.toThrow(/permission denied/);
    await app.end();
    // legacy plaintext row (written before go-live) -> still downloadable -> one-off script encrypts it
    const legacy = (await h.admin.query(`INSERT INTO mapema.report_artifact (snapshot_id, kind, template_id, format, filename, draft, content, sha256)
      SELECT snapshot_id, kind, template_id, 'csv', 'legacy-before-go-live.csv', draft, convert_to('a,b\n1,2\n','UTF8'), encode(sha256(convert_to('a,b\n1,2\n','UTF8')),'hex') FROM mapema.report_artifact WHERE id = $1 RETURNING id`, [csv.id])).rows[0];
    const l1 = await h.http.get(`/v1/reports/artifacts/${legacy.id}/download`).set('Authorization', `Bearer ${await h.staff.ceo.token()}`).expect(200);
    process.env.STORAGE_ENCRYPTION_KEY = h.env.STORAGE_ENCRYPTION_KEY;
    const owner = new URL(ADMIN_URL); owner.pathname = `/${h.dbName}`;
    const n = await encryptLegacyArtifacts(owner.toString(), { log: () => undefined });
    expect(n).toBe(1);
    expect((await h.admin.query(`SELECT encrypted FROM mapema.report_artifact WHERE id = $1`, [legacy.id])).rows[0].encrypted).toBe(true);
    const l2 = await h.http.get(`/v1/reports/artifacts/${legacy.id}/download`).set('Authorization', `Bearer ${await h.staff.ceo.token()}`).expect(200);
    expect(l2.text).toBe(l1.text);
  });

  // ------------------------------------------------------------------ S-12
  it('TC-GL-S12 M-Pesa callbacks: the path token is masked in problem responses/logs; previous token works during rotation (audited); IP allow-list', async () => {
    const post = (token: string, ip: string) => h.http.post(`/v1/webhooks/mpesa/b2c/result/${token}`).set('X-Forwarded-For', ip).send({ Result: {} });
    const wrong = await post('a-wrong-token-that-must-not-echo', '196.201.214.10').expect(401);
    expect(JSON.stringify(wrong.body)).not.toContain('a-wrong-token-that-must-not-echo');
    expect(wrong.body.instance).toBe('/v1/webhooks/mpesa/b2c/result/[redacted]');
    const good = await post(TOKEN, '196.201.214.10');
    expect(good.status).not.toBe(401); // token + IP accepted (400: not a Daraja result body)
    expect(good.body.instance).toBe('/v1/webhooks/mpesa/b2c/result/[redacted]');
    await post(TOKEN, '10.1.2.3').expect(401); // right token, wrong network
    await post(TOKEN, '196.201.213.114').expect(400);
    const viaPrev = await h.http.post(`/v1/webhooks/mpesa/b2c/timeout/${PREV}`).set('X-Forwarded-For', '196.201.214.11').send({ Result: { ResultType: 0, ResultCode: 1, ResultDesc: 'x', OriginatorConversationID: 'unknown-1', ConversationID: 'c', TransactionID: 't' } });
    expect(viaPrev.status).toBe(200);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM mapema.audit_event WHERE action = 'mpesa.callback_previous_token'`)).rows[0].n).toBe(1);
    expect(redactUrl('/v1/webhooks/mpesa/b2c/timeout/abc123?x=1')).toBe('/v1/webhooks/mpesa/b2c/timeout/[redacted]?x=1');
    expect(redactUrl('/v1/invoices/abc')).toBe('/v1/invoices/abc');
  });

  // ------------------------------------------------------------------ S-13 + S-14
  it('TC-GL-S13 ERP connections: only allow-listed https hosts can be saved', async () => {
    const mk = (baseUrl: string, status?: number) => w.ops.post('/erp/connections', { buyerId: w.buyerId, kind: 'odoo', name: 'GL Odoo', config: { baseUrl, database: 'acme', username: 'api@acme.test' }, secretEnv: 'ERP_SECRET_GL_ODOO' }, status);
    expect((await mk('https://intranet.acme.example', 400)).title).toBe('ERP_HOST_NOT_ALLOWED');
    expect((await mk('http://erp.acme.example', 400)).title).toBe('ERP_HTTPS_REQUIRED');
    expect((await mk('https://169.254.169.254/latest/meta-data', 400)).title).toBe('ERP_HOST_NOT_ALLOWED');
    expect((await mk('https://localhost:8069', 400)).title).toBe('ERP_HOST_NOT_ALLOWED');
    const ok = await mk('https://acme.odoo.com');
    expect(ok.status).toBe('pending_mapping');
    const n = (await h.admin.query(`SELECT count(*)::int AS n FROM mapema.erp_connection`)).rows[0].n;
    expect(n).toBe(1);
  });

  it('TC-GL-S14 integration users: flagged, excluded from the staff access review, listed as service accounts, and can never sign in', async () => {
    const iu = (await h.admin.query(`SELECT u.id, u.idp_subject, u.is_integration FROM mapema.user_account u JOIN mapema.erp_connection c ON c.integration_user_id = u.id`)).rows[0];
    expect(iu.is_integration).toBe(true);
    const staff = await w.admin.get('/admin/users');
    expect(staff.map((u: any) => u.id)).not.toContain(iu.id);
    expect(staff.length).toBeGreaterThan(5);
    const svc = await w.compliance.get('/admin/service-accounts');
    expect(svc).toEqual([expect.objectContaining({ id: iu.id, active: false, connection_name: 'GL Odoo' })]);
    await w.ops.get('/admin/service-accounts', 403);
    // even with a valid IdP token for its subject and MFA claims, and even if someone flips it active
    const t = await h.token(iu.idp_subject, { amr: ['pwd', 'otp'] });
    const r = await h.http.get('/v1/me').set('Authorization', `Bearer ${t}`).expect(401);
    expect(r.body.title).toBe('NO_ACCOUNT');
    await expect(h.admin.query(`UPDATE mapema.user_account SET active = true WHERE id = $1`, [iu.id])).rejects.toThrow(/integration_user_inactive/);
  });

  // ------------------------------------------------------------------ D-66 holidays
  it('TC-GL-HOL-01 the calendar lists the Schedule days (Cap. 110, Mazingira Day) and the seeded gazetted Idd-ul-Fitr 2026', async () => {
    const c = await w.ops.get('/calendar/holidays?year=2026');
    expect(c.source).toMatch(/Public Holidays Act \(Cap\. 110\)/);
    expect(c.holidays.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Idd-ul-Fitr', 'Mazingira Day', 'Mashujaa Day', 'Jamhuri Day', 'Madaraka Day']));
    expect(c.holidays.find((x: any) => x.name === 'Idd-ul-Fitr')).toMatchObject({ date: '2026-03-20', kind: 'gazetted', source: expect.stringContaining('3955') });
    expect(c.missingIddUlFitr).toBe(false);
    expect((await w.ops.get('/calendar/holidays?year=2027')).missingIddUlFitr).toBe(true);
  });

  it('TC-GL-HOL-02 ops adds a gazetted holiday with maker-checker: maker cannot approve, other roles cannot propose, duplicates refused; approval takes effect immediately', async () => {
    await w.credit.post('/calendar/holidays', { date: '2027-03-10', name: 'Idd-ul-Fitr', gazetteRef: 'Gazette Notice (test) of 2027' }, 403);
    await w.ops.post('/calendar/holidays', { date: '2027-03-10', name: 'Idd-ul-Fitr' }, 400); // gazette reference required
    await w.ops.post('/calendar/holidays', { date: '2027-03-10', name: 'Idd', gazetteRef: 'GN', substitutesDate: '2027-03-11' }, 400);
    const p = await w.ops.post('/calendar/holidays', { date: '2027-03-10', name: 'Idd-ul-Fitr', gazetteRef: 'Gazette Notice (test) of 2027' });
    await w.ops.post('/calendar/holidays', { date: '2027-03-10', name: 'Idd-ul-Fitr', gazetteRef: 'Gazette Notice (test) of 2027' }, 409); // already pending
    await w.ops.post(`/approvals/${p.id}/approve`, { reason: 'self' }, 403);
    await w.approve(p.id, w.ops2);
    const c = await w.ops.get('/calendar/holidays?year=2027');
    expect(c.holidays.find((x: any) => x.date === '2027-03-10')).toMatchObject({ name: 'Idd-ul-Fitr', kind: 'gazetted' });
    expect(c.missingIddUlFitr).toBe(false);
    const row = (await h.admin.query(`SELECT approval_id, created_by FROM mapema.public_holiday WHERE holiday_date = '2027-03-10'`)).rows[0];
    expect(row).toEqual({ approval_id: p.id, created_by: h.staff.ops.id });
    await w.ops.post('/calendar/holidays', { date: '2027-03-10', name: 'Idd-ul-Fitr', gazetteRef: 'again' }, 409);
    const acts = (await h.admin.query(`SELECT action FROM mapema.audit_event WHERE action LIKE '%holiday_gazette' ORDER BY id`)).rows.map((r) => r.action);
    expect(acts).toEqual(['approval.propose.holiday_gazette', 'approval.approve.holiday_gazette']);
    const app = new (await import('pg')).default.Client({ connectionString: h.appUrl }); await app.connect();
    await expect(app.query(`DELETE FROM mapema.public_holiday`)).rejects.toThrow(/permission denied/);
    await app.end();
  });
  // ------------------------------------------------------------------ backup / restore test
  it('TC-GL-BAK-01 the monthly restore check: chain, migrations and artefact decryption; it catches the artefact tampered in TC-GL-S09 and a missing migration', async () => {
    const u = new URL(ADMIN_URL); u.pathname = `/${h.dbName}`;
    // the only damaged row is the PDF whose ciphertext TC-GL-S09 overwrote with the CSV's
    const tampered = (await h.admin.query(`SELECT a.id FROM mapema.report_artifact a JOIN mapema.report_artifact b ON a.content = b.content AND a.id <> b.id WHERE a.format = 'pdf'`)).rows.map((r) => r.id);
    expect(tampered).toHaveLength(1);
    const r1 = await restoreCheck(u.toString(), { key: h.env.STORAGE_ENCRYPTION_KEY, sample: 1000 });
    expect(r1.checks.migrations).toEqual({ ok: true, applied: 10 });
    expect(r1.checks.audit_chain.ok).toBe(true);
    expect(r1.checks.audit_chain.checked).toBeGreaterThan(10);
    expect(r1.checks.artefacts).toEqual({ ok: false, detail: { badId: tampered[0] } });
    expect(r1.ok).toBe(false);
    await h.admin.query(`DELETE FROM public.schema_migrations WHERE name = '010_go_live.sql'`);
    const r2 = await restoreCheck(u.toString(), { key: h.env.STORAGE_ENCRYPTION_KEY, sample: 0 });
    expect(r2.checks.migrations).toEqual({ ok: false, detail: { missing: ['010_go_live.sql'] } });
    await h.admin.query(`INSERT INTO public.schema_migrations (name) VALUES ('010_go_live.sql')`);
    const r3 = await restoreCheck(u.toString(), { key: h.env.STORAGE_ENCRYPTION_KEY, sample: 0 });
    expect(r3.ok, JSON.stringify(r3)).toBe(true);
  });
});
