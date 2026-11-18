/**
 * [DevOps + Backend Engineer] Background worker. Same code and configuration as the API, no HTTP.
 *  - every 5 s: deliver due outbox items (ledger/bank/notifications), retry with backoff, dead after 8
 *  - every 5 min: poll bank payout statuses
 *  - daily 00:15 EAT: post held remainders whose due date has arrived (CBK-order posting policy)
 *  - daily 06:30 EAT: three-way reconciliation for the previous day (Phase 2: classified, alerts on unexplained)
 *  - daily 06:45 EAT: accounting journal push for the previous day (idempotent)
 *  - daily 07:00 EAT: CRD-07 review-date / KYC-expiry reminders (credit tasks at 30, 7 and 0 days)
 *  - daily 08:00 EAT: collections - reminders, DPD moves, recourse cases, NPL + in duplum cap (contact hours)
 *  - hourly: CRM import of buyer leads from the site D1 database
 *  - 1st of the month 02:00 EAT: month-end snapshot + CBK return + CRB file + lender pack
 * Only one worker runs jobs at a time (Postgres advisory lock), so scaling out is safe.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdvancesService, AppModule, Clock, CollectionsService, CreditReviewService, Db, IntegrationsService, loadConfig, Outbox, PaymentsService, ReconciliationService, RegulatoryService } from '@mapema/api';
import { addDays } from '@mapema/pricing';

const log = new Logger('Worker');

export function eatClock(d: Date) {
  const eat = new Date(d.getTime() + 3 * 3600_000);
  return { date: eat.toISOString().slice(0, 10), hhmm: eat.toISOString().slice(11, 16) };
}

export interface Job { name: string; at?: string; everyMs?: number; dayOfMonth?: number; run: () => Promise<unknown> }

export function dueJobs(jobs: Job[], now: Date, last: Map<string, string | number>): Job[] {
  const { date, hhmm } = eatClock(now);
  return jobs.filter((j) => {
    if (j.everyMs) return now.getTime() - Number(last.get(j.name) ?? 0) >= j.everyMs;
    if (j.dayOfMonth !== undefined && Number(date.slice(8, 10)) !== j.dayOfMonth) return false;
    return j.at !== undefined && hhmm >= j.at && last.get(j.name) !== date;
  });
}

async function main() {
  const cfg = loadConfig();
  const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg), { logger: ['error', 'warn', 'log'] });
  const db = ctx.get(Db); const outbox = ctx.get(Outbox); const clock = ctx.get(Clock);
  const payments = ctx.get(PaymentsService); const advances = ctx.get(AdvancesService); const reviews = ctx.get(CreditReviewService);
  const collections = ctx.get(CollectionsService); const recon = ctx.get(ReconciliationService); const integrations = ctx.get(IntegrationsService); const regulatory = ctx.get(RegulatoryService);
  const jobs: Job[] = [
    { name: 'outbox', everyMs: 5_000, run: () => outbox.processDue(50) },
    { name: 'payout-status', everyMs: 300_000, run: () => advances.refreshPayoutStatuses() },
    { name: 'held-remainders', at: '00:15', run: () => payments.postHeld(clock.today()) },
    { name: 'reconciliation', at: '06:30', run: () => recon.reconcile(addDays(clock.today(), -1)) },
    { name: 'accounting-push', at: '06:45', run: () => integrations.pushDailyJournal(addDays(clock.today(), -1)) },
    { name: 'review-reminders', at: '07:00', run: () => reviews.run(clock.today()) },
    { name: 'collections', at: '08:00', run: () => collections.runDaily(clock.today()) },
    { name: 'crm-import', everyMs: 3_600_000, run: () => integrations.importLeads() },
    { name: 'month-end-reports', at: '02:00', dayOfMonth: 1, run: () => regulatory.monthEnd(clock.today()) },
  ];
  const last = new Map<string, string | number>();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  log.log(`worker started (${cfg.APP_ENV})`);
  while (!stopping) {
    const c = await db.pool.connect();
    try {
      const got = (await c.query(`SELECT pg_try_advisory_lock(hashtext('mapema.worker')) AS ok`)).rows[0].ok;
      if (got) {
        try {
          for (const j of dueJobs(jobs, clock.now(), last)) {
            try { await j.run(); } catch (e) { log.error(`${j.name}: ${(e as Error).message}`); }
            last.set(j.name, j.everyMs ? clock.now().getTime() : eatClock(clock.now()).date);
          }
        } finally { await c.query(`SELECT pg_advisory_unlock(hashtext('mapema.worker'))`); }
      }
    } finally { c.release(); }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  await ctx.close();
}

if (require.main === module) main().catch((e) => { log.error(e); process.exit(1); });
