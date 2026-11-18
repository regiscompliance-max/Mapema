/**
 * [Backend Engineer + Credit Risk + Treasury] Multi-lender funding sources (Phase 3 FUND-01..06).
 *  - sources (equity, debt facility A, ...) with eligibility rules and covenants; create/change is
 *    maker-checker (admin/credit/ceo propose, CEO approves) and creates a Fineract fund
 *  - every advance is tagged at RELEASE: credit may name a source at approval (validated then and again
 *    at release); otherwise the lowest-priority eligible source with headroom and pro forma covenants
 *  - Fineract: the fund is set on the loan at origination (immutable once active, verified against
 *    Fineract 1.16); the CURRENT tag lives in the loan datatable mapema_funding_tag and moves on re-tag
 *  - re-tagging is maker-checker (credit/ops propose, CEO approves); history is append-only
 *  - consistency check compares the platform tag with Fineract's tag loan by loan
 * With no approved source configured, advances stay untagged (Phase 1/2 behaviour).
 */
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { covenantStatus, daysBetween, evaluateSource, facilityUtilisation, FacilityLoan, FundingCandidate, FundingSourceRule, pickFundingSource, SourceEvaluation, validateFundingSource } from '@mapema/pricing';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS } from '../common/config';
import { Clock } from '../common/clock';
import { Db, Q, toCents } from '../common/db';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { AuthUser, CurrentUser, Roles } from '../auth/auth';
import { ApprovalsService } from './approvals';

const LIVE = `('released','funded','late','recourse','non_performing')`;
export interface FundingResolution { applies: boolean; code: string | null; sourceId: string | null; evaluations: SourceEvaluation[]; reason: string }
const zEligibility = z.object({
  buyerIds: z.array(zUuid).max(200).optional(), sectorCodes: z.array(z.string().max(20)).max(50).optional(), excludeSectorCodes: z.array(z.string().max(20)).max(50).optional(),
  maxTenorDays: z.number().int().optional(), minAdvanceCents: z.string().regex(/^\d+$/).optional(), maxAdvanceCents: z.string().regex(/^\d+$/).optional(), requireEtimsValid: z.boolean().optional(),
}).strict();
const zCovenants = z.object({ maxBuyerConcentrationBps: z.number().int().optional(), maxNplRatioBps: z.number().int().optional(), maxDpd30RatioBps: z.number().int().optional() }).strict();
export const zSource = z.object({
  code: z.string().max(24), name: zText(120), type: z.enum(['equity', 'debt_facility', 'other']), limitCents: z.string().regex(/^-?\d+$/).nullable(),
  priority: z.number().int(), eligibility: zEligibility.default({}), covenants: zCovenants.default({}), reason: zText(500),
});

@Injectable()
export class FundingService implements OnModuleInit {
  constructor(private readonly db: Db, private readonly audit: Audit, private readonly clock: Clock, private readonly approvals: ApprovalsService, @Inject(ADAPTERS) private readonly adapters: Adapters) {}

  onModuleInit() {
    this.approvals.register('funding_source_change', async (c, a) => {
      const p = a.payload;
      const fundId = await this.adapters.ledger.ensureFund(p.code, p.name);
      await c.query(`UPDATE funding_source SET name = $2, type = $3, limit_cents = $4, priority = $5, eligibility = $6::jsonb, covenants = $7::jsonb, active = $8,
        fineract_fund_id = $9, approved_via = $10, updated_at = now() WHERE id = $1`,
        [a.entity_id, p.name, p.type, p.limitCents, p.priority, JSON.stringify(p.eligibility ?? {}), JSON.stringify(p.covenants ?? {}), p.active !== false, fundId, a.id]);
      await this.audit.record(c, SYSTEM, 'funding_source.applied', 'funding_source', a.entity_id, null, { ...p, fineractFundId: fundId, approvalId: a.id });
    });
    this.approvals.register('funding_retag', async (c, a) => {
      const adv = (await c.query(`SELECT id, funding_source_id, status FROM advance WHERE id = $1 FOR UPDATE`, [a.entity_id])).rows[0];
      if (!adv) throw notFound('Advance');
      if (adv.funding_source_id !== a.payload.fromSourceId) throw conflict('TAG_CHANGED', 'The tag changed since this request was made; propose again');
      const ev = await this.evaluateFor(c, a.entity_id, a.payload.toCode);
      if (!ev.code) throw unprocessable('FUNDING_SOURCE_INELIGIBLE', 'The target source is no longer eligible', { evaluations: ev.evaluations });
      await c.query(`UPDATE advance SET funding_source_id = $2, funding_tagged_at = now(), updated_at = now() WHERE id = $1`, [a.entity_id, ev.sourceId]);
      await c.query(`INSERT INTO funding_tag_history (advance_id, from_source_id, to_source_id, effective_on, reason, approved_via) VALUES ($1,$2,$3,$4,$5,$6)`,
        [a.entity_id, adv.funding_source_id, ev.sourceId, this.clock.today(), a.payload.reason, a.id]);
      await this.audit.record(c, SYSTEM, 'advance.funding_retagged', 'advance', a.entity_id, { fundingSourceId: adv.funding_source_id }, { fundingSourceId: ev.sourceId, code: ev.code, approvalId: a.id });
    }, async (a) => { await this.syncLedgerTag(a.entity_id); });
  }

  // ------------------------------------------------------------------ inputs
  async rules(q: Q = this.db.pool): Promise<(FundingSourceRule & { id: string; name: string; fineractFundId: number | null })[]> {
    const rows = await q.query(`SELECT * FROM funding_source WHERE approved_via IS NOT NULL ORDER BY priority, code`);
    return (rows.rows ?? rows).map((r: any) => ({ id: r.id, code: r.code, name: r.name, type: r.type, limitCents: r.limit_cents === null ? null : toCents(r.limit_cents), priority: r.priority,
      active: r.active, eligibility: r.eligibility ?? {}, covenants: r.covenants ?? {}, fineractFundId: r.fineract_fund_id ? Number(r.fineract_fund_id) : null }));
  }
  async loans(q: Q = this.db.pool, excludeAdvanceId?: string): Promise<FacilityLoan[]> {
    const today = this.clock.today();
    const r = await q.query(`SELECT a.id, a.buyer_id, a.status, a.due_date, fs.code, COALESCE(a.mirror_principal_outstanding_cents, a.principal_cents) AS o
      FROM advance a JOIN funding_source fs ON fs.id = a.funding_source_id WHERE a.status IN ${LIVE} AND ($1::uuid IS NULL OR a.id <> $1)`, [excludeAdvanceId ?? null]);
    return r.rows.map((x: any) => ({ sourceCode: x.code, buyerId: x.buyer_id, outstandingCents: toCents(x.o), dpd: Math.max(0, daysBetween(x.due_date, today)), npl: x.status === 'non_performing' }));
  }
  async candidate(q: Q, advanceId: string): Promise<FundingCandidate> {
    const a = (await q.query(`SELECT a.buyer_id, a.principal_cents, a.due_date, i.etims_status, s.code AS sector FROM advance a JOIN invoice i ON i.id = a.invoice_id
      JOIN organisation b ON b.id = a.buyer_id LEFT JOIN sector s ON s.id = b.sector_id WHERE a.id = $1`, [advanceId])).rows[0];
    if (!a) throw notFound('Advance');
    return { buyerId: a.buyer_id, sectorCode: a.sector ?? null, tenorDays: daysBetween(this.clock.today(), a.due_date), principalCents: toCents(a.principal_cents), etimsValid: ['valid', 'overridden'].includes(a.etims_status) };
  }

  /** Which source this advance would be tagged to now (preferred = named by credit; evaluated alone). */
  async evaluateFor(q: Q, advanceId: string, preferred?: string | null): Promise<FundingResolution> {
    const rules = await this.rules(q);
    if (!rules.some((r) => r.active)) return { applies: false, code: null, sourceId: null, evaluations: [], reason: 'no funding sources configured (untagged)' };
    const cand = await this.candidate(q, advanceId);
    const res = pickFundingSource(rules, cand, await this.loans(q, advanceId), preferred ?? undefined);
    const src = rules.find((r) => r.code === res.code);
    return { applies: true, code: res.code, sourceId: src?.id ?? null, evaluations: res.evaluations,
      reason: !src ? 'no eligible funding source' : preferred ? `named by credit at approval` : `auto at release (priority ${src.priority})` };
  }

  async tagAtRelease(q: Q, advanceId: string, r: FundingResolution) {
    if (!r.code) return;
    await q.query(`UPDATE advance SET funding_source_id = $2, funding_tagged_at = now() WHERE id = $1`, [advanceId, r.sourceId]);
    await q.query(`INSERT INTO funding_tag_history (advance_id, from_source_id, to_source_id, effective_on, reason) VALUES ($1,NULL,$2,$3,$4)`, [advanceId, r.sourceId, this.clock.today(), r.reason]);
  }

  /** Ledger side after booking / re-tag. A failure leaves ledger_synced_at NULL; the consistency check shows it. */
  async syncLedgerTag(advanceId: string) {
    const a = await this.db.one(`SELECT a.fineract_loan_id, fs.code FROM advance a JOIN funding_source fs ON fs.id = a.funding_source_id WHERE a.id = $1`, [advanceId]);
    if (!a?.fineract_loan_id) return;
    try {
      await this.adapters.ledger.setFundingTag(Number(a.fineract_loan_id), a.code, this.clock.today());
      await this.db.query(`UPDATE funding_tag_history SET ledger_synced_at = now() WHERE advance_id = $1 AND ledger_synced_at IS NULL`, [advanceId]);
    } catch (e) {
      await this.db.tx((c) => this.audit.record(c, SYSTEM, 'advance.funding_tag_sync_failed', 'advance', advanceId, null, { error: (e as Error).message.slice(0, 200) }));
    }
  }
  async fundIdFor(advanceId: string): Promise<number | undefined> {
    const r = await this.db.one(`SELECT fs.fineract_fund_id FROM advance a JOIN funding_source fs ON fs.id = a.funding_source_id WHERE a.id = $1`, [advanceId]);
    return r?.fineract_fund_id ? Number(r.fineract_fund_id) : undefined;
  }

  // ------------------------------------------------------------------ API
  async list() {
    const rules = await this.rules(); const loans = await this.loans();
    return rules.map((r) => {
      const u = facilityUtilisation(r, loans);
      return { id: r.id, code: r.code, name: r.name, type: r.type, limitCents: r.limitCents, priority: r.priority, active: r.active, eligibility: r.eligibility, covenants: r.covenants,
        fineractFundId: r.fineractFundId, utilisation: u, covenantStatus: covenantStatus(r, loans) };
    });
  }

  async propose(u: AuthUser, b: z.infer<typeof zSource>, existingCode?: string) {
    const rule: FundingSourceRule = { code: b.code, type: b.type, limitCents: b.limitCents === null ? null : BigInt(b.limitCents), priority: b.priority, active: true, eligibility: b.eligibility, covenants: b.covenants };
    const bad = validateFundingSource(rule);
    if (bad.length) throw badRequest('INVALID_FUNDING_SOURCE', `Invalid: ${bad.join(', ')}`, { fields: bad });
    return this.db.tx(async (c) => {
      let id: string;
      if (existingCode) {
        const ex = (await c.query(`SELECT id FROM funding_source WHERE code = $1`, [existingCode])).rows[0];
        if (!ex) throw notFound('Funding source');
        if (b.code !== existingCode) throw badRequest('CODE_IMMUTABLE', 'A funding source code cannot change');
        id = ex.id;
      } else {
        const r = (await c.query(`INSERT INTO funding_source (code, name, type, limit_cents, priority, active, eligibility, covenants) VALUES ($1,$2,$3,$4,$5,false,$6::jsonb,$7::jsonb)
          ON CONFLICT (code) DO NOTHING RETURNING id`, [b.code, b.name, b.type, b.limitCents, b.priority, JSON.stringify(b.eligibility), JSON.stringify(b.covenants)])).rows[0];
        if (!r) throw conflict('DUPLICATE_CODE', 'A funding source with this code exists; propose a change instead');
        id = r.id;
      }
      return this.approvals.propose(c, u, { action: 'funding_source_change', entityType: 'funding_source', entityId: id, payload: { ...b, active: true }, requiredRole: 'ceo', reason: b.reason });
    });
  }
  async proposeActive(u: AuthUser, code: string, active: boolean, reason: string) {
    const r = (await this.rules()).find((x) => x.code === code);
    if (!r) throw notFound('Funding source');
    return this.db.tx((c) => this.approvals.propose(c, u, { action: 'funding_source_change', entityType: 'funding_source', entityId: r.id,
      payload: { code: r.code, name: r.name, type: r.type, limitCents: r.limitCents, priority: r.priority, eligibility: r.eligibility, covenants: r.covenants, active, reason }, requiredRole: 'ceo', reason }));
  }

  async proposeRetag(u: AuthUser, advanceId: string, toCode: string, reason: string) {
    return this.db.tx(async (c) => {
      const a = (await c.query(`SELECT a.id, a.status, a.funding_source_id, fs.code FROM advance a LEFT JOIN funding_source fs ON fs.id = a.funding_source_id WHERE a.id = $1`, [advanceId])).rows[0];
      if (!a) throw notFound('Advance');
      if (!a.funding_source_id) throw conflict('NOT_TAGGED', 'Only advances tagged at release can be re-tagged');
      if (a.code === toCode) throw conflict('SAME_SOURCE', `Already tagged to ${toCode}`);
      const ev = await this.evaluateFor(c, advanceId, toCode);
      if (!ev.code) throw unprocessable('FUNDING_SOURCE_INELIGIBLE', `${toCode} is not eligible for this advance`, { evaluations: ev.evaluations });
      return this.approvals.propose(c, u, { action: 'funding_retag', entityType: 'advance', entityId: advanceId, payload: { fromSourceId: a.funding_source_id, fromCode: a.code, toCode, reason }, requiredRole: 'ceo', reason });
    });
  }

  history(advanceId: string) {
    return this.db.query(`SELECT h.id, f.code AS from_code, t.code AS to_code, h.effective_on, h.reason, h.approved_via, h.ledger_synced_at, h.created_at
      FROM funding_tag_history h LEFT JOIN funding_source f ON f.id = h.from_source_id JOIN funding_source t ON t.id = h.to_source_id WHERE h.advance_id = $1 ORDER BY h.id`, [advanceId]);
  }

  /** Tag that applied at the end of a day (for month-end lender packs). */
  async tagsAsOf(date: string): Promise<Map<string, string>> {
    const rows = await this.db.query(`SELECT DISTINCT ON (h.advance_id) h.advance_id, t.code FROM funding_tag_history h JOIN funding_source t ON t.id = h.to_source_id
      WHERE h.effective_on <= $1 ORDER BY h.advance_id, h.id DESC`, [date]);
    return new Map(rows.map((r: any) => [r.advance_id, r.code]));
  }

  async consistency() {
    const rows = await this.db.query(`SELECT a.id, a.fineract_loan_id, fs.code FROM advance a JOIN funding_source fs ON fs.id = a.funding_source_id WHERE a.fineract_loan_id IS NOT NULL ORDER BY a.created_at LIMIT 1000`);
    const mismatches: { advanceId: string; platform: string; ledger: string | null }[] = [];
    for (const r of rows) {
      const t = await this.adapters.ledger.getFundingTag(Number(r.fineract_loan_id));
      if (t.tagCode !== r.code) mismatches.push({ advanceId: r.id, platform: r.code, ledger: t.tagCode });
    }
    return { checked: rows.length, mismatches, checkedAt: this.clock.now().toISOString() };
  }

  /** used by the per-funder lender pack */
  async source(code: string) {
    const r = (await this.rules()).find((x) => x.code === code);
    if (!r) throw notFound('Funding source');
    return r;
  }
  evaluate = evaluateSource;
}

@Controller()
export class FundingController {
  constructor(private readonly s: FundingService) {}

  @Get('funding-sources') @Roles('ceo', 'credit', 'ops', 'admin', 'compliance', 'auditor', 'lender')
  list() { return this.s.list(); }

  @Post('funding-sources') @Roles('admin', 'credit', 'ceo')
  create(@CurrentUser() u: AuthUser, @Body() b: unknown) { return this.s.propose(u, zSource.parse(b)); }

  @Post('funding-sources/:code/change') @Roles('admin', 'credit', 'ceo')
  change(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body() b: unknown) { return this.s.propose(u, zSource.parse(b), z.string().max(24).parse(code)); }

  @Post('funding-sources/:code/active') @Roles('admin', 'credit', 'ceo')
  active(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body() b: unknown) {
    const body = z.object({ active: z.boolean(), reason: zText(500) }).parse(b);
    return this.s.proposeActive(u, z.string().max(24).parse(code), body.active, body.reason);
  }

  @Post('advances/:id/funding-tag') @Roles('credit', 'ops')
  retag(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ sourceCode: z.string().max(24), reason: zText(500) }).parse(b);
    return this.s.proposeRetag(u, zUuid.parse(id), body.sourceCode, body.reason);
  }

  @Get('advances/:id/funding-tags') @Roles('ceo', 'credit', 'ops', 'admin', 'compliance', 'auditor')
  history(@Param('id') id: string) { return this.s.history(zUuid.parse(id)); }

  @Get('funding/consistency') @Roles('ceo', 'ops', 'compliance', 'auditor')
  consistency() { return this.s.consistency(); }
}
