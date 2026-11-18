/**
 * [Credit Risk + Treasury] Multi-lender funding rules (Phase 3 FUND-02/04/05). PURE: no I/O.
 * A funding source (equity, debt facility A, ...) has eligibility rules and covenants. Every advance
 * is tagged to exactly one source at release. Money is integer cents; ratios are basis points
 * rounded half-up. Covenants are tested PRO FORMA (as if the candidate advance were already in).
 */
import { Cents, divHalfUp } from './money';

export interface FundingEligibility {
  buyerIds?: string[];
  sectorCodes?: string[];
  excludeSectorCodes?: string[];
  maxTenorDays?: number;
  minAdvanceCents?: string;
  maxAdvanceCents?: string;
  requireEtimsValid?: boolean;
}
export interface FundingCovenants {
  /** single buyer outstanding as a share of the facility limit (or of outstanding when there is no limit) */
  maxBuyerConcentrationBps?: number;
  /** non-performing outstanding / facility outstanding */
  maxNplRatioBps?: number;
  /** outstanding more than 30 days past due / facility outstanding */
  maxDpd30RatioBps?: number;
}
export interface FundingSourceRule {
  code: string;
  type: 'equity' | 'debt_facility' | 'other';
  limitCents: Cents | null;
  priority: number;
  active: boolean;
  eligibility: FundingEligibility;
  covenants: FundingCovenants;
}
export interface FundingCandidate { buyerId: string; sectorCode: string | null; tenorDays: number; principalCents: Cents; etimsValid: boolean }
export interface FacilityLoan { sourceCode: string; buyerId: string; outstandingCents: Cents; dpd: number; npl: boolean }
export interface CovenantResult { code: 'BUYER_CONCENTRATION' | 'NPL_RATIO' | 'DPD30_RATIO'; limitBps: number; actualBps: number; ok: boolean }
export interface SourceEvaluation { code: string; ok: boolean; reasons: string[] }

const bps = (part: Cents, whole: Cents): number => (whole <= 0n ? 0 : Number(divHalfUp(part * 10_000n, whole)));

export function checkEligibility(s: FundingSourceRule, c: FundingCandidate): { ok: boolean; reasons: string[] } {
  if (!s.active) return { ok: false, reasons: ['SOURCE_INACTIVE'] };
  const e = s.eligibility ?? {};
  const r: string[] = [];
  if (e.buyerIds?.length && !e.buyerIds.includes(c.buyerId)) r.push('BUYER_NOT_ELIGIBLE');
  if (e.sectorCodes?.length && (!c.sectorCode || !e.sectorCodes.includes(c.sectorCode))) r.push('SECTOR_NOT_ELIGIBLE');
  if (e.excludeSectorCodes?.length && c.sectorCode && e.excludeSectorCodes.includes(c.sectorCode)) r.push('SECTOR_EXCLUDED');
  if (e.maxTenorDays !== undefined && c.tenorDays > e.maxTenorDays) r.push('TENOR_ABOVE_MAX');
  if (e.minAdvanceCents !== undefined && c.principalCents < BigInt(e.minAdvanceCents)) r.push('ADVANCE_BELOW_MIN');
  if (e.maxAdvanceCents !== undefined && c.principalCents > BigInt(e.maxAdvanceCents)) r.push('ADVANCE_ABOVE_MAX');
  if (e.requireEtimsValid && !c.etimsValid) r.push('ETIMS_REQUIRED');
  return { ok: r.length === 0, reasons: r };
}

export function facilityUtilisation(s: FundingSourceRule, loans: FacilityLoan[]) {
  const mine = loans.filter((l) => l.sourceCode === s.code);
  const outstandingCents = mine.reduce((a, l) => a + l.outstandingCents, 0n);
  return {
    outstandingCents, limitCents: s.limitCents,
    headroomCents: s.limitCents === null ? null : s.limitCents - outstandingCents,
    usedBps: s.limitCents === null ? null : bps(outstandingCents, s.limitCents),
    count: mine.length,
  };
}

export function covenantStatus(s: FundingSourceRule, loans: FacilityLoan[], extra?: { buyerId: string; principalCents: Cents }): CovenantResult[] {
  const mine = loans.filter((l) => l.sourceCode === s.code);
  if (extra) mine.push({ sourceCode: s.code, buyerId: extra.buyerId, outstandingCents: extra.principalCents, dpd: 0, npl: false });
  const total = mine.reduce((a, l) => a + l.outstandingCents, 0n);
  const out: CovenantResult[] = [];
  const cv = s.covenants ?? {};
  if (cv.maxBuyerConcentrationBps !== undefined) {
    const byBuyer = new Map<string, Cents>();
    for (const l of mine) byBuyer.set(l.buyerId, (byBuyer.get(l.buyerId) ?? 0n) + l.outstandingCents);
    // pro forma: the candidate's buyer is the one that matters; otherwise the largest buyer
    const largest = extra ? (byBuyer.get(extra.buyerId) ?? 0n) : [...byBuyer.values()].reduce((a, b) => (a > b ? a : b), 0n);
    const actualBps = bps(largest, s.limitCents ?? total);
    out.push({ code: 'BUYER_CONCENTRATION', limitBps: cv.maxBuyerConcentrationBps, actualBps, ok: actualBps <= cv.maxBuyerConcentrationBps });
  }
  if (cv.maxNplRatioBps !== undefined) {
    const actualBps = bps(mine.filter((l) => l.npl).reduce((a, l) => a + l.outstandingCents, 0n), total);
    out.push({ code: 'NPL_RATIO', limitBps: cv.maxNplRatioBps, actualBps, ok: actualBps <= cv.maxNplRatioBps });
  }
  if (cv.maxDpd30RatioBps !== undefined) {
    const actualBps = bps(mine.filter((l) => l.dpd > 30).reduce((a, l) => a + l.outstandingCents, 0n), total);
    out.push({ code: 'DPD30_RATIO', limitBps: cv.maxDpd30RatioBps, actualBps, ok: actualBps <= cv.maxDpd30RatioBps });
  }
  return out;
}

export function evaluateSource(s: FundingSourceRule, c: FundingCandidate, loans: FacilityLoan[]): SourceEvaluation {
  const el = checkEligibility(s, c);
  const reasons = [...el.reasons];
  if (el.ok) {
    const u = facilityUtilisation(s, loans);
    if (u.headroomCents !== null && c.principalCents > u.headroomCents) reasons.push('FACILITY_LIMIT');
    for (const cv of covenantStatus(s, loans, { buyerId: c.buyerId, principalCents: c.principalCents })) if (!cv.ok) reasons.push(`COVENANT_${cv.code}`);
  }
  return { code: s.code, ok: reasons.length === 0, reasons };
}

/** Lowest priority number first. A preferred source is evaluated alone: no silent fallback. */
export function pickFundingSource(sources: FundingSourceRule[], c: FundingCandidate, loans: FacilityLoan[], preferred?: string): { code: string | null; evaluations: SourceEvaluation[] } {
  if (preferred) {
    const s = sources.find((x) => x.code === preferred);
    if (!s) return { code: null, evaluations: [{ code: preferred, ok: false, reasons: ['SOURCE_UNKNOWN'] }] };
    const ev = evaluateSource(s, c, loans);
    return { code: ev.ok ? s.code : null, evaluations: [ev] };
  }
  const evaluations: SourceEvaluation[] = [];
  for (const s of [...sources].sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code))) {
    const ev = evaluateSource(s, c, loans);
    evaluations.push(ev);
    if (ev.ok) return { code: s.code, evaluations };
  }
  return { code: null, evaluations };
}

const BPS_KEYS = ['maxBuyerConcentrationBps', 'maxNplRatioBps', 'maxDpd30RatioBps'] as const;
export function validateFundingSource(s: FundingSourceRule): string[] {
  const bad: string[] = [];
  if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(s.code)) bad.push('code');
  if ((s.limitCents !== null && s.limitCents <= 0n) || (s.type === 'debt_facility' && s.limitCents === null)) bad.push('limitCents');
  if (!Number.isInteger(s.priority) || s.priority < 0 || s.priority > 1000) bad.push('priority');
  const e = s.eligibility ?? {};
  if (e.maxTenorDays !== undefined && (!Number.isInteger(e.maxTenorDays) || e.maxTenorDays < 1 || e.maxTenorDays > 365)) bad.push('eligibility.maxTenorDays');
  for (const k of ['minAdvanceCents', 'maxAdvanceCents'] as const) if (e[k] !== undefined && !/^\d+$/.test(String(e[k]))) bad.push(`eligibility.${k}`);
  for (const k of BPS_KEYS) { const v = s.covenants?.[k]; if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 10_000)) bad.push(`covenants.${k}`); }
  return bad;
}
