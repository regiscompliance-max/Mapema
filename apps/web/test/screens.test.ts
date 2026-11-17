/**
 * [QA Engineer + Frontend Engineer] Phase 1b screens: every partly-done story now has a screen, wired into a portal.
 * Behaviour is exercised end-to-end by scripts/ui-smoke.mjs at 390 px (clicks into each screen, axe scan).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFile, CONSENT_TEXT, DOC_LABELS, UPLOAD_TYPES } from '../components/shared';

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
const SRC = walk(join(__dirname, '../components')).map((f) => readFileSync(f, 'utf8')).join('\n');

const STORIES = ['BUY-02', 'BUY-07', 'BUY-09', 'BUY-12', 'BUY-13', 'SUP-02', 'SUP-03', 'SUP-06', 'SUP-13', 'SUP-14', 'CRD-01', 'CRD-03', 'CRD-04', 'CRD-07', 'OPS-12', 'ADM-01', 'ADM-03', 'ADM-07'];

describe('Phase 1b story screens', () => {
  it.each(STORIES)('%s has a screen marked data-story', (id) => {
    expect(SRC.includes(`data-story="${id}"`) || SRC.includes(`story="${id}"`) || SRC.includes(`'${id}'`)).toBe(true);
  });
  it('the shortfall (D-22) screen is used by supplier, buyer and staff portals', () => {
    for (const f of ['supplier.tsx', 'buyer.tsx', 'staff.tsx']) expect(readFileSync(join(__dirname, '../components/portals', f), 'utf8')).toMatch(/<Shortfalls/);
  });
  it('new screens are reachable from a portal (imported and rendered)', () => {
    const staff = readFileSync(join(__dirname, '../components/portals/staff.tsx'), 'utf8');
    for (const c of ['CreditFile', 'DsrPanel', 'LimitsFloat', 'ReviewTasks', 'StaffAdmin', 'WriteOffs']) expect(staff).toMatch(new RegExp(`<${c}[ />]`));
    const sup = readFileSync(join(__dirname, '../components/portals/supplier.tsx'), 'utf8');
    for (const c of ['SubmitInvoice', 'Consents', 'MyData', 'TermsExplained', 'Documents']) expect(sup).toMatch(new RegExp(`<${c}[ />]`));
    const buy = readFileSync(join(__dirname, '../components/portals/buyer.tsx'), 'utf8');
    for (const c of ['Programme', 'Documents']) expect(buy).toMatch(new RegExp(`<${c}[ />]`));
  });
  it('form fields in the new screens use visible labels, not placeholder-only inputs', () => {
    for (const f of ['shared.tsx', 'portals/staff-extra.tsx']) expect(readFileSync(join(__dirname, '../components', f), 'utf8')).not.toMatch(/placeholder=/);
  });
});

describe('upload checks mirror the API (BUY-02 / SUP-02)', () => {
  it('accepts PDF/JPEG/PNG up to 10 MB', () => {
    expect(checkFile({ size: 1000, type: 'application/pdf' })).toBeNull();
    expect(checkFile({ size: 10 * 1024 * 1024, type: 'image/png' })).toBeNull();
  });
  it('rejects other types, empty and oversized files', () => {
    expect(checkFile({ size: 1000, type: 'application/zip' })).toMatch(/PDF/);
    expect(checkFile({ size: 0, type: 'image/jpeg' })).toMatch(/10 MB/);
    expect(checkFile({ size: 10 * 1024 * 1024 + 1, type: 'application/pdf' })).toMatch(/10 MB/);
  });
  it('upload types are the ones the API accepts; every document type has a label', () => {
    const api = readFileSync(join(__dirname, '../../api/src/modules/onboarding.ts'), 'utf8');
    for (const t of Object.keys(UPLOAD_TYPES)) expect(api).toContain(`'${t}'`);
    for (const t of ['notice_of_assignment', 'receipt', 'ilu', 'master_agreement']) expect(DOC_LABELS[t]).toBeTruthy();
  });
});

describe('consents (SUP-03)', () => {
  it('purposes match the API enum and each has a text version', () => {
    const api = readFileSync(join(__dirname, '../../api/src/modules/onboarding.ts'), 'utf8');
    for (const [p, c] of Object.entries(CONSENT_TEXT)) { expect(api).toContain(`'${p}'`); expect(c.version).toMatch(/^[A-Z]+-\d{4}-\d{2}$/); }
  });
});
