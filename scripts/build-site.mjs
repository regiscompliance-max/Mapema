#!/usr/bin/env node
// Rebuild the static public site and generate the Cloudflare Worker that serves it.
//   node scripts/build-site.mjs            -> infra/cloudflare-site/dist/worker.mjs + dist/mcp-deploy.js
//   node scripts/build-site.mjs --no-build -> skip the Next.js build, reuse apps/web/out
// Deploy: pass dist/mcp-deploy.js as the `code` of the Cloudflare connector's `execute` tool
// (CallDynamicTool user-Cloudflare/execute, code = "$file:<abs path>"), or use wrangler with a token (see README).
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'infra/cloudflare-site');
const out = join(root, 'apps/web/out');
const cfg = JSON.parse(readFileSync(join(site, 'site.json'), 'utf8'));

if (!process.argv.includes('--no-build')) {
  execSync('npx tsc -p packages/pricing/tsconfig.json', { cwd: root, stdio: 'inherit' });
  execSync('npx next build', { cwd: join(root, 'apps/web'), stdio: 'inherit' });
}

const TYPES = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml' };
const BINARY = { woff2: 'font/woff2', ico: 'image/x-icon', png: 'image/png' }; // embedded as base64
const files = {};
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const rel = '/' + relative(out, p).split('\\').join('/');
    if (rel === '/_headers') continue; // headers are set in the Worker
    const ext = rel.split('.').pop();
    if (BINARY[ext]) { files[rel] = [BINARY[ext], readFileSync(p).toString('base64'), 1]; continue; }
    if (!TYPES[ext]) throw new Error(`No content type for ${rel}; add it to TYPES or BINARY in scripts/build-site.mjs`);
    files[rel] = [TYPES[ext], readFileSync(p, 'utf8')];
  }
})(out);

const worker = readFileSync(join(site, 'worker.template.mjs'), 'utf8')
  .replace('__FILES__', () => JSON.stringify(files))
  .replace('__NOTICE__', () => JSON.stringify(cfg.privacyNoticeVersion));
const metadata = { main_module: 'worker.mjs', compatibility_date: cfg.compatibilityDate, bindings: [{ type: 'd1', name: cfg.d1.binding, id: cfg.d1.databaseId }] };
const deploy = `async () => {
  const code = ${JSON.stringify(worker)};
  const metadata = ${JSON.stringify(metadata)};
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.mjs', new Blob([code], { type: 'application/javascript+module' }), 'worker.mjs');
  const r = await cloudflare.request({ method: 'PUT', path: \`/accounts/\${accountId}/workers/scripts/${cfg.scriptName}\`, body: form });
  const s = await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/workers/scripts/${cfg.scriptName}/subdomain\`, body: { enabled: true, previews_enabled: false } });
  return { success: r.success, id: r.result && r.result.id, bytes: code.length, subdomain: s.result };
}`;
mkdirSync(join(site, 'dist'), { recursive: true });
writeFileSync(join(site, 'dist/worker.mjs'), worker);
writeFileSync(join(site, 'dist/mcp-deploy.js'), deploy);
console.log(`files: ${Object.keys(files).length}, worker: ${(worker.length / 1024).toFixed(0)} KiB -> infra/cloudflare-site/dist/`);
