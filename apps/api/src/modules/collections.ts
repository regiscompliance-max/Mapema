/**
 * [Backend Engineer + Credit + Compliance & Risk Analyst] Phase 2 late-payment automation (COL-01..05).
 * Daily job (08:00 EAT - inside reasonable contact hours):
 *   1. reminders pre-due / due / overdue to the buyer, supplier warning, by SMS + email (Notifier ->
 *      outbox -> SMS/email adapters); once per step (reminder_event), catch-up sends only the latest
 *   2. DPD status: funded -> late (1 DPD) -> recourse case opens (policy.recourseAfterDays) -> NPL
 *      (policy NPL days by term). Periods configurable by maker-checker; counsel to confirm (Q-D)
 *   3. NPL in duplum cap: charges after NPL capped at principal at NPL; excess waived IN THE LEDGER
 *   4. the Phase 1 staff ladder tasks (D7 call, D14 demand, recourse decision) as collection_action rows
 * Recourse to the supplier is maker-checker: credit proposes, a different credit user (or CEO) approves.
 */
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { ageingBucket, CollectionsPolicy, DEFAULT_COLLECTIONS_POLICY, dpd, dpdStage, dueReminderSteps, formatKes, inDuplumWaiver, nplThreshold, validatePolicy } from '@mapema/pricing';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS } from '../common/config';
import { Clock } from '../common/clock';
import { Db, toCents } from '../common/db';
import { badRequest, conflict, notFound } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { AuthUser, CurrentUser, Roles, STAFF_ROLES, StepUp } from '../auth/auth';
import { ApprovalsService } from './approvals';

const PolicyBody = z.object({
  preDueDays: z.array(z.number().int()), overdueDays: z.array(z.number().int()), supplierWarningDay: z.number().int(), recourseAfterDays: z.number().int(),
  nplDaysShortTerm: z.number().int(), nplDaysLongTerm: z.number().int(), shortTermMaxDays: z.number().int(), counselConfirmed: z.boolean(),
}).strict();

@Injectable()
export class CollectionsService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly clock: Clock,
    private readonly notifier: Notifier,
    private readonly approvals: ApprovalsService,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
  ) {}

  onModuleInit() {
    this.approvals.register('collections_policy_change', async (c, a) => {
      const before = (await c.query(`SELECT value FROM platform_setting WHERE key = 'collections_policy'`)).rows[0]?.value;
      await c.query(`UPDATE platform_setting SET value = $1::jsonb, updated_via = $2, updated_at = now() WHERE key = 'collections_policy'`, [JSON.stringify(a.payload.policy), a.id]);
      await this.audit.record(c, SYSTEM, 'collections.policy_changed', 'platform_setting', a.entity_id, before, a.payload.policy);
    });
    this.approvals.register('recourse_start', async (c, a) => {
      const adv = (await c.query(`SELECT a.*, i.invoice_number, i.due_date AS inv_due, ca.virtual_account_no FROM advance a JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN collection_account ca ON ca.buyer_id = a.buyer_id WHERE a.id = $1 FOR UPDATE OF a`, [a.entity_id])).rows[0];
      if (!adv || !['late', 'non_performing'].includes(adv.status)) throw conflict('BAD_STATE', `Advance is ${adv?.status}`);
      const today = this.clock.today();
      const q = await this.adapters.ledger.payoffQuote(Number(adv.fineract_loan_id), today);
      if (adv.status === 'late') await c.query(`UPDATE advance SET status = 'recourse', recourse_at = $2, updated_at = now() WHERE id = $1`, [adv.id, today]);
      else await c.query(`UPDATE advance SET recourse_at = $2, updated_at = now() WHERE id = $1`, [adv.id, today]);
      await c.query(`UPDATE recourse_case SET status = 'demanded', approved_via = $2, demanded_on = $3, amount_demanded_cents = $4 WHERE advance_id = $1`, [adv.id, a.id, today, q.totalCents]);
      await c.query(`INSERT INTO collection_action (advance_id, stage, channel, performed_by, outcome) VALUES ($1,'d30_recourse','letter',$2,$3)`, [adv.id, a.maker_id, `recourse approved: ${a.payload.reason}`]);
      await this.audit.record(c, SYSTEM, 'advance.recourse', 'advance', adv.id, { status: adv.status }, { status: adv.status === 'late' ? 'recourse' : adv.status, amountDemandedCents: q.totalCents, reason: a.payload.reason });
      await this.notifier.toOrg(c, adv.supplier_id, 'recourse.demand', { invoice: adv.invoice_number, days: String(dpd(adv.due_date, today)), amount: formatKes(q.totalCents), account: adv.virtual_account_no ?? '-' }, { type: 'advance', id: adv.id });
    });
  }

  async policy(q = this.db.pool): Promise<CollectionsPolicy> {
    const v = (await q.query(`SELECT value FROM platform_setting WHERE key = 'collections_policy'`)).rows[0]?.value;
    return { ...DEFAULT_COLLECTIONS_POLICY, ...(v ?? {}) };
  }

  async proposePolicy(u: AuthUser, body: unknown) {
    const p = PolicyBody.parse(body) as CollectionsPolicy;
    const errs = validatePolicy(p);
    if (errs.length) throw badRequest('BAD_POLICY', errs.join('; '));
    return this.db.tx((c) => this.approvals.propose(c, u, { action: 'collections_policy_change', entityType: 'platform_setting', entityId: '00000000-0000-0000-0000-00000000000c', payload: { policy: p }, requiredRole: 'ceo', reason: 'Collections policy change' }));
  }

  // ------------------------------------------------------------------ daily run
  async runDaily(today = this.clock.today()) {
    const policy = await this.policy();
    const rows = await this.db.query(
      `SELECT a.id, a.status, a.term_days, a.buyer_id, a.supplier_id, a.due_date, a.fineract_loan_id, a.principal_cents, a.verification_fee_cents,
              a.npl_principal_cents, a.npl_charges_cents, a.in_duplum_waived_cents, i.invoice_number, i.amount_cents, i.status AS invoice_status, ca.virtual_account_no,
              (SELECT array_agg(stage) FROM collection_action x WHERE x.advance_id = a.id) AS done,
              (SELECT array_agg(step_key) FROM reminder_event r WHERE r.advance_id = a.id) AS sent,
              (SELECT id FROM recourse_case rc WHERE rc.advance_id = a.id) AS case_id
       FROM advance a JOIN invoice i ON i.id = a.invoice_id LEFT JOIN collection_account ca ON ca.buyer_id = a.buyer_id
       WHERE a.status IN ('funded','late','recourse','non_performing') ORDER BY a.due_date, a.id`);
    const out = { checked: rows.length, actions: [] as { advanceId: string; stage: string }[], reminders: [] as any[], skipped: [] as any[], moves: [] as any[], recourseCases: [] as any[], waivers: [] as any[] };
    for (const r of rows) {
      const d = dpd(r.due_date, today);
      const term = r.term_days ?? 120;
      const stage = dpdStage(d, term, policy);
      const loanId = r.fineract_loan_id ? Number(r.fineract_loan_id) : null;
      // NPL snapshot / in duplum need ledger reads, done outside the transaction
      let nplSnap: { principal: bigint; charges: bigint } | null = null;
      if (stage === 'npl' && r.status !== 'non_performing' && loanId) {
        const st = await this.adapters.ledger.getLoan(loanId, today);
        nplSnap = { principal: st.principalOutstandingCents, charges: this.charges(st, toCents(r.verification_fee_cents)) };
      }
      await this.db.tx(async (c) => {
        const params = { invoice: r.invoice_number, amount: formatKes(toCents(r.amount_cents)), due: r.due_date, account: r.virtual_account_no ?? '-', days: String(d) };
        // 1. reminders (not while the invoice is disputed - BUY-07 freezes collections)
        if (r.invoice_status !== 'disputed') {
          const { send, skip } = dueReminderSteps(r.due_date, today, r.sent ?? [], policy);
          for (const s of skip) {
            await c.query(`INSERT INTO reminder_event (advance_id, step_key, audience, scheduled_for, status, run_date) VALUES ($1,$2,$3,$4,'skipped',$5) ON CONFLICT DO NOTHING`, [r.id, s.key, s.audience, s.date, today]);
            out.skipped.push({ advanceId: r.id, key: s.key });
          }
          for (const s of send) {
            const ins = await c.query(`INSERT INTO reminder_event (advance_id, step_key, audience, scheduled_for, status, run_date) VALUES ($1,$2,$3,$4,'sent',$5) ON CONFLICT DO NOTHING RETURNING id`, [r.id, s.key, s.audience, s.date, today]);
            if (!ins.rows.length) continue;
            await this.notifier.toOrg(c, s.audience === 'buyer' ? r.buyer_id : r.supplier_id, s.template, params, { type: 'advance', id: r.id });
            await this.audit.record(c, SYSTEM, 'collections.reminder', 'advance', r.id, null, { step: s.key, audience: s.audience });
            out.reminders.push({ advanceId: r.id, key: s.key, audience: s.audience });
          }
        }
        if (d < 1) return;
        // 2. status moves + staff ladder
        const done: string[] = r.done ?? [];
        const step = async (stg: string, outcome: string) => {
          if (done.includes(stg)) return;
          await c.query(`INSERT INTO collection_action (advance_id, stage, channel, outcome) VALUES ($1,$2,'system',$3)`, [r.id, stg, outcome]);
          await this.audit.record(c, SYSTEM, `collections.${stg}`, 'advance', r.id, null, { daysLate: d });
          out.actions.push({ advanceId: r.id, stage: stg });
          done.push(stg);
        };
        let status = r.status;
        if (status === 'funded') {
          await c.query(`UPDATE advance SET status = 'late', late_at = $2, updated_at = now() WHERE id = $1`, [r.id, today]);
          await this.audit.record(c, SYSTEM, 'advance.late', 'advance', r.id, { status }, { status: 'late', dpd: d });
          out.moves.push({ advanceId: r.id, from: status, to: 'late' });
          status = 'late';
        }
        await step('d1_reminder', 'buyer reminder schedule running (see reminder_event)');
        if (d >= 7) await step('d7_call', 'task: ops to call buyer AP');
        if (d >= 7 && !(r.done ?? []).includes('d7_call')) await this.notifier.toRole(c, 'ops', 'reminder.overdue', params, { type: 'advance', id: r.id });
        if (d >= 14) await step('d14_demand', 'task: ops to issue demand letter (template needs counsel sign-off)');
        if (d >= policy.recourseAfterDays) {
          await step('d30_recourse', 'task: credit to decide recourse to supplier (maker-checker)');
          if (!r.case_id) {
            await c.query(`INSERT INTO recourse_case (advance_id, supplier_id, opened_on, dpd_at_open) VALUES ($1,$2,$3,$4) ON CONFLICT (advance_id) DO NOTHING`, [r.id, r.supplier_id, today, d]);
            await this.notifier.toRole(c, 'credit', 'recourse.case_due', params, { type: 'advance', id: r.id });
            out.recourseCases.push({ advanceId: r.id, status: 'due' });
          }
        }
        if (nplSnap) {
          await c.query(`UPDATE advance SET status = 'non_performing', npl_at = $2, npl_principal_cents = $3, npl_charges_cents = $4, updated_at = now() WHERE id = $1`, [r.id, today, nplSnap.principal, nplSnap.charges]);
          await step('npl', `classified non-performing at ${d} DPD (threshold ${nplThreshold(term, policy)}); in duplum cap applies`);
          await this.audit.record(c, SYSTEM, 'advance.non_performing', 'advance', r.id, { status }, { status: 'non_performing', dpd: d, principalAtNplCents: nplSnap.principal, chargesAtNplCents: nplSnap.charges });
          await this.notifier.toRole(c, 'compliance', 'collections.npl', params, { type: 'advance', id: r.id });
          await this.notifier.toRole(c, 'credit', 'collections.npl', params, { type: 'advance', id: r.id });
          out.moves.push({ advanceId: r.id, from: status, to: 'non_performing' });
          r.status = 'non_performing'; r.npl_principal_cents = nplSnap.principal.toString(); r.npl_charges_cents = nplSnap.charges.toString();
        }
      });
      // 3. in duplum cap (ledger first, then record)
      if (r.status === 'non_performing' && loanId && r.npl_principal_cents !== null) {
        const w = await this.capInDuplum(r, loanId, today);
        if (w) out.waivers.push(w);
      }
    }
    return out;
  }

  private charges(st: { interestChargedCents: bigint; interestWaivedCents?: bigint; penaltiesOutstandingCents: bigint }, verificationFee: bigint) {
    return st.interestChargedCents - (st.interestWaivedCents ?? 0n) + verificationFee + st.penaltiesOutstandingCents;
  }

  private async capInDuplum(r: any, loanId: number, today: string) {
    const exists = await this.db.one(`SELECT 1 FROM in_duplum_waiver WHERE advance_id = $1 AND as_of_date = $2`, [r.id, today]);
    if (exists) return null;
    const st = await this.adapters.ledger.getLoan(loanId, today);
    let waive = inDuplumWaiver(toCents(r.npl_principal_cents), toCents(r.npl_charges_cents), this.charges(st, toCents(r.verification_fee_cents)));
    if (waive > st.interestOutstandingCents) waive = st.interestOutstandingCents; // only interest is waivable; principal never
    if (waive <= 0n) return null;
    const ref = await this.adapters.ledger.waiveInterest({ requestId: `induplum-${r.id}-${today}` }, loanId, waive, today, 'In duplum cap (NDTCP Regulations 2026 - counsel to confirm)', `induplum-${r.id}-${today}`);
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO in_duplum_waiver (advance_id, as_of_date, amount_cents, ledger_ref) VALUES ($1,$2,$3,$4)`, [r.id, today, waive, ref]);
      await c.query(`UPDATE advance SET in_duplum_waived_cents = in_duplum_waived_cents + $2, updated_at = now() WHERE id = $1`, [r.id, waive]);
      await this.audit.record(c, SYSTEM, 'collections.in_duplum_waiver', 'advance', r.id, null, { waivedCents: waive, ledgerRef: ref, date: today });
    });
    return { advanceId: r.id, waivedCents: waive.toString() };
  }

  // ------------------------------------------------------------------ recourse (maker-checker)
  async proposeRecourse(u: AuthUser, advanceId: string, reason: string) {
    return this.db.tx(async (c) => {
      const a = (await c.query(`SELECT a.status, a.supplier_id, a.due_date FROM advance a WHERE a.id = $1`, [advanceId])).rows[0];
      if (!a) throw notFound('Advance');
      if (!['late', 'non_performing'].includes(a.status)) throw conflict('BAD_STATE', 'Recourse only on late or non-performing advances');
      const today = this.clock.today();
      await c.query(`INSERT INTO recourse_case (advance_id, supplier_id, opened_on, dpd_at_open) VALUES ($1,$2,$3,$4) ON CONFLICT (advance_id) DO NOTHING`, [advanceId, a.supplier_id, today, dpd(a.due_date, today)]);
      const cs = (await c.query(`SELECT id, status FROM recourse_case WHERE advance_id = $1`, [advanceId])).rows[0];
      if (cs.status !== 'due') throw conflict('BAD_STATE', `Recourse case is ${cs.status}`);
      await c.query(`UPDATE recourse_case SET proposed_by = $2, note = $3 WHERE id = $1`, [cs.id, u.id, reason]);
      return this.approvals.propose(c, u, { action: 'recourse_start', entityType: 'advance', entityId: advanceId, payload: { reason, caseId: cs.id }, requiredRole: 'credit', reason });
    });
  }

  recourseCases() {
    return this.db.query(`SELECT rc.*, i.invoice_number, s.legal_name AS supplier, a.status AS advance_status, a.due_date
      FROM recourse_case rc JOIN advance a ON a.id = rc.advance_id JOIN invoice i ON i.id = a.invoice_id JOIN organisation s ON s.id = rc.supplier_id ORDER BY rc.opened_on DESC`);
  }

  async book(today = this.clock.today()) {
    const rows = await this.db.query(`SELECT a.id, a.status, a.due_date, a.term_days, a.principal_cents, a.npl_at, a.in_duplum_waived_cents, i.invoice_number, i.amount_cents, b.legal_name AS buyer, s.legal_name AS supplier,
        (SELECT max(step_key || '@' || run_date) FROM reminder_event r WHERE r.advance_id = a.id AND r.status = 'sent') AS last_reminder,
        (SELECT status FROM recourse_case rc WHERE rc.advance_id = a.id) AS recourse_status
      FROM advance a JOIN invoice i ON i.id = a.invoice_id JOIN organisation b ON b.id = a.buyer_id JOIN organisation s ON s.id = a.supplier_id
      WHERE a.status IN ('funded','late','recourse','non_performing') ORDER BY a.due_date`);
    return rows.map((r) => { const d = dpd(r.due_date, today); return { ...r, dpd: d, bucket: ageingBucket(d) }; });
  }
}

@Controller()
export class CollectionsController {
  constructor(private readonly s: CollectionsService) {}

  @Post('collections/run') @Roles('ops')
  run() { return this.s.runDaily(); }

  @Post('ops/late-ladder/run') @Roles('ops')
  ladder() { return this.s.runDaily(); }

  @Get('collections/book') @Roles(...STAFF_ROLES, 'auditor')
  book() { return this.s.book(); }

  @Get('collections/policy') @Roles(...STAFF_ROLES, 'auditor')
  policy() { return this.s.policy(); }

  @Post('collections/policy') @Roles('credit') @StepUp()
  propose(@CurrentUser() u: AuthUser, @Body() b: unknown) { return this.s.proposePolicy(u, b); }

  @Get('recourse-cases') @Roles(...STAFF_ROLES, 'auditor')
  cases() { return this.s.recourseCases(); }

  @Post('advances/:id/recourse') @Roles('credit') @StepUp()
  recourse(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.proposeRecourse(u, zUuid.parse(id), z.object({ reason: zText() }).parse(b).reason);
  }
}
