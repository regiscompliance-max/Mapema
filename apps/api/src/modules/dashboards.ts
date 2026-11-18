/**
 * [Backend Engineer + Frontend Engineer] Phase 2 dashboards (DSH-01..03). All money as cents strings.
 * Exposure = principal outstanding from allocations (Fineract allocation mirror), same basis as the
 * month-end snapshot. Caps follow the release-time limit checks: % of lending float (buyer 25%,
 * supplier 10%, sector 35% defaults) capped by any absolute cap.
 */
import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { z } from 'zod';
import { AGEING_BUCKETS, ageingBucket, dpd } from '@mapema/pricing';
import { Clock } from '../common/clock';
import { Db, toCents } from '../common/db';
import { forbidden } from '../common/errors';
import { AuthUser, BUYER_ROLES, CurrentUser, hasRole, orgIds, Roles, STAFF_ROLES, SUPPLIER_ROLES } from '../auth/auth';
import { SettingsService } from './admin';

const s = (b: bigint) => b.toString();
const bps = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 20000n + whole) / (whole * 2n)) : 0);
const LIVE = `('funded','late','recourse','non_performing')`;

@Injectable()
export class DashboardsService {
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly settings: SettingsService) {}

  private async liveAdvances(where = '', params: unknown[] = []) {
    return this.db.query(`SELECT a.id, a.status, a.buyer_id, a.supplier_id, a.due_date, a.principal_cents, i.invoice_number, i.amount_cents AS invoice_amount_cents,
        b.legal_name AS buyer, sp.legal_name AS supplier, b.sector_id, sec.code AS sector_code, sec.name AS sector_name,
        (a.principal_cents - COALESCE((SELECT SUM(pa.principal_cents) FROM payment_allocation pa WHERE pa.advance_id = a.id),0))::bigint AS outstanding,
        COALESCE((SELECT SUM(p.amount_cents) FROM payment p WHERE p.advance_id = a.id),0)::bigint AS paid
      FROM advance a JOIN invoice i ON i.id = a.invoice_id JOIN organisation b ON b.id = a.buyer_id JOIN organisation sp ON sp.id = a.supplier_id LEFT JOIN sector sec ON sec.id = b.sector_id
      WHERE a.status IN ${LIVE} ${where} ORDER BY a.due_date, i.invoice_number`, params);
  }

  private async capFor(subject: string, orgId: string | null, sectorId: number | null, float: bigint) {
    const r = await this.db.one(`SELECT pct_of_float_bps, absolute_cap_cents FROM limit_config WHERE active AND subject = $1
      AND (subject_org_id = $2 OR subject_org_id IS NULL) AND subject_sector_id IS NOT DISTINCT FROM $3 ORDER BY subject_org_id NULLS LAST LIMIT 1`, [subject, orgId, sectorId])
      ?? (subject === 'sector' ? await this.db.one(`SELECT pct_of_float_bps, absolute_cap_cents FROM limit_config WHERE active AND subject = 'sector' ORDER BY created_at LIMIT 1`) : undefined);
    const limitBps = r?.pct_of_float_bps !== null && r?.pct_of_float_bps !== undefined ? Number(r.pct_of_float_bps) : ({ buyer: 2500, supplier: 1000, sector: 3500 } as any)[subject];
    let cap = (float * BigInt(limitBps)) / 10000n;
    if (r?.absolute_cap_cents) { const a = toCents(r.absolute_cap_cents); if (a < cap) cap = a; }
    return { cap, limitBps };
  }

  async staff() {
    const today = this.clock.today();
    const float = await this.settings.currentFloat();
    const rows = await this.liveAdvances();
    const out = (xs: any[]) => xs.reduce((t, r) => t + toCents(r.outstanding), 0n);
    const total = out(rows);
    const group = async (key: 'buyer_id' | 'supplier_id' | 'sector_id', subject: string) => {
      const m = new Map<string, any[]>();
      for (const r of rows) { const k = String(r[key] ?? 'none'); m.set(k, [...(m.get(k) ?? []), r]); }
      const res: any[] = [];
      for (const [k, xs] of m) {
        const e = out(xs);
        const { cap, limitBps } = await this.capFor(subject, key === 'sector_id' ? null : k, key === 'sector_id' ? (xs[0].sector_id ?? null) : null, float);
        res.push({ orgId: key === 'sector_id' ? undefined : k, name: key === 'buyer_id' ? xs[0].buyer : key === 'supplier_id' ? xs[0].supplier : (xs[0].sector_name ?? 'Unassigned'),
          code: key === 'sector_id' ? xs[0].sector_code : undefined, exposureCents: s(e), capCents: s(cap), limitBps, usedBps: bps(e, cap), breach: e > cap, count: xs.length });
      }
      return res.sort((a, b) => b.usedBps - a.usedBps);
    };
    const ageing: Record<string, { count: number; principalCents: string }> = {};
    for (const b of AGEING_BUCKETS) { const xs = rows.filter((r) => ageingBucket(dpd(r.due_date, today)) === b); ageing[b] = { count: xs.length, principalCents: s(out(xs)) }; }
    const byStatus = (st: string) => { const xs = rows.filter((r) => r.status === st); return { count: xs.length, principalCents: s(out(xs)) }; };
    const monthStart = `${today.slice(0, 7)}-01`;
    const coll = await this.db.one(`SELECT COALESCE(SUM(amount_cents),0)::bigint AS c, count(*)::int AS n FROM bank_transaction WHERE value_date BETWEEN $1 AND $2`, [monthStart, today]);
    const rec = await this.db.one(`SELECT as_of_date, status, unexplained_count FROM reconciliation_run ORDER BY as_of_date DESC LIMIT 1`);
    const cases = await this.db.one(`SELECT count(*) FILTER (WHERE status = 'due')::int AS due, count(*) FILTER (WHERE status = 'demanded')::int AS demanded FROM recourse_case`);
    const npl = byStatus('non_performing');
    return {
      asOf: today, floatCents: s(float), headroomCents: s(float - total),
      portfolio: { count: rows.length, outstandingPrincipalCents: s(total) },
      utilisation: { buyers: await group('buyer_id', 'buyer'), suppliers: await group('supplier_id', 'supplier'), sectors: await group('sector_id', 'sector') },
      ageing, late: byStatus('late'), recourse: byStatus('recourse'), npl, nplRatioBps: bps(BigInt(npl.principalCents), total),
      recourseCases: cases,
      collections: { monthToDateCents: s(toCents(coll.c)), receipts: coll.n },
      reconciliation: rec ? { asOfDate: rec.as_of_date, status: rec.status, unexplained: rec.unexplained_count } : { asOfDate: null, status: 'never_run', unexplained: 0 },
    };
  }

  private pickOrg(u: AuthUser, roles: typeof BUYER_ROLES, orgId?: string) {
    const mine = orgIds(u, roles);
    if (orgId) { if (!mine.includes(orgId)) throw forbidden('ORG_SCOPE', 'Not your organisation'); return orgId; }
    if (!mine.length) throw forbidden('ORG_SCOPE', 'No organisation');
    return mine[0];
  }

  async buyer(u: AuthUser, orgId?: string) {
    const id = this.pickOrg(u, BUYER_ROLES, orgId);
    const today = this.clock.today();
    const rows = await this.liveAdvances('AND a.buyer_id = $1', [id]);
    const owed = (r: any) => { const x = toCents(r.invoice_amount_cents) - toCents(r.paid); return x > 0n ? x : 0n; };
    const item = (r: any) => ({ advanceId: r.id, invoiceNumber: r.invoice_number, supplier: r.supplier, dueDate: r.due_date, amountCents: s(owed(r)), daysPastDue: dpd(r.due_date, today) });
    const horizon = new Date(`${today}T00:00:00Z`); horizon.setUTCDate(horizon.getUTCDate() + 30);
    const dueNext = rows.filter((r) => r.due_date >= today && r.due_date <= horizon.toISOString().slice(0, 10)).map(item);
    const overdue = rows.filter((r) => r.due_date < today).map(item);
    const byStatus = Object.fromEntries((await this.db.query(`SELECT status, count(*)::int AS n FROM invoice WHERE buyer_id = $1 GROUP BY status`, [id])).map((r) => [r.status, r.n]));
    const prog = await this.db.one(`SELECT limit_cents, review_date FROM buyer_programme WHERE buyer_id = $1 AND status IN ('approved','live') LIMIT 1`, [id]);
    const acct = await this.db.one(`SELECT virtual_account_no FROM collection_account WHERE buyer_id = $1`, [id]);
    const used = rows.reduce((t, r) => t + toCents(r.outstanding), 0n);
    const sum = (xs: any[]) => s(xs.reduce((t, x) => t + BigInt(x.amountCents), 0n));
    return { orgId: id, asOf: today, dueNext30: dueNext, dueNext30TotalCents: sum(dueNext), overdue, overdueTotalCents: sum(overdue), invoicesByStatus: byStatus,
      programme: prog ? { limitCents: s(toCents(prog.limit_cents)), usedCents: s(used), usedBps: bps(used, toCents(prog.limit_cents)), reviewDate: prog.review_date } : null,
      collectionAccount: acct?.virtual_account_no ?? null };
  }

  async supplier(u: AuthUser, orgId?: string) {
    const id = this.pickOrg(u, SUPPLIER_ROLES, orgId);
    const today = this.clock.today();
    const rows = await this.liveAdvances('AND a.supplier_id = $1', [id]);
    const funded = rows.reduce((t, r) => t + toCents(r.outstanding), 0n);
    // balance still to come = invoice - principal - fees as disclosed (the deferred price), for live advances
    const tc = await this.db.one(`SELECT COALESCE(SUM(i.amount_cents - a.principal_cents - a.discount_fee_cents - a.verification_fee_cents),0)::bigint AS t
      FROM advance a JOIN invoice i ON i.id = a.invoice_id WHERE a.supplier_id = $1 AND a.status IN ('funded','late')`, [id]);
    const payouts = await this.db.query(`SELECT p.id, p.type, p.amount_cents, p.status, p.value_date, i.invoice_number FROM payout p JOIN advance a ON a.id = p.advance_id JOIN invoice i ON i.id = a.invoice_id
      WHERE a.supplier_id = $1 AND p.status IN ('released','confirmed') ORDER BY p.created_at DESC LIMIT 10`, [id]);
    const demands = await this.db.query(`SELECT rc.advance_id, rc.status, rc.amount_demanded_cents, rc.demanded_on, i.invoice_number FROM recourse_case rc JOIN advance a ON a.id = rc.advance_id JOIN invoice i ON i.id = a.invoice_id
      WHERE rc.supplier_id = $1 AND rc.status = 'demanded'`, [id]);
    const fin = await this.db.one(`SELECT count(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS v FROM invoice WHERE supplier_id = $1 AND status = 'eligible'`, [id]);
    return { orgId: id, asOf: today, fundedOutstandingCents: s(funded), fundedCount: rows.length, balancesToComeCents: s(toCents(tc.t)),
      recentPayouts: payouts.map((p) => ({ id: p.id, type: p.type, amountCents: p.amount_cents, status: p.status, valueDate: p.value_date, invoiceNumber: p.invoice_number })),
      recourseDemands: demands.map((d) => ({ advanceId: d.advance_id, invoiceNumber: d.invoice_number, amountCents: d.amount_demanded_cents, demandedOn: d.demanded_on, status: d.status })),
      financeableCount: fin.n, financeableCents: s(toCents(fin.v)) };
  }
}

@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly s: DashboardsService) {}

  @Get('staff') @Roles(...STAFF_ROLES, 'auditor')
  staff() { return this.s.staff(); }

  @Get('buyer') @Roles(...BUYER_ROLES)
  buyer(@CurrentUser() u: AuthUser, @Query('orgId') orgId?: string) { return this.s.buyer(u, orgId ? z.string().uuid().parse(orgId) : undefined); }

  @Get('supplier') @Roles(...SUPPLIER_ROLES)
  supplier(@CurrentUser() u: AuthUser, @Query('orgId') orgId?: string) { return this.s.supplier(u, orgId ? z.string().uuid().parse(orgId) : undefined); }
}
void hasRole;
