/**
 * [Security Engineer + QA Engineer] Phase 1b: browser sessions move from sessionStorage bearer tokens to
 * an httpOnly, Secure, SameSite=Strict session cookie issued by the API, with CSRF protection
 * (synchroniser token in a custom header + Origin check) on every state-changing cookie request.
 *  TC-SES-01 sign-in exchanges an IdP token for a cookie; the token is never echoed back
 *  TC-SES-02 only the hash of the session id is stored
 *  TC-SES-03 cookie works for reads; writes need the CSRF header and an allowed Origin
 *  TC-SES-04 MFA / account checks still apply at session creation
 *  TC-SES-05 idle timeout and absolute lifetime
 *  TC-SES-06 re-authentication (step-up) rotates the session id; the old cookie dies
 *  TC-SES-07 logout revokes server-side and clears the cookie
 *  TC-SES-08 CORS allows credentials only for the configured web origin
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, startHarness } from './harness';

let h: Harness;
const ORIGIN = 'http://localhost:3000';
beforeAll(async () => { h = await startHarness(); h.clock.set('2026-11-17T09:00:00Z'); });
afterAll(async () => { await h?.close(); });

function sidFrom(res: any): string {
  const c = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((x) => x.startsWith('mapema_sid='));
  if (!c) throw new Error('no session cookie');
  return c.split(';')[0].slice('mapema_sid='.length);
}
async function signIn(sub = 'staff:ops', opts: { amr?: string[]; authAgeSec?: number } = {}, cookie?: string) {
  let r = h.http.post('/v1/auth/session').set('Origin', ORIGIN);
  if (cookie) r = r.set('Cookie', `mapema_sid=${cookie}`);
  return r.send({ accessToken: await h.token(sub, opts) });
}

describe('cookie sessions + CSRF', () => {
  it('TC-SES-01 sign-in sets an httpOnly Secure SameSite=Strict cookie and returns a CSRF token, not the access token', async () => {
    const r = await signIn();
    expect(r.status).toBe(201);
    const raw = ([] as string[]).concat(r.headers['set-cookie']).find((x) => x.startsWith('mapema_sid='))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
    expect(r.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/eyJ/); // no JWT echoed
    expect(r.body.user.email).toBe('ops@mapema.test');
  });

  it('TC-SES-02 the database holds only a SHA-256 of the session id', async () => {
    const sid = sidFrom(await signIn());
    const rows = (await h.admin.query(`SELECT sid_sha256 FROM mapema.web_session`)).rows;
    expect(rows.some((x: any) => x.sid_sha256.equals(createHash('sha256').update(sid).digest()))).toBe(true);
    const dump = JSON.stringify((await h.admin.query(`SELECT * FROM mapema.web_session`)).rows);
    expect(dump).not.toContain(sid);
  });

  it('TC-SES-03 reads work with the cookie alone; writes need X-CSRF-Token and an allowed Origin', async () => {
    const r = await signIn('staff:admin');
    const sid = sidFrom(r); const csrf = r.body.csrfToken;
    const me = await h.http.get('/v1/me').set('Cookie', `mapema_sid=${sid}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('admin@mapema.test');
    const body = { amountCents: '100000000', basisNote: 'csrf test' };
    const noHeader = await h.http.post('/v1/admin/float').set('Cookie', `mapema_sid=${sid}`).set('Origin', ORIGIN).send(body);
    expect(noHeader.status).toBe(403); expect(noHeader.body.title).toBe('CSRF_FAILED');
    const wrong = await h.http.post('/v1/admin/float').set('Cookie', `mapema_sid=${sid}`).set('Origin', ORIGIN).set('X-CSRF-Token', 'x'.repeat(43)).send(body);
    expect(wrong.status).toBe(403); expect(wrong.body.title).toBe('CSRF_FAILED');
    const evil = await h.http.post('/v1/admin/float').set('Cookie', `mapema_sid=${sid}`).set('Origin', 'https://evil.example').set('X-CSRF-Token', csrf).send(body);
    expect(evil.status).toBe(403); expect(evil.body.title).toBe('CSRF_FAILED');
    const ok = await h.http.post('/v1/admin/float').set('Cookie', `mapema_sid=${sid}`).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send(body);
    expect(ok.status).toBe(201);
    // GET /auth/session gives the CSRF token back after a page reload (it is kept in memory only)
    const again = await h.http.get('/v1/auth/session').set('Cookie', `mapema_sid=${sid}`);
    expect(again.status).toBe(200); expect(again.body.csrfToken).toBe(csrf);
  });

  it('TC-SES-04 no second factor, staff with SMS only, or unknown account -> no session', async () => {
    expect((await signIn('staff:ops', { amr: ['pwd'] })).body.title).toBe('MFA_REQUIRED');
    expect((await signIn('staff:ops', { amr: ['pwd', 'sms'] })).body.title).toBe('STRONG_MFA_REQUIRED');
    expect((await signIn('nobody:x')).body.title).toBe('NO_ACCOUNT');
    const bad = await h.http.post('/v1/auth/session').set('Origin', ORIGIN).send({ accessToken: 'not-a-jwt' });
    expect(bad.status).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
  });

  it('TC-SES-05 idle timeout (15 min) and absolute lifetime (8 h)', async () => {
    h.clock.set('2026-11-17T10:00:00Z');
    const sid = sidFrom(await signIn());
    h.clock.set('2026-11-17T10:14:00Z');
    expect((await h.http.get('/v1/me').set('Cookie', `mapema_sid=${sid}`)).status).toBe(200);
    h.clock.set('2026-11-17T10:30:00Z');
    const idle = await h.http.get('/v1/me').set('Cookie', `mapema_sid=${sid}`);
    expect(idle.status).toBe(401); expect(idle.body.title).toBe('SESSION_EXPIRED');
    h.clock.set('2026-11-17T11:00:00Z');
    const sid2 = sidFrom(await signIn());
    for (let m = 10; m < 8 * 60; m += 10) { h.clock.set(new Date(Date.parse('2026-11-17T11:00:00Z') + m * 60_000).toISOString()); await h.http.get('/v1/me').set('Cookie', `mapema_sid=${sid2}`).expect(200); }
    h.clock.set(new Date(Date.parse('2026-11-17T11:00:00Z') + 8 * 3600_000 + 60_000).toISOString());
    const abs = await h.http.get('/v1/me').set('Cookie', `mapema_sid=${sid2}`);
    expect(abs.status).toBe(401); expect(abs.body.title).toBe('SESSION_EXPIRED');
    h.clock.set('2026-11-17T09:00:00Z');
  });

  it('TC-SES-06 step-up uses the session auth_time; re-authenticating rotates the session id', async () => {
    const old = await signIn('staff:ops', { authAgeSec: 3600 });
    const oldSid = sidFrom(old);
    // a step-up endpoint refuses the stale authentication
    const p = await h.http.post('/v1/payouts/00000000-0000-4000-8000-000000000000/release').set('Cookie', `mapema_sid=${oldSid}`).set('Origin', ORIGIN).set('X-CSRF-Token', old.body.csrfToken);
    expect(p.body.title).toBe('STEP_UP_REQUIRED');
    const fresh = await signIn('staff:ops', {}, oldSid);
    const newSid = sidFrom(fresh);
    expect(newSid).not.toBe(oldSid);
    expect(fresh.body.csrfToken).not.toBe(old.body.csrfToken);
    expect((await h.http.get('/v1/me').set('Cookie', `mapema_sid=${oldSid}`)).status).toBe(401);
    const p2 = await h.http.post('/v1/payouts/00000000-0000-4000-8000-000000000000/release').set('Cookie', `mapema_sid=${newSid}`).set('Origin', ORIGIN).set('X-CSRF-Token', fresh.body.csrfToken);
    expect(p2.status).toBe(404); // past auth + step-up; the payout simply doesn't exist
  });

  it('TC-SES-07 logout revokes the session and clears the cookie', async () => {
    const r = await signIn(); const sid = sidFrom(r);
    const out = await h.http.post('/v1/auth/logout').set('Cookie', `mapema_sid=${sid}`).set('Origin', ORIGIN).set('X-CSRF-Token', r.body.csrfToken);
    expect(out.status).toBe(204);
    const cleared = ([] as string[]).concat(out.headers['set-cookie']).find((x) => x.startsWith('mapema_sid='))!;
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect((await h.http.get('/v1/me').set('Cookie', `mapema_sid=${sid}`)).status).toBe(401);
    const ev = (await h.admin.query(`SELECT action FROM mapema.audit_event WHERE action IN ('session.create','session.logout')`)).rows.map((x: any) => x.action);
    expect(ev).toEqual(expect.arrayContaining(['session.create', 'session.logout']));
  });

  it('TC-SES-08 CORS: credentials only for the configured origin; X-CSRF-Token allowed', async () => {
    const ok = await h.http.options('/v1/me').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'x-csrf-token,content-type');
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['access-control-allow-headers'].toLowerCase()).toContain('x-csrf-token');
    const bad = await h.http.options('/v1/me').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('TC-SES-09 bearer tokens still work for API clients and need no CSRF header (not ambient)', async () => {
    const r = await h.http.get('/v1/me').set('Authorization', `Bearer ${await h.staff.ops.token()}`);
    expect(r.status).toBe(200);
  });
});
