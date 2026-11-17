/**
 * [QA Engineer] Test harness: a fresh Postgres database per test file, migrated with the real
 * migrations, the API connecting as a NON-superuser login role that only has the mapema_app
 * privileges (so append-only/no-delete grants are exercised), mock adapters, dev IdP tokens.
 */
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { Adapters, createAdapters, MockBank, MockEsign, MockLedger, MockSms, MockEmail } from '@mapema/adapters';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/common/config';
import { Clock } from '../src/common/clock';
import { DevIdp } from '../src/auth/dev-idp';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { migrate } = require('../../../scripts/migrate.mjs');

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://root:postgres@localhost:5432/postgres';
const APP_ROLE = 'mapema_api_test';
const APP_ROLE_PW = 'test-only-not-a-secret';

export interface Harness {
  app: INestApplication;
  http: ReturnType<typeof request>;
  admin: pg.Pool; // superuser pool on the test DB (fixtures + assertions only)
  adapters: Adapters & { bank: MockBank; ledger: MockLedger; esign: MockEsign; sms: MockSms; email: MockEmail };
  clock: Clock;
  token: (sub: string, opts?: { email?: string; amr?: string[]; authAgeSec?: number }) => Promise<string>;
  staff: Record<string, { id: string; sub: string; token: () => Promise<string> }>;
  close: () => Promise<void>;
  dbName: string;
}

function url(base: string, db: string, user?: string, pw?: string) {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = pw ?? ''; }
  return u.toString();
}

export const STAFF = ['ceo', 'credit', 'credit2', 'ops', 'ops2', 'compliance', 'admin', 'auditor'] as const;

export async function startHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const dbName = `mapema_t_${process.pid}_${randomBytes(3).toString('hex')}`;
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PW}'; END IF; END $$`);
  await root.end();
  await migrate(url(ADMIN_URL, dbName), () => undefined);
  const admin = new pg.Pool({ connectionString: url(ADMIN_URL, dbName), max: 3 });
  await admin.query(`GRANT mapema_app TO ${APP_ROLE}`);

  const hex = () => randomBytes(32).toString('hex');
  const env: Record<string, string> = {
    APP_ENV: 'test', DATABASE_URL: url(ADMIN_URL, dbName, APP_ROLE, APP_ROLE_PW), DEV_IDP_ENABLED: 'true',
    PII_ENCRYPTION_KEY: hex(), PII_BLIND_INDEX_KEY: hex(), STORAGE_ENCRYPTION_KEY: hex(),
    BANK_WEBHOOK_SECRET: 'test-bank-webhook-secret-123', ESIGN_WEBHOOK_SECRET: 'test-esign-webhook-secret-123',
    ADAPTER_MODE_LEDGER: 'mock', ...extraEnv,
  };
  const cfg = loadConfig(env);
  const adapters = createAdapters(cfg.raw) as Harness['adapters'];
  const app = await createApp(cfg, { adapters }, { logger: false });
  const idp = app.get(DevIdp);
  const clock = app.get(Clock);
  const token: Harness['token'] = (sub, o = {}) => idp.issue(sub, { email: o.email, amr: o.amr ?? ['pwd', 'otp'], authAgeSec: o.authAgeSec ?? 0 });

  const staff: Harness['staff'] = {};
  for (const name of STAFF) {
    const role = name.replace(/\d$/, '');
    const sub = `staff:${name}`;
    const u = (await admin.query(`INSERT INTO mapema.user_account (idp_subject, email, display_name, mfa_enabled, mfa_methods, access_expires_at) VALUES ($1,$2,$3,true,'{totp}',$4) RETURNING id`,
      [sub, `${name}@mapema.test`, `Test ${name}`, role === 'auditor' ? new Date(Date.now() + 30 * 864e5) : null])).rows[0];
    await admin.query(`INSERT INTO mapema.user_role_assignment (user_id, role) VALUES ($1,$2)`, [u.id, role]);
    staff[name] = { id: u.id, sub, token: () => token(sub, { email: `${name}@mapema.test` }) };
  }
  return {
    app, http: request(app.getHttpServer()), admin, adapters, clock, token, staff, dbName,
    close: async () => {
      await app.close();
      await admin.end();
      const r = new pg.Client({ connectionString: ADMIN_URL });
      await r.connect();
      await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await r.end();
    },
  };
}

/** Thin API client: every call asserts the expected status and returns the body. */
export function client(h: Harness, getToken: () => Promise<string>) {
  const call = async (method: 'get' | 'post', path: string, body?: unknown, expect = method === 'post' ? [200, 201] : [200], headers: Record<string, string> = {}) => {
    let r = h.http[method](`/v1${path}`).set('Authorization', `Bearer ${await getToken()}`);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    const res = body === undefined ? await r : await r.send(body as object);
    const exp = Array.isArray(expect) ? expect : [expect];
    if (!exp.includes(res.status)) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} (expected ${exp.join('/')}): ${JSON.stringify(res.body)}`);
    return res.body;
  };
  return {
    get: (p: string, expect?: number | number[]) => call('get', p, undefined, expect as any),
    post: (p: string, body?: unknown, expect?: number | number[], headers?: Record<string, string>) => call('post', p, body ?? {}, expect as any, headers),
  };
}
