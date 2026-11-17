/**
 * [Backend Engineer] Transactional outbox. Side effects on partners (ledger, bank, SMS, email)
 * are written to `outbox` in the same transaction as the state change and executed after commit
 * by the worker (or immediately via kick()). Handlers must be idempotent (keys = entity ids).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Db, Q } from './db';

type Handler = (payload: any, row: { id: string; aggregate_id: string; attempts: number }) => Promise<void>;
const MAX_ATTEMPTS = 8;

@Injectable()
export class Outbox {
  private readonly log = new Logger('Outbox');
  private handlers = new Map<string, Handler>();
  constructor(private readonly db: Db) {}

  on(topic: string, h: Handler) {
    this.handlers.set(topic, h);
  }

  async enqueue(q: Q, topic: string, aggregateId: string, idempotencyKey: string, payload: unknown): Promise<string> {
    const r = await q.query(
      `INSERT INTO outbox (topic, aggregate_id, idempotency_key, payload) VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key RETURNING id`,
      [topic, aggregateId, idempotencyKey, JSON.stringify(payload)],
    );
    return String(r.rows[0].id);
  }

  /** Process one item now (after commit). Errors are recorded; the worker retries. */
  async kick(id: string) {
    await this.processWhere(`id = $1 AND status IN ('pending','failed')`, [id]);
  }

  async processDue(limit = 20): Promise<number> {
    return this.processWhere(`((status IN ('pending','failed') AND next_attempt_at <= now()) OR (status = 'in_flight' AND next_attempt_at < now() - interval '10 minutes')) ORDER BY id LIMIT ${Number(limit)}`, []);
  }

  private async processWhere(where: string, params: unknown[]): Promise<number> {
    const rows = await this.db.tx(async (c) => {
      const r = await c.query(`SELECT id, topic, aggregate_id, payload, attempts FROM outbox WHERE ${where} FOR UPDATE SKIP LOCKED`, params);
      const ids = r.rows.map((x: any) => x.id);
      if (ids.length) await c.query(`UPDATE outbox SET status = 'in_flight', attempts = attempts + 1, next_attempt_at = now() WHERE id = ANY($1) AND status <> 'done'`, [ids]);
      return r.rows as any[];
    });
    let done = 0;
    for (const row of rows) {
      const h = this.handlers.get(row.topic);
      try {
        if (!h) throw new Error(`no handler for ${row.topic}`);
        await h(row.payload, { id: String(row.id), aggregate_id: row.aggregate_id, attempts: row.attempts + 1 });
        await this.db.query(`UPDATE outbox SET status = 'done', last_error = NULL WHERE id = $1`, [row.id]);
        done++;
      } catch (e) {
        const attempts = row.attempts + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        const backoffSec = Math.min(3600, 2 ** attempts * 5);
        this.log.warn(`outbox ${row.id} ${row.topic} attempt ${attempts} failed: ${(e as Error).message}`);
        await this.db.query(
          `UPDATE outbox SET status = $2, last_error = $3, next_attempt_at = now() + ($4 || ' seconds')::interval WHERE id = $1`,
          [row.id, dead ? 'dead' : 'failed', String((e as Error).message).slice(0, 1000), String(backoffSec)],
        );
      }
    }
    return done;
  }
}
