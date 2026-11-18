/**
 * [Backend Engineer + Compliance & Risk Analyst] Operations: late-payment ladder (OPS-08),
 * recourse, disputes (BUY-07 / OPS-11), complaints (reg. 40 clocks, counsel to confirm), data
 * subject requests (DPA 2019 s.26), AML flags (POCAMLA), daily reconciliation (OPS-06).
 */
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS } from '../common/config';
import { Clock } from '../common/clock';
import { Db, toCents } from '../common/db';
import { conflict, notFound, unprocessable } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { assertOrgAccess, AuthUser, BUYER_ROLES, CurrentUser, isStaff, orgIds, Public, Roles, STAFF_ROLES, StepUp, SUPPLIER_ROLES } from '../auth/auth';
import { ApprovalsService } from './approvals';

export const DSR_DAYS = 7; // DP (General) Regs 2021 access-request clock; counsel to confirm (Q-16)

@Injectable()
export class OpsService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly clock: Clock,
    private readonly notifier: Notifier,
    private readonly approvals: ApprovalsService,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
  ) {}

  onModuleInit() {
    this.approvals.register('dispute_close', async (c, a) => {
      await c.query(`UPDATE dispute SET status = $2, resolution = $3, closed_via = $4, closed_at = now() WHERE id = $1 AND status IN ('open','investigating')`,
        [a.entity_id, a.payload.outcome, a.payload.resolution, a.id]);
      await c.query(`UPDATE invoice SET status = $2, updated_at = now() WHERE id = $1 AND status = 'disputed'`, [a.payload.invoiceId, a.payload.restoreStatus]);
    });
  }

  // late ladder + recourse moved to collections.ts (Phase 2 COL-01..05)

  async addCollectionNote(u: AuthUser, advanceId: string, b: { channel: string; outcome: string }) {
    return this.db.tx(async (c) => {
      const r = (await c.query(`INSERT INTO collection_action (advance_id, stage, channel, performed_by, outcome) VALUES ($1,'note',$2,$3,$4) RETURNING id`, [advanceId, b.channel, u.id, b.outcome])).rows[0];
      await this.audit.record(c, u.actor, 'collections.note', 'advance', advanceId, null, { channel: b.channel });
      return r;
    });
  }

  collectionActions(advanceId: string) {
    return this.db.query(`SELECT id, stage, channel, performed_by, outcome, performed_at FROM collection_action WHERE advance_id = $1 ORDER BY performed_at`, [advanceId]);
  }

  // ------------------------------------------------------------------ disputes
  async raiseDispute(u: AuthUser, b: { invoiceId: string; reasonCode: string; description?: string }) {
    return this.db.tx(async (c) => {
      const inv = (await c.query(`SELECT id, buyer_id, status FROM invoice WHERE id = $1 FOR UPDATE`, [b.invoiceId])).rows[0];
      if (!inv) throw notFound('Invoice');
      if (!orgIds(u, BUYER_ROLES).includes(inv.buyer_id)) throw notFound('Invoice');
      if (['settled', 'cancelled', 'rejected', 'disputed'].includes(inv.status)) throw conflict('BAD_STATE', `Invoice is ${inv.status}`);
      const d = (await c.query(`INSERT INTO dispute (invoice_id, buyer_id, raised_by, reason_code, description) VALUES ($1,$2,$3,$4,$5) RETURNING id, status`,
        [inv.id, inv.buyer_id, u.id, b.reasonCode, b.description ?? null])).rows[0];
      await c.query(`UPDATE invoice SET status = 'disputed', updated_at = now() WHERE id = $1`, [inv.id]);
      await this.audit.record(c, u.actor, 'dispute.open', 'dispute', d.id, { invoiceStatus: inv.status }, { reasonCode: b.reasonCode });
      await this.notifier.toRole(c, 'ops', 'dispute.opened', { invoice: inv.id });
      // store the status to restore on close
      await c.query(`UPDATE dispute SET resolution = $2 WHERE id = $1`, [d.id, `prior_status:${inv.status}`]);
      return d;
    });
  }

  async proposeDisputeClose(u: AuthUser, id: string, b: { outcome: 'resolved' | 'withdrawn'; resolution: string; invoiceValid: boolean }) {
    return this.db.tx(async (c) => {
      const d = (await c.query(`SELECT * FROM dispute WHERE id = $1`, [id])).rows[0];
      if (!d) throw notFound('Dispute');
      if (!['open', 'investigating'].includes(d.status)) throw conflict('BAD_STATE', `Dispute is ${d.status}`);
      const prior = String(d.resolution ?? '').replace('prior_status:', '') || 'confirmed';
      const restoreStatus = b.invoiceValid ? prior : 'cancelled';
      return this.approvals.propose(c, u, { action: 'dispute_close', entityType: 'dispute', entityId: id, payload: { outcome: b.outcome, resolution: b.resolution, invoiceId: d.invoice_id, restoreStatus }, requiredRole: 'compliance', reason: b.resolution });
    });
  }

  listDisputes(u: AuthUser) {
    const buyers = isStaff(u) || u.roles.some((r) => r.role === 'auditor') ? null : orgIds(u, BUYER_ROLES);
    return this.db.query(`SELECT d.id, d.invoice_id, d.buyer_id, d.reason_code, d.description, d.status, d.opened_at, d.closed_at, i.invoice_number
      FROM dispute d JOIN invoice i ON i.id = d.invoice_id WHERE ($1::uuid[] IS NULL OR d.buyer_id = ANY($1)) ORDER BY d.opened_at DESC`, [buyers]);
  }

  // ------------------------------------------------------------------ complaints (reg. 40)
  async raiseComplaint(u: AuthUser, b: { category: string; description: string; orgId?: string }) {
    if (b.orgId) assertOrgAccess(u, b.orgId);
    const now = this.clock.now();
    return this.db.tx(async (c) => {
      const r = (await c.query(`INSERT INTO complaint (org_id, raised_by, category, description, ack_due_at, resolve_due_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ack_due_at, resolve_due_at, status`,
        [b.orgId ?? null, u.id, b.category, b.description, new Date(now.getTime() + 7 * 864e5), new Date(now.getTime() + 30 * 864e5)])).rows[0];
      await this.audit.record(c, u.actor, 'complaint.open', 'complaint', r.id, null, { category: b.category });
      await this.notifier.toRole(c, 'compliance', 'complaint.ack', { ref: r.id.slice(0, 8), due: r.resolve_due_at.toISOString().slice(0, 10) });
      return r;
    });
  }

  async updateComplaint(u: AuthUser, id: string, status: 'acknowledged' | 'resolved' | 'escalated' | 'closed', note: string) {
    return this.db.tx(async (c) => {
      const r = (await c.query(`UPDATE complaint SET status = $2, acknowledged_at = COALESCE(acknowledged_at, CASE WHEN $2 <> 'open' THEN now() END),
        resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now() ELSE resolved_at END WHERE id = $1 RETURNING id, status`, [id, status])).rows[0];
      if (!r) throw notFound('Complaint');
      await this.audit.record(c, u.actor, `complaint.${status}`, 'complaint', id, null, { note });
      return r;
    });
  }

  listComplaints(u: AuthUser) {
    const own = isStaff(u) || u.roles.some((r) => r.role === 'auditor') ? null : u.id;
    return this.db.query(`SELECT id, org_id, category, description, status, ack_due_at, resolve_due_at, acknowledged_at, resolved_at, created_at,
        (status NOT IN ('resolved','closed') AND now() > resolve_due_at) AS overdue
      FROM complaint WHERE ($1::uuid IS NULL OR raised_by = $1) ORDER BY created_at DESC`, [own]);
  }

  // ------------------------------------------------------------------ DSR (DPA 2019 Part IV)
  async createDsr(b: { email: string; type: string }) {
    const due = new Date(this.clock.now().getTime() + DSR_DAYS * 864e5);
    return this.db.tx(async (c) => {
      const r = (await c.query(`INSERT INTO data_subject_request (requester_email, type, due_at) VALUES ($1,$2,$3) RETURNING id, status, due_at`, [b.email, b.type, due])).rows[0];
      await this.audit.record(c, SYSTEM, 'dsr.received', 'data_subject_request', r.id, null, { type: b.type });
      await this.notifier.toRole(c, 'compliance', 'dsr.received', { ref: r.id.slice(0, 8) });
      return { id: r.id, status: r.status, dueAt: r.due_at };
    });
  }

  async updateDsr(u: AuthUser, id: string, b: { status: string; note?: string; identityVerified?: boolean }) {
    return this.db.tx(async (c) => {
      const r = (await c.query(`UPDATE data_subject_request SET status = $2, outcome_note = COALESCE($3, outcome_note), handled_by = $4,
        identity_verified_at = CASE WHEN $5 THEN COALESCE(identity_verified_at, now()) ELSE identity_verified_at END WHERE id = $1 RETURNING id, status`,
        [id, b.status, b.note ?? null, u.id, b.identityVerified ?? false])).rows[0];
      if (!r) throw notFound('Data subject request');
      await this.audit.record(c, u.actor, `dsr.${b.status}`, 'data_subject_request', id, null, { note: b.note });
      return r;
    });
  }

  listDsr() {
    return this.db.query(`SELECT id, requester_email, type, status, due_at, identity_verified_at, created_at, (status NOT IN ('completed','refused') AND now() > due_at) AS overdue FROM data_subject_request ORDER BY created_at DESC`);
  }

  // ------------------------------------------------------------------ AML
  listAml() {
    return this.db.query(`SELECT f.id, f.org_id, o.legal_name, f.entity_type, f.entity_id, f.rule_code, f.status, f.frc_goaml_ref, f.created_at FROM aml_flag f LEFT JOIN organisation o ON o.id = f.org_id ORDER BY f.created_at DESC`);
  }

  async reviewAml(u: AuthUser, id: string, b: { outcome: 'dismissed' | 'str_filed'; goamlRef?: string; note: string }) {
    if (b.outcome === 'str_filed' && !b.goamlRef) throw unprocessable('GOAML_REF_REQUIRED', 'Enter the goAML reference of the STR');
    return this.db.tx(async (c) => {
      const r = (await c.query(`UPDATE aml_flag SET status = $2, frc_goaml_ref = $3, reviewed_by = $4 WHERE id = $1 AND status = 'open' RETURNING id, status`, [id, b.outcome, b.goamlRef ?? null, u.id])).rows[0];
      if (!r) throw notFound('Open AML flag');
      await this.audit.record(c, u.actor, `aml.${b.outcome}`, 'aml_flag', id, null, { note: b.note }); // tipping-off: never notify the customer
      return r;
    });
  }

  // reconciliation moved to reconciliation.ts (Phase 2 REC-01..06)

  // ------------------------------------------------------------------ funding (float top-up record)
  async recordFunding(u: AuthUser, b: { amountCents: bigint; source: string; reference: string; valueDate: string }) {
    const row = await this.db.tx(async (c) => {
      const r = (await c.query(`INSERT INTO funding_movement (amount_cents, direction, source, reference, value_date) VALUES ($1,'in',$2,$3,$4) ON CONFLICT (reference) DO NOTHING RETURNING id`,
        [b.amountCents, b.source, b.reference, b.valueDate])).rows[0];
      if (!r) throw conflict('DUPLICATE_REFERENCE', 'Funding reference already recorded');
      await this.audit.record(c, u.actor, 'funding.in', 'funding_movement', r.id, null, { amountCents: b.amountCents, source: b.source });
      return r;
    });
    await this.adapters.ledger.postJournal({ requestId: `fund-${row.id}` }, { date: b.valueDate, debit: 'bank', credit: 'equity', amountCents: b.amountCents, reference: `fund-${b.reference}`, note: `Funding ${b.source}` });
    return row;
  }
}

const Dispute = z.object({ invoiceId: zUuid, reasonCode: z.enum(['goods_not_received', 'quality', 'pricing', 'duplicate', 'other']), description: z.string().max(2000).optional() });

@Controller()
export class OpsController {
  constructor(private readonly s: OpsService) {}

  @Post('advances/:id/collection-actions') @Roles('ops', 'credit')
  note(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.addCollectionNote(u, zUuid.parse(id), z.object({ channel: z.enum(['email', 'sms', 'call', 'letter']), outcome: zText(2000) }).parse(b));
  }

  @Get('advances/:id/collection-actions') @Roles(...STAFF_ROLES, 'auditor')
  actions(@Param('id') id: string) { return this.s.collectionActions(zUuid.parse(id)); }

  @Post('disputes') @Roles('buyer_admin', 'buyer_checker')
  dispute(@CurrentUser() u: AuthUser, @Body() b: unknown) { return this.s.raiseDispute(u, Dispute.parse(b)); }

  @Get('disputes') @Roles(...STAFF_ROLES, ...BUYER_ROLES, 'auditor')
  disputes(@CurrentUser() u: AuthUser) { return this.s.listDisputes(u); }

  @Post('disputes/:id/close') @Roles('ops')
  closeDispute(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.proposeDisputeClose(u, zUuid.parse(id), z.object({ outcome: z.enum(['resolved', 'withdrawn']), resolution: zText(2000), invoiceValid: z.boolean() }).parse(b));
  }

  @Post('complaints') @Roles(...BUYER_ROLES, ...SUPPLIER_ROLES)
  complaint(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    return this.s.raiseComplaint(u, z.object({ category: z.enum(['pricing', 'service', 'payout', 'data', 'conduct', 'other']), description: zText(4000), orgId: zUuid.optional() }).parse(b));
  }

  @Get('complaints') @Roles(...STAFF_ROLES, ...BUYER_ROLES, ...SUPPLIER_ROLES, 'auditor')
  complaints(@CurrentUser() u: AuthUser) { return this.s.listComplaints(u); }

  @Post('complaints/:id/status') @Roles('compliance', 'ops')
  complaintStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ status: z.enum(['acknowledged', 'resolved', 'escalated', 'closed']), note: zText(2000) }).parse(b);
    return this.s.updateComplaint(u, zUuid.parse(id), body.status, body.note);
  }

  @Public() @Post('public/data-requests')
  dsr(@Body() b: unknown) {
    return this.s.createDsr(z.object({ email: z.string().email().max(254), type: z.enum(['access', 'correction', 'deletion', 'objection', 'portability', 'restriction']) }).parse(b));
  }

  @Get('dsr') @Roles('compliance')
  dsrs() { return this.s.listDsr(); }

  @Post('dsr/:id') @Roles('compliance')
  dsrUpdate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.updateDsr(u, zUuid.parse(id), z.object({ status: z.enum(['verifying', 'in_progress', 'completed', 'refused', 'partially_completed']), note: z.string().max(2000).optional(), identityVerified: z.boolean().optional() }).parse(b));
  }

  @Get('aml-flags') @Roles('compliance')
  aml() { return this.s.listAml(); }

  @Post('aml-flags/:id/review') @Roles('compliance') @StepUp()
  amlReview(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.reviewAml(u, zUuid.parse(id), z.object({ outcome: z.enum(['dismissed', 'str_filed']), goamlRef: z.string().max(64).optional(), note: zText(2000) }).parse(b));
  }

  @Post('funding') @Roles('ceo') @StepUp()
  funding(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ amountCents: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform((v) => BigInt(v)), source: zText(200), reference: z.string().min(3).max(64), valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(b);
    return this.s.recordFunding(u, body);
  }
}

