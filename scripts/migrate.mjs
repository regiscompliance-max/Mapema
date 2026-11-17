#!/usr/bin/env node
// [DevOps] Apply db/migrations/*.sql in order, once each. Usage: DATABASE_URL=... node scripts/migrate.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export async function migrate(databaseUrl, log = console.log) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await client.query(readFileSync(join(dir, f), 'utf8'));
      await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [f]);
      log(`applied ${f}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
  migrate(url).then(() => console.log('migrations complete'), (e) => { console.error(e.message); process.exit(1); });
}
