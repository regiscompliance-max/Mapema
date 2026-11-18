/**
 * [Security Engineer] D-32 (go-live): server-side OIDC login - the API is the "backend for frontend".
 * The browser never sees an authorization code exchange, a PKCE verifier, an access token or an ID
 * token; it only ever holds the HttpOnly session cookie (mapema_sid) and an in-memory CSRF token.
 *
 *   POST /v1/auth/oidc/start     {returnTo?, stepUp?, join?}  -> {authorizeUrl}
 *        creates state (256-bit), nonce, PKCE S256 verifier; stores hash(state), hash(binding),
 *        encrypted verifier (+ encrypted invitation details) for 10 minutes; sets the one-time
 *        binding cookie mapema_oidc (HttpOnly, Secure, SameSite=Lax, Path=/v1/auth/oidc) - Lax so it
 *        survives the top-level redirect back from the IdP; it binds the callback to THIS browser
 *        (login-CSRF / code-injection defence).
 *   GET  /v1/auth/oidc/callback  ?code&state  (the IdP redirects here; redirect_uri = OIDC_REDIRECT_URI)
 *        single-use state + binding check -> code exchange at the token endpoint (confidential client:
 *        client_secret when set, always the PKCE verifier) -> ID token verified (issuer, audience =
 *        client id, nonce) -> access token verified (issuer, audience, MFA amr) -> invitation accepted
 *        when this was a join -> session cookie -> 302 to WEB_ORIGIN + returnTo.
 *        Every failure: 302 to WEB_ORIGIN/signin?error=<CODE> (no detail leaks), no session.
 * Step-up (re-authentication for money moves) = start with stepUp: prompt=login + max_age=0, so the
 * new session carries a fresh auth_time; the old session id is rotated.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, Inject, Injectable, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Audit, SYSTEM } from '../common/audit';
import { Clock } from '../common/clock';
import { AppConfig, CONFIG } from '../common/config';
import { FieldCrypto } from '../common/crypto';
import { Db } from '../common/db';
import { badRequest, DomainError } from '../common/errors';
import { zText } from '../common/http';
import { Identity, identityFromToken, Public, TokenVerifier } from './auth';
import { parseCookies, Sessions, SID_COOKIE } from './session';
import { OnboardingService } from '../modules/onboarding';

export const OIDC_COOKIE = 'mapema_oidc';
const STATE_TTL_SEC = 600;
const sha = (s: string) => createHash('sha256').update(s).digest();
const b64u = (n = 32) => randomBytes(n).toString('base64url');
const zPhoneKe = z.string().regex(/^\+2547\d{8}$|^\+2541\d{8}$/);
export const zStart = z.object({
  returnTo: z.string().max(200).regex(/^\/(?![/\\])[\w\-./?=&%]*$/, 'returnTo must be a path on this site').default('/app'),
  stepUp: z.boolean().default(false),
  join: z.object({ token: z.string().min(20).max(200), displayName: zText(200), phone: zPhoneKe.optional() }).optional(),
});

export class OidcError extends Error { constructor(readonly code: string) { super(code); } }

@Injectable()
export class OidcBff {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig, private readonly db: Db, private readonly clock: Clock, private readonly crypto: FieldCrypto,
    private readonly verifier: TokenVerifier, private readonly identity: Identity, private readonly sessions: Sessions, private readonly audit: Audit,
    private readonly onboarding: OnboardingService,
  ) {}

  get enabled() { return this.cfg.DEV_IDP_ENABLED !== 'true' || this.cfg.raw.OIDC_BFF_WITH_DEV_IDP === 'true'; }
  clientId() { return this.cfg.raw.OIDC_CLIENT_ID ?? 'mapema-web'; }
  redirectUri() { return this.cfg.raw.OIDC_REDIRECT_URI ?? `http://localhost:${this.cfg.PORT}/v1/auth/oidc/callback`; }
  webOrigin() { return this.cfg.WEB_ORIGIN.split(',')[0].trim(); }
  private authUrl() { return this.cfg.raw.OIDC_AUTH_URL ?? `${this.cfg.OIDC_ISSUER}/protocol/openid-connect/auth`; }
  private tokenUrl() { return this.cfg.raw.OIDC_TOKEN_URL ?? `${this.cfg.OIDC_ISSUER}/protocol/openid-connect/token`; }

  bindingCookie(value: string, maxAge: number) {
    return `${OIDC_COOKIE}=${value}; Path=/v1/auth/oidc; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  }

  async start(b: z.infer<typeof zStart>, opts: { mfaRetry?: boolean } = {}) {
    if (!this.enabled) throw new DomainError(404, 'OIDC_DISABLED', 'Single sign-on is not configured here');
    const state = b64u(); const binding = b64u(); const verifier = b64u(48); const nonce = b64u();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const now = this.clock.now();
    await this.db.query(`DELETE FROM oidc_login_state WHERE expires_at < $1`, [new Date(now.getTime() - 86_400_000)]).catch(() => undefined);
    await this.db.query(`INSERT INTO oidc_login_state (state_sha256, binding_sha256, verifier_enc, nonce, return_to, step_up, join_enc, mfa_retry, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [sha(state), sha(binding), this.crypto.encrypt(verifier), nonce, b.returnTo, b.stepUp, b.join ? this.crypto.encrypt(JSON.stringify(b.join)) : null, Boolean(opts.mfaRetry), now, new Date(now.getTime() + STATE_TTL_SEC * 1000)]);
    const p = new URLSearchParams({ client_id: this.clientId(), response_type: 'code', scope: this.cfg.raw.OIDC_SCOPES ?? 'openid email', redirect_uri: this.redirectUri(), state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });
    if (b.stepUp || opts.mfaRetry) { p.set('prompt', 'login'); p.set('max_age', '0'); }
    return { authorizeUrl: `${this.authUrl()}?${p}`, cookie: this.bindingCookie(binding, STATE_TTL_SEC) };
  }

  /** Returns the Set-Cookie headers and where to send the browser. Throws OidcError(code) on any failure. */
  async callback(q: { code?: string; state?: string; error?: string }, req: any) {
    if (!this.enabled) throw new OidcError('OIDC_DISABLED');
    if (q.error) throw new OidcError(q.error === 'access_denied' ? 'ACCESS_DENIED' : 'IDP_ERROR');
    if (!q.code || !q.state || q.state.length > 100 || q.code.length > 2000) throw new OidcError('BAD_CALLBACK');
    const binding = parseCookies(req.headers.cookie)[OIDC_COOKIE];
    if (!binding) throw new OidcError('STATE_INVALID');
    // single use: the row is consumed atomically before anything else happens
    const row = (await this.db.query(`UPDATE oidc_login_state SET consumed_at = $2 WHERE state_sha256 = $1 AND consumed_at IS NULL AND expires_at > $2 RETURNING *`, [sha(q.state), this.clock.now()]))[0];
    if (!row) throw new OidcError('STATE_INVALID');
    const a = Buffer.from(row.binding_sha256); const bb = sha(binding);
    if (a.length !== bb.length || !timingSafeEqual(a, bb)) throw new OidcError('STATE_INVALID');
    const verifier = this.crypto.decrypt(row.verifier_enc)!;

    const body = new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: this.redirectUri(), client_id: this.clientId(), code_verifier: verifier });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const secret = this.cfg.raw.OIDC_CLIENT_SECRET;
    if (secret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.clientId())}:${encodeURIComponent(secret)}`).toString('base64')}`;
    let tok: any;
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch(this.tokenUrl(), { method: 'POST', headers, body, signal: ctrl.signal, redirect: 'error' }).finally(() => clearTimeout(t));
      if (!res.ok) throw new OidcError('CODE_EXCHANGE_FAILED');
      tok = await res.json();
    } catch (e) { throw e instanceof OidcError ? e : new OidcError('IDP_UNAVAILABLE'); }
    if (typeof tok?.access_token !== 'string' || typeof tok?.id_token !== 'string') throw new OidcError('CODE_EXCHANGE_FAILED');
    try { await this.verifier.verifyIdToken(tok.id_token, row.nonce, this.clientId()); } catch { throw new OidcError('ID_TOKEN_INVALID'); }

    let id;
    try { id = identityFromToken(await this.verifier.verify(tok.access_token)); } catch { throw new OidcError('TOKEN_INVALID'); }
    if (row.step_up && Math.floor(Date.now() / 1000) - id.authTime > this.cfg.STEP_UP_MAX_AGE_SEC) throw new OidcError('STEP_UP_REQUIRED');
    if (row.join_enc) {
      const join = JSON.parse(this.crypto.decrypt(row.join_enc)!);
      try { await this.onboarding.acceptInvitation(tok.access_token, this.verifier, join); } catch (e) { throw new OidcError(e instanceof DomainError ? e.code : 'JOIN_FAILED'); }
    }
    let user;
    try { user = await this.identity.build(id, req); } catch (e) {
      // Keycloak does not report a factor the user only ENROLLED in this login (TOTP set-up is a required
      // action, not a completed OTP step), so that login carries amr [pwd]. Send the browser straight back
      // to the IdP once with prompt=login so the new code is actually used; a second miss fails closed.
      if (e instanceof DomainError && e.code === 'MFA_REQUIRED' && !row.mfa_retry) {
        const again = await this.start({ returnTo: row.return_to, stepUp: row.step_up }, { mfaRetry: true });
        await this.db.tx((c) => this.audit.record(c, { ...SYSTEM, ip: req.ip, userAgent: req.headers['user-agent'] }, 'session.oidc_mfa_reprompt', 'web_session', null, null, { sub: id.sub, amr: id.amr })).catch(() => undefined);
        return { cookies: [again.cookie], location: again.authorizeUrl };
      }
      throw new OidcError(e instanceof DomainError ? e.code : 'NO_ACCOUNT');
    }
    const previous = parseCookies(req.headers.cookie)[SID_COOKIE];
    const s = await this.sessions.create(user, id, req, previous);
    await this.db.tx((c) => this.audit.record(c, user.actor, 'session.oidc_login', 'user_account', user.id, null, { stepUp: row.step_up, join: Boolean(row.join_enc), amr: id.amr }));
    return { cookies: [this.sessions.cookie(s.sid, s.maxAgeSec), this.bindingCookie('', 0)], location: `${this.webOrigin()}${row.return_to}` };
  }
}

@Controller('auth/oidc')
export class OidcBffController {
  constructor(private readonly bff: OidcBff, private readonly db: Db, private readonly audit: Audit) {}

  @Public() @Post('start') @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async start(@Body() b: unknown, @Res({ passthrough: true }) res: any) {
    const parsed = zStart.safeParse(b ?? {});
    if (!parsed.success) throw badRequest('BAD_RETURN_TO', parsed.error.issues.map((i) => i.message).join('; '));
    const r = await this.bff.start(parsed.data);
    res.setHeader('Set-Cookie', r.cookie);
    res.setHeader('Cache-Control', 'no-store');
    return { authorizeUrl: r.authorizeUrl };
  }

  @Public() @Get('callback') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async callback(@Query() q: Record<string, string>, @Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer'); // the code must not leak via Referer
    try {
      const r = await this.bff.callback({ code: q.code, state: q.state, error: q.error }, req);
      res.setHeader('Set-Cookie', r.cookies);
      return res.redirect(302, r.location);
    } catch (e) {
      const code = e instanceof OidcError ? e.code : 'SIGN_IN_FAILED';
      await this.db.tx((c) => this.audit.record(c, { ...SYSTEM, ip: req.ip, userAgent: req.headers['user-agent'] }, 'session.oidc_failed', 'web_session', null, null, { code })).catch(() => undefined);
      res.setHeader('Set-Cookie', this.bff.bindingCookie('', 0));
      return res.redirect(302, `${this.bff.webOrigin()}/signin?error=${encodeURIComponent(code)}`);
    }
  }
}
