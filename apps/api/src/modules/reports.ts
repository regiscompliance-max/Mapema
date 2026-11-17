/**
 * [Backend Engineer + Data/Reporting] Dashboards, auditor portfolio view (read-only, AUD-01),
 * audit log search/export with chain verification (AUD-02), trial balance from Fineract (AUD-03),
 * and the caller's own profile and in-app notifications.
 */
import { Controller, Get, Inject, Injectable, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { Audit, verifyAuditChain } from '../common/audit';
import { ADAPTERS } from '../common/config';
import { Db, toCents } from '../common/db';
import { AuthUser, CurrentUser, isStaff, Roles, STAFF_ROLES } from '../auth/auth';
import { SettingsService } from './admin';

@Injectable()
export class ReportsService {
  constructor(private readonly db: Db, private readonly audit: Audit, private readonly settings: SettingsService, @Inject(ADAPTERS) private readonly adapters: Adapters) {}

  async dashboard() {
    const float = await this.settings.currentFloat();
    const p = await this.db.one(`SELECT
        COALESCE(SUM(principal_cents) FILTER (WHERE status IN ('approved','released','funded','late','recourse','non_performing')),0)::bigint AS exposure,
        count(*) FILTER (WHERE status = 'requested')::int AS requested,
        count(*) FILTER (WHERE status = 'approved')::int AS awaiting_release,
        count(*) FILTER (WHERE status IN ('funded'))::int AS funded,
        count(*) FILTER (WHERE status IN ('late','recourse'))::int AS late,
        count(*) FILTER (WHERE status = 'non_performing')::int AS npl,
        count(*) FILTER (WHERE status = 'settled')::int AS settled
      FROM advance`);
    const other = await this.db.one(`SELECT
        (SELECT count(*) FROM approval_request WHERE status = 'pending')::int AS pending_approvals,
        (SELECT count(*) FROM payment WHERE status = 'unmatched')::int AS unmatched_payments,
        (SELECT count(*) FROM payout WHERE status = 'proposed' AND type = 'balance')::int AS balances_to_release,
        (SELECT count(*) FROM reconciliation_break WHERE status = 'open')::int AS open_breaks,
        (SELECT count(*) FROM aml_flag WHERE status = 'open')::int AS open_aml_flags,
        (SELECT count(*) FROM complaint WHERE status NOT IN ('resolved','closed'))::int AS open_complaints,
        (SELECT count(*) FROM outbox WHERE status = 'dead')::int AS dead_jobs`);
    const exposure = toCents(p.exposure);
    return { floatCents: float, exposureCents: exposure, headroomCents: float - exposure, advances: { ...p, exposure: undefined }, queues: other, lending: await this.settings.lending() };
  }

  portfolio() {
    return this.db.query(`SELECT a.id, a.status, a.principal_cents, a.discount_fee_cents, a.verification_fee_cents, a.due_date, a.disbursement_date, a.fineract_loan_id,
        i.invoice_number, i.amount_cents AS invoice_amount_cents, s.legal_name AS supplier, b.legal_name AS buyer,
        COALESCE(SUM(pa.principal_cents),0)::bigint AS principal_repaid, COALESCE(SUM(pa.fees_charges_cents),0)::bigint AS fees_repaid,
        COALESCE(SUM(pa.interest_cents),0)::bigint AS interest_repaid, COALESCE(SUM(pa.supplier_balance_cents),0)::bigint AS supplier_balance
      FROM advance a JOIN invoice i ON i.id = a.invoice_id JOIN organisation s ON s.id = a.supplier_id JOIN organisation b ON b.id = a.buyer_id
      LEFT JOIN payment_allocation pa ON pa.advance_id = a.id
      GROUP BY a.id, i.id, s.id, b.id ORDER BY a.created_at DESC LIMIT 1000`);
  }

  auditEvents(f: { entityType?: string; entityId?: string; action?: string; from?: string; to?: string; limit: number }) {
    return this.db.query(`SELECT id, occurred_at, actor_user_id, actor_role, action, entity_type, entity_id, before, after, request_id, row_hash
      FROM audit_event WHERE ($1::text IS NULL OR entity_type = $1) AND ($2::text IS NULL OR entity_id = $2) AND ($3::text IS NULL OR action LIKE $3 || '%')
        AND ($4::timestamptz IS NULL OR occurred_at >= $4) AND ($5::timestamptz IS NULL OR occurred_at < $5)
      ORDER BY id DESC LIMIT $6`, [f.entityType ?? null, f.entityId ?? null, f.action ?? null, f.from ?? null, f.to ?? null, f.limit]);
  }

  async exportCsv(u: AuthUser, from?: string, to?: string) {
    const rows = await this.db.query(`SELECT id, occurred_at, actor_user_id, actor_role, action, entity_type, entity_id, request_id, prev_hash, row_hash FROM audit_event
      WHERE ($1::timestamptz IS NULL OR occurred_at >= $1) AND ($2::timestamptz IS NULL OR occurred_at < $2) ORDER BY id`, [from ?? null, to ?? null]);
    const chain = await verifyAuditChain(this.db.pool);
    await this.db.tx((c) => this.audit.record(c, u.actor, 'audit.export', 'audit_event', null, null, { rows: rows.length, from, to, chainOk: chain.ok }));
    const esc = (v: unknown) => { const s = v instanceof Date ? v.toISOString() : String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = 'id,occurred_at,actor_user_id,actor_role,action,entity_type,entity_id,request_id,prev_hash,row_hash';
    return { csv: [head, ...rows.map((r: any) => [r.id, r.occurred_at, r.actor_user_id, r.actor_role, r.action, r.entity_type, r.entity_id, r.request_id, r.prev_hash, r.row_hash].map(esc).join(','))].join('\n') + '\n', chain };
  }

  verify() { return verifyAuditChain(this.db.pool); }

  async trialBalance() {
    const tb = await this.adapters.ledger.trialBalance();
    const sum = Object.values(tb).reduce((a, b) => a + b, 0n);
    return { source: `ledger:${this.adapters.ledger.mode}`, accounts: tb, sumCents: sum, balanced: sum === 0n };
  }

  async me(u: AuthUser) {
    const orgs = await this.db.query(`SELECT id, type, legal_name, status FROM organisation WHERE id = ANY($1::uuid[])`, [u.roles.map((r) => r.orgId).filter(Boolean)]);
    return { id: u.id, email: u.email, displayName: u.displayName, roles: u.roles, amr: u.amr, staff: isStaff(u), organisations: orgs };
  }

  myNotifications(u: AuthUser) {
    return this.db.query(`SELECT id, channel, template_key, status, entity_type, entity_id, created_at FROM notification WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [u.id]);
  }
}

@Controller()
export class ReportsController {
  constructor(private readonly s: ReportsService) {}

  @Get('me') me(@CurrentUser() u: AuthUser) { return this.s.me(u); }
  @Get('me/notifications') notes(@CurrentUser() u: AuthUser) { return this.s.myNotifications(u); }

  @Get('dashboard') @Roles(...STAFF_ROLES)
  dashboard() { return this.s.dashboard(); }

  @Get('reports/portfolio') @Roles(...STAFF_ROLES, 'auditor')
  portfolio() { return this.s.portfolio(); }

  @Get('audit/events') @Roles('compliance', 'ceo', 'auditor')
  events(@Query() q: unknown) {
    return this.s.auditEvents(z.object({ entityType: z.string().max(60).optional(), entityId: z.string().max(80).optional(), action: z.string().max(80).optional(),
      from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(q ?? {}));
  }

  @Get('audit/verify') @Roles('compliance', 'ceo', 'auditor')
  verify() { return this.s.verify(); }

  @Get('audit/export') @Roles('compliance', 'auditor')
  async export(@CurrentUser() u: AuthUser, @Query() q: unknown, @Res() res: any) {
    const f = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).parse(q ?? {});
    const { csv, chain } = await this.s.exportCsv(u, f.from, f.to);
    res.setHeader('X-Audit-Chain-Ok', String(chain.ok));
    res.type('text/csv').attachment('mapema-audit-export.csv').send(csv);
  }

  @Get('ledger/trial-balance') @Roles('ceo', 'ops', 'compliance', 'auditor')
  tb() { return this.s.trialBalance(); }
}
