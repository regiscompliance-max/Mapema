/**
 * [QA Engineer + Security Engineer] SYS-05 end to end against a REAL Keycloak (go-live). Opt-in:
 *   KEYCLOAK_URL=http://localhost:8180 KEYCLOAK_ADMIN_PASSWORD=... PLAYWRIGHT_DIR=/tmp/pw/node_modules npx vitest run test/keycloak.live.test.ts
 * Keycloak runs locally with infra/keycloak/mapema-realm.json imported (docs/go-live/keycloak-local.md).
 * A real browser (Playwright/Chromium) signs in through the API's BFF: password -> TOTP enrolment
 * (required action) -> session; then a second sign-in with a TOTP code; a wrong code is refused; a
 * step-up forces a fresh login. The API checks the token's amr for a strong factor.
 * Skipped (not failed) when KEYCLOAK_URL is not set, e.g. in CI.
 */
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, startHarness } from './harness';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { configureKeycloak } = require('../../../scripts/keycloak-configure.mjs');

const KC = process.env.KEYCLOAK_URL;
const REALM = `${KC}/realms/mapema`;
const API_PORT = 4555; const WEB = 'http://localhost:3999';
const SECRET = process.env.MAPEMA_BFF_CLIENT_SECRET ?? 'local-kc-test-secret-0123456789';
const USER = { username: 'kc-ops@mapema.test', password: 'Local-only-Pa55word!' };

function totp(base32: string, at = Date.now()) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32.replace(/[\s=]/g, '').toUpperCase(); let bits = '';
  for (const ch of clean) bits += alpha.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(ctr).digest(); const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
const waitNextStep = async () => { const ms = 30_000 - (Date.now() % 30_000) + 500; await new Promise((r) => setTimeout(r, ms)); };

let h: Harness; let pw: any; let browser: any; let adminTok = ''; let userId = ''; let otpSecret = '';
const admin = async (path: string, init: RequestInit = {}): Promise<any> => {
  const r = await fetch(`${KC}/admin/realms/mapema${path}`, { ...init, headers: { Authorization: `Bearer ${adminTok}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!r.ok && r.status !== 409) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 || r.status === 201 || r.status === 409 ? r : r.json();
};

describe.skipIf(!KC)('SYS-05 MFA end to end with Keycloak (live, local)', () => {
  beforeAll(async () => {
    const t = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: process.env.KEYCLOAK_ADMIN_USER ?? 'kcadmin', password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? '' }) });
    adminTok = ((await t.json()) as any).access_token;
    await configureKeycloak({ url: KC, user: process.env.KEYCLOAK_ADMIN_USER ?? 'kcadmin', password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? '', log: () => undefined });
    const client = (await admin('/clients?clientId=mapema-web'))[0];
    await admin(`/clients/${client.id}`, { method: 'PUT', body: JSON.stringify({ ...client, redirectUris: [`http://localhost:${API_PORT}/v1/auth/oidc/callback`, 'http://localhost:4000/v1/auth/oidc/callback'] }) });
    const old = await admin(`/users?username=${encodeURIComponent(USER.username)}&exact=true`);
    for (const u of old) await admin(`/users/${u.id}`, { method: 'DELETE' });
    await admin('/users', { method: 'POST', body: JSON.stringify({ username: USER.username, email: USER.username, firstName: 'Keycloak', lastName: 'Ops', enabled: true, emailVerified: true, requiredActions: ['CONFIGURE_TOTP'], credentials: [{ type: 'password', value: USER.password, temporary: false }] }) });
    userId = (await admin(`/users?username=${encodeURIComponent(USER.username)}&exact=true`))[0].id;

    h = await startHarness({ DEV_IDP_ENABLED: 'false', OIDC_ISSUER: REALM, OIDC_CLIENT_ID: 'mapema-web', OIDC_CLIENT_SECRET: SECRET, OIDC_REDIRECT_URI: `http://localhost:${API_PORT}/v1/auth/oidc/callback`, WEB_ORIGIN: WEB });
    const u = (await h.admin.query(`INSERT INTO mapema.user_account (idp_subject, email, display_name, mfa_enabled, mfa_methods) VALUES ($1,$2,'Keycloak Ops',true,'{totp}') RETURNING id`, [userId, USER.username])).rows[0];
    await h.admin.query(`INSERT INTO mapema.user_role_assignment (user_id, role) VALUES ($1,'ops')`, [u.id]);
    await h.app.listen(API_PORT, '127.0.0.1');
    const req = createRequire(`${process.env.PLAYWRIGHT_DIR ?? '/tmp/pw/node_modules'}/`);
    pw = (() => { try { return req('playwright'); } catch { return req('playwright-core'); } })();
    browser = await pw.chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await h?.close(); });

  async function signIn(opts: { stepUp?: boolean; otp?: (page: any) => Promise<void>; enrol?: boolean }) {
    const ctx = await browser.newContext();
    await ctx.route(`${WEB}/**`, (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>web app</p>' }));
    const page = await ctx.newPage();
    const s = await page.request.post(`http://localhost:${API_PORT}/v1/auth/oidc/start`, { data: { returnTo: '/app', stepUp: opts.stepUp ?? false } });
    const { authorizeUrl } = await s.json();
    expect(authorizeUrl.startsWith(`${REALM}/protocol/openid-connect/auth?`)).toBe(true);
    await page.goto(authorizeUrl);
    await page.fill('#username', USER.username); await page.fill('#password', USER.password);
    await page.click('#kc-login');
    if (opts.enrol) {
      await page.waitForSelector('#totp');
      await page.click('#mode-manual').catch(() => undefined);
      otpSecret = (await page.textContent('#kc-totp-secret-key')).replace(/\s/g, '');
      await page.fill('#totp', totp(otpSecret));
      await page.fill('#userLabel', 'test phone').catch(() => undefined);
      await page.click('#saveTOTPBtn').catch(async () => page.click('input[type=submit]'));
      // enrolment is a required action, not a completed OTP step, so that token says amr [pwd]: the API
      // sends the browser back once with prompt=login and the user signs in with password + the new code
      await page.waitForSelector('#password', { timeout: 20_000 });
      if (await page.isEditable('#username').catch(() => false)) await page.fill('#username', USER.username);
      await page.fill('#password', USER.password); await page.click('#kc-login');
      await waitNextStep();
      await page.waitForSelector('#otp'); await page.fill('#otp', totp(otpSecret)); await page.click('#kc-login');
    } else if (opts.otp) await opts.otp(page);
    await page.waitForURL((u: URL) => u.toString().startsWith(WEB), { timeout: 20_000 });
    const landed = page.url();
    const me = await page.request.get(`http://localhost:${API_PORT}/v1/auth/session`);
    return { ctx, landed, me: me.ok() ? await me.json() : null, status: me.status() };
  }

  it('TC-GL-KC-01 first sign-in: password, then TOTP enrolment; the API accepts the session only with the otp factor', async () => {
    const r = await signIn({ enrol: true });
    expect(r.landed, r.landed).toBe(`${WEB}/app`);
    expect(r.me.user).toMatchObject({ email: USER.username, roles: [{ role: 'ops', orgId: null }] });
    const sess = (await h.admin.query(`SELECT amr, auth_time FROM mapema.web_session ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(sess.amr).toEqual(expect.arrayContaining(['otp']));
    await r.ctx.close();
  }, 120_000);

  it('TC-GL-KC-02 later sign-ins ask for the TOTP code; a wrong code is refused by Keycloak', async () => {
    await waitNextStep();
    const r = await signIn({ otp: async (page) => {
      await page.waitForSelector('#otp');
      await page.fill('#otp', String((Number(totp(otpSecret)) + 1) % 1_000_000).padStart(6, '0'));
      await page.click('#kc-login');
      await page.waitForSelector('#input-error-otp-code, .kc-feedback-text, #input-error', { timeout: 10_000 });
      await page.fill('#otp', totp(otpSecret));
      await page.click('#kc-login');
    } });
    expect(r.landed).toBe(`${WEB}/app`);
    expect(r.me.user.email).toBe(USER.username);
    await r.ctx.close();
  }, 120_000);

  it('TC-GL-KC-03 step-up forces a fresh password + TOTP login and the new session has a fresh auth_time', async () => {
    await waitNextStep();
    const before = Math.floor(Date.now() / 1000);
    const r = await signIn({ stepUp: true, otp: async (page) => { await page.waitForSelector('#otp'); await page.fill('#otp', totp(otpSecret)); await page.click('#kc-login'); } });
    expect(r.landed).toBe(`${WEB}/app`);
    const sess = (await h.admin.query(`SELECT auth_time FROM mapema.web_session ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(Number(sess.auth_time)).toBeGreaterThanOrEqual(before - 5);
    await r.ctx.close();
  }, 120_000);

  it('TC-GL-KC-04 a Keycloak user with no Mapema account is refused after MFA (NO_ACCOUNT), no session', async () => {
    await h.admin.query(`UPDATE mapema.user_account SET active = false WHERE idp_subject = $1`, [userId]);
    await waitNextStep();
    const r = await signIn({ otp: async (page) => { await page.waitForSelector('#otp'); await page.fill('#otp', totp(otpSecret)); await page.click('#kc-login'); } });
    expect(r.landed).toBe(`${WEB}/signin?error=NO_ACCOUNT`);
    expect(r.status).toBe(401);
    await h.admin.query(`UPDATE mapema.user_account SET active = true WHERE idp_subject = $1`, [userId]);
    await r.ctx.close();
  }, 120_000);
});
