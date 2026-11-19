/**
 * [Backend Engineer + Security Engineer] Generic maker-checker (SYS-03). A maker proposes a
 * change; a different user holding the required role approves (with step-up MFA) and the
 * registered handler applies the change in the SAME transaction. DB constraint four_eyes
 * makes maker == checker impossible even if service code is wrong.
 */
import { Body, Controller, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { Audit } from '../common/audit';
import { Db, Q } from '../common/db';
import { conflict, forbidden, notFound } from '../common/errors';
import { zUuid } from '../common/http';
import { AuthUser, CurrentUser, hasRole, Role, Roles, StepUp, STAFF_ROLES } from '../auth/auth';

export type ApprovalAction =
  | 'buyer_programme_approve' | 'supplier_limit_set' | 'limit_config_change' | 'float_change' | 'pricing_version_activate'
  | 'payout_release' | 'user_role_change' | 'write_off' | 'manual_payment_match' | 'reconciliation_break_close'
  | 'etims_override' | 'bank_account_verify' | 'dispute_close' | 'lending_enable'
  | 'collections_policy_change' | 'recourse_start' | 'reconciliation_baseline_set' | 'reconciliation_break_resolve' | 'report_template_activate'
  | 'erp_mapping_change' | 'funding_source_change' | 'funding_retag' | 'mpesa_cap_change' | 'holiday_gazette'
  | 'registry_search' | 'registry_filing' | 'programme_pricing_profile_change' | 'revenue_split_change';

export interface ApprovalRow {
  id: string; action: ApprovalAction; entity_type: string; entity_id: string; payload: any; maker_id: string; required_role: Role; status: string;
}
type Handler = (c: PoolClient, a: ApprovalRow, checker: AuthUser) => Promise<void>;
type AfterCommit = (a: ApprovalRow) => Promise<void>;

@Injectable()
export class ApprovalsService {
  private handlers = new Map<ApprovalAction, { apply: Handler; after?: AfterCommit }>();
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  register(action: ApprovalAction, apply: Handler, after?: AfterCommit) {
    this.handlers.set(action, { apply, after });
  }

  async propose(q: Q, maker: AuthUser, p: { action: ApprovalAction; entityType: string; entityId: string; payload: unknown; requiredRole: Role; reason?: string }) {
    const pending = await q.query(
      `SELECT id FROM approval_request WHERE action = $1 AND entity_id = $2 AND status = 'pending'`, [p.action, p.entityId]);
    if (pending.rows.length) throw conflict('APPROVAL_PENDING', 'A change for this record is already waiting for approval');
    const r = await q.query(
      `INSERT INTO approval_request (action, entity_type, entity_id, payload, required_role, maker_id, maker_reason)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING id, status, created_at, expires_at`,
      [p.action, p.entityType, p.entityId, JSON.stringify(p.payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), p.requiredRole, maker.id, p.reason ?? null],
    );
    await this.audit.record(q, maker.actor, `approval.propose.${p.action}`, p.entityType, p.entityId, null, { approvalId: r.rows[0].id, payload: p.payload });
    return r.rows[0];
  }

  async decide(id: string, checker: AuthUser, decision: 'approve' | 'reject', reason?: string) {
    const a = await this.db.tx(async (c) => {
      const row = (await c.query(`SELECT * FROM approval_request WHERE id = $1 FOR UPDATE`, [id])).rows[0] as ApprovalRow & { expires_at: Date };
      if (!row) throw notFound('Approval');
      if (row.status !== 'pending') throw conflict('APPROVAL_NOT_PENDING', `Approval is ${row.status}`);
      if (new Date(row.expires_at) < new Date()) {
        await c.query(`UPDATE approval_request SET status = 'expired' WHERE id = $1`, [id]);
        throw conflict('APPROVAL_EXPIRED', 'This approval request has expired; propose it again');
      }
      if (row.maker_id === checker.id) throw forbidden('FOUR_EYES', 'You cannot approve your own request');
      if (!hasRole(checker, row.required_role)) throw forbidden('ROLE_REQUIRED', `Needs role ${row.required_role}`);
      await c.query(
        `UPDATE approval_request SET status = $2, checker_id = $3, checker_reason = $4, decided_at = now(), step_up_auth_ref = $5 WHERE id = $1`,
        [id, decision === 'approve' ? 'approved' : 'rejected', checker.id, reason ?? null, `auth_time:${checker.authTime}`],
      );
      if (decision === 'approve') {
        const h = this.handlers.get(row.action);
        if (!h) throw conflict('NO_HANDLER', `No handler for ${row.action}`);
        await h.apply(c, row, checker);
      }
      await this.audit.record(c, checker.actor, `approval.${decision}.${row.action}`, row.entity_type, row.entity_id, { status: 'pending' }, { status: decision, approvalId: id });
      return row;
    });
    if (decision === 'approve') await this.handlers.get(a.action)?.after?.(a);
    return { id, status: decision === 'approve' ? 'approved' : 'rejected' };
  }

  list(status = 'pending') {
    return this.db.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.payload, a.required_role, a.status, a.maker_reason, a.created_at, a.expires_at,
              m.display_name AS maker_name, a.maker_id
       FROM approval_request a JOIN user_account m ON m.id = a.maker_id WHERE a.status = $1 ORDER BY a.created_at`, [status]);
  }
}

@Controller('approvals')
@Roles(...STAFF_ROLES)
export class ApprovalsController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.svc.list(z.enum(['pending', 'approved', 'rejected', 'expired']).default('pending').parse(status));
  }

  @Post(':id/approve')
  @StepUp()
  approve(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ reason: z.string().max(500).optional() }).parse(b ?? {});
    return this.svc.decide(zUuid.parse(id), u, 'approve', body.reason);
  }

  @Post(':id/reject')
  @StepUp()
  reject(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ reason: z.string().min(3).max(500) }).parse(b ?? {});
    return this.svc.decide(zUuid.parse(id), u, 'reject', body.reason);
  }
}
