/**
 * [Security Engineer + DevOps] Postgres-backed storage for @nestjs/throttler (Phase 1b), so the
 * limits (300/min global, fee-quote 30/min, leads 5/min, sign-in 20/min) hold across API instances.
 * Fixed window per key, one atomic upsert per request on an UNLOGGED table. Fails OPEN if the
 * database errors (the request would fail anyway on its own queries; we log and do not block).
 * RATE_LIMIT_STORE=memory restores the per-instance in-memory counter (single-instance dev only).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { Db } from './db';

const RESET = `((t.blocked_until IS NOT NULL AND t.blocked_until <= now()) OR (t.blocked_until IS NULL AND t.expires_at <= now()))`;

@Injectable()
export class PgThrottlerStorage implements ThrottlerStorage {
  private readonly log = new Logger('RateLimit');
  private calls = 0;
  constructor(private readonly db: Db) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const k = `${throttlerName}:${key}`;
    try {
      const r = await this.db.one<{ hits: number; tte: string; tbe: string | null }>(
        `INSERT INTO rate_limit_hit AS t (key, hits, expires_at, blocked_until)
           VALUES ($1, 1, now() + $2 * interval '1 millisecond', CASE WHEN 1 > $3 THEN now() + $4 * interval '1 millisecond' END)
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN ${RESET} THEN 1 ELSE t.hits + 1 END,
           expires_at = CASE WHEN ${RESET} THEN now() + $2 * interval '1 millisecond' ELSE t.expires_at END,
           blocked_until = CASE WHEN ${RESET} THEN NULL
                                WHEN t.blocked_until IS NULL AND t.hits + 1 > $3 THEN now() + $4 * interval '1 millisecond'
                                ELSE t.blocked_until END
         RETURNING hits, extract(epoch FROM (expires_at - now()))::text AS tte,
                   CASE WHEN blocked_until > now() THEN extract(epoch FROM (blocked_until - now()))::text END AS tbe`,
        [k, ttl, limit, blockDuration > 0 ? blockDuration : ttl]);
      if (++this.calls % 1000 === 0) void this.prune();
      return {
        totalHits: Number(r!.hits),
        timeToExpire: Math.max(0, Math.ceil(Number(r!.tte))),
        isBlocked: r!.tbe !== null,
        timeToBlockExpire: r!.tbe !== null ? Math.max(1, Math.ceil(Number(r!.tbe))) : 0,
      };
    } catch (e) {
      this.log.error(`rate-limit store unavailable, allowing request: ${(e as Error).message}`);
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  async prune() {
    await this.db.query(`DELETE FROM rate_limit_hit WHERE expires_at < now() - interval '1 hour' AND (blocked_until IS NULL OR blocked_until < now())`).catch(() => undefined);
  }
}
