// [QA] Phase 1b browser smoke of the seeded demo world at phone width (390x844).
// Covers: public site + Swahili; cookie sign-in (httpOnly/Secure/SameSite=Strict, nothing in storage, CSRF enforced,
// survives reload, logout); the worked example (quote+disclosure, credit approve, ops release); every Phase 1b screen;
// and an axe-core accessibility scan (serious/critical) of each screen visited.
// Needs: API + web running (web built with NEXT_PUBLIC_DEV_SIGNIN=true), fresh `npm run db:seed` with SEED_API_URL,
// playwright-core + axe-core resolvable (NODE_PATH) and a Chrome binary.
// Usage: WEB_URL=http://localhost:3000 API_URL=http://localhost:4000 node scripts/ui-smoke.mjs
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const AXE = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const W = process.env.WEB_URL ?? 'http://localhost:3000';
const A = process.env.API_URL ?? 'http://localhost:4000';
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = []; const errors = []; const axeFindings = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 160) }); };
async function newPage() {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return p;
}
async function axe(p, label) {
  await p.addScriptTag({ content: AXE });
  const r = await p.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations
    .filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, target: v.nodes[0]?.target?.join(' ') })));
  for (const v of r) axeFindings.push({ screen: label, ...v });
}
async function signin(p, email, factor = 'otp') {
  await p.goto(`${W}/signin`); await p.fill('input[name=email]', email); await p.selectOption('select[name=factor]', factor);
  await p.click('form button'); await p.waitForURL('**/app'); await p.waitForSelector('[role=tablist]');
}
const tab = async (p, label) => { await p.click(`[role=tab]:has-text("${label}")`); };
const status = async (p) => { await p.waitForFunction(() => document.querySelector('[role=status],[role=alert]')?.textContent, null, { timeout: 10000 }); return p.textContent('[role=status],[role=alert]'); };
const story = async (p, id) => p.waitForSelector(`[data-story="${id}"]`, { timeout: 8000 }).then(() => true, () => false);
const api = async (path, body) => (await fetch(`${A}/v1${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();

let p;
try {
// ---------------- public
p = await newPage();
await p.goto(W); check('public: home has a heading', (await p.textContent('h1'))?.length > 5);
await axe(p, 'home');
await p.goto(`${W}/pricing`); check('public: pricing shows the worked example (KES 44,800)', (await p.content()).includes('44,800'));
const en = await p.textContent('h1').catch(() => '');
await p.goto(`${W}/lang?to=sw`).catch(() => {}); await p.goto(`${W}/pricing`); check('public: Swahili toggle changes the page', (await p.textContent('h1')) !== en);
await p.goto(`${W}/lang?to=en`).catch(() => {});

// ---------------- supplier: cookie session + worked example + Phase 1b supplier screens
p = await newPage();
await signin(p, 'finance@juakali.test', 'sms');
const cookies = await p.context().cookies(A);
const sid = cookies.find((c) => c.name === 'mapema_sid');
check('session: mapema_sid cookie is HttpOnly + Secure + SameSite=Strict', sid && sid.httpOnly && sid.secure && sid.sameSite === 'Strict', JSON.stringify(sid && { httpOnly: sid.httpOnly, secure: sid.secure, sameSite: sid.sameSite }));
const storage = await p.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), js: document.cookie }));
check('session: no token in localStorage/sessionStorage; cookie not readable by JS', storage.local.length === 0 && storage.session.length === 0 && !storage.js.includes('mapema_sid'), JSON.stringify(storage));
const csrf = await p.evaluate(async (a) => { const r = await fetch(`${a}/v1/complaints`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'other', description: 'csrf probe' }) }); return [r.status, (await r.json()).title]; }, A);
check('session: a write without the CSRF header is refused (403 CSRF_FAILED)', csrf[0] === 403 && csrf[1] === 'CSRF_FAILED', csrf.join(' '));
await p.waitForSelector('text=DEMO-INV-0001');
await axe(p, 'supplier invoices');
await p.click('button:has-text("Get paid")');
await p.waitForSelector('#offer-h');
const offer = await p.textContent('section');
check('SUP-07: offer shows 800,000 / 44,800 / 152,700', ['800,000.00', '44,800.00', '152,700.00'].every((x) => offer.includes(x)));
await p.click('summary:has-text("How early repayment")');
check('SUP-14: early repayment / recourse explained inside the offer', await story(p, 'SUP-14'));
await axe(p, 'supplier offer');
await p.check('#offer-h ~ label input[type=checkbox], section input[type=checkbox]');
await p.click('section .flex button.btn');
check('SUP-07: accept', /Requested/.test(await status(p)));
await p.reload(); await p.waitForSelector('[role=tablist]');
await tab(p, 'Privacy');
check('SUP-03: consent screen', await story(p, 'SUP-03'));
await p.click('li:has-text("News and offers") button:has-text("I agree")');
const cs = await status(p); check('session: after a page reload the CSRF token is restored (consent saved)', /Consent recorded/.test(cs), cs);
check('SUP-13: my data view shows the business', await story(p, 'SUP-13') && (await p.textContent('[data-story="SUP-13"]')).includes('Jua Kali Packaging Ltd'));
await axe(p, 'supplier privacy');
await tab(p, 'Add invoice');
check('SUP-06: supplier add-invoice form lists the buyer', await story(p, 'SUP-06') && await p.waitForSelector('[data-story="SUP-06"] option:has-text("Acme")', { state: 'attached', timeout: 8000 }).then(() => true, () => false));
await axe(p, 'supplier add invoice');
await tab(p, 'Account');
check('SUP-02: document upload on the account screen', await story(p, 'SUP-02'));
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
await p.setInputFiles('[data-story="SUP-02"] input[type=file]', { name: 'cr12.pdf', mimeType: 'application/pdf', buffer: pdf });
await p.selectOption('[data-story="SUP-02"] select[name=type]', 'cr12');
await p.click('[data-story="SUP-02"] form button');
check('SUP-02: upload a PDF', /Uploaded/.test(await status(p)));
await p.waitForSelector('[data-story="SUP-02"] td:has-text("cr12.pdf")', { timeout: 5000 }).catch(() => {});
check('SUP-02: uploaded file listed', (await p.textContent('[data-story="SUP-02"]')).includes('cr12.pdf'));
await axe(p, 'supplier account');
await tab(p, 'Advance'); check('D-22: supplier sees the unpaid-balance (shortfall) section', await story(p, 'SHORTFALL'));

// ---------------- credit
p = await newPage(); await signin(p, 'credit@mapema.test');
await tab(p, 'Advance'); await p.waitForSelector('text=DEMO-INV-0001');
await p.click('button:has-text("Approve")'); const ap = await status(p); check('CRD-08: credit approves', /Approved/.test(ap), ap);
await tab(p, 'Organisation').catch(async () => tab(p, 'Org'));
await p.click('tr:has-text("Acme") button:has-text("Open credit file")');
check('CRD-01: buyer credit file', await story(p, 'CRD-01'));
check('CRD-03: programme proposal form', await story(p, 'CRD-03'));
await axe(p, 'credit file (buyer)');
await p.click('button:has-text("Back to list")');
await p.click('tr:has-text("Jua Kali") button:has-text("Open credit file")');
check('CRD-04: supplier credit file with per-buyer limit', await story(p, 'CRD-04') && await p.waitForSelector('[data-story="CRD-04"] button:has-text("Set limit")', { timeout: 8000 }).then(() => true, () => false));
await tab(p, 'Review tasks'); check('CRD-07: review tasks screen', await story(p, 'CRD-07'));
await p.click('button:has-text("Check now")'); check('CRD-07: run the reminder check', /Checked/.test(await status(p)));
await axe(p, 'review tasks');
await tab(p, 'Write-offs'); check('ADM-07: write-off screen (credit)', await story(p, 'ADM-07'));

// ---------------- ops: release, then the buyer pays (mock bank)
p = await newPage(); await signin(p, 'ops@mapema.test');
await tab(p, 'Advance'); await p.waitForSelector('text=Release payment');
const checks = await p.textContent('table');
check('CRD-06: release-time checks all green (incl. PROGRAMME_IN_REVIEW_DATE, KYC_CURRENT)', !checks.includes('✗') && checks.includes('KYC_CURRENT') && checks.includes('PROGRAMME_IN_REVIEW_DATE'));
await api('/dev/bank/fund', { amountCents: '1000000000' }); // the mock bank keeps balances in API memory
await p.click('button:has-text("Release payment")'); const rs = await status(p); check('OPS-02: ops release', /Released/.test(rs), rs);
await api('/dev/jobs/run', {});
await tab(p, 'Payment'); check('D-22: ops sees shortfalls on the payments screen', await story(p, 'SHORTFALL'));
await axe(p, 'ops payments');

// ---------------- buyer
p = await newPage(); await signin(p, 'ap@acme.test');
await tab(p, 'calendar').catch(() => tab(p, 'Calendar')).catch(() => {});
const cal = await p.waitForSelector('text=Pay financed invoices to', { timeout: 8000 }).then(() => p.textContent('.card'), () => '');
check('BUY-10: payment calendar shows where to pay', cal.includes('Account'));
const acct = (await p.textContent('.card .font-mono').catch(() => ''))?.trim();
if (acct) {
  await api('/dev/bank/credit', { accountNo: acct, amountCents: '100000000', bankRef: `SMOKE-${Date.now()}`, valueDate: new Date().toISOString().slice(0, 10), payerName: 'Acme Supermarkets Ltd', narrative: 'DEMO-INV-0001' });
}
await tab(p, 'Programme'); check('BUY-13: programme limit and utilisation', await story(p, 'BUY-13') && (await p.textContent('[data-story="BUY-13"]')).includes('In use'));
await axe(p, 'buyer programme');
await tab(p, 'Documents');
check('BUY-09: notice of assignment listed', await story(p, 'BUY-09') && await p.waitForSelector('[data-story="BUY-09"] td:has-text("notice-DEMO-INV-0001.pdf")', { timeout: 8000 }).then(() => true, () => false));
const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 8000 }).catch(() => null), p.click('[data-story="BUY-09"] button:has-text("Download")').catch(() => {})]);
check('BUY-09: notice downloads as a PDF', dl && dl.suggestedFilename() === 'notice-DEMO-INV-0001.pdf', dl?.suggestedFilename());
check('BUY-12: receipt listed after the buyer paid', await p.waitForSelector('[data-story="BUY-12"] td:has-text("receipt-")', { timeout: 8000 }).then(() => true, () => false));
check('BUY-02: KYB upload for the buyer admin', await story(p, 'BUY-02') && Boolean(await p.$('[data-story="BUY-02"] input[type=file]')));
await axe(p, 'buyer documents');
await tab(p, 'Confirm'); check('BUY-07: hold / release-hold screen', await story(p, 'BUY-07'));

// ---------------- compliance: DSR
await api('/public/data-requests', { email: 'smoke-dsr@example.com', type: 'access' });
p = await newPage(); await signin(p, 'compliance@mapema.test');
await tab(p, 'Compliance'); check('OPS-12: DSR screen', await story(p, 'OPS-12'));
await p.click('[data-story="OPS-12"] tr:has-text("smoke-dsr@example.com") button:has-text("Update")');
await p.selectOption('[data-story="OPS-12"] select[name=status]', 'verifying'); await p.check('[data-story="OPS-12"] input[name=idv]');
await p.click('[data-story="OPS-12"] form button.btn'); check('OPS-12: DSR status updated', /updated/.test(await status(p)));
await axe(p, 'compliance');

// ---------------- admin
p = await newPage(); await signin(p, 'admin@mapema.test');
await tab(p, 'Staff'); check('ADM-01: staff list shows credit@mapema.test', await story(p, 'ADM-01') && (await p.waitForSelector('[data-story="ADM-01"] td:has-text("credit@mapema.test")', { timeout: 8000 }).then(() => true, () => false)));
await axe(p, 'staff admin');
await tab(p, 'Settings'); check('ADM-03: float and limits forms', await story(p, 'ADM-03'));
await axe(p, 'settings');

// ---------------- auditor + logout
p = await newPage(); await signin(p, 'auditor@mapema.test'); await p.waitForSelector('text=DEMO-INV-0001');
await tab(p, 'Audit'); await p.waitForSelector('text=intact'); check('SYS-02: audit hash chain intact', true);
await p.click('button:has-text("Sign out")').catch(async () => p.click('header button.underline, div > button.underline'));
await p.waitForURL((u) => !u.pathname.startsWith('/app'), { timeout: 8000 }).catch(() => {});
const after = (await p.context().cookies(A)).find((c) => c.name === 'mapema_sid');
await p.goto(`${W}/app`); await p.waitForURL('**/signin', { timeout: 8000 }).catch(() => {});
check('session: sign out clears the cookie and /app goes back to sign-in', !after?.value && p.url().endsWith('/signin'), p.url());

} catch (e) { check(`smoke aborted: ${e.message.split('\n')[0]}`, false); }
const realErrors = errors.filter((e) => !/401|403|Failed to load resource/.test(e));
check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
check('accessibility: no serious/critical axe (WCAG 2 A/AA) violations on the screens visited', axeFindings.length === 0, JSON.stringify(axeFindings.slice(0, 4)));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -- ${r.detail}`}`);
if (axeFindings.length) console.log('axe findings:', JSON.stringify(axeFindings, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
await b.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
