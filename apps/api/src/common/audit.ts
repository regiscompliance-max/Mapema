/**
 * [Security Engineer] Append-only, hash-chained audit log (SYS-02). Writes happen inside the
 * same DB transaction as the change they describe. PII must be redacted by the caller.
 */
import { Injectable } from '@nestjs/common';
import { Q } from './db';

export interface Actor {
  userId?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}
export const SYSTEM: Actor = { userId: null, role: 'system' };

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

@Injectable()
export class Audit {
  async record(q: Q, actor: Actor, action: string, entityType: string, entityId: string | null, before?: unknown, after?: unknown) {
    await q.query(
      `INSERT INTO audit_event (actor_user_id, actor_role, action, entity_type, entity_id, before, after, ip, user_agent, request_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
      [actor.userId ?? null, actor.role ?? null, action, entityType, entityId, json(before), json(after), actor.ip ?? null, actor.userAgent ?? null, actor.requestId ?? null],
    );
  }
}

/** Recompute the chain (AUD-02 export integrity check). Returns the first broken id or null. */
export async function verifyAuditChain(q: Q): Promise<{ ok: boolean; checked: number; brokenAt: string | null }> {
  const r = await q.query(`
    SELECT id, prev_hash, row_hash,
      encode(public.digest(prev_hash || '|' || occurred_at::text || '|' || COALESCE(actor_user_id::text,'') || '|' ||
        action || '|' || entity_type || '|' || COALESCE(entity_id,'') || '|' ||
        COALESCE(before::text,'') || '|' || COALESCE(after::text,''), 'sha256'), 'hex') AS recomputed,
      lag(row_hash) OVER (ORDER BY id) AS prev_row
    FROM mapema.audit_event ORDER BY id`);
  for (const row of r.rows) {
    const expectedPrev = row.prev_row ?? '0'.repeat(64);
    if (row.recomputed !== row.row_hash || row.prev_hash !== expectedPrev) return { ok: false, checked: r.rows.length, brokenAt: String(row.id) };
  }
  return { ok: true, checked: r.rows.length, brokenAt: null };
}
