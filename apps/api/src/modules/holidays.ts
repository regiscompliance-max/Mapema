/**
 * [Backend Engineer + Ops + Compliance] Kenyan public-holiday calendar (go-live, D-66).
 *  - Schedule Part I days (Public Holidays Act, Cap. 110) and the s.4 Sunday rule are computed by
 *    @mapema/pricing - nothing to maintain.
 *  - Days that need a Gazette notice (Idd-ul-Fitr each year, election day, swearing-in, ad-hoc
 *    declarations and s.3 substitutions) are proposed by ops with the Gazette reference and approved by a
 *    DIFFERENT ops user (maker-checker, action holiday_gazette). The table is insert-only for the app.
 *  - The calendar drives the reconciliation timing window and the collections reminder dates.
 */
import { Body, Controller, Get, Injectable, OnModuleInit, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { addDays, BusinessCalendar, GazettedHoliday, kenyanHolidays, PUBLIC_HOLIDAYS_ACT_SOURCE } from '@mapema/pricing';
import { Clock } from '../common/clock';
import { Db } from '../common/db';
import { badRequest, conflict } from '../common/errors';
import { zText } from '../common/http';
import { AuthUser, CurrentUser, Roles } from '../auth/auth';
import { ApprovalsService } from './approvals';

const zIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const zHoliday = z.object({
  date: zIso, name: zText(120).pipe(z.string().min(3)), gazetteRef: zText(200).pipe(z.string().min(3)), substitutesDate: zIso.optional(), reason: zText(500).optional(),
});

@Injectable()
export class HolidaysService implements OnModuleInit {
  private cached?: { at: number; cal: BusinessCalendar; rows: GazettedHoliday[] };
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly approvals: ApprovalsService) {}

  onModuleInit() {
    this.approvals.register('holiday_gazette', async (c, a) => {
      const p = a.payload;
      const r = await c.query(`INSERT INTO public_holiday (holiday_date, name, gazette_ref, substitutes_date, approval_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (holiday_date) DO NOTHING RETURNING id`,
        [p.date, p.name, p.gazetteRef, p.substitutesDate ?? null, a.id, a.maker_id]);
      if (!r.rows.length) throw conflict('HOLIDAY_EXISTS', `A gazetted holiday on ${p.date} is already recorded`);
    }, async () => { this.cached = undefined; });
  }

  async gazetted(): Promise<GazettedHoliday[]> {
    const rows = await this.db.query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS date, name, gazette_ref, to_char(substitutes_date, 'YYYY-MM-DD') AS substitutes FROM public_holiday ORDER BY holiday_date`);
    return rows.map((r: any) => ({ date: r.date, name: r.name, gazetteRef: r.gazette_ref, substitutesDate: r.substitutes ?? undefined }));
  }

  /** The business calendar (cached for 5 minutes; dropped as soon as a holiday is approved). */
  async calendar(): Promise<BusinessCalendar> {
    if (this.cached && Date.now() - this.cached.at < 300_000) return this.cached.cal;
    const rows = await this.gazetted();
    const cal = new BusinessCalendar(rows);
    this.cached = { at: Date.now(), cal, rows };
    return cal;
  }

  async list(year: number) {
    const g = await this.gazetted();
    const cal = await this.calendar();
    const today = this.clock.today();
    return {
      year, source: PUBLIC_HOLIDAYS_ACT_SOURCE,
      note: 'Schedule Part I days and the s.4 Sunday rule are computed; Idd-ul-Fitr and any day declared by Gazette notice must be entered by ops (maker-checker).',
      holidays: kenyanHolidays(year, g),
      nextBusinessDay: cal.onOrAfter(today),
      missingIddUlFitr: !g.some((x) => x.date.startsWith(`${year}-`) && /idd-ul-fitr/i.test(x.name)),
    };
  }

  async propose(u: AuthUser, b: z.infer<typeof zHoliday>) {
    const today = this.clock.today();
    if (b.date < addDays(today, -400) || b.date > addDays(today, 800)) throw badRequest('HOLIDAY_DATE_RANGE', 'The date must be within about a year in the past or two years ahead');
    if (b.substitutesDate && !kenyanHolidays(Number(b.substitutesDate.slice(0, 4))).some((h) => h.date === b.substitutesDate || h.observedFor === b.substitutesDate))
      throw badRequest('NOT_A_SCHEDULE_DAY', 'substitutesDate must be a Schedule Part I public holiday');
    const exists = await this.db.one(`SELECT 1 FROM public_holiday WHERE holiday_date = $1`, [b.date]);
    if (exists) throw conflict('HOLIDAY_EXISTS', `A gazetted holiday on ${b.date} is already recorded`);
    // one pending proposal per date (approvals refuse a second pending request for the same entity)
    const entityId = (await this.db.one(`SELECT md5($1)::uuid AS id`, [`mapema:holiday:${b.date}`])).id;
    return this.db.tx((c) => this.approvals.propose(c, u, {
      action: 'holiday_gazette', entityType: 'public_holiday', entityId,
      payload: { date: b.date, name: b.name, gazetteRef: b.gazetteRef, substitutesDate: b.substitutesDate ?? null }, requiredRole: 'ops', reason: b.reason ?? `${b.name} (${b.gazetteRef})`,
    }));
  }
}

@Controller('calendar')
export class HolidaysController {
  constructor(private readonly s: HolidaysService) {}

  @Get('holidays')
  list(@Query('year') year?: string) {
    const y = year ? z.coerce.number().int().min(2000).max(2100).parse(year) : Number(new Date().toISOString().slice(0, 4));
    return this.s.list(y);
  }

  @Post('holidays') @Roles('ops')
  propose(@CurrentUser() u: AuthUser, @Body() b: unknown) { return this.s.propose(u, zHoliday.parse(b)); }
}
