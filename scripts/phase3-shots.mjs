// [QA] Phase 3 browser check + screenshots of the growth demo (SEED_DEMO_GROWTH=true via scripts/smoke-stack.sh).
// Funding sources, ERP connections, M-Pesa, payout batch (maker-checker approve by ops2), buyer ERP + bulk confirm, supplier
// bulk quote + M-Pesa wallet, at 390 px and desktop (1440), with an axe-core scan (serious/critical) of each screen.
// Usage: WEB_URL=http://localhost:3000 SHOTS_DIR=/path node scripts/phase3-shots.mjs  (playwright-core + axe-core on NODE_PATH)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const AXE = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const W = process.env.WEB_URL ?? 'http://localhost:3000';
const OUT = process.env.SHOTS_DIR ?? '/tmp/phase-3-shots';
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
    await tab(p, 'Funding'); check(`funding sources (${tag}) FUND-01`, await story(p, 'FUND-01')); await p.waitForSelector('text=FAC-A'); await settle(p);
    const ft = await p.textContent('[data-story="FUND-01"]');
    check(`funding (${tag}) shows utilisation, covenants and the Fineract consistency check`, /Headroom/.test(ft) && /buyer concentration/.test(ft) && /Fineract tag check/.test(ft));
    if (w === 390) { const sw = await p.evaluate(() => document.documentElement.scrollWidth); check('funding 390: no horizontal page scroll', sw <= 390, `scrollWidth ${sw}`); }
    await axe(p, `funding ${tag}`); await shot(p, `staff-funding-${tag}.png`);
    await tab(p, 'ERP'); check(`ERP connections (${tag}) ERP-01`, await story(p, 'ERP-01')); await p.waitForSelector('text=Acme Odoo'); await settle(p);
    await p.click('button:has-text("Imported records") >> nth=0'); check(`ERP items + mapping (${tag}) ERP-05`, await story(p, 'ERP-05')); await p.waitForSelector('text=SUPPLIER_NOT_LINKED'); await settle(p);
    check(`ERP (${tag}) never shows the key, only the env name`, !(await p.content()).includes('demo-only-not-a-real-key') && (await p.content()).includes('ERP_SECRET_DEMO_ODOO'));
    if (w === 390) { const sw = await p.evaluate(() => document.documentElement.scrollWidth); check('ERP 390: no horizontal page scroll', sw <= 390, `scrollWidth ${sw}`); }
    await axe(p, `erp ${tag}`); await shot(p, `staff-erp-${tag}.png`);
    await tab(p, 'M-Pesa'); check(`M-Pesa panel (${tag}) MP-02/MP-04`, await story(p, 'MP-02') && await story(p, 'MP-04')); await p.waitForSelector('text=completed'); await settle(p);
    await axe(p, `mpesa ${tag}`); await shot(p, `staff-mpesa-${tag}.png`);
    await p.context().close();
    const o = await session('ops2@mapema.test', 'otp', w);
    await tab(o, 'Payout batches'); check(`payout batches (${tag}) BULK-03`, await story(o, 'BULK-03')); await o.waitForSelector('text=DEMO ERP batch'); await settle(o);
    await o.click('button:has-text("Open") >> nth=0'); await o.waitForSelector('text=ODOO-DEMO-1'); await settle(o);
    if (w === 390) { const sw = await o.evaluate(() => document.documentElement.scrollWidth); check('payout batch 390: no horizontal page scroll', sw <= 390, `scrollWidth ${sw}`); }
    await axe(o, `batches ${tag}`); await shot(o, `staff-payout-batch-pending-${tag}.png`);
    if (w === 1440) {
      await o.click('button:has-text("Approve batch and release")'); await o.waitForSelector('text=Batch processed', { timeout: 15000 }); await settle(o);
      const bt = await o.textContent('[data-story="BULK-03"]');
      check('ops2 approves the batch: every item released', /completed/.test(bt) && !/failed/.test(bt), bt.slice(0, 120));
      await shot(o, `staff-payout-batch-released-${tag}.png`);
    }
    await o.context().close();
  }
  for (const [w, tag] of [[390, '390'], [1440, 'desktop']]) {
    const buyer = await session('ap@acme.test', 'otp', w);
    await tab(buyer, 'ERP'); check(`buyer ERP status (${tag})`, await story(buyer, 'ERP-01')); await buyer.waitForSelector('text=Acme Odoo'); await settle(buyer);
    check(`buyer cannot add connections (${tag})`, !(await buyer.$('summary:has-text("Add ERP connection")')));
    await axe(buyer, `buyer erp ${tag}`); await shot(buyer, `buyer-erp-${tag}.png`);
    await buyer.context().close();
    const chk = await session('checker@acme.test', 'otp', w);
    await tab(chk, 'Bulk confirm'); check(`buyer bulk confirm (${tag}) BULK-01`, await story(chk, 'BULK-01')); await settle(chk);
    await axe(chk, `buyer bulk ${tag}`); await shot(chk, `buyer-bulk-confirm-${tag}.png`);
    await chk.context().close();
    const sup = await session('finance@juakali.test', 'sms', w);
    await tab(sup, 'Bulk quotes'); check(`supplier bulk quotes (${tag}) BULK-02`, await story(sup, 'BULK-02')); await sup.waitForSelector('text=DEMO-INV-0001'); await settle(sup);
    await sup.click('[data-story="BULK-02"] input[type=checkbox] >> nth=0'); await sup.click('button:has-text("Get quotes")'); await sup.waitForSelector('text=Accept all quotes'); await settle(sup);
    const qt = await sup.textContent('[data-story="BULK-02"]');
    check(`bulk quote (${tag}) shows the worked example 800,000 advance and 47,300 cost`, /800,000/.test(qt) && /47,300/.test(qt), qt.slice(-200));
    if (w === 390) { const sw = await sup.evaluate(() => document.documentElement.scrollWidth); check('bulk quote 390: no horizontal page scroll', sw <= 390, `scrollWidth ${sw}`); }
    await axe(sup, `supplier bulk ${tag}`); await shot(sup, `supplier-bulk-quote-${tag}.png`);
    await tab(sup, 'Account'); check(`supplier M-Pesa wallet (${tag}) MP-01`, await story(sup, 'MP-01')); await settle(sup);
    await axe(sup, `supplier wallet ${tag}`); await shot(sup, `supplier-mpesa-wallet-${tag}.png`);
    await sup.context().close();
  }
} catch (e) { check('script error', false, e.message); }
await b.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; axe serious/critical: ${axeFindings.length}; console errors: ${errors.length}`);
for (const f of axeFindings) console.log('AXE', JSON.stringify(f));
for (const e of errors.slice(0, 10)) console.log('CONSOLE', e);
process.exit(failed.length || axeFindings.length ? 1 : 0);
