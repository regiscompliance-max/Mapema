/**
 * [Backend Engineer] Calendar-day arithmetic on ISO dates (YYYY-MM-DD), interpreted in
 * Africa/Nairobi (EAT, UTC+3, no DST). Day counts are pure calendar differences.
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(d: string, field = 'date'): void {
  if (!ISO.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new RangeError(`${field} must be an ISO date YYYY-MM-DD`);
  }
  const back = new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10);
  if (back !== d) throw new RangeError(`${field} is not a real calendar date`);
}

/** Days from `from` to `to` (to - from). */
export function daysBetween(from: string, to: string): number {
  assertIsoDate(from, 'from');
  assertIsoDate(to, 'to');
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function addDays(d: string, n: number): string {
  assertIsoDate(d);
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Today's date in Nairobi. */
export function todayEAT(now: Date = new Date()): string {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}
