/**
 * [QA Engineer + Frontend Engineer] Phase 2 screens (TC-P2W-*), written from docs/phase-2/stories.md before the
 * screens. Behaviour is exercised end to end by scripts/ui-smoke.mjs (390 px + desktop screenshots, axe scan).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(__dirname, '../components/portals', f), 'utf8');
const P2 = read('phase2.tsx');
const API = (f: string) => readFileSync(join(__dirname, '../../api/src/modules', f), 'utf8');

describe('TC-P2W-01 every Phase 2 screen is marked with its story and reachable from a portal', () => {
  it.each(['DSH-01', 'DSH-02', 'DSH-03', 'REC-03', 'RPT-01', 'RPT-04', 'COL-05', 'COL-06'])('%s has a data-story screen', (id) => expect(P2).toContain(`data-story="${id}"`));
  it('staff portal renders the overview, reconciliation breaks, collections and reports', () => {
    const s = read('staff.tsx');
    for (const c of ['StaffOverview', 'ReconBreaks', 'CollectionsBook', 'Reports']) expect(s).toMatch(new RegExp(`<${c}[ />]`));
  });
  it('buyer and supplier portals open on their dashboard', () => {
    expect(read('buyer.tsx')).toMatch(/useState\('overview'\)[\s\S]*<BuyerDashboard/);
    expect(read('supplier.tsx')).toMatch(/useState\('overview'\)[\s\S]*<SupplierDashboard/);
  });
  it('the auditor can read dashboards, reports and reconciliation but cannot generate or resolve', () => {
    const a = read('auditor.tsx');
    expect(a).toMatch(/<Reports canGenerate=\{false\}/); expect(a).toMatch(/<ReconBreaks canOps=\{false\}/);
  });
});

describe('TC-P2W-02 screens call the Phase 2 API routes that exist', () => {
  const routes = [...P2.matchAll(/(?:useGet<[^>]*>\(|api\()\s*[`'](\/[a-z-]+\/[a-z-]+)/g)].map((m) => m[1]);
  it('found the routes', () => expect(routes.length).toBeGreaterThan(8));
  it.each(['/dashboards/staff', '/reconciliation/runs', '/reconciliation/baseline', '/reports/snapshots', '/reports/templates', '/collections/book', '/collections/policy', '/collections/run'])('%s is used and served', (r) => {
    expect(P2).toContain(r);
    const [ctrl, sub] = r.slice(1).split('/');
    const src = ['dashboards.ts', 'reconciliation.ts', 'regulatory.ts', 'collections.ts'].map(API).join('\n');
    expect(src.includes(`@Controller('${ctrl}')`) ? src.includes(`'${sub}`) : src.includes(`'${ctrl}/${sub}'`)).toBe(true);
  });
});

describe('TC-P2W-03 money, DRAFT and maker-checker wording', () => {
  it('money is rendered from cents through kesFromCents, never from floats', () => {
    expect(P2).toMatch(/kesFromCents/); expect(P2).not.toMatch(/parseFloat|toFixed\(2\)\s*\+\s*' ?KES/);
  });
  it('CBK and CRB outputs are labelled DRAFT / assumed layout', () => {
    expect(P2).toMatch(/CBK monthly return \(DRAFT\)/); expect(P2).toMatch(/CRB data submission \(DRAFT\)/); expect(P2).toMatch(/assumed layout/);
  });
  it('break resolution, baseline, recourse and policy changes say a second person must approve', () => {
    expect(P2).toMatch(/a second ops user must approve/); expect(P2).toMatch(/a second credit user must approve/); expect(P2).toMatch(/CEO approves/);
  });
  it('limits shown are the policy defaults: buyer 25%, supplier 10%, sector 35%', () => {
    for (const l of ['Buyers (limit 25% of float)', 'Suppliers (limit 10% of float)', 'Sectors (limit 35% of float)']) expect(P2).toContain(l);
  });
  it('form fields use visible labels, not placeholder-only inputs', () => expect(P2).not.toMatch(/placeholder=/));
});
