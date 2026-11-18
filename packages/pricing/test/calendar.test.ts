/**
 * [QA Engineer + Compliance & Risk Analyst] Go-live: Kenyan public-holiday calendar (Public Holidays
 * Act, Cap. 110) and business-day arithmetic used by reconciliation and collections reminders.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BusinessCalendar, DEFAULT_COLLECTIONS_POLICY as P, dueReminderSteps, easterSunday, kenyanHolidays, PUBLIC_HOLIDAYS_ACT_SOURCE, reminderSchedule, scheduleDays,
} from '../src';

const IDD_2026 = { date: '2026-03-20', name: 'Idd-ul-Fitr', gazetteRef: 'Gazette Notice No. 3955 of 18 March 2026' };

describe('TC-GL-CAL-01 Schedule Part I and Easter', () => {
  it('Easter Sunday (Gregorian computus) for known years', () => {
    expect(['2022', '2024', '2025', '2026', '2027'].map((y) => easterSunday(Number(y)))).toEqual(['2022-04-17', '2024-03-31', '2025-04-20', '2026-04-05', '2027-03-28']);
  });
  it('2026: Part I days + gazetted Idd-ul-Fitr; Saturdays are not moved; Mazingira Day replaced Utamaduni Day (Act No. 3 of 2024)', () => {
    const h = kenyanHolidays(2026, [IDD_2026]);
    expect(h.map((x) => `${x.date} ${x.name}`)).toEqual([
      "2026-01-01 New Year's Day", '2026-03-20 Idd-ul-Fitr', '2026-04-03 Good Friday', '2026-04-06 Easter Monday', '2026-05-01 Labour Day',
      '2026-06-01 Madaraka Day', '2026-10-10 Mazingira Day', '2026-10-20 Mashujaa Day', '2026-12-12 Jamhuri Day', '2026-12-25 Christmas Day', '2026-12-26 Boxing Day',
    ]);
    expect(h.find((x) => x.name === 'Idd-ul-Fitr')).toMatchObject({ kind: 'gazetted', source: IDD_2026.gazetteRef });
    expect(h.find((x) => x.name === 'Labour Day')).toMatchObject({ kind: 'statutory', source: PUBLIC_HOLIDAYS_ACT_SOURCE });
    expect(scheduleDays(2026).map((d) => d.name)).not.toContain('Utamaduni Day');
  });
});

describe('TC-GL-CAL-02 s.4 Sunday rule: the first succeeding day that is not a public holiday', () => {
  it('2022: Christmas on Sunday moves past Boxing Day (Monday) to Tuesday 27 December', () => {
    const h = kenyanHolidays(2022);
    expect(h.filter((x) => x.date >= '2022-12-25').map((x) => `${x.date} ${x.name}`)).toEqual(['2022-12-26 Boxing Day', '2022-12-27 Christmas Day (observed)']);
    expect(h.find((x) => x.observedFor === '2022-12-25')?.source).toMatch(/s\.4$/);
  });
  it('2023: New Year on Sunday -> Monday 2 January', () => {
    expect(kenyanHolidays(2023)[0]).toMatchObject({ date: '2023-01-02', observedFor: '2023-01-01' });
  });
  it('2027: Mazingira (Sun 10 Oct) -> Mon 11; Jamhuri (Sun 12 Dec) -> Mon 13; Boxing Day (Sun 26 Dec) -> Mon 27', () => {
    const d = kenyanHolidays(2027).map((x) => x.date);
    expect(d).toEqual(expect.arrayContaining(['2027-10-11', '2027-12-13', '2027-12-27']));
    expect(d).not.toContain('2027-10-10');
  });
  it('a gazetted substitution (s.3) removes the Schedule day it replaces', () => {
    const h = kenyanHolidays(2027, [{ date: '2027-10-22', name: 'Mashujaa Day (substituted)', gazetteRef: 'GN test', substitutesDate: '2027-10-20' }]);
    expect(h.map((x) => x.date)).toContain('2027-10-22');
    expect(h.map((x) => x.date)).not.toContain('2027-10-20');
  });
  it('property: every year has the ten Schedule days (or their observed day), none on a Sunday', () => {
    fc.assert(fc.property(fc.integer({ min: 2000, max: 2100 }), (y) => {
      const h = kenyanHolidays(y);
      return h.length === 10 && h.every((x) => new Date(`${x.date}T00:00:00Z`).getUTCDay() !== 0) && new Set(h.map((x) => x.date)).size === 10;
    }));
  });
});

describe('TC-GL-CAL-03 business days', () => {
  const cal = new BusinessCalendar([IDD_2026]);
  it('weekends and holidays are not business days', () => {
    expect(cal.isBusinessDay('2026-03-20')).toBe(false); // Idd-ul-Fitr (Friday)
    expect(cal.isBusinessDay('2026-03-21')).toBe(false); // Saturday
    expect(cal.isBusinessDay('2026-03-23')).toBe(true);
    expect(cal.onOrAfter('2026-04-03')).toBe('2026-04-07'); // Good Friday -> Tuesday after Easter Monday
    expect(cal.onOrBefore('2026-04-06')).toBe('2026-04-02');
  });
  it('addBusinessDays skips holidays both ways; weekendsOnly() keeps the Phase 2 behaviour', () => {
    expect(cal.addBusinessDays('2026-04-02', 1)).toBe('2026-04-07');
    expect(cal.addBusinessDays('2026-04-07', -1)).toBe('2026-04-02');
    expect(BusinessCalendar.weekendsOnly().addBusinessDays('2026-04-02', 1)).toBe('2026-04-03');
    expect(cal.addBusinessDays('2026-12-24', 1)).toBe('2026-12-28');
    expect(cal.businessDaysBetween('2026-12-24', '2026-12-28')).toBe(1);
  });
  it('property: addBusinessDays(n) then (-n) returns to the start for business days', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 700 }), fc.integer({ min: 1, max: 30 }), (off, n) => {
      const start = cal.onOrAfter(new Date(Date.UTC(2026, 0, 1) + off * 864e5).toISOString().slice(0, 10));
      return cal.addBusinessDays(cal.addBusinessDays(start, n), -n) === start && cal.businessDaysBetween(start, cal.addBusinessDays(start, n)) === n;
    }));
  });
});

describe('TC-GL-CAL-04 reminders move off weekends and public holidays', () => {
  const cal = new BusinessCalendar();
  it('worked-example due date Sun 21 Feb 2027: pre-due steps move back, due/overdue steps move forward; keys unchanged', () => {
    expect(reminderSchedule('2027-02-21', P, cal).map((s) => `${s.key}@${s.date}`)).toEqual([
      'pre_7@2027-02-12', 'pre_1@2027-02-19', 'due_0@2027-02-22', 'od_1@2027-02-22', 'od_7@2027-03-01', 'od_14@2027-03-08', 'sup_warn_14@2027-03-08',
    ]);
  });
  it('due on Christmas 2026: nothing goes out on the holidays; on Monday 28 December the buyer gets ONE message, the accurate overdue one (due_0 is recorded as skipped)', () => {
    const due = '2026-12-25';
    expect(dueReminderSteps(due, '2026-12-25', ['pre_7', 'pre_1'], P, cal).send).toEqual([]);
    const r = dueReminderSteps(due, '2026-12-28', ['pre_7', 'pre_1'], P, cal);
    expect(r.send.map((s) => s.key)).toEqual(['od_1']);
    expect(r.skip.map((s) => s.key)).toEqual(['due_0']);
  });
  it('nothing is sent on a weekend or holiday; the next business day sends the latest step only', () => {
    expect(dueReminderSteps('2027-02-21', '2027-02-21', ['pre_7', 'pre_1'], P, cal)).toEqual({ send: [], skip: [] });
    expect(dueReminderSteps('2027-02-21', '2027-02-14', [], P, cal)).toEqual({ send: [], skip: [] }); // Sunday
  });
  it('without a calendar the Phase 2 calendar-day schedule is unchanged', () => {
    expect(reminderSchedule('2027-02-21', P).map((s) => s.date)[0]).toBe('2027-02-14');
  });
});
