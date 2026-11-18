#!/usr/bin/env node
// [Security Engineer + DevOps] S-09 one-off: encrypt report artefacts written before go-live
// (encrypted = false) with the same envelope the API uses. Run ONCE per environment as the migration
// owner (the app role cannot UPDATE artefacts - they are append-only for it), AFTER migration 010:
//   DATABASE_URL=<owner url> STORAGE_ENCRYPTION_KEY=<hex> node scripts/encrypt-report-artifacts.mjs [--dry-run]
// Each row is re-read after the update and decrypted to prove the round trip; sha256 (plaintext) is unchanged.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';

const MAGIC = Buffer.from('MRA1');
const deriveKey = () => createHmac('sha256', Buffer.from(process.env.STORAGE_ENCRYPTION_KEY ?? '', 'hex')).update('mapema-report-artifact-v1').digest();
const aad = (r) => Buffer.from(`${r.snapshot_id}|${r.template_id ?? ''}|${r.filename}`, 'utf8');
function seal(key, plain, a) {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(a);
  const ct = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}
function open(key, b, a) { const d = createDecipheriv('aes-256-gcm', key, b.subarray(4, 16)); d.setAAD(a); d.setAuthTag(b.subarray(16, 32)); return Buffer.concat([d.update(b.subarray(32)), d.final()]); }

export async function encryptLegacyArtifacts(url, { dryRun = false, log = console.log } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(process.env.STORAGE_ENCRYPTION_KEY ?? '')) throw new Error('STORAGE_ENCRYPTION_KEY (64 hex) is required');
  const key = deriveKey();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  let n = 0;
  try {
    await c.query('BEGIN');
    const rows = (await c.query(`SELECT id, snapshot_id, template_id, filename, content, sha256 FROM mapema.report_artifact WHERE NOT encrypted FOR UPDATE`)).rows;
    for (const r of rows) {
      if (createHash('sha256').update(r.content).digest('hex') !== r.sha256) throw new Error(`artefact ${r.id}: stored bytes do not match sha256; stopping`);
      const sealed = seal(key, r.content, aad(r));
      if (!open(key, sealed, aad(r)).equals(r.content)) throw new Error(`artefact ${r.id}: round trip failed`);
      if (!dryRun) await c.query(`UPDATE mapema.report_artifact SET content = $2, encrypted = true, plain_bytes = $3 WHERE id = $1`, [r.id, sealed, r.content.length]);
      n++;
    }
    await c.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { await c.end(); }
  log(`${dryRun ? 'would encrypt' : 'encrypted'} ${n} legacy report artefact(s)`);
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  encryptLegacyArtifacts(process.env.DATABASE_URL, { dryRun: process.argv.includes('--dry-run') }).catch((e) => { console.error(e.message); process.exit(1); });
}
