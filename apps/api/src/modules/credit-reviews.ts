/**
 * [Backend Engineer + Credit] CRD-07 review-date reminders (Phase 1b).
 * Daily (worker 07:00 EAT): for every live/approved buyer programme review date, every active
 * buyer/supplier limit review date, and every active party's KYC expiry, create a credit task at
 * 30 days, 7 days and on the date itself (threshold 0), and email the credit team. Idempotent per
 * (kind, subject, due date, threshold). On the date the party is excluded from new advances by the
 * automatic checks PROGRAMME_IN_REVIEW_DATE / KYC_CURRENT (AdvancesService.checks), enforced again at release.
 */
import { Body, Controller, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { addDays } from '@mapema/pricing';
import { Audit, SYSTEM } from '../common/audit';
import { Clock } from '../common/clock';
import { Db, Q } from '../common/db';
import { conflict, notFound } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { AuthUser, CurrentUser, Roles } from '../auth/auth';

const KIND_LABEL: Record<string, string> = { programme_review: 'Buyer programme review', limit_review: 'Limit review', kyc_expiry: 'KYC refresh' };

/** Earliest expiry among each party's latest PASSING KYC checks (org + its people). */
export const KYC_EXPIRY_SQL = `
  SELECT MIN(k.expires_at) AS expires_at FROM (
    SELECT DISTINCT ON (kc.subject_org_id, kc.subject_person_id, kc.check_type) kc.expires_at, kc.result
    FROM kyc_check kc WHERE kc.subject_org_id = $1 OR kc.subject_person_id IN (SELECT id FROM person WHERE org_id = $1)
    ORDER BY kc.subject_org_id, kc.subject_person_id, kc.check_type, kc.checked_at DESC) k
  WHERE k.result = 'pass' AND k.expires_at IS NOT NULL`;

export async function kycExpiry(q: Q, orgId: string): Promise<Date | null> {
  const r = (await q.query(KYC_EXPIRY_SQL, [orgId])).rows[0];
  return r?.expires_at ? new Date(r.expires_at) : null;
}

@Injectable()
export class CreditReviewService {
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly notifier: Notifier, private readonly audit: Audit) {}

  private threshold(today: string, due: string): 30 | 7 | 0 | null {
    if (today >= due) return 0;
    if (today >= addDays(due, -7)) return 7;
    if (today >= addDays(due, -30)) return 30;
    return null;
  }

  async run(today = this.clock.today()) {
    const horizon = addDays(today, 30);
    const items: { kind: string; org_id: string; org_name: string; entity_type: string; entity_id: string; due: string }[] = [];
    items.push(...(await this.db.query(`SELECT 'programme_review' AS kind, bp.buyer_id AS org_id, o.legal_name AS org_name, 'buyer_programme' AS entity_type, bp.id AS entity_id, bp.review_date AS due
      FROM buyer_programme bp JOIN organisation o ON o.id = bp.buyer_id WHERE bp.status IN ('approved','live') AND bp.review_date <= $1`, [horizon])));
    items.push(...(await this.db.query(`SELECT 'limit_review' AS kind, l.subject_org_id AS org_id, o.legal_name AS org_name, 'limit_config' AS entity_type, l.id AS entity_id, l.review_date AS due
      FROM limit_config l JOIN organisation o ON o.id = l.subject_org_id WHERE l.active AND l.subject IN ('buyer','supplier') AND l.review_date IS NOT NULL AND l.review_date <= $1`, [horizon])));
    const parties = await this.db.query(`SELECT id, legal_name FROM organisation WHERE status IN ('live','active','approved')`);
    for (const p of parties) {
      const exp = await kycExpiry(this.db.pool, p.id);
      if (!exp) continue;
      const due = new Date(exp.getTime() + 3 * 3600_000).toISOString().slice(0, 10); // EAT date
      if (due <= horizon) items.push({ kind: 'kyc_expiry', org_id: p.id, org_name: p.legal_name, entity_type: 'organisation', entity_id: p.id, due });
    }
    let created = 0;
    for (const it of items) {
      const t = this.threshold(today, it.due);
      if (t === null) continue;
      await this.db.tx(async (c) => {
        const row = (await c.query(`INSERT INTO credit_task (kind, org_id, entity_type, entity_id, due_date, threshold_days) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (kind, entity_id, due_date, threshold_days) DO NOTHING RETURNING id`, [it.kind, it.org_id, it.entity_type, it.entity_id, it.due, t])).rows[0];
        if (!row) return;
        created++;
        await this.audit.record(c, SYSTEM, 'credit_task.create', 'credit_task', row.id, null, { kind: it.kind, orgId: it.org_id, due: it.due, thresholdDays: t });
        await this.notifier.toRole(c, 'credit', 'credit.review_due', { what: KIND_LABEL[it.kind], org: it.org_name, date: it.due,
          when: t === 0 ? 'today - new advances are blocked until reviewed' : `in ${t} days` }, { type: 'credit_task', id: row.id });
      });
    }
    return { date: today, candidates: items.length, created };
  }

  list(status?: 'open' | 'done') {
    return this.db.query(`SELECT t.id, t.kind, t.org_id, o.legal_name AS org_name, o.type AS org_type, t.entity_type, t.entity_id, t.due_date, t.threshold_days, t.status, t.note, t.created_at, t.done_at
      FROM credit_task t JOIN organisation o ON o.id = t.org_id WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.status, t.due_date, t.threshold_days LIMIT 500`, [status ?? null]);
  }

  async done(u: AuthUser, id: string, note: string) {
    return this.db.tx(async (c) => {
      const t = (await c.query(`SELECT * FROM credit_task WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!t) throw notFound('Task');
      if (t.status !== 'open') throw conflict('TASK_DONE', 'This task is already done');
      await c.query(`UPDATE credit_task SET status = 'done', done_by = $2, done_at = now(), note = $3 WHERE id = $1`, [id, u.id, note]);
      await this.audit.record(c, u.actor, 'credit_task.done', 'credit_task', id, { status: 'open' }, { status: 'done', note });
      return { id, status: 'done' };
    });
  }
}

@Controller('credit')
export class CreditReviewController {
  constructor(private readonly s: CreditReviewService) {}

  @Post('review-reminders/run') @Roles('credit', 'admin')
  run() { return this.s.run(); }

  @Get('tasks') @Roles('credit', 'ceo', 'admin', 'auditor')
  list(@Query('status') status?: string) { return this.s.list(status ? z.enum(['open', 'done']).parse(status) : undefined); }

  @Post('tasks/:id/done') @Roles('credit')
  done(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.done(u, zUuid.parse(id), z.object({ note: zText(2000) }).parse(b).note);
  }
}
