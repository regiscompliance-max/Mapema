/**
 * [Backend Engineer + Credit + Compliance & Risk Analyst] Phase 2 collections maths (COL-01..03).
 * Pure, deterministic. Dates are ISO (EAT calendar days). Money is BigInt cents.
 * The 30/90-day periods are taken from law-firm commentary on the NDTCP Regulations 2026 (C-07)
 * and are CONFIGURABLE; Kenyan counsel to confirm (Q-D) - `counselConfirmed` stays false until then.
 */
import { addDays, daysBetween } from './dates';
import type { BusinessCalendar } from './calendar';
import { Cents } from './money';

export interface CollectionsPolicy {
  preDueDays: number[];        // reminders N days before the due date (buyer)
  overdueDays: number[];       // reminders N days after the due date (buyer)
  supplierWarningDay: number;  // DPD at which the supplier is told recourse may follow
  recourseAfterDays: number;   // DPD at which a recourse case opens (credit decides, maker-checker)
  nplDaysShortTerm: number;    // DPD -> non-performing for terms <= shortTermMaxDays
  nplDaysLongTerm: number;     // DPD -> non-performing otherwise
  shortTermMaxDays: number;
  counselConfirmed: boolean;
}

export const DEFAULT_COLLECTIONS_POLICY: CollectionsPolicy = Object.freeze({
  preDueDays: [7, 1], overdueDays: [1, 7, 14], supplierWarningDay: 14, recourseAfterDays: 30,
  nplDaysShortTerm: 30, nplDaysLongTerm: 90, shortTermMaxDays: 30, counselConfirmed: false,
}) as CollectionsPolicy;

export function validatePolicy(p: CollectionsPolicy): string[] {
  const e: string[] = [];
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!Array.isArray(p.preDueDays) || !p.preDueDays.every((d) => intIn(d, 1, 60))) e.push('preDueDays must be 1..60');
  if (!Array.isArray(p.overdueDays) || p.overdueDays.length === 0) e.push('overdueDays must not be empty');
  else if (!p.overdueDays.every((d) => intIn(d, 1, 365))) e.push('overdueDays must be 1..365');
  if (!intIn(p.supplierWarningDay, 1, 365)) e.push('supplierWarningDay must be 1..365');
  if (!intIn(p.recourseAfterDays, 1, 365)) e.push('recourseAfterDays must be 1..365');
  if (!intIn(p.nplDaysShortTerm, 1, 365)) e.push('nplDaysShortTerm must be 1..365');
  if (!intIn(p.nplDaysLongTerm, 1, 365)) e.push('nplDaysLongTerm must be 1..365');
  if (!intIn(p.shortTermMaxDays, 1, 120)) e.push('shortTermMaxDays must be 1..120');
  return e;
}

/** Days past due: whole calendar days after the due date, never negative. */
export function dpd(dueDate: string, asOf: string): number {
  const d = daysBetween(dueDate, asOf);
  return d > 0 ? d : 0;
}

export type AgeingBucket = 'current' | 'dpd_1_30' | 'dpd_31_60' | 'dpd_61_90' | 'dpd_91_plus';
export const AGEING_BUCKETS: AgeingBucket[] = ['current', 'dpd_1_30', 'dpd_31_60', 'dpd_61_90', 'dpd_91_plus'];

/** Neutral DPD buckets for dashboards and the lender pack (not a CBK classification - see Q-A). */
export function ageingBucket(days: number): AgeingBucket {
  if (days <= 0) return 'current';
  if (days <= 30) return 'dpd_1_30';
  if (days <= 60) return 'dpd_31_60';
  if (days <= 90) return 'dpd_61_90';
  return 'dpd_91_plus';
}

export function nplThreshold(termDays: number, p: CollectionsPolicy = DEFAULT_COLLECTIONS_POLICY): number {
  return termDays <= p.shortTermMaxDays ? p.nplDaysShortTerm : p.nplDaysLongTerm;
}

export type DpdStage = 'current' | 'late' | 'recourse_due' | 'npl';

/** Late -> Recourse -> NPL. NPL wins when both thresholds are reached. */
export function dpdStage(days: number, termDays: number, p: CollectionsPolicy = DEFAULT_COLLECTIONS_POLICY): DpdStage {
  if (days <= 0) return 'current';
  if (days >= nplThreshold(termDays, p)) return 'npl';
  if (days >= p.recourseAfterDays) return 'recourse_due';
  return 'late';
}

export interface ReminderStep { key: string; date: string; audience: 'buyer' | 'supplier'; template: 'reminder.pre_due' | 'reminder.due' | 'reminder.overdue' | 'reminder.supplier_warning'; offset: number }

/**
 * Reminder dates. With a business calendar (go-live, D-66) a step that lands on a weekend or Kenyan
 * public holiday moves: pre-due reminders to the PREVIOUS business day (so they still arrive before
 * the due date), due / overdue / supplier-warning steps to the NEXT business day. Keys never change,
 * so a step is still sent at most once. Without a calendar: plain calendar days (unit tests, Phase 2).
 * DPD itself stays calendar days from the contractual due date (see dpd()).
 */
export function reminderSchedule(dueDate: string, p: CollectionsPolicy = DEFAULT_COLLECTIONS_POLICY, cal?: BusinessCalendar): ReminderStep[] {
  const fwd = (d: string) => (cal ? cal.onOrAfter(d) : d);
  const back = (d: string) => (cal ? cal.onOrBefore(d) : d);
  const steps: ReminderStep[] = [];
  for (const d of [...p.preDueDays].sort((a, b) => b - a)) steps.push({ key: `pre_${d}`, date: back(addDays(dueDate, -d)), audience: 'buyer', template: 'reminder.pre_due', offset: -d });
  steps.push({ key: 'due_0', date: fwd(dueDate), audience: 'buyer', template: 'reminder.due', offset: 0 });
  for (const d of [...p.overdueDays].sort((a, b) => a - b)) steps.push({ key: `od_${d}`, date: fwd(addDays(dueDate, d)), audience: 'buyer', template: 'reminder.overdue', offset: d });
  steps.push({ key: `sup_warn_${p.supplierWarningDay}`, date: fwd(addDays(dueDate, p.supplierWarningDay)), audience: 'supplier', template: 'reminder.supplier_warning', offset: p.supplierWarningDay });
  return steps.sort((a, b) => (a.offset - b.offset) || (a.audience === 'buyer' ? -1 : 1));
}

/**
 * Which steps to send today. Each step goes once. After a missed run only the LATEST due step per
 * audience is sent; older unsent ones are skipped (recorded, never sent late) to avoid a burst.
 */
export function dueReminderSteps(dueDate: string, today: string, sentKeys: string[], p: CollectionsPolicy = DEFAULT_COLLECTIONS_POLICY, cal?: BusinessCalendar): { send: ReminderStep[]; skip: ReminderStep[] } {
  const send: ReminderStep[] = []; const skip: ReminderStep[] = [];
  // with a business calendar nothing goes out on a weekend / public holiday; the next business day catches up
  if (cal && !cal.isBusinessDay(today)) return { send, skip };
  for (const audience of ['buyer', 'supplier'] as const) {
    const pending = reminderSchedule(dueDate, p, cal).filter((s) => s.audience === audience && s.date <= today && !sentKeys.includes(s.key));
    if (pending.length === 0) continue;
    send.push(pending[pending.length - 1]);
    skip.push(...pending.slice(0, -1));
  }
  return { send, skip };
}

/**
 * In duplum (NDTCP Regulations 2026 / Banking Act s.44A analogue, counsel to confirm): interest and
 * charges accruing after an advance becomes non-performing may not exceed the principal outstanding
 * at that time. Inputs are cumulative charges (interest + fees + penalties, NET of earlier waivers)
 * at NPL and now. Returns the amount to waive now (0 if under the cap).
 */
export function inDuplumWaiver(principalAtNplCents: Cents, chargesAtNplCents: Cents, chargesNowCents: Cents): Cents {
  const since = chargesNowCents - chargesAtNplCents;
  const excess = since - principalAtNplCents;
  return excess > 0n ? excess : 0n;
}
