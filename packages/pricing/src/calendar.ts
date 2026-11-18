/**
 * [Backend Engineer + Compliance & Risk Analyst] Kenyan business-day calendar (go-live, D-66).
 *
 * Source: Public Holidays Act (Cap. 110), Schedule Part I, as amended by the Statute Law
 * (Miscellaneous Amendments) Act, 2024 (Act No. 3 of 2024, in force 26 April 2024: 10 October is
 * Mazingira Day). Part I days are public holidays for everyone:
 *   New Year's Day 1 Jan; Good Friday; Easter Monday; Labour Day 1 May; Madaraka Day 1 Jun;
 *   Idd-ul-Fitr (date depends on the moon - gazetted each year); Mazingira Day 10 Oct;
 *   Mashujaa Day 20 Oct; Jamhuri Day 12 Dec; Christmas 25 Dec; Boxing Day 26 Dec.
 * s.4: where a Part I day falls on a Sunday, the first succeeding day that is not itself a public
 *   holiday is the public holiday instead (e.g. Christmas on a Sunday -> Tuesday 27th, because
 *   Monday 26th is Boxing Day).
 * s.2(4)/(5) and s.3: general-election day, the President-elect's swearing-in and any day the Cabinet
 *   Secretary declares by Gazette notice (in addition to, or in substitution for, a Schedule day) are
 *   public holidays. Those - and Idd-ul-Fitr - are entered by ops as GAZETTED holidays under
 *   maker-checker (holiday_gazette) and passed in here as `gazetted`.
 * Part II (Idd-ul-Azha) and Part III (Diwali) are holidays only for members of those faiths, so they
 * are NOT bank closing days and are not treated as non-business days.
 *
 * Pure and deterministic. Dates are ISO YYYY-MM-DD calendar days in Africa/Nairobi.
 */
import { addDays, assertIsoDate } from './dates';

export const PUBLIC_HOLIDAYS_ACT_SOURCE = 'Public Holidays Act (Cap. 110), Schedule Part I, as amended by Act No. 3 of 2024';

export interface Holiday {
  date: string;
  name: string;
  kind: 'statutory' | 'gazetted';
  source: string;
  /** set when a statutory day moved under s.4 (Sunday rule) */
  observedFor?: string;
  /** gazetted only: the Schedule day this one replaces under s.3 (that day stops being a holiday) */
  substitutesDate?: string;
}
export interface GazettedHoliday { date: string; name: string; gazetteRef: string; substitutesDate?: string | null }

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Western (Gregorian) Easter Sunday - anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new RangeError('year must be 1900..2200');
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** The fixed and Easter-based Part I days of a year, BEFORE the Sunday rule (Idd-ul-Fitr is gazetted). */
export function scheduleDays(year: number): { date: string; name: string }[] {
  const easter = easterSunday(year);
  return [
    { date: iso(year, 1, 1), name: "New Year's Day" },
    { date: addDays(easter, -2), name: 'Good Friday' },
    { date: addDays(easter, 1), name: 'Easter Monday' },
    { date: iso(year, 5, 1), name: 'Labour Day' },
    { date: iso(year, 6, 1), name: 'Madaraka Day' },
    { date: iso(year, 10, 10), name: 'Mazingira Day' },
    { date: iso(year, 10, 20), name: 'Mashujaa Day' },
    { date: iso(year, 12, 12), name: 'Jamhuri Day' },
    { date: iso(year, 12, 25), name: 'Christmas Day' },
    { date: iso(year, 12, 26), name: 'Boxing Day' },
  ].sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * All public holidays of `year`: Schedule Part I days with the s.4 Sunday rule applied, plus gazetted
 * days (Idd-ul-Fitr, elections, ad-hoc). A gazetted substitution removes the substituted Schedule day.
 * Gazetted Idd-ul-Fitr is subject to s.4 too, but the Gazette notice names the actual day, so it is
 * taken as given.
 */
export function kenyanHolidays(year: number, gazetted: GazettedHoliday[] = []): Holiday[] {
  const g = gazetted.filter((x) => x.date.startsWith(`${year}-`) || (x.substitutesDate ?? '').startsWith(`${year}-`));
  for (const x of g) { assertIsoDate(x.date, 'gazetted date'); if (x.substitutesDate) assertIsoDate(x.substitutesDate, 'substitutesDate'); }
  const removed = new Set(g.map((x) => x.substitutesDate).filter(Boolean) as string[]);
  const out: Holiday[] = g.filter((x) => x.date.startsWith(`${year}-`)).map((x) => ({ date: x.date, name: x.name, kind: 'gazetted' as const, source: x.gazetteRef, ...(x.substitutesDate ? { substitutesDate: x.substitutesDate } : {}) }));
  const taken = () => new Set(out.map((h) => h.date));
  // first pass: Schedule days that are not Sundays (they block the Sunday rule's "not being a public holiday")
  const days = scheduleDays(year).filter((d) => !removed.has(d.date));
  for (const d of days) if (dow(d.date) !== 0 && !taken().has(d.date)) out.push({ date: d.date, name: d.name, kind: 'statutory', source: PUBLIC_HOLIDAYS_ACT_SOURCE });
  // s.4: a Sunday Schedule day moves to the first succeeding day that is not a public holiday
  for (const d of days) {
    if (dow(d.date) !== 0) continue;
    let cur = addDays(d.date, 1);
    while (taken().has(cur) || dow(cur) === 0) cur = addDays(cur, 1);
    out.push({ date: cur, name: `${d.name} (observed)`, kind: 'statutory', source: `${PUBLIC_HOLIDAYS_ACT_SOURCE}, s.4`, observedFor: d.date });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/** Business days = Monday to Friday that are not Kenyan public holidays. Holidays are computed per year on demand. */
export class BusinessCalendar {
  private cache = new Map<number, Set<string>>();
  constructor(private readonly gazetted: GazettedHoliday[] = [], private readonly opts: { holidays?: boolean } = {}) {}

  /** Weekends only (no holidays) - the pre-go-live behaviour, kept for pure unit tests. */
  static weekendsOnly() { return new BusinessCalendar([], { holidays: false }); }

  private year(y: number) {
    let s = this.cache.get(y);
    if (!s) { s = new Set(this.opts.holidays === false ? [] : kenyanHolidays(y, this.gazetted).map((h) => h.date)); this.cache.set(y, s); }
    return s;
  }
  isHoliday(d: string): boolean { assertIsoDate(d); return this.year(Number(d.slice(0, 4))).has(d); }
  isWeekend(d: string): boolean { const w = dow(d); return w === 0 || w === 6; }
  isBusinessDay(d: string): boolean { return !this.isWeekend(d) && !this.isHoliday(d); }
  /** d itself when it is a business day, else the next one. */
  onOrAfter(d: string): string { let c = d; while (!this.isBusinessDay(c)) c = addDays(c, 1); return c; }
  /** d itself when it is a business day, else the previous one. */
  onOrBefore(d: string): string { let c = d; while (!this.isBusinessDay(c)) c = addDays(c, -1); return c; }
  /** Move n business days (negative = back). n = 0 returns d unchanged. */
  addBusinessDays(d: string, n: number): string {
    assertIsoDate(d);
    let cur = d; let left = Math.abs(n); const step = n >= 0 ? 1 : -1;
    while (left > 0) { cur = addDays(cur, step); if (this.isBusinessDay(cur)) left--; }
    return cur;
  }
  /** Business days strictly after `from` up to and including `to` (0 when to <= from). */
  businessDaysBetween(from: string, to: string): number {
    let n = 0; let cur = from;
    while (cur < to) { cur = addDays(cur, 1); if (this.isBusinessDay(cur)) n++; }
    return n;
  }
}
