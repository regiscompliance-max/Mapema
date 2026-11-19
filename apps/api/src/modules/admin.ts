/**
 * [Backend Engineer] Admin: lending switch (D-05), pricing versions with CBK approval reference
 * (ADM-02), lending float and concentration limits (ADM-03), capital movements, feature/adapter
 * status (ADM-08). Every change is maker-checker with the CEO (or admin) as checker.
 */
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { quote } from '@mapema/pricing';
import { Audit } from '../common/audit';
import { ADAPTERS, AppConfig, CONFIG } from '../common/config';
import { Db, Q, toCents } from '../common/db';
import { badRequest, conflict, notFound } from '../common/errors';
import { zCents, zDate, zPositiveCents, zText, zUuid } from '../common/http';
import { AuthUser, CurrentUser, Roles, StepUp } from '../auth/auth';
import { ApprovalsService } from './approvals';

export interface PricingRow {
  id: string; code: string; advance_rate_bps: number; discount_rate_bps_per_30d: number; verification_fee_cents: string; min_days: number; max_days: number;
}

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(private readonly db: Db, private readonly approvals: ApprovalsService, private readonly audit: Audit, @Inject(ADAPTERS) private readonly adapters: Adapters) {}

  onModuleInit() {
    this.approvals.register('lending_enable', async (c, a) => {
      await c.query(`UPDATE platform_setting SET value = $1::jsonb, updated_via = $2, updated_at = now() WHERE key = 'lending'`,
        [JSON.stringify({ enabled: true, cbk_licence_no: a.payload.cbkLicenceNo }), a.id]);
    });
    this.approvals.register('pricing_version_activate', async (c, a) => {
      await c.query(`UPDATE pricing_version SET status = 'retired' WHERE status = 'active' AND id <> $1`, [a.entity_id]);
      await c.query(
        `UPDATE pricing_version SET status = 'active', cbk_approval_ref = $2, customer_notice_sent_at = $3, effective_from = $4 WHERE id = $1`,
        [a.entity_id, a.payload.cbkApprovalRef, a.payload.customerNoticeSentAt, a.payload.effectiveFrom]);
    });
    this.approvals.register('float_change', async (c, a) => {
      await c.query(`INSERT INTO lending_float (amount_cents, effective_from, basis_note, approved_via) VALUES ($1, now(), $2, $3)`,
        [a.payload.amountCents, a.payload.basisNote, a.id]);
    });
    this.approvals.register('limit_config_change', async (c, a) => {
      const p = a.payload;
      await c.query(`UPDATE limit_config SET active = false WHERE subject = $1 AND subject_org_id IS NOT DISTINCT FROM $2 AND subject_sector_id IS NOT DISTINCT FROM $3 AND active`,
        [p.subject, p.subjectOrgId ?? null, p.subjectSectorId ?? null]);
      await c.query(`INSERT INTO limit_config (subject, subject_org_id, subject_sector_id, pct_of_float_bps, absolute_cap_cents, approved_via) VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.subject, p.subjectOrgId ?? null, p.subjectSectorId ?? null, p.pctOfFloatBps ?? null, p.absoluteCapCents ?? null, a.id]);
    });
    this.approvals.register('revenue_split_change', async (c, a) => {
      const p = a.payload;
      await c.query(
        `INSERT INTO revenue_split_config (cost_of_funds_annual_ppm, bank_margin_share_bps, vat_rate_bps, vat_pending_counsel,
           excise_on_processing_fee, excise_rate_bps, excise_pending_counsel, approved_via, effective_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
        [p.costOfFundsAnnualPpm, p.bankMarginShareBps, p.vatRateBps, p.vatPendingCounsel, p.exciseOnProcessingFee, p.exciseRateBps, p.excisePendingCounsel, a.id]);
    });
  }

  async lending(q: Q = this.db.pool): Promise<{ enabled: boolean; cbk_licence_no: string | null }> {
    return (await q.query(`SELECT value FROM platform_setting WHERE key = 'lending'`)).rows[0].value;
  }

  /** Phase 3 MP-02: largest advance paid by M-Pesa B2C (maker-checker change, CEO). */
  async mpesaCap(q: Q = this.db.pool): Promise<bigint> {
    const r = (await q.query(`SELECT value FROM platform_setting WHERE key = 'mpesa_payout_cap_cents'`)).rows[0];
    return r ? BigInt(r.value) : 15_000_000n;
  }

  async invoiceMinimum(q: Q = this.db.pool): Promise<bigint> {
    return BigInt((await q.query(`SELECT value FROM platform_setting WHERE key = 'invoice_minimum_cents'`)).rows[0].value);
  }

  async activePricing(q: Q = this.db.pool): Promise<PricingRow | undefined> {
    return (await q.query(`SELECT * FROM pricing_version WHERE status = 'active' AND (effective_from IS NULL OR effective_from <= CURRENT_DATE) ORDER BY effective_from DESC NULLS LAST LIMIT 1`)).rows[0];
  }

  async currentFloat(q: Q = this.db.pool): Promise<bigint> {
    const r = (await q.query(`SELECT amount_cents FROM lending_float WHERE effective_from <= now() ORDER BY effective_from DESC LIMIT 1`)).rows[0];
    return r ? toCents(r.amount_cents) : 0n;
  }

  async proposeLendingEnable(u: AuthUser, cbkLicenceNo: string) {
    return this.db.tx((c) => this.approvals.propose(c, u, {
      action: 'lending_enable', entityType: 'platform_setting', entityId: '00000000-0000-0000-0000-00000000000a',
      payload: { cbkLicenceNo }, requiredRole: 'ceo', reason: 'Enable lending: CBK licence number entered',
    }));
  }

  async disableLending(u: AuthUser, reason: string) {
    return this.db.tx(async (c) => {
      const before = await this.lending(c);
      await c.query(`UPDATE platform_setting SET value = jsonb_set(value, '{enabled}', 'false'), updated_at = now() WHERE key = 'lending'`);
      await this.audit.record(c, u.actor, 'lending.disable', 'platform_setting', 'lending', before, { enabled: false, reason });
      return { enabled: false };
    });
  }

  async createPricing(u: AuthUser, b: { code: string; advanceRateBps: number; discountRateBpsPer30d: number; verificationFeeCents: bigint; minDays: number; maxDays: number }) {
    // sanity: the worked example must still be computable under the new version
    quote(100000000n, Math.min(48, b.maxDays), { ...b, minInvoiceCents: 0n });
    return this.db.tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO pricing_version (code, advance_rate_bps, discount_rate_bps_per_30d, verification_fee_cents, min_days, max_days, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7) RETURNING *`,
        [b.code, b.advanceRateBps, b.discountRateBpsPer30d, b.verificationFeeCents, b.minDays, b.maxDays, u.id])).rows[0];
      await this.audit.record(c, u.actor, 'pricing.create', 'pricing_version', r.id, null, r);
      return r;
    });
  }

  async proposePricingActivation(u: AuthUser, id: string, b: { cbkApprovalRef: string; customerNoticeSentAt: string; effectiveFrom: string }) {
    return this.db.tx(async (c) => {
      const pv = (await c.query(`SELECT * FROM pricing_version WHERE id = $1`, [id])).rows[0];
      if (!pv) throw notFound('Pricing version');
      if (!['draft', 'pending_cbk', 'approved'].includes(pv.status)) throw conflict('BAD_STATE', `Pricing version is ${pv.status}`);
      return this.approvals.propose(c, u, { action: 'pricing_version_activate', entityType: 'pricing_version', entityId: id, payload: b, requiredRole: 'ceo' });
    });
  }

  async proposeFloat(u: AuthUser, amountCents: bigint, basisNote: string) {
    return this.db.tx((c) => this.approvals.propose(c, u, {
      action: 'float_change', entityType: 'lending_float', entityId: '00000000-0000-0000-0000-00000000000f',
      payload: { amountCents: amountCents.toString(), basisNote }, requiredRole: 'ceo',
    }));
  }

  async proposeLimit(u: AuthUser, p: { subject: 'buyer' | 'supplier' | 'sector'; subjectOrgId?: string; subjectSectorId?: number; pctOfFloatBps?: number; absoluteCapCents?: bigint }) {
    if (p.subject === 'sector' && !p.subjectSectorId) throw badRequest('SECTOR_REQUIRED', 'subjectSectorId required for sector limits');
    return this.db.tx((c) => this.approvals.propose(c, u, {
      action: 'limit_config_change', entityType: 'limit_config',
      entityId: p.subjectOrgId ?? `00000000-0000-0000-0000-${String(p.subjectSectorId ?? 0).padStart(12, '0')}`,
      payload: { ...p, absoluteCapCents: p.absoluteCapCents?.toString() }, requiredRole: 'ceo',
    }));
  }

  async adapterStatus() {
    const out = [];
    for (const [name, a] of Object.entries(this.adapters)) out.push({ name, ...(await (a as any).health()) });
    return out;
  }

  async currentRevenueSplit(q: Q = this.db.pool): Promise<any> {
    const r = (await q.query(`SELECT * FROM revenue_split_config ORDER BY effective_from DESC, created_at DESC LIMIT 1`)).rows[0];
    if (!r) {
      return {
        cost_of_funds_annual_ppm: 87450, bank_margin_share_bps: 5000, vat_rate_bps: 1600, vat_pending_counsel: true,
        excise_on_processing_fee: false, excise_rate_bps: 2000, excise_pending_counsel: true,
      };
    }
    return r;
  }

  async proposeRevenueSplit(u: AuthUser, p: {
    costOfFundsAnnualPpm: number; bankMarginShareBps: number; vatRateBps: number; vatPendingCounsel: boolean;
    exciseOnProcessingFee: boolean; exciseRateBps: number; excisePendingCounsel: boolean;
  }) {
    return this.db.tx((c) => this.approvals.propose(c, u, {
      action: 'revenue_split_change', entityType: 'revenue_split_config',
      entityId: '00000000-0000-0000-0000-0000000000a1',
      payload: p, requiredRole: 'ceo', reason: 'Update bank cost of funds, margin split or pending-counsel tax flags',
    }));
  }
}

@Controller('admin')
export class AdminController {
  constructor(private readonly s: SettingsService, private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @Get('settings')
  @Roles('admin', 'ceo', 'credit', 'ops', 'compliance')
  async settings() {
    return {
      lending: await this.s.lending(), invoiceMinimumCents: await this.s.invoiceMinimum(), floatCents: await this.s.currentFloat(),
      pricing: await this.db.query(`SELECT * FROM pricing_version ORDER BY created_at DESC`),
      pricingProfiles: await this.db.query(`SELECT * FROM pricing_profile ORDER BY code`),
      revenueSplit: await this.s.currentRevenueSplit(),
      limits: await this.db.query(`SELECT * FROM limit_config WHERE active ORDER BY subject`),
      environment: this.cfg.APP_ENV,
    };
  }

  @Get('adapters')
  @Roles('admin', 'ceo')
  adapters() { return this.s.adapterStatus(); }

  @Post('lending/enable')
  @Roles('admin', 'ceo', 'compliance')
  enable(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ cbkLicenceNo: zText(100) }).parse(b);
    return this.s.proposeLendingEnable(u, body.cbkLicenceNo);
  }

  @Post('lending/disable')
  @Roles('admin', 'ceo', 'compliance')
  @StepUp()
  disable(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    return this.s.disableLending(u, z.object({ reason: zText() }).parse(b).reason);
  }

  @Post('pricing-versions')
  @Roles('admin')
  createPricing(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({
      code: zText(40), advanceRateBps: z.number().int().min(1).max(10000), discountRateBpsPer30d: z.number().int().min(0).max(10000),
      verificationFeeCents: zCents, minDays: z.number().int().min(1).default(1), maxDays: z.number().int().max(120).default(120),
    }).parse(b);
    return this.s.createPricing(u, body);
  }

  @Post('pricing-versions/:id/activate')
  @Roles('admin')
  activate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ cbkApprovalRef: zText(100), customerNoticeSentAt: z.string().datetime(), effectiveFrom: zDate }).parse(b);
    return this.s.proposePricingActivation(u, zUuid.parse(id), body);
  }

  @Post('float')
  @Roles('admin', 'ceo')
  float(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ amountCents: zPositiveCents, basisNote: zText() }).parse(b);
    return this.s.proposeFloat(u, body.amountCents, body.basisNote);
  }

  @Post('limits')
  @Roles('admin', 'credit')
  limits(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({
      subject: z.enum(['buyer', 'supplier', 'sector']), subjectOrgId: zUuid.optional(), subjectSectorId: z.number().int().optional(),
      pctOfFloatBps: z.number().int().min(0).max(10000).optional(), absoluteCapCents: zCents.optional(),
    }).refine((x) => x.pctOfFloatBps !== undefined || x.absoluteCapCents !== undefined, 'pctOfFloatBps or absoluteCapCents required').parse(b);
    return this.s.proposeLimit(u, body);
  }

  @Get('revenue-split')
  @Roles('admin', 'ceo', 'credit', 'ops', 'compliance')
  revenueSplit() { return this.s.currentRevenueSplit(); }

  @Post('revenue-split')
  @Roles('admin', 'credit')
  proposeRevenueSplit(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({
      costOfFundsAnnualPpm: z.number().int().min(0).max(1_000_000),
      bankMarginShareBps: z.number().int().min(0).max(10000),
      vatRateBps: z.number().int().min(0).max(10000).default(1600),
      vatPendingCounsel: z.boolean().default(true),
      exciseOnProcessingFee: z.boolean().default(false),
      exciseRateBps: z.number().int().min(0).max(10000).default(2000),
      excisePendingCounsel: z.boolean().default(true),
    }).parse(b);
    return this.s.proposeRevenueSplit(u, body);
  }
}
