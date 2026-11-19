import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../lib/messages/en.json';
import sw from '../lib/messages/sw.json';
import { DICTS, translate } from '../lib/i18n';
import { bps, kesFromCents, parseKesInput } from '../lib/money';
import { BANK_FUNDED_A_PRICING, quote, STANDARD_PRICING } from '@mapema/pricing';

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });

describe('i18n (Swahili-ready)', () => {
  it('en and sw have exactly the same keys and no empty strings', () => {
    expect(Object.keys(sw).sort()).toEqual(Object.keys(en).sort());
    for (const d of Object.values(DICTS)) for (const v of Object.values(d)) expect(v.trim()).not.toBe('');
  });
  it('every t("key") used in the UI exists in both dictionaries', () => {
    const used = new Set<string>();
    for (const f of [...walk(join(__dirname, '../app')), ...walk(join(__dirname, '../components'))])
      for (const m of readFileSync(f, 'utf8').matchAll(/\bt\('([a-z][a-zA-Z]*\.[a-zA-Z.]+)'\)/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(30);
    for (const k of used) { expect(en, k).toHaveProperty([k]); expect(sw, k).toHaveProperty([k]); }
  });
  it('interpolates params and falls back to the key', () => {
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
});

describe('money input and display', () => {
  it('parses KES input to integer cents exactly', () => {
    expect(parseKesInput('1,000,000')).toBe(100000000n);
    expect(parseKesInput('KES 50,000.5')).toBe(5000050n);
    expect(parseKesInput('0.01')).toBe(1n);
  });
  it('rejects floats beyond cents, negatives and junk', () => {
    for (const bad of ['1.001', '-5', 'abc', '', '1e6', '12345678901234']) expect(parseKesInput(bad)).toBeNull();
  });
  it('formats cents and bps', () => {
    expect(kesFromCents('100000000')).toContain('1,000,000.00');
    expect(kesFromCents(null)).toBe('-');
    expect(bps(4496)).toBe('44.96%');
  });
});

describe('public fee calculator uses the same engine as the API', () => {
  it('direct-legacy worked example is still available on that profile', () => {
    const q = quote(100000000n, 48, STANDARD_PRICING);
    expect(q.advanceCents).toBe(80000000n);
    expect(q.discountFeeCents).toBe(4480000n);
    expect(q.totalCostCents).toBe(4730000n);
    expect(q.aprBps).toBe(4496);
    expect(q.supplierBalanceCents).toBe(15270000n);
  });
  it('bank-funded-A is the public default: KES 1,000,000 for 48 days is 19,200 + 5,000 = 24,200', () => {
    const q = quote(100000000n, 48, BANK_FUNDED_A_PRICING);
    expect(q.advanceCents).toBe(80000000n);
    expect(q.discountFeeCents).toBe(1920000n);
    expect(q.processingFeeCents).toBe(500000n);
    expect(q.totalCostCents).toBe(2420000n);
    expect(q.supplierBalanceCents).toBe(17580000n);
    expect(q.aprBps).toBe(2300);
    expect(q.billedBy).toBe('funding_bank');
  });
  it('public English and Kiswahili copy does not advertise the legacy worked example', () => {
    const blob = `${JSON.stringify(en)}
${JSON.stringify(sw)}`;
    for (const s of ['44,800', '47,300', '152,700', '3.5%', '44.96', 'KES 2,500']) {
      expect(blob, s).not.toContain(s);
    }
  });
});
