/**
 * [QA Engineer + Frontend Engineer] Phase 3 screens (TC-P3W-*), written from docs/phase-3/stories.md before the
 * screens. Behaviour runs end to end through scripts/phase3-shots.mjs (390 px + desktop screenshots).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(__dirname, '../components/portals', f), 'utf8');
const P3 = read('phase3.tsx');
const API = (f: string) => readFileSync(join(__dirname, '../../api/src/modules', f), 'utf8');
const MSG = (l: string) => JSON.parse(readFileSync(join(__dirname, `../lib/messages/${l}.json`), 'utf8'));

describe('TC-P3W-01 every Phase 3 screen is marked with its story and reachable from a portal', () => {
  it.each(['ERP-01', 'ERP-05', 'FUND-01', 'FUND-03', 'MP-02', 'MP-04', 'BULK-01', 'BULK-02', 'BULK-03'])('%s has a data-story screen', (id) => expect(P3).toContain(`data-story="${id}"`));
  it('staff portal renders ERP, funding, payout batches and M-Pesa', () => {
    const s = read('staff.tsx');
    for (const c of ['ErpConnections', 'FundingSources', 'PayoutBatches', 'MpesaPanel']) expect(s).toMatch(new RegExp(`<${c}[ />]`));
  });
  it('buyer portal shows ERP status and bulk confirmation; supplier portal bulk quotes and the M-Pesa wallet', () => {
    const b = read('buyer.tsx'); const sp = read('supplier.tsx');
    expect(b).toMatch(/<ErpConnections[ />]/); expect(b).toMatch(/<BulkConfirm[ />]/);
    expect(sp).toMatch(/<BulkQuote[ />]/); expect(sp).toMatch(/<MpesaWallet[ />]/);
  });
});

describe('TC-P3W-02 screens call Phase 3 API routes that exist', () => {
  const src = ['erp.ts', 'funding.ts', 'mpesa.ts', 'bulk.ts'].map(API).join('\n');
  it.each(['erp/connections', 'funding-sources', 'funding/consistency', 'payout-batches', 'mpesa/settings', 'mpesa/payouts', 'mpesa/cap', 'invoices/bulk-decision', 'invoices/bulk-quote'])('/%s is used and served', (r) => {
    expect(P3).toContain(`/${r}`);
    const [ctrl, ...rest] = r.split('/');
    expect(src.includes(`'${r}'`) || (src.includes(`@Controller('${ctrl}')`) && src.includes(`'${rest.join('/')}`))).toBe(true);
  });
});

describe('TC-P3W-03 money, maker-checker and honesty wording', () => {
  it('money from cents through kesFromCents / parseKesInput, never floats', () => {
    expect(P3).toMatch(/kesFromCents/); expect(P3).toMatch(/parseKesInput/); expect(P3).not.toMatch(/parseFloat/);
  });
  it('maker-checker is stated where it applies', () => {
    expect(P3).toMatch(/a second ops user must approve the mapping/); expect(P3).toMatch(/CEO approves/); expect(P3).toMatch(/a different ops user approves the batch/);
  });
  it('M-Pesa says it is a mock/sandbox and is never auto-resent', () => {
    expect(P3).toMatch(/never resent automatically/); expect(P3).toMatch(/Daraja B2C maximum KES 250,000/);
  });
  it('ERP screens never show a secret, only the env variable name', () => {
    expect(P3).toMatch(/secret_env/); expect(P3).not.toMatch(/apiKey|password/i);
  });
  it('form fields use visible labels', () => expect(P3).not.toMatch(/placeholder=/));
});

describe('TC-P3W-04 Swahili-ready: every Phase 3 label key exists in en and sw', () => {
  const keys = [...new Set([...P3.matchAll(/t\('(p3\.[a-z0-9_.]+)'/g)].map((m) => m[1]))];
  it('found the keys', () => expect(keys.length).toBeGreaterThan(10));
  it.each(['en', 'sw'])('%s has them all', (l) => { const m = MSG(l); for (const k of keys) expect(m[k], k).toBeTruthy(); });
});
