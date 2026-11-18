/**
 * [QA Engineer] Phase 3 multi-lender funding rules (FUND-02/04/05), written before the code.
 * Pure maths: eligibility, facility utilisation, covenants (pro forma) and source selection.
 * Money is integer cents; ratios are basis points rounded half-up.
 */
import { describe, expect, it } from 'vitest';
import { checkEligibility, covenantStatus, facilityUtilisation, FundingSourceRule, kes, pickFundingSource, validateFundingSource } from '../src';

const FAC_A: FundingSourceRule = {
  code: 'FAC-A', type: 'debt_facility', limitCents: kes(2_000_000), priority: 10, active: true,
  eligibility: { sectorCodes: ['FMCG'], maxTenorDays: 60, maxAdvanceCents: String(kes(1_000_000)), requireEtimsValid: true },
  covenants: { maxBuyerConcentrationBps: 6000, maxNplRatioBps: 500, maxDpd30RatioBps: 1000 },
};
const EQUITY: FundingSourceRule = { code: 'EQUITY', type: 'equity', limitCents: null, priority: 100, active: true, eligibility: {}, covenants: {} };
const cand = (o: Partial<{ buyerId: string; sectorCode: string | null; tenorDays: number; principalCents: bigint; etimsValid: boolean }> = {}) =>
  ({ buyerId: 'acme', sectorCode: 'FMCG', tenorDays: 48, principalCents: kes(800_000), etimsValid: true, ...o });

describe('TC-P3U-FUND-01 eligibility rules', () => {
  it('the worked example (KES 800,000, 48 days, FMCG buyer) is eligible for facility A', () => {
    expect(checkEligibility(FAC_A, cand())).toEqual({ ok: true, reasons: [] });
  });
  it('lists every failed rule: tenor, sector, size, eTIMS, buyer list, inactive', () => {
    expect(checkEligibility(FAC_A, cand({ tenorDays: 61 })).reasons).toEqual(['TENOR_ABOVE_MAX']);
    expect(checkEligibility(FAC_A, cand({ sectorCode: 'CONSTRUCTION' })).reasons).toEqual(['SECTOR_NOT_ELIGIBLE']);
    expect(checkEligibility(FAC_A, cand({ sectorCode: null })).reasons).toEqual(['SECTOR_NOT_ELIGIBLE']);
    expect(checkEligibility(FAC_A, cand({ principalCents: kes(1_000_000) + 1n })).reasons).toEqual(['ADVANCE_ABOVE_MAX']);
    expect(checkEligibility(FAC_A, cand({ principalCents: kes(1_000_000) })).ok).toBe(true); // boundary is inclusive, to the cent
    expect(checkEligibility(FAC_A, cand({ etimsValid: false })).reasons).toEqual(['ETIMS_REQUIRED']);
    const listed = { ...FAC_A, eligibility: { buyerIds: ['other'], excludeSectorCodes: ['FMCG'], minAdvanceCents: String(kes(900_000)) } };
    expect(checkEligibility(listed, cand()).reasons).toEqual(['BUYER_NOT_ELIGIBLE', 'SECTOR_EXCLUDED', 'ADVANCE_BELOW_MIN']);
    expect(checkEligibility({ ...FAC_A, active: false }, cand()).reasons).toEqual(['SOURCE_INACTIVE']);
  });
  it('equity with no rules takes anything', () => {
    expect(checkEligibility(EQUITY, cand({ tenorDays: 120, sectorCode: null, etimsValid: false })).ok).toBe(true);
  });
});

describe('TC-P3U-FUND-02 utilisation and covenants', () => {
  const loans = [
    { sourceCode: 'FAC-A', buyerId: 'acme', outstandingCents: kes(800_000), dpd: 0, npl: false },
    { sourceCode: 'FAC-A', buyerId: 'beta', outstandingCents: kes(150_000), dpd: 35, npl: false },
    { sourceCode: 'FAC-A', buyerId: 'beta', outstandingCents: kes(50_000), dpd: 95, npl: true },
    { sourceCode: 'EQUITY', buyerId: 'acme', outstandingCents: kes(999_999), dpd: 0, npl: false },
  ];
  it('utilisation counts only the facility loans, to the cent, with headroom and basis points', () => {
    expect(facilityUtilisation(FAC_A, loans)).toEqual({ outstandingCents: kes(1_000_000), limitCents: kes(2_000_000), headroomCents: kes(1_000_000), usedBps: 5000, count: 3 });
    expect(facilityUtilisation(EQUITY, loans)).toEqual({ outstandingCents: kes(999_999), limitCents: null, headroomCents: null, usedBps: null, count: 1 });
  });
  it('covenants: buyer concentration against the facility limit, NPL and 30+ DPD against outstanding', () => {
    expect(covenantStatus(FAC_A, loans)).toEqual([
      { code: 'BUYER_CONCENTRATION', limitBps: 6000, actualBps: 4000, ok: true },
      { code: 'NPL_RATIO', limitBps: 500, actualBps: 500, ok: true }, // 50,000 / 1,000,000 = 5.00% exactly: at the limit is not a breach
      { code: 'DPD30_RATIO', limitBps: 1000, actualBps: 2000, ok: false }, // (150,000 + 50,000) / 1,000,000
    ]);
  });
  it('pro forma: adding KES 500,000 for acme pushes concentration to 65% (breach); 400,000 lands exactly on 60%', () => {
    const clean = loans.filter((l) => l.dpd === 0);
    const c1 = covenantStatus(FAC_A, clean, { buyerId: 'acme', principalCents: kes(500_000) });
    expect(c1.find((c) => c.code === 'BUYER_CONCENTRATION')).toEqual({ code: 'BUYER_CONCENTRATION', limitBps: 6000, actualBps: 6500, ok: false });
    const c2 = covenantStatus(FAC_A, clean, { buyerId: 'acme', principalCents: kes(400_000) });
    expect(c2.find((c) => c.code === 'BUYER_CONCENTRATION')!.ok).toBe(true);
    expect(covenantStatus(FAC_A, [], undefined).map((c) => c.actualBps)).toEqual([0, 0, 0]); // empty facility: no division by zero
  });
});

describe('TC-P3U-FUND-03 picking a source', () => {
  it('lowest priority number first; falls through on eligibility, headroom and pro forma covenants', () => {
    expect(pickFundingSource([EQUITY, FAC_A], cand(), []).code).toBe('FAC-A');
    expect(pickFundingSource([EQUITY, FAC_A], cand({ tenorDays: 90 }), []).code).toBe('EQUITY');
    const full = [{ sourceCode: 'FAC-A', buyerId: 'beta', outstandingCents: kes(1_500_000), dpd: 0, npl: false }];
    const r = pickFundingSource([EQUITY, FAC_A], cand(), full); // 1.5m + 0.8m > 2m limit
    expect(r.code).toBe('EQUITY');
    expect(r.evaluations.find((e) => e.code === 'FAC-A')!.reasons).toEqual(['FACILITY_LIMIT']);
    const conc = [{ sourceCode: 'FAC-A', buyerId: 'acme', outstandingCents: kes(500_000), dpd: 0, npl: false }];
    expect(pickFundingSource([EQUITY, FAC_A], cand(), conc).evaluations.find((e) => e.code === 'FAC-A')!.reasons).toEqual(['COVENANT_BUYER_CONCENTRATION']);
  });
  it('a preferred source is evaluated alone: no silent fallback when credit names one', () => {
    const r = pickFundingSource([EQUITY, FAC_A], cand({ tenorDays: 90 }), [], 'FAC-A');
    expect(r.code).toBeNull();
    expect(r.evaluations).toEqual([{ code: 'FAC-A', ok: false, reasons: ['TENOR_ABOVE_MAX'] }]);
    expect(pickFundingSource([EQUITY, FAC_A], cand(), [], 'NOPE').evaluations).toEqual([{ code: 'NOPE', ok: false, reasons: ['SOURCE_UNKNOWN'] }]);
  });
  it('no eligible source returns null with every reason', () => {
    const r = pickFundingSource([FAC_A], cand({ tenorDays: 90 }), []);
    expect(r).toEqual({ code: null, evaluations: [{ code: 'FAC-A', ok: false, reasons: ['TENOR_ABOVE_MAX'] }] });
  });
  it('validates a source definition', () => {
    expect(validateFundingSource(FAC_A)).toEqual([]);
    expect(validateFundingSource({ ...FAC_A, code: 'fac a', limitCents: -1n, priority: -1, covenants: { maxNplRatioBps: 20_000 } })).toEqual(['code', 'limitCents', 'priority', 'covenants.maxNplRatioBps']);
    expect(validateFundingSource({ ...FAC_A, type: 'debt_facility', limitCents: null })).toEqual(['limitCents']); // a debt facility needs a limit
  });
});
