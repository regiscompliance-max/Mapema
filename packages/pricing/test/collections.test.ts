/**
 * [QA Engineer] Phase 2 COL-01..03 unit tests, written from docs/phase-2/stories.md before the code.
 * DPD maths, Late -> Recourse -> NPL stages, reminder schedule with catch-up, in duplum waiver to the cent.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ageingBucket, DEFAULT_COLLECTIONS_POLICY as P, dpd, dpdStage, dueReminderSteps, inDuplumWaiver, nplThreshold, reminderSchedule, validatePolicy,
} from '../src';

describe('TC-P2U-COL-01 days past due and ageing buckets', () => {
  it('DPD is whole calendar days after the due date, never negative', () => {
    expect(dpd('2027-02-21', '2027-02-20')).toBe(0);
    expect(dpd('2027-02-21', '2027-02-21')).toBe(0);
    expect(dpd('2027-02-21', '2027-02-22')).toBe(1);
    expect(dpd('2027-02-21', '2027-03-23')).toBe(30);
  });
  it('buckets: current, 1-30, 31-60, 61-90, 91+', () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91, 400].map(ageingBucket)).toEqual(
      ['current', 'dpd_1_30', 'dpd_1_30', 'dpd_31_60', 'dpd_31_60', 'dpd_61_90', 'dpd_61_90', 'dpd_91_plus', 'dpd_91_plus']);
  });
});

describe('TC-P2U-COL-02 Late -> Recourse -> NPL (configurable, counsel to confirm)', () => {
  it('defaults: recourse at 30 DPD; NPL at 30 DPD for terms <= 30 days, else 90', () => {
    expect(P.recourseAfterDays).toBe(30);
    expect(nplThreshold(30, P)).toBe(30);
    expect(nplThreshold(48, P)).toBe(90);
    expect(dpdStage(0, 48, P)).toBe('current');
    expect(dpdStage(1, 48, P)).toBe('late');
    expect(dpdStage(29, 48, P)).toBe('late');
    expect(dpdStage(30, 48, P)).toBe('recourse_due');
    expect(dpdStage(89, 48, P)).toBe('recourse_due');
    expect(dpdStage(90, 48, P)).toBe('npl');
    expect(dpdStage(30, 21, P)).toBe('npl'); // short term: NPL wins at 30
  });
  it('honours a changed policy', () => {
    const p = { ...P, recourseAfterDays: 45, nplDaysLongTerm: 120 };
    expect(dpdStage(44, 60, p)).toBe('late');
    expect(dpdStage(45, 60, p)).toBe('recourse_due');
    expect(dpdStage(119, 60, p)).toBe('recourse_due');
    expect(dpdStage(120, 60, p)).toBe('npl');
  });
  it('stage is monotonic in DPD', () => {
    const rank = { current: 0, late: 1, recourse_due: 2, npl: 3 } as const;
    fc.assert(fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 1, max: 120 }), (d, t) => rank[dpdStage(d + 1, t, P)] >= rank[dpdStage(d, t, P)]));
  });
});

describe('TC-P2U-COL-03 policy validation', () => {
  it('rejects nonsense', () => {
    expect(validatePolicy(P)).toEqual([]);
    expect(validatePolicy({ ...P, recourseAfterDays: 0 })).toContain('recourseAfterDays must be 1..365');
    expect(validatePolicy({ ...P, nplDaysShortTerm: 0 })).toContain('nplDaysShortTerm must be 1..365');
    expect(validatePolicy({ ...P, preDueDays: [-1] })).toContain('preDueDays must be 1..60');
    expect(validatePolicy({ ...P, overdueDays: [] })).toContain('overdueDays must not be empty');
  });
});

describe('TC-P2U-COL-04 reminder schedule (pre-due, due, overdue) with catch-up', () => {
  const due = '2027-02-21';
  it('default schedule: -7, -1, 0, +1, +7, +14 to the buyer; +14 warning to the supplier', () => {
    expect(reminderSchedule(due, P).map((s) => `${s.key}@${s.date}>${s.audience}`)).toEqual([
      'pre_7@2027-02-14>buyer', 'pre_1@2027-02-20>buyer', 'due_0@2027-02-21>buyer',
      'od_1@2027-02-22>buyer', 'od_7@2027-02-28>buyer', 'od_14@2027-03-07>buyer', 'sup_warn_14@2027-03-07>supplier',
    ]);
  });
  it('sends each step once; a missed run sends only the latest step per audience and skips the stale ones', () => {
    expect(dueReminderSteps(due, '2027-02-13', [], P)).toEqual({ send: [], skip: [] });
    expect(dueReminderSteps(due, '2027-02-14', [], P).send.map((s) => s.key)).toEqual(['pre_7']);
    expect(dueReminderSteps(due, '2027-02-14', ['pre_7'], P).send).toEqual([]);
    const late = dueReminderSteps(due, '2027-02-23', ['pre_7'], P); // worker down for pre_1, due_0
    expect(late.send.map((s) => s.key)).toEqual(['od_1']);
    expect(late.skip.map((s) => s.key)).toEqual(['pre_1', 'due_0']);
    const both = dueReminderSteps(due, '2027-03-07', ['pre_7', 'pre_1', 'due_0', 'od_1', 'od_7'], P);
    expect(both.send.map((s) => s.key)).toEqual(['od_14', 'sup_warn_14']);
  });
});

describe('TC-P2U-COL-05 in duplum: charges after NPL capped at principal outstanding at NPL', () => {
  it('waives only the excess, to the cent', () => {
    // principal at NPL 800,000.00; charges (interest+fees+penalties, net of waivers) 47,300.00 at NPL
    expect(inDuplumWaiver(80_000_000n, 4_730_000n, 4_730_000n)).toBe(0n);
    expect(inDuplumWaiver(80_000_000n, 4_730_000n, 84_730_000n)).toBe(0n); // exactly at the cap
    expect(inDuplumWaiver(80_000_000n, 4_730_000n, 84_730_001n)).toBe(1n);
    expect(inDuplumWaiver(80_000_000n, 4_730_000n, 90_000_000n)).toBe(5_270_000n);
  });
  it('never negative; never more than the post-NPL charges', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.bigInt({ min: 0n, max: 10n ** 12n }), (p, at, extra) => {
      const w = inDuplumWaiver(p, at, at + extra);
      return w >= 0n && w <= extra && extra - w <= p;
    }));
  });
});
