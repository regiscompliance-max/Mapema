// [QA] Browser smoke of the seeded demo world (mobile viewport 390x844): public site, Swahili toggle, supplier quote+accept with full disclosure,
// credit approval, ops release (different person), auditor chain check, buyer calendar. Needs: API + web running in dev mode,
// fresh `npm run db:seed` with SEED_API_URL, `npm i -D playwright-core` (or global) and a Chrome binary. Usage: WEB_URL=http://localhost:3000 node scripts/ui-smoke.mjs
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const W = process.env.WEB_URL ?? 'http://localhost:3000';
const out = [];
const errors = [];
async function page() { const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage(); p.on('console', (m) => m.type() === 'error' && errors.push(m.text())); return p; }
async function signin(p, email, factor = 'otp') {
  await p.goto(`${W}/signin`); await p.fill('input[name=email]', email); await p.selectOption('select[name=factor]', factor);
  await p.click('form button'); await p.waitForURL('**/app'); await p.waitForSelector('[role=tablist]');
}
let p = await page();
await p.goto(W); out.push(['home h1', await p.textContent('h1')]);
await p.goto(`${W}/pricing`); out.push(['pricing has worked example', (await p.content()).includes('44,800')]);
await p.goto(`${W}/lang?to=sw`).catch(() => {}); await p.goto(W); out.push(['home h1 (sw?)', await p.textContent('h1')]);
await p.screenshot({ path: './ui-smoke-home.png' });
p = await page();
await signin(p, 'finance@juakali.test', 'sms');
await p.waitForSelector('text=DEMO-INV-0001');
await p.click('button:has-text("Get paid")').catch(async () => { await p.click('td button'); });
await p.waitForSelector('#offer-h');
const offer = await p.textContent('section');
out.push(['offer shows 800,000 / 44,800 / 152,700', ['800,000.00', '44,800.00', '152,700.00'].every((x) => offer.includes(x))]);
await p.screenshot({ path: './ui-smoke-offer.png', fullPage: true });
await p.check('section input[type=checkbox]'); await p.click('section button.btn');
await p.waitForSelector('[role=status]'); out.push(['accept', await p.textContent('[role=status]')]);
p = await page();
await signin(p, 'credit@mapema.test');
await p.click('[role=tab]:has-text("Advance")').catch(async () => { const tabs = await p.$$('[role=tab]'); await tabs[2].click(); });
await p.waitForSelector('text=DEMO-INV-0001');
await p.click('button:has-text("Approve")'); await p.waitForFunction(() => document.querySelector('[role=status],[role=alert]')?.textContent);
out.push(['credit approve', await p.textContent('[role=status],[role=alert]')]);
p = await page();
await signin(p, 'ops@mapema.test');
const tabs = await p.$$eval('[role=tab]', (t) => t.map((x) => x.textContent)); out.push(['ops tabs', tabs.join('|')]);
await (await p.$$('[role=tab]'))[2].click(); await p.waitForSelector('text=Release payment');
const checks = await p.textContent('table'); out.push(['release checks all green', !checks.includes('✗') && checks.includes('PAYOUT_ACCOUNT_VERIFIED')]);
await p.click('button:has-text("Release payment")'); await p.waitForFunction(() => document.querySelector('[role=status],[role=alert]')?.textContent);
out.push(['ops release', (await p.textContent('[role=status],[role=alert]')).slice(0, 200)]);
await p.screenshot({ path: './ui-smoke-ops.png', fullPage: true });
p = await page(); await signin(p, 'auditor@mapema.test'); await p.waitForSelector('text=DEMO-INV-0001'); out.push(['auditor portfolio', 'ok']);
await (await p.$$('[role=tab]'))[1].click(); await p.waitForSelector('text=intact'); out.push(['audit chain', await p.textContent('p:has-text("Hash chain")')]);
p = await page(); await signin(p, 'ap@acme.test'); out.push(['buyer tabs', (await p.$$eval('[role=tab]', (t) => t.map((x) => x.textContent))).join('|')]);
await (await p.$$('[role=tab]'))[3].click(); await p.waitForSelector('text=Pay financed invoices to'); out.push(['buyer calendar', (await p.textContent('.card')).slice(0, 80)]);
for (const o of out) console.log(...o);
console.log('console errors:', errors.length, errors.slice(0, 5));
await b.close();
