/**
 * [QA Engineer] TC-P2U-REC-01..08 - reconciliation classification edge cases (stories REC-02/05),
 * written before recon-engine.ts. Pure function: no database, no adapters.
 * Sign convention: a break's amount is its contribution to (bank - platform) or (fineract - platform).
 */
import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '@mapema/pricing';
import { classifyRecon, ReconInput } from '../src/modules/recon-engine';

const base = (o: Partial<ReconInput> = {}): ReconInput => ({
  asOf: '2027-03-03', // Wednesday
  bankBalanceCents: 0n, fineractBalanceCents: 0n, platformBalanceCents: 0n,
  baseline: { bankCents: 0n, fineractCents: 0n, platformCents: 0n },
  statement: [], platformItems: [], pendingPostings: [], carryForward: [], timingWindowBusinessDays: 1, ...o,
});
const sum = (bs: { amountCents: bigint }[]) => bs.reduce((s, b) => s + b.amountCents, 0n);

describe('TC-P2U-REC recon engine', () => {
  it('REC-01 all three agree, items match -> balanced, no breaks', () => {
    const r = classifyRecon(base({
      bankBalanceCents: 1_004_730_000n, fineractBalanceCents: 1_004_730_000n, platformBalanceCents: 1_004_730_000n,
      statement: [{ bankRef: 'EQ-1', valueDate: '2027-01-04', amountCents: 1_000_000_000n, type: 'credit' }, { bankRef: 'MB1', valueDate: '2027-01-04', amountCents: -80_000_000n, type: 'debit' }, { bankRef: 'FT1', valueDate: '2027-02-21', amountCents: 100_000_000n, type: 'credit' }, { bankRef: 'MB2', valueDate: '2027-02-21', amountCents: -15_270_000n, type: 'debit' }],
      platformItems: [{ ref: 'EQ-1', date: '2027-01-04', amountCents: 1_000_000_000n, source: 'funding' }, { ref: 'MB1', date: '2027-01-04', amountCents: -80_000_000n, source: 'payout' }, { ref: 'FT1', date: '2027-02-21', amountCents: 100_000_000n, source: 'bank_transaction' }, { ref: 'MB2', date: '2027-02-21', amountCents: -15_270_000n, source: 'payout' }],
    }));
    expect(r.status).toBe('balanced');
    expect(r.breaks).toEqual([]);
    expect(r.unexplainedCount).toBe(0);
  });

  it('REC-02 a credit on the as-of day not yet ingested is TIMING', () => {
    const r = classifyRecon(base({ bankBalanceCents: 5_000_000n, fineractBalanceCents: 0n, statement: [{ bankRef: 'FT9', valueDate: '2027-03-03', amountCents: 5_000_000n, type: 'credit' }] }));
    expect(r.breaks).toMatchObject([{ kind: 'bank_vs_platform', classification: 'timing', category: 'credit_not_yet_ingested', amountCents: 5_000_000n, itemKey: 'bank:FT9', expectedClearBy: '2027-03-04' }]);
    expect(r.status).toBe('explained');
  });

  it('REC-03 an un-ingested credit from an earlier day is UNEXPLAINED (unknown bank item)', () => {
    const r = classifyRecon(base({ bankBalanceCents: 5_000_000n, statement: [{ bankRef: 'FT8', valueDate: '2027-03-01', amountCents: 5_000_000n, type: 'credit' }] }));
    expect(r.breaks[0]).toMatchObject({ classification: 'unexplained', category: 'unknown_bank_item' });
    expect(r.status).toBe('breaks');
    expect(r.unexplainedCount).toBe(1);
  });

  it('REC-04 payout released within one business day but not on the statement is TIMING; older is UNEXPLAINED; weekends skipped', () => {
    const p = (ref: string, date: string) => ({ ref, date, amountCents: -1_000_000n, source: 'payout' as const });
    const r = classifyRecon(base({ asOf: '2027-03-01' /* Monday */, platformBalanceCents: -3_000_000n, fineractBalanceCents: -3_000_000n,
      platformItems: [p('MB7', '2027-03-01'), p('MB6', '2027-02-26' /* Friday = 1 business day before */), p('MB5', '2027-02-25')] }));
    const by = Object.fromEntries(r.breaks.map((b) => [b.itemKey, b]));
    expect(by['platform:MB7']).toMatchObject({ classification: 'timing', category: 'payout_in_transit', amountCents: 1_000_000n, expectedClearBy: '2027-03-02' });
    expect(by['platform:MB6']).toMatchObject({ classification: 'timing', category: 'payout_in_transit' });
    expect(by['platform:MB5']).toMatchObject({ classification: 'unexplained', category: 'missing_on_statement' });
    expect(sum(r.breaks.filter((b) => b.kind === 'bank_vs_platform'))).toBe(r.differences.bankVsPlatformCents);
  });

  it('REC-05 bank charges are EXPLAINED; matched ref with a different amount is UNEXPLAINED', () => {
    const r = classifyRecon(base({
      bankBalanceCents: 99_997_500n, platformBalanceCents: 100_000_000n, fineractBalanceCents: 100_000_000n,
      statement: [{ bankRef: 'CHG1', valueDate: '2027-03-02', amountCents: -2_500n, type: 'charge', narrative: 'RTGS fee' }, { bankRef: 'FT1', valueDate: '2027-03-02', amountCents: 99_999_000n, type: 'credit' }, { bankRef: 'X', valueDate: '2027-03-02', amountCents: 1_000n, type: 'credit' }],
      platformItems: [{ ref: 'FT1', date: '2027-03-02', amountCents: 100_000_000n, source: 'bank_transaction' }],
    }));
    const by = Object.fromEntries(r.breaks.map((b) => [b.itemKey, b]));
    expect(by['bank:CHG1']).toMatchObject({ classification: 'explained', category: 'bank_charge', amountCents: -2_500n });
    expect(by['match:FT1']).toMatchObject({ classification: 'unexplained', category: 'amount_mismatch', amountCents: -1_000n });
    expect(by['bank:X']).toMatchObject({ classification: 'unexplained', category: 'unknown_bank_item', amountCents: 1_000n });
    expect(sum(Object.values(by).filter((b) => b.kind === 'bank_vs_platform'))).toBe(-2_500n);
  });

  it('REC-06 Fineract vs platform: pending ledger posting is TIMING, dead posting UNEXPLAINED, remainder becomes an unexplained residual', () => {
    const r = classifyRecon(base({
      bankBalanceCents: 10_000_000n, platformBalanceCents: 10_000_000n, fineractBalanceCents: 10_000_000n - 300_000n - 200_000n + 12_345n,
      statement: [{ bankRef: 'A', valueDate: '2027-03-02', amountCents: 10_000_000n, type: 'credit' }], platformItems: [{ ref: 'A', date: '2027-03-02', amountCents: 10_000_000n, source: 'bank_transaction' }],
      pendingPostings: [{ ref: 'ob-1', amountCents: 300_000n, state: 'retrying' }, { ref: 'ob-2', amountCents: 200_000n, state: 'dead' }],
    }));
    const by = Object.fromEntries(r.breaks.map((b) => [b.itemKey, b]));
    expect(by['ledger:ob-1']).toMatchObject({ kind: 'fineract_vs_platform', classification: 'timing', category: 'ledger_posting_pending', amountCents: -300_000n });
    expect(by['ledger:ob-2']).toMatchObject({ classification: 'unexplained', category: 'ledger_posting_failed', amountCents: -200_000n });
    expect(by['residual:fineract_vs_platform']).toMatchObject({ classification: 'unexplained', category: 'unexplained_residual', amountCents: 12_345n });
    expect(sum(r.breaks.filter((b) => b.kind === 'fineract_vs_platform'))).toBe(r.differences.fineractVsPlatformCents);
  });

  it('REC-07 baseline: balances are compared as movements since the approved opening balances', () => {
    const r = classifyRecon(base({ bankBalanceCents: 500n, fineractBalanceCents: 987_654_321n + 500n, platformBalanceCents: 500n, baseline: { bankCents: 0n, fineractCents: 987_654_321n, platformCents: 0n },
      statement: [{ bankRef: 'A', valueDate: '2027-03-02', amountCents: 500n, type: 'credit' }], platformItems: [{ ref: 'A', date: '2027-03-02', amountCents: 500n, source: 'bank_transaction' }] }));
    expect(r.status).toBe('balanced');
    expect(r.movements).toEqual({ bankCents: 500n, fineractCents: 500n, platformCents: 500n });
  });

  it('REC-08 an approved carry-forward explains the same item on later runs', () => {
    const r = classifyRecon(base({ bankBalanceCents: 7_000n, statement: [{ bankRef: 'REV1', valueDate: '2027-02-01', amountCents: 7_000n, type: 'credit' }], carryForward: [{ itemKey: 'bank:REV1', approvalId: 'appr-1', amountCents: 7_000n }] }));
    expect(r.breaks[0]).toMatchObject({ classification: 'explained', category: 'carried_forward', approvalId: 'appr-1' });
    // carry-forward is per amount: if the amount changes it is unexplained again
    const r2 = classifyRecon(base({ bankBalanceCents: 7_001n, statement: [{ bankRef: 'REV1', valueDate: '2027-02-01', amountCents: 7_001n, type: 'credit' }], carryForward: [{ itemKey: 'bank:REV1', approvalId: 'appr-1', amountCents: 7_000n }] }));
    expect(r2.breaks[0]).toMatchObject({ classification: 'unexplained' });
  });
});

describe('TC-GL-REC-HOL timing window uses the Kenyan public-holiday calendar (D-66, closes Q-G)', () => {
  // Easter 2027: Good Friday 26 March, Easter Monday 29 March. As of Tuesday 30 March, ONE business day back is Thursday 25 March.
  const cal = new BusinessCalendar();
  const payout = (date: string) => base({ asOf: '2027-03-30', calendar: cal, bankBalanceCents: 0n, fineractBalanceCents: -1_000_000n, platformBalanceCents: -1_000_000n,
    platformItems: [{ ref: 'MBX', date, amountCents: -1_000_000n, source: 'payout' }] });
  it('a payout released on the Thursday before Good Friday is still in transit on Tuesday (holidays are not business days)', () => {
    expect(classifyRecon(payout('2027-03-25')).breaks[0]).toMatchObject({ classification: 'timing', category: 'payout_in_transit', expectedClearBy: '2027-03-31' });
    // weekends-only (Phase 2 behaviour) would have called the same item unexplained
    expect(classifyRecon({ ...payout('2027-03-25'), calendar: undefined }).breaks[0]).toMatchObject({ classification: 'unexplained' });
  });
  it('a credit on the as-of day before Christmas expects to clear on the next business day (28 December 2026)', () => {
    const r = classifyRecon(base({ asOf: '2026-12-24', calendar: cal, bankBalanceCents: 5_000_000n, statement: [{ bankRef: 'FTX', valueDate: '2026-12-24', amountCents: 5_000_000n, type: 'credit' }] }));
    expect(r.breaks[0]).toMatchObject({ classification: 'timing', expectedClearBy: '2026-12-28' });
  });
});
