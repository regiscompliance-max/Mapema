// [QA] Phase 2 browser check + screenshots of the demo month (SEED_DEMO_MONTH=YYYY-MM via scripts/smoke-stack.sh).
// Staff overview at 390 px and desktop (1440), the reconciliation / collections / reports screens, the buyer and supplier
// dashboards, the auditor read-only view, and an axe-core scan (serious/critical) of each screen.
// Usage: WEB_URL=http://localhost:3000 SHOTS_DIR=/path node scripts/phase2-shots.mjs  (playwright-core + axe-core on NODE_PATH)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const AXE = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const W = process.env.WEB_URL ?? 'http://localhost:3000';
const OUT = process.env.SHOTS_DIR ?? '/tmp/phase-2-shots';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = []; const axeFindings = []; const errors = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 160) });
async function session(email, factor, width) {
  const ctx = await b.newContext({ viewport: { width, height: width < 600 ? 844 : 900 } });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('response', (r) => r.status() === 404 && errors.push(`404 ${r.url()}`));
  await p.goto(`${W}/signin`); await p.fill('input[name=email]', email); await p.selectOption('select[name=factor]', factor);
  await p.click('form button'); await p.waitForURL('**/app'); await p.waitForSelector('[role=tablist]');
  return p;
}
async function axe(p, label) {
  await p.addScriptTag({ content: AXE });
  const r = await p.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations
    .filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, target: v.nodes[0]?.target?.join(' ') })));
  for (const v of r) axeFindings.push({ screen: label, ...v });
}
const tab = (p, label) => p.click(`[role=tab]:has-text("${label}")`);
const story = (p, id) => p.waitForSelector(`[data-story="${id}"]`, { timeout: 8000 }).then(() => true, () => false);
const shot = (p, f) => p.screenshot({ path: `${OUT}/${f}`, fullPage: true });
const settle = (p) => p.waitForLoadState('networkidle').catch(() => {});

try {
  for (const [w, tag] of [[390, '390'], [1440, 'desktop']]) {
    const p = await session('ceo@mapema.test', 'otp', w);
    check(`staff overview (${tag}) renders DSH-01`, await story(p, 'DSH-01'));
    await p.waitForSelector('text=Outstanding principal'); await settle(p);
    const txt = await p.textContent('[data-story="DSH-01"]');
    check(`staff overview (${tag}) shows the 25/10/35 limits`, /limit 25% of float/.test(txt) && /limit 10% of float/.test(txt) && /limit 35% of float/.test(txt));
    check(`staff overview (${tag}) shows NPL and recourse`, /Non-performing/.test(txt) && /Recourse/.test(txt));
    if (w === 390) { const sw = await p.evaluate(() => document.documentElement.scrollWidth); check('staff overview 390: no horizontal page scroll', sw <= 390, `scrollWidth ${sw}`); }
    await axe(p, `staff overview ${tag}`);
    await shot(p, `staff-dashboard-${tag}.png`);
    await tab(p, 'Reconciliation'); check(`recon screen (${tag})`, await story(p, 'REC-03')); await p.waitForSelector('text=balanced'); await settle(p); await axe(p, `recon ${tag}`); await shot(p, `staff-reconciliation-${tag}.png`);
    await tab(p, 'Collections'); check(`collections screen (${tag})`, await story(p, 'COL-05')); await p.waitForSelector('text=DEMO-INV-0002'); await settle(p); await axe(p, `collections ${tag}`); await shot(p, `staff-collections-${tag}.png`);
    await tab(p, 'Reports'); check(`reports screen (${tag})`, await story(p, 'RPT-01')); await p.waitForSelector('text=2026-10'); await settle(p);
    await p.click('button:has-text("Open") >> nth=0'); check(`reports: snapshot files listed (${tag})`, await p.waitForSelector('text=mapema-lender-pack', { timeout: 8000 }).then(() => true, () => false));
    await axe(p, `reports ${tag}`); await shot(p, `staff-reports-${tag}.png`);
    await p.context().close();
  }
  const buyer = await session('ap@acme.test', 'otp', 390);
  check('buyer dashboard (DSH-02) is the landing tab', await story(buyer, 'DSH-02')); await settle(buyer); await axe(buyer, 'buyer dashboard'); await shot(buyer, 'buyer-dashboard-390.png');
  const sup = await session('finance@juakali.test', 'sms', 390);
  check('supplier dashboard (DSH-03) is the landing tab', await story(sup, 'DSH-03')); await sup.waitForSelector('text=Recourse demands'); await settle(sup); await axe(sup, 'supplier dashboard'); await shot(sup, 'supplier-dashboard-390.png');
  const aud = await session('auditor@mapema.test', 'otp', 390);
  await tab(aud, 'Reports'); check('auditor reads reports without generate buttons', await story(aud, 'RPT-01') && !(await aud.$('button:has-text("Take snapshot")')));
} catch (e) { check('script error', false, e.message); }
await b.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; axe serious/critical: ${axeFindings.length}; console errors: ${errors.length}`);
for (const f of axeFindings) console.log('AXE', JSON.stringify(f));
for (const e of errors.slice(0, 10)) console.log('CONSOLE', e);
process.exit(failed.length || axeFindings.length ? 1 : 0);
