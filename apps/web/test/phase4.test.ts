/**
 * [QA Engineer + Frontend Engineer] Phase 4 screens (TC-P4W-*), written from docs/phase-4-security/stories.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(__dirname, '../components', f), 'utf8');
const P4 = read('portals/phase4.tsx');
const API = (f: string) => readFileSync(join(__dirname, '../../api/src/modules', f), 'utf8');
const MSG = (l: string) => JSON.parse(readFileSync(join(__dirname, `../lib/messages/${l}.json`), 'utf8'));
const site = read('site.tsx');
const notice = readFileSync(join(__dirname, '../app/legal/anti-fraud/page.tsx'), 'utf8');

describe('TC-P4W-01 screens are marked with their story and reachable from a portal', () => {
  it.each(['P4-1', 'P4-6', 'P4-1-file'])('%s has a data-story screen', (id) => expect(P4).toContain(`data-story="${id}"`));
  it('staff portal renders registry search, filing queue and the government-payer flag', () => {
    const s = read('portals/staff.tsx');
    const x = read('portals/staff-extra.tsx');
    expect(s).toMatch(/<RegistrySearchForm[ />]/);
    expect(s).toMatch(/<RegistryFilingQueue[ />]/);
    expect(x).toMatch(/<GovernmentPayerFields[ />]/);
    expect(x).toContain('data-story="P4-8"');
  });
  it('buyer confirmation and bulk confirm collect the goods-received attestation', () => {
    const b = read('portals/buyer.tsx');
    expect(b).toContain('data-story="P4-5"');
    expect(b).toMatch(/goodsReceived/);
    expect(read('portals/phase3.tsx')).toMatch(/goodsReceived/);
  });
});

describe('TC-P4W-02 screens call Phase 4 API routes that exist', () => {
  const ui = P4 + read('portals/staff.tsx') + read('portals/staff-extra.tsx') + read('portals/staff-extra.tsx');
  const src = ['registry.ts', 'onboarding.ts'].map(API).join('\n');
  it('registry search and filing routes', () => {
    expect(ui).toContain('/invoices/${invoiceId}/registry-search');
    expect(ui).toContain('/advances/${advanceId}/registry-filing');
    expect(src).toContain("'invoices/:id/registry-search'");
    expect(src).toContain("'advances/:id/registry-filing'");
  });
  it('ops filing tasks, eTIMS override and government-payer routes', () => {
    expect(ui).toContain('/ops/tasks?kind=registry_filing_due');
    expect(ui).toContain('/invoices/${invoiceId}/etims-override');
    expect(ui).toContain('/organisations/${orgId}/programme');
    expect(src).toContain("'ops/tasks'");
    expect(src).toContain("'invoices/:id/etims-override'");
    expect(src).toContain("'organisations/:id/government-payer'");
  });
});

describe('TC-P4W-03 honesty wording and money handling', () => {
  it('the registry UI says there is no invented API and funding needs a second person', () => {
    expect(P4).toContain("t('p4.search.lead')");
    expect(MSG('en')['p4.search.lead']).toMatch(/no invented registry API/i);
    expect(MSG('en')['p4.search.proposed']).toMatch(/second credit officer/i);
  });
  it('the draft anti-fraud notice still says Mapema is not yet licensed and must not be treated as published', () => {
    expect(notice).toMatch(/not yet licensed by the Central Bank of Kenya/i);
    expect(notice).toMatch(/DRAFT anti-fraud notice/i);
    expect(notice).toMatch(/not a live marketing publication/i);
    expect(site).toContain('/legal/anti-fraud');
    expect(site).toMatch(/not yet licensed by the Central Bank of Kenya/);
  });
  it('form fields use visible labels', () => expect(P4).not.toMatch(/placeholder=/));
});

describe('TC-P4W-04 Swahili-ready: every Phase 4 label key exists in en and sw', () => {
  const keys = [...new Set([...P4.matchAll(/t\('(p4\.[a-z0-9_.]+)'/g)].map((m) => m[1]))];
  it('found the keys', () => expect(keys.length).toBeGreaterThan(10));
  it.each(['en', 'sw'])('%s has them all', (l) => { const m = MSG(l); for (const k of keys) expect(m[k], k).toBeTruthy(); });
});
