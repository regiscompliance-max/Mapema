/**
 * [Backend Engineer] Idempotency-Key support for money endpoints: the same key + same body
 * returns the stored response; the same key with a different body is rejected.
 */
import { Injectable } from '@nestjs/common';
import { FieldCrypto } from './crypto';
import { Db } from './db';
import { badRequest, conflict, unprocessable } from './errors';
import { jsonReplacer } from './http';

@Injectable()
export class Idempotency {
  constructor(private readonly db: Db) {}

  async run<T>(key: string | undefined, userId: string, body: unknown, fn: () => Promise<T>): Promise<T> {
    if (!key) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header for this request');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_FORMAT', 'Idempotency-Key must be 8-100 URL-safe characters');
    const hash = FieldCrypto.sha256(JSON.stringify(body ?? {}));
    const scoped = `${userId}:${key}`;
    const ins = await this.db.query(
      `INSERT INTO idempotency_key (key, user_id, request_hash) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING RETURNING key`, [scoped, userId, hash]);
    if (!ins.length) {
      const prev = await this.db.one(`SELECT request_hash, response_code, response_body FROM idempotency_key WHERE key = $1`, [scoped]);
      if (prev.request_hash !== hash) throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used with a different request');
      if (prev.response_code === null) throw conflict('REQUEST_IN_PROGRESS', 'The original request is still being processed');
      return prev.response_body as T;
    }
    try {
      const out = await fn();
      await this.db.query(`UPDATE idempotency_key SET response_code = 200, response_body = $2::jsonb WHERE key = $1`, [scoped, JSON.stringify(out, jsonReplacer)]);
      return JSON.parse(JSON.stringify(out, jsonReplacer));
    } catch (e) {
      await this.db.query(`DELETE FROM idempotency_key WHERE key = $1`, [scoped]);
      throw e;
    }
  }
}
