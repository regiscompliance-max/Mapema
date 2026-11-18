/**
 * [QA Engineer + Security Engineer] D-32: server-side OIDC code exchange (BFF). The API runs with the
 * dev IdP OFF and a real OIDC flow against a local fake provider; nothing token-like reaches the browser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, startHarness } from './harness';
import { FakeOidc } from './fake-oidc';

let h: Harness; let idp: FakeOidc;
const WEB = 'http://localhost:3000';
const CLIENT = { id: 'mapema-bff', secret: 'test-only-client-secret-123' };
beforeAll(async () => {
  idp = await new FakeOidc(CLIENT).start();
  h = await startHarness({
    DEV_IDP_ENABLED: 'false', OIDC_ISSUER: idp.issuer, OIDC_JWKS_URL: `${idp.issuer}/certs`, OIDC_AUTH_URL: `${idp.issuer}/auth`, OIDC_TOKEN_URL: `${idp.issuer}/token`,
    OIDC_CLIENT_ID: CLIENT.id, OIDC_CLIENT_SECRET: CLIENT.secret, OIDC_REDIRECT_URI: 'http://localhost:4000/v1/auth/oidc/callback', WEB_ORIGIN: WEB,
  });
  idp.user = { sub: 'staff:ops', email: 'ops@mapema.test', amr: ['pwd', 'otp'] }; // harness staff user
});
afterAll(async () => { await h?.close(); await idp?.close(); });

const cookiesOf = (res: request.Response) => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
const cookieVal = (cs: string[], name: string) => cs.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

/** start -> "user signs in at the IdP" -> the IdP's redirect back. Returns the callback query and the binding cookie. */
async function login(body: Record<string, unknown> = {}) {
  const s = await h.http.post('/v1/auth/oidc/start').send(body).expect(201);
  const binding = cookieVal(cookiesOf(s), 'mapema_oidc')!;
  const r = await fetch(s.body.authorizeUrl, { redirect: 'manual' });
  const back = new URL(r.headers.get('location')!);
  return { start: s, binding, back };
}
const callback = (back: URL, binding?: string) => {
  const r = h.http.get(`/v1/auth/oidc/callback${back.search}`);
  return binding ? r.set('Cookie', `mapema_oidc=${binding}`) : r;
};

describe('D-32 BFF OIDC login', () => {
  it('TC-GL-BFF-01 start: PKCE S256 + state + nonce go to the IdP, the browser only gets an HttpOnly Lax binding cookie', async () => {
    const { start, back } = await login();
    const u = new URL(start.body.authorizeUrl);
    expect(u.origin + u.pathname).toBe(`${idp.issuer}/auth`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: CLIENT.id, response_type: 'code', code_challenge_method: 'S256', redirect_uri: 'http://localhost:4000/v1/auth/oidc/callback' });
    expect(u.searchParams.get('state')).toHaveLength(43);
    expect(u.searchParams.get('nonce')).toHaveLength(43);
    expect(JSON.stringify(start.body)).not.toMatch(/verifier|secret/i);
    const c = cookiesOf(start).find((x) => x.startsWith('mapema_oidc='))!;
    expect(c).toMatch(/HttpOnly/); expect(c).toMatch(/Secure/); expect(c).toMatch(/SameSite=Lax/); expect(c).toMatch(/Path=\/v1\/auth\/oidc/);
    expect(start.headers['cache-control']).toBe('no-store');
    expect(back.searchParams.get('code')).toBeTruthy();
    const row = (await h.admin.query(`SELECT * FROM mapema.oidc_login_state ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(row.verifier_enc[0]).toBe(1); // field-encrypted, never stored in clear
    expect(row.return_to).toBe('/app');
  });

  it('TC-GL-BFF-02 callback: server-side code exchange (client secret + PKCE), session cookie, redirect to the web app; no token in the response', async () => {
    idp.tokenCalls.length = 0;
    const { back, binding } = await login({ returnTo: '/app/approvals' });
    const cb = await callback(back, binding).expect(302);
    expect(cb.headers.location).toBe(`${WEB}/app/approvals`);
    const cs = cookiesOf(cb);
    const sid = cookieVal(cs, 'mapema_sid')!;
    expect(sid).toHaveLength(43);
    expect(cs.find((c) => c.startsWith('mapema_sid='))).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(cs.find((c) => c.startsWith('mapema_oidc='))).toMatch(/Max-Age=0/);
    expect(cb.headers['referrer-policy']).toBe('no-referrer');
    expect(JSON.stringify(cb.headers)).not.toMatch(/eyJ/); // no JWT anywhere
    expect(idp.tokenCalls[0]).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT.id, authorization: expect.stringMatching(/^Basic /) });
    expect(idp.tokenCalls[0].code_verifier).toMatch(/^[\w-]{64}$/);
    const me = await h.http.get('/v1/auth/session').set('Cookie', `mapema_sid=${sid}`).expect(200);
    expect(me.body.user).toMatchObject({ email: 'ops@mapema.test', roles: [{ role: 'ops', orgId: null }] });
    const acts = (await h.admin.query(`SELECT action FROM mapema.audit_event WHERE action IN ('session.create','session.oidc_login') ORDER BY id`)).rows.map((r) => r.action);
    expect(acts).toEqual(['session.create', 'session.oidc_login']);
  });

  it('TC-GL-BFF-03 a state is single-use; a callback without the binding cookie (another browser / login CSRF) is refused', async () => {
    const { back, binding } = await login();
    const stolen = await callback(back).expect(302); // attacker's browser: no binding cookie
    expect(stolen.headers.location).toBe(`${WEB}/signin?error=STATE_INVALID`);
    const a = await login();
    const wrong = await callback(a.back, binding).expect(302); // someone else's binding
    expect(wrong.headers.location).toBe(`${WEB}/signin?error=STATE_INVALID`);
    expect(cookieVal(cookiesOf(wrong), 'mapema_sid')).toBeUndefined();
    const b = await login();
    await callback(b.back, b.binding).expect(302);
    const replay = await callback(b.back, b.binding).expect(302);
    expect(replay.headers.location).toBe(`${WEB}/signin?error=STATE_INVALID`);
    void back;
  });

  it('TC-GL-BFF-04 expired state, wrong nonce, wrong audience, IdP error and no-MFA sign-ins all fail closed with no session', async () => {
    const e = await login();
    await h.admin.query(`UPDATE mapema.oidc_login_state SET expires_at = now() - interval '1 second' WHERE consumed_at IS NULL`);
    expect((await callback(e.back, e.binding)).headers.location).toBe(`${WEB}/signin?error=STATE_INVALID`);
    for (const [tamper, code] of [['nonce', 'ID_TOKEN_INVALID'], ['audience', 'TOKEN_INVALID']] as const) {
      idp.tamper = tamper;
      const t = await login();
      const r = await callback(t.back, t.binding);
      expect(r.headers.location).toBe(`${WEB}/signin?error=${code}`);
      expect(cookieVal(cookiesOf(r), 'mapema_sid')).toBeUndefined();
    }
    idp.tamper = 'none';
    const d = await login();
    expect((await h.http.get(`/v1/auth/oidc/callback?error=access_denied&state=${d.back.searchParams.get('state')}`).set('Cookie', `mapema_oidc=${d.binding}`)).headers.location).toBe(`${WEB}/signin?error=ACCESS_DENIED`);
    idp.user = { sub: 'staff:ops', email: 'ops@mapema.test', amr: ['pwd'] };
    const m = await login();
    // a password-only login (e.g. the login in which the user just enrolled TOTP) is sent straight back to
    // the IdP ONCE with prompt=login so the second factor is actually used; a second miss fails closed
    const retry = await callback(m.back, m.binding).expect(302);
    const ru = new URL(retry.headers.location);
    expect(ru.origin + ru.pathname).toBe(`${idp.issuer}/auth`);
    expect(ru.searchParams.get('prompt')).toBe('login');
    expect(cookieVal(cookiesOf(retry), 'mapema_sid')).toBeUndefined();
    const rb = cookieVal(cookiesOf(retry), 'mapema_oidc')!;
    expect(rb).toHaveLength(43);
    const again = new URL((await fetch(ru, { redirect: 'manual' })).headers.get('location')!);
    const second = await callback(again, rb).expect(302);
    expect(second.headers.location).toBe(`${WEB}/signin?error=MFA_REQUIRED`);
    expect(cookieVal(cookiesOf(second), 'mapema_sid')).toBeUndefined();
    idp.user = { sub: 'staff:nobody', email: 'nobody@mapema.test', amr: ['pwd', 'otp'] };
    const n = await login();
    expect((await callback(n.back, n.binding)).headers.location).toBe(`${WEB}/signin?error=NO_ACCOUNT`);
    idp.user = { sub: 'staff:ops', email: 'ops@mapema.test', amr: ['pwd', 'otp'] };
    const fails = (await h.admin.query(`SELECT after->>'code' AS code FROM mapema.audit_event WHERE action = 'session.oidc_failed' ORDER BY id`)).rows.map((r) => r.code);
    expect(fails).toEqual(expect.arrayContaining(['STATE_INVALID', 'ID_TOKEN_INVALID', 'TOKEN_INVALID', 'ACCESS_DENIED', 'MFA_REQUIRED', 'NO_ACCOUNT']));
  });

  it('TC-GL-BFF-05 step-up asks the IdP for a fresh login (prompt=login, max_age=0) and refuses a stale authentication', async () => {
    const s = await login({ stepUp: true });
    const u = new URL(s.start.body.authorizeUrl);
    expect(u.searchParams.get('prompt')).toBe('login');
    expect(u.searchParams.get('max_age')).toBe('0');
    expect((await callback(s.back, s.binding)).headers.location).toBe(`${WEB}/app`);
    idp.authAgeSec = 3600;
    const stale = await login({ stepUp: true });
    expect((await callback(stale.back, stale.binding)).headers.location).toBe(`${WEB}/signin?error=STEP_UP_REQUIRED`);
    idp.authAgeSec = 0;
  });

  it('TC-GL-BFF-06 open redirects are refused; the dev IdP is not mounted when the BFF is on', async () => {
    for (const returnTo of ['//evil.example/x', 'https://evil.example', '/\\evil.example', 'app']) await h.http.post('/v1/auth/oidc/start').send({ returnTo }).expect(400);
    await h.http.post('/v1/dev-idp/token').send({ email: 'ops@mapema.test', factor: 'otp' }).expect(404);
  });
});
