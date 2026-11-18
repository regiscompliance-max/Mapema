// [QA] Phase 4 screenshots: anti-fraud draft, buyer confirmation attestation, staff registry / credit file.
// Usage: WEB_URL=http://localhost:3000 SHOTS_DIR=/workspace/mapema/phase-4-shots node scripts/phase4-shots.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const W = process.env.WEB_URL ?? 'http://localhost:3000';
const OUT = process.env.SHOTS_DIR ?? '/workspace/mapema/phase-4-shots';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
async function page(width) {
  const ctx = await b.newContext({ viewport: { width, height: width < 600 ? 844 : 900 } });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return p;
}
const settle = (p) => p.waitForLoadState('networkidle').catch(() => {});
try {
  for (const [w, tag] of [[390, '390'], [1440, 'desktop']]) {
    const p = await page(w);
    await p.goto(`${W}/legal/anti-fraud`, { waitUntil: 'domcontentloaded' });
    await settle(p);
    const body = await p.textContent('body');
    if (!/not yet licensed/i.test(body || '') || !/DRAFT anti-fraud notice/i.test(body || '')) {
      throw new Error(`anti-fraud page missing draft or licence wording (${tag})`);
    }
    await p.screenshot({ path: `${OUT}/anti-fraud-${tag}.png`, fullPage: true });
    await p.context().close();
  }
  // Optional signed-in shots if the demo stack is up
  const trySession = async (email, factor, width, tabLabel, story, file) => {
    const p = await page(width);
    await p.goto(`${W}/signin`);
    if (!(await p.$('input[name=email]'))) { await p.context().close(); return false; }
    await p.fill('input[name=email]', email);
    if (await p.$('select[name=factor]')) await p.selectOption('select[name=factor]', factor);
    await p.click('form button');
    await p.waitForURL('**/app', { timeout: 8000 });
    if (tabLabel) await p.click(`[role=tab]:has-text("${tabLabel}")`);
    if (story) await p.waitForSelector(`[data-story="${story}"]`, { timeout: 8000 });
    await settle(p);
    await p.screenshot({ path: `${OUT}/${file}`, fullPage: true });
    await p.context().close();
    return true;
  };
  try {
    await trySession('checker@acme.test', 'otp', 1440, 'Confirm & sign ILU', 'P4-5', 'buyer-confirm-attestation-desktop.png');
    await trySession('credit@mapema.test', 'otp', 1440, 'Advances', 'P4-1', 'staff-advances-registry-desktop.png');
    await trySession('credit@mapema.test', 'otp', 390, 'Orgs', 'P4-8', 'staff-credit-file-gov-390.png');
  } catch (e) {
    console.log('signed-in shots skipped:', e.message);
  }
  console.log('shots written to', OUT, 'console errors', errors.length);
} finally {
  await b.close();
}
