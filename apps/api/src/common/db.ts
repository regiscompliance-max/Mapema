/**
 * [Backend Engineer] PostgreSQL access. Raw parameterised SQL only (no string concatenation of
 * user input). Money columns (bigint) are returned as strings by node-postgres and converted
 * with toCents(); never parsed as JS numbers.
 */
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';
import { AppConfig, CONFIG } from './config';

types.setTypeParser(20, (v) => v); // int8 stays a string -> BigInt in code
types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'

export type Q = Pick<PoolClient, 'query'>;

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: Pool;
  constructor(@Inject(CONFIG) cfg: AppConfig) {
    // session settings travel in the startup packet, so no query can run before they apply
    this.pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 20, options: '-c search_path=mapema,public -c TimeZone=UTC' });
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(sql, params as any[]);
    return r.rows as T[];
  }

  async one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  /** Run fn in a transaction; retries serialization failures up to 3 times. */
  async tx<T>(fn: (c: PoolClient) => Promise<T>, isolation: 'READ COMMITTED' | 'SERIALIZABLE' = 'READ COMMITTED'): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const c = await this.pool.connect();
      try {
        await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } catch (e: any) {
        await c.query('ROLLBACK').catch(() => undefined);
        if ((e?.code === '40001' || e?.code === '40P01') && attempt < 3) continue;
        throw e;
      } finally {
        c.release();
      }
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

export const toCents = (v: string | number | bigint | null | undefined): bigint => (v === null || v === undefined ? 0n : BigInt(v));
