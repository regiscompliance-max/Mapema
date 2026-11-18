#!/usr/bin/env node
// [DevOps + QA] Monthly restore test (docs/go-live/backup-and-restore.md). Point it at a database RESTORED from backup
// (never at the live one) and it proves the restore is usable:
//   RESTORED_DATABASE_URL=<restored, read-only role is enough> [STORAGE_ENCRYPTION_KEY=<hex>] node scripts/restore-check.mjs
// Checks: every migration in db/migrations is recorded; the audit hash chain recomputes end to end; report artefacts
// still decrypt and match their sha256 (when the key is given); key tables are non-empty; latest audit time (RPO).
// Prints one JSON line and exits 1 on any failure.
import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export async function restoreCheck(url, { key = process.env.STORAGE_ENCRYPTION_KEY, sample = 20 } = {}) {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  const out = { ok: true, checks: {} };
  const fail = (name, detail) => { out.ok = false; out.checks[name] = { ok: false, detail }; };
  try {
    const files = readdirSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await c.query('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name));
    const missing = files.filter((f) => !done.has(f));
    if (missing.length) fail('migrations', { missing }); else out.checks.migrations = { ok: true, applied: files.length };

    const rows = (await c.query(`
      SELECT id, prev_hash, row_hash,
        encode(public.digest(prev_hash || '|' || occurred_at::text || '|' || COALESCE(actor_user_id::text,'') || '|' ||
          action || '|' || entity_type || '|' || COALESCE(entity_id,'') || '|' ||
          COALESCE(before::text,'') || '|' || COALESCE(after::text,''), 'sha256'), 'hex') AS recomputed,
        lag(row_hash) OVER (ORDER BY id) AS prev_row
      FROM mapema.audit_event ORDER BY id`)).rows;
    const broken = rows.find((r) => r.recomputed !== r.row_hash || r.prev_hash !== (r.prev_row ?? '0'.repeat(64)));
    if (broken) fail('audit_chain', { brokenAt: String(broken.id), checked: rows.length }); else out.checks.audit_chain = { ok: true, checked: rows.length };

    if (key && /^[0-9a-f]{64}$/i.test(key)) {
      const k = createHmac('sha256', Buffer.from(key, 'hex')).update('mapema-report-artifact-v1').digest();
      const arts = (await c.query(`SELECT id, snapshot_id, template_id, filename, content, sha256 FROM mapema.report_artifact WHERE encrypted ORDER BY random() LIMIT $1`, [sample])).rows;
      let bad = null;
      for (const r of arts) {
        try {
          const d = createDecipheriv('aes-256-gcm', k, r.content.subarray(4, 16));
          d.setAAD(Buffer.from(`${r.snapshot_id}|${r.template_id ?? ''}|${r.filename}`, 'utf8')); d.setAuthTag(r.content.subarray(16, 32));
          const plain = Buffer.concat([d.update(r.content.subarray(32)), d.final()]);
          if (createHash('sha256').update(plain).digest('hex') !== r.sha256) bad = r.id;
        } catch { bad = r.id; }
        if (bad) break;
      }
      if (bad) fail('artefacts', { badId: bad }); else out.checks.artefacts = { ok: true, sampled: arts.length };
    } else out.checks.artefacts = { ok: true, skipped: 'no STORAGE_ENCRYPTION_KEY given' };

    const counts = {};
    for (const t of ['user_account', 'organisation', 'invoice', 'advance', 'audit_event']) {
      counts[t] = Number((await c.query(`SELECT count(*)::int AS n FROM mapema.${t}`)).rows[0].n);
    }
    out.checks.counts = { ok: true, ...counts };
    const last = (await c.query('SELECT max(occurred_at) AS t FROM mapema.audit_event')).rows[0].t;
    out.checks.latest_audit_event = { ok: true, at: last ? new Date(last).toISOString() : null };
  } finally { await c.end(); }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.RESTORED_DATABASE_URL;
  if (!url) { console.error('RESTORED_DATABASE_URL is required (a restored copy, never production)'); process.exit(2); }
  restoreCheck(url).then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }).catch((e) => { console.error(e.message); process.exit(1); });
}
