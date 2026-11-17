/**
 * [Security Engineer] Phase 1b server-side browser sessions (replaces sessionStorage bearer tokens).
 *  - Cookie `mapema_sid`: 256-bit random id, HttpOnly, Secure, SameSite=Strict, Path=/, host-only.
 *    Only its SHA-256 is stored (web_session.sid_sha256).
 *  - CSRF: every state-changing request authenticated by the cookie must carry X-CSRF-Token equal to
 *    HMAC(key, sid) (synchroniser token, never stored, returned to the page in the sign-in response
 *    and by GET /auth/session; the page keeps it in memory) AND an Origin in WEB_ORIGIN.
 *    SameSite=Strict is a third, independent layer.
 *  - Idle timeout SESSION_IDLE_MINUTES (15) and absolute lifetime SESSION_MAX_HOURS (8), on the
 *    injectable clock. Re-authentication (step-up) rotates the id; logout revokes server-side.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Audit } from '../common/audit';
import { Clock } from '../common/clock';
import { AppConfig, CONFIG } from '../common/config';
import { Db } from '../common/db';
import { DomainError } from '../common/errors';
import type { Actor } from '../common/audit';

export const SID_COOKIE = 'mapema_sid';
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const csrfFail = () => new DomainError(403, 'CSRF_FAILED', 'Request blocked: missing or invalid CSRF token or origin. Reload the page and try again.');

@Injectable()
export class Sessions {
  private readonly key: Buffer;
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly audit: Audit, @Inject(CONFIG) private readonly cfg: AppConfig) {
    // domain-separated from the blind-index use of the same key material
    this.key = createHmac('sha256', Buffer.from(cfg.PII_BLIND_INDEX_KEY, 'hex')).update('mapema-csrf-key-v1').digest();
  }

  csrfFor(sid: string) { return createHmac('sha256', this.key).update(sid).digest('base64url'); }

  cookie(sid: string, maxAgeSec: number) {
    return `${SID_COOKIE}=${sid}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`;
  }
  clearCookie() { return `${SID_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`; }

  async create(user: { id: string; actor: Actor }, id: { sub: string; amr: string[]; authTime: number }, req: any, previousSid?: string) {
    const sid = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const expires = new Date(now.getTime() + this.cfg.SESSION_MAX_HOURS * 3600_000);
    const row = await this.db.tx(async (c) => {
      if (previousSid) {
        await c.query(`UPDATE web_session SET revoked_at = $2, revoked_reason = 'rotated' WHERE sid_sha256 = $1 AND revoked_at IS NULL`, [sha(previousSid), now]);
      }
      const r = (await c.query(
        `INSERT INTO web_session (sid_sha256, user_id, idp_subject, amr, auth_time, created_at, last_seen_at, expires_at, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9) RETURNING id`,
        [sha(sid), user.id, id.sub, id.amr, id.authTime, now, expires, req.ip ?? null, String(req.headers['user-agent'] ?? '').slice(0, 300) || null])).rows[0];
      await this.audit.record(c, user.actor, 'session.create', 'web_session', r.id, null, { amr: id.amr, rotated: Boolean(previousSid), expiresAt: expires.toISOString() });
      return r;
    });
    return { sid, sessionId: row.id as string, csrfToken: this.csrfFor(sid), expiresAt: expires, maxAgeSec: this.cfg.SESSION_MAX_HOURS * 3600 };
  }

  async resolve(sid: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sid)) throw new DomainError(401, 'SESSION_EXPIRED', 'Your session has ended; sign in again');
    const s = await this.db.one(`SELECT * FROM web_session WHERE sid_sha256 = $1`, [sha(sid)]);
    const now = this.clock.now();
    if (!s || s.revoked_at || new Date(s.expires_at) <= now || now.getTime() - new Date(s.last_seen_at).getTime() > this.cfg.SESSION_IDLE_MINUTES * 60_000) {
      throw new DomainError(401, 'SESSION_EXPIRED', 'Your session has ended; sign in again');
    }
    if (now.getTime() - new Date(s.last_seen_at).getTime() > 60_000) {
      await this.db.query(`UPDATE web_session SET last_seen_at = $2 WHERE id = $1`, [s.id, now]);
    }
    return s;
  }

  assertCsrf(req: any, sid: string) {
    const allowed = this.cfg.WEB_ORIGIN.split(',').map((o) => o.trim());
    const origin = req.headers.origin as string | undefined;
    if (!origin || !allowed.includes(origin)) throw csrfFail();
    const got = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
    const want = Buffer.from(this.csrfFor(sid));
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw csrfFail();
  }

  async revoke(sid: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const r = (await c.query(`UPDATE web_session SET revoked_at = $2, revoked_reason = 'logout' WHERE sid_sha256 = $1 AND revoked_at IS NULL RETURNING id`, [sha(sid), this.clock.now()])).rows[0];
      if (r) await this.audit.record(c, actor, 'session.logout', 'web_session', r.id, null, {});
    });
  }
}
