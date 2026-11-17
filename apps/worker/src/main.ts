/**
 * [DevOps + Backend Engineer] Background worker. Same code and configuration as the API, no HTTP.
 *  - every 5 s: deliver due outbox items (ledger/bank/notifications), retry with backoff, dead after 8
 *  - every 5 min: poll bank payout statuses
 *  - daily 00:15 EAT: post held remainders whose due date has arrived (CBK-order posting policy)
 *  - daily 06:00 EAT: late-payment ladder; 06:30 EAT: three-way reconciliation for the previous day
 *  - daily 07:00 EAT: CRD-07 review-date / KYC-expiry reminders (credit tasks at 30, 7 and 0 days)
 * Only one worker runs jobs at a time (Postgres advisory lock), so scaling out is safe.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdvancesService, AppModule, Clock, CreditReviewService, Db, loadConfig, OpsService, Outbox, PaymentsService } from '@mapema/api';
import { addDays } from '@mapema/pricing';

const log = new Logger('Worker');

export function eatClock(d: Date) {
  const eat = new Date(d.getTime() + 3 * 3600_000);
  return { date: eat.toISOString().slice(0, 10), hhmm: eat.toISOString().slice(11, 16) };
}

export interface Job { name: string; at?: string; everyMs?: number; run: () => Promise<unknown> }

export function dueJobs(jobs: Job[], now: Date, last: Map<string, string | number>): Job[] {
  const { date, hhmm } = eatClock(now);
  return jobs.filter((j) => {
    if (j.everyMs) return now.getTime() - Number(last.get(j.name) ?? 0) >= j.everyMs;
    return j.at !== undefined && hhmm >= j.at && last.get(j.name) !== date;
  });
}

async function main() {
  const cfg = loadConfig();
  const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg), { logger: ['error', 'warn', 'log'] });
  const db = ctx.get(Db); const outbox = ctx.get(Outbox); const clock = ctx.get(Clock);
  const payments = ctx.get(PaymentsService); const ops = ctx.get(OpsService); const advances = ctx.get(AdvancesService); const reviews = ctx.get(CreditReviewService);
  const jobs: Job[] = [
    { name: 'outbox', everyMs: 5_000, run: () => outbox.processDue(50) },
    { name: 'payout-status', everyMs: 300_000, run: () => advances.refreshPayoutStatuses() },
    { name: 'held-remainders', at: '00:15', run: () => payments.postHeld(clock.today()) },
    { name: 'late-ladder', at: '06:00', run: () => ops.runLateLadder(clock.today()) },
    { name: 'reconciliation', at: '06:30', run: () => ops.reconcile(addDays(clock.today(), -1)) },
    { name: 'review-reminders', at: '07:00', run: () => reviews.run(clock.today()) },
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
