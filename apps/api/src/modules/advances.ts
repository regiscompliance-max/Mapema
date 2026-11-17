/**
 * [Backend Engineer + Compliance & Risk Analyst] Advances (workflow 3, steps 4-8).
 *  quote  -> immutable price disclosure shown to the supplier (full price disclosure)
 *  accept -> advance REQUESTED (Idempotency-Key)
 *  credit approves (automatic checks must all pass)            -> APPROVED  (maker)
 *  a different ops user releases (limits re-checked at release) -> RELEASED  (checker, step-up MFA)
 *  outbox: Fineract books the loan FIRST, then the bank pays (D-15); bank failure undoes the
 *  ledger disbursal -> FUNDED or RELEASE_FAILED. Notice of assignment + SMS/email on funding.
 */
import { Body, Controller, Get, Headers, Inject, Injectable, OnModuleInit, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { AdapterError } from '@mapema/adapters';
import { daysBetween, formatKes, quote as priceQuote } from '@mapema/pricing';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS, AppConfig, CONFIG } from '../common/config';
import { Clock } from '../common/clock';
import { FieldCrypto } from '../common/crypto';
import { Db, Q, toCents } from '../common/db';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { Idempotency } from '../common/idempotency';
import { Notifier } from '../common/notify';
import { Outbox } from '../common/outbox';
import { AuthUser, CurrentUser, hasRole, isStaff, orgIds, Roles, StepUp, SUPPLIER_ROLES } from '../auth/auth';
import { ApprovalsService } from './approvals';
import { kycExpiry } from './credit-reviews';
import { SettingsService } from './admin';
import { DocumentsService, simplePdf } from './documents';
import { TERMS_VERSION } from './onboarding';

export const KID_VERSION = 'KID-2026-11-v1';
const LIVE_STATUSES = `('approved','released','funded','late','recourse','non_performing')`;

export interface Check { code: string; ok: boolean; detail?: string }

@Injectable()
export class AdvancesService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly notifier: Notifier,
    private readonly outbox: Outbox,
    private readonly docs: DocumentsService,
    private readonly approvals: ApprovalsService,
    private readonly crypto: FieldCrypto,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit() {
    this.outbox.on('advance.disburse', (p) => this.disburse(p.advanceId));
    this.approvals.register('write_off', async (c, a) => {
      const adv = (await c.query(`SELECT * FROM advance WHERE id = $1 FOR UPDATE`, [a.entity_id])).rows[0];
      if (!adv?.fineract_loan_id) throw conflict('NOT_FUNDED', 'Only funded advances can be written off');
      await this.adapters.ledger.writeOff({ requestId: a.id }, Number(adv.fineract_loan_id), this.clock.today(), a.payload.reason);
      await c.query(`UPDATE advance SET status = 'written_off', updated_at = now() WHERE id = $1`, [a.entity_id]);
      await c.query(`INSERT INTO collection_action (advance_id, stage, channel, outcome) VALUES ($1,'write_off','system',$2)`, [a.entity_id, a.payload.reason]);
    });
  }

  // ------------------------------------------------------------------ quote & accept (SUP-07)
  async quote(u: AuthUser, invoiceId: string) {
    const supplierIds = orgIds(u, SUPPLIER_ROLES);
    const inv = await this.db.one(`SELECT * FROM invoice WHERE id = $1`, [invoiceId]);
    if (!inv || !supplierIds.includes(inv.supplier_id)) throw notFound('Invoice');
    if (inv.status !== 'eligible') throw conflict('NOT_ELIGIBLE', `Invoice is ${inv.status}; it must be confirmed by the buyer with a signed ILU`);
    const lending = await this.settings.lending();
    if (!lending.enabled) throw unprocessable('LENDING_DISABLED', 'Mapema is not yet lending (CBK licence pending). No quote can be given.');
    const prog = await this.db.one(`SELECT bp.*, pv.discount_rate_bps_per_30d, pv.verification_fee_cents, pv.min_days, pv.max_days, pv.status AS pv_status
      FROM buyer_programme bp JOIN pricing_version pv ON pv.id = bp.pricing_version_id WHERE bp.buyer_id = $1 AND bp.status = 'live'`, [inv.buyer_id]);
    if (!prog) throw unprocessable('PROGRAMME_NOT_LIVE', "The buyer's programme is not live");
    const pricing = await this.settings.activePricing();
    if (!pricing) throw unprocessable('NO_ACTIVE_PRICING', 'No active pricing');
    const today = this.clock.today();
    const days = daysBetween(today, inv.due_date);
    const q = priceQuote(toCents(inv.amount_cents), days, {
      advanceRateBps: Math.min(prog.advance_rate_bps, pricing.advance_rate_bps), discountRateBpsPer30d: pricing.discount_rate_bps_per_30d,
      verificationFeeCents: toCents(pricing.verification_fee_cents), minDays: pricing.min_days, maxDays: pricing.max_days, minInvoiceCents: await this.settings.invoiceMinimum(),
    });
    const d = await this.db.tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO price_disclosure (invoice_id, pricing_version_id, invoice_amount_cents, advance_rate_bps, discount_rate_bps_per_30d, quote_date, due_date, days,
           advance_cents, discount_fee_cents, verification_fee_cents, total_cost_cents, mapema_keeps_cents, supplier_balance_cents, apr_bps, terms_version, kid_version, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [invoiceId, pricing.id, q.invoiceCents, q.advanceRateBps, q.discountRateBpsPer30d, today, inv.due_date, days, q.advanceCents, q.discountFeeCents,
          q.verificationFeeCents, q.totalCostCents, q.mapemaKeepsCents, q.supplierBalanceCents, q.aprBps, TERMS_VERSION, KID_VERSION, new Date(this.clock.now().getTime() + this.cfg.QUOTE_TTL_MINUTES * 60_000)])).rows[0];
      await this.audit.record(c, u.actor, 'price_disclosure.create', 'price_disclosure', r.id, null, { invoiceId, ...q });
      return r;
    });
    return this.disclosureView(d);
  }

  disclosureView(d: any) {
    return {
      disclosureId: d.id, invoiceId: d.invoice_id, currency: 'KES', invoiceAmountCents: toCents(d.invoice_amount_cents), days: d.days, dueDate: d.due_date,
      advanceRateBps: d.advance_rate_bps, discountRateBpsPer30d: d.discount_rate_bps_per_30d,
      advanceCents: toCents(d.advance_cents), discountFeeCents: toCents(d.discount_fee_cents), verificationFeeCents: toCents(d.verification_fee_cents),
      totalCostCents: toCents(d.total_cost_cents), mapemaKeepsCents: toCents(d.mapema_keeps_cents), supplierBalanceCents: toCents(d.supplier_balance_cents),
      aprBps: d.apr_bps, expiresAt: d.expires_at, termsVersion: d.terms_version, kidVersion: d.kid_version, acceptedAt: d.accepted_at,
      explanation: [
        `You receive ${formatKes(toCents(d.advance_cents))} now (${d.advance_rate_bps / 100}% of the invoice).`,
        `Discount fee (interest) is at most ${formatKes(toCents(d.discount_fee_cents))} for ${d.days} days; if your buyer pays early you pay less.`,
        `Verification fee ${formatKes(toCents(d.verification_fee_cents))}. Total cost ${formatKes(toCents(d.total_cost_cents))} (simple annual rate ${(d.apr_bps / 100).toFixed(2)}%).`,
        `When your buyer pays, you receive at least ${formatKes(toCents(d.supplier_balance_cents))} more within 1 business day.`,
        'If the buyer has not paid 30 days after the due date, Mapema may ask you to repay (recourse).',
      ],
    };
  }

  async accept(u: AuthUser, disclosureIds: string[], ip?: string) {
    const supplierIds = orgIds(u, SUPPLIER_ROLES);
    if (!(await this.settings.lending()).enabled) throw unprocessable('LENDING_DISABLED', 'Mapema is not yet lending');
    const out = [];
    for (const id of disclosureIds) {
      out.push(await this.db.tx(async (c) => {
        const d = (await c.query(`SELECT * FROM price_disclosure WHERE id = $1`, [id])).rows[0];
        if (!d) throw notFound('Quote');
        const inv = (await c.query(`SELECT * FROM invoice WHERE id = $1 FOR UPDATE`, [d.invoice_id])).rows[0];
        if (!supplierIds.includes(inv.supplier_id)) throw notFound('Quote');
        if (d.accepted_at) throw conflict('ALREADY_ACCEPTED', 'This quote was already accepted');
        if (new Date(d.expires_at) < this.clock.now()) throw conflict('QUOTE_EXPIRED', 'This quote has expired; get a new quote');
        if (inv.status !== 'eligible') throw conflict('NOT_ELIGIBLE', `Invoice is ${inv.status}`);
        await c.query(`UPDATE price_disclosure SET accepted_by = $2, accepted_at = now(), accepted_ip = $3 WHERE id = $1`, [id, u.id, ip ?? null]);
        const a = (await c.query(
          `INSERT INTO advance (invoice_id, supplier_id, buyer_id, price_disclosure_id, principal_cents, discount_fee_cents, verification_fee_cents, status, rate_bps_per_30d, term_days, due_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'requested',$8,$9,$10) RETURNING *`,
          [inv.id, inv.supplier_id, inv.buyer_id, id, d.advance_cents, d.discount_fee_cents, d.verification_fee_cents, d.discount_rate_bps_per_30d, d.days, d.due_date])).rows[0];
        await c.query(`UPDATE invoice SET status = 'advance_requested', updated_at = now() WHERE id = $1`, [inv.id]);
        await this.audit.record(c, u.actor, 'advance.request', 'advance', a.id, null, { disclosureId: id, principalCents: a.principal_cents, ip });
        return { advanceId: a.id, status: a.status, principalCents: toCents(a.principal_cents) };
      }));
    }
    return { advances: out };
  }

  // ------------------------------------------------------------------ automatic checks (CRD-06)
  async checks(q: Q, advanceId: string): Promise<{ checks: Check[]; adv: any }> {
    const adv = (await q.query(
      `SELECT a.*, i.etims_status, i.invoice_number, i.supplier_kra_pin, i.amount_cents AS invoice_amount_cents, i.issue_date, i.due_date AS invoice_due_date,
              b.status AS buyer_status, b.dispute_freeze, b.sector_id, s.status AS supplier_status, l.status AS link_status, l.supplier_limit_cents,
              bp.limit_cents AS programme_limit_cents, bp.status AS programme_status, bp.review_date AS programme_review_date,
              (SELECT signed_at FROM confirmation c JOIN confirmation_invoice ci ON ci.confirmation_id = c.id WHERE ci.invoice_id = a.invoice_id) AS ilu_signed_at
       FROM advance a JOIN invoice i ON i.id = a.invoice_id JOIN organisation b ON b.id = a.buyer_id JOIN organisation s ON s.id = a.supplier_id
       LEFT JOIN supplier_link l ON l.buyer_id = a.buyer_id AND l.supplier_id = a.supplier_id
       LEFT JOIN buyer_programme bp ON bp.buyer_id = a.buyer_id AND bp.status = 'live'
       WHERE a.id = $1`, [advanceId])).rows[0];
    if (!adv) throw notFound('Advance');
    const checks: Check[] = [];
    const lending = await this.settings.lending(q);
    checks.push({ code: 'LENDING_ENABLED', ok: lending.enabled, detail: lending.enabled ? `CBK licence ${lending.cbk_licence_no}` : 'Lending is switched off' });
    checks.push({ code: 'ETIMS_VALID', ok: ['valid', 'overridden'].includes(adv.etims_status), detail: adv.etims_status });
    checks.push({ code: 'ILU_SIGNED', ok: Boolean(adv.ilu_signed_at), detail: adv.ilu_signed_at ? String(adv.ilu_signed_at) : 'not signed' });
    const fuzzy = (await q.query(
      `SELECT count(*)::int AS n FROM invoice i JOIN advance a2 ON a2.invoice_id = i.id AND a2.status NOT IN ('declined','cancelled','release_failed')
       WHERE i.supplier_kra_pin = $1 AND i.amount_cents = $2 AND i.issue_date = $3 AND i.id <> $4`, [adv.supplier_kra_pin, adv.invoice_amount_cents, adv.issue_date, adv.invoice_id])).rows[0].n;
    checks.push({ code: 'NO_DUPLICATE', ok: fuzzy === 0, detail: fuzzy ? `${fuzzy} financed invoice(s) with same PIN, amount and date` : 'none' });
    checks.push({ code: 'BUYER_LIVE', ok: adv.buyer_status === 'live' && adv.programme_status === 'live', detail: `${adv.buyer_status}/${adv.programme_status ?? 'no programme'}` });
    checks.push({ code: 'NO_BUYER_DISPUTE', ok: !adv.dispute_freeze, detail: adv.dispute_freeze ? 'open dispute freezes new advances' : 'none' });
    checks.push({ code: 'SUPPLIER_ACTIVE', ok: adv.supplier_status === 'active' && adv.link_status === 'active', detail: `${adv.supplier_status}/${adv.link_status}` });
    const ba = (await q.query(`SELECT verified_at, cooling_off_until FROM bank_account WHERE org_id = $1 AND is_payout_default AND deactivated_at IS NULL`, [adv.supplier_id])).rows[0];
    const baOk = Boolean(ba?.verified_at) && (!ba.cooling_off_until || new Date(ba.cooling_off_until) <= this.clock.now());
    checks.push({ code: 'PAYOUT_ACCOUNT_VERIFIED', ok: baOk, detail: !ba ? 'no account' : !ba.verified_at ? 'not verified by call-back' : baOk ? 'verified' : 'in cooling-off after change' });
    // CRD-07: a party past its review date or KYC expiry is excluded from new advances
    const today = this.clock.today();
    const lr = (await q.query(`SELECT MIN(review_date) AS d FROM limit_config WHERE active AND subject IN ('buyer','supplier') AND subject_org_id IN ($1,$2) AND review_date IS NOT NULL`, [adv.buyer_id, adv.supplier_id])).rows[0]?.d as string | null;
    const reviewIssues = [adv.programme_review_date && adv.programme_review_date <= today ? `programme review was due ${adv.programme_review_date}` : null, lr && lr <= today ? `limit review was due ${lr}` : null].filter(Boolean);
    checks.push({ code: 'PROGRAMME_IN_REVIEW_DATE', ok: reviewIssues.length === 0, detail: reviewIssues.length ? reviewIssues.join('; ') : `programme review ${adv.programme_review_date ?? 'n/a'}` });
    const now = this.clock.now();
    const kycS = await kycExpiry(q, adv.supplier_id); const kycB = await kycExpiry(q, adv.buyer_id);
    const kycIssues = [kycS && kycS <= now ? `supplier KYC expired ${kycS.toISOString().slice(0, 10)}` : null, kycB && kycB <= now ? `buyer KYB expired ${kycB.toISOString().slice(0, 10)}` : null].filter(Boolean);
    checks.push({ code: 'KYC_CURRENT', ok: kycIssues.length === 0, detail: kycIssues.length ? kycIssues.join('; ') : 'current' });
    const days = daysBetween(this.clock.today(), adv.due_date);
    checks.push({ code: 'DUE_DATE_AHEAD', ok: days >= 1, detail: `${days} days to due date` });
    checks.push(...(await this.limitChecks(q, adv)));
    return { checks, adv };
  }

  /** Concentration limits + float, computed at approval AND again at release (brief). */
  async limitChecks(q: Q, adv: any): Promise<Check[]> {
    const float = await this.settings.currentFloat(q);
    const principal = toCents(adv.principal_cents);
    const expo = async (col: string | null, val: unknown) => toCents((await q.query(
      `SELECT COALESCE(SUM(CASE WHEN a.status IN ('approved','released') THEN a.principal_cents ELSE COALESCE(a.mirror_principal_outstanding_cents, a.principal_cents) END),0)::bigint AS e
       FROM advance a JOIN organisation b ON b.id = a.buyer_id WHERE a.status IN ${LIVE_STATUSES} AND a.id <> $1 ${col ? `AND ${col} = $2` : ''}`,
      col ? [adv.id, val] : [adv.id])).rows[0].e);
    const pct = async (subject: string, orgId: string | null, sectorId: number | null): Promise<bigint | null> => {
      const r = (await q.query(
        `SELECT pct_of_float_bps, absolute_cap_cents FROM limit_config WHERE active AND subject = $1
           AND (subject_org_id = $2 OR subject_org_id IS NULL) AND subject_sector_id IS NOT DISTINCT FROM $3
         ORDER BY subject_org_id NULLS LAST LIMIT 1`, [subject, orgId, sectorId])).rows[0];
      if (!r) return null;
      const caps: bigint[] = [];
      if (r.pct_of_float_bps !== null) caps.push((float * BigInt(r.pct_of_float_bps)) / 10000n);
      if (r.absolute_cap_cents !== null) caps.push(toCents(r.absolute_cap_cents));
      return caps.reduce((a, b) => (a < b ? a : b));
    };
    const min = (...xs: (bigint | null | undefined)[]) => xs.filter((x): x is bigint => x !== null && x !== undefined).reduce((a, b) => (a < b ? a : b));
    const buyerCap = min(await pct('buyer', adv.buyer_id, null), adv.programme_limit_cents !== null ? toCents(adv.programme_limit_cents) : null, float);
    const supplierCap = min(await pct('supplier', adv.supplier_id, null), adv.supplier_limit_cents !== null ? toCents(adv.supplier_limit_cents) : null, float);
    const sectorCap = adv.sector_id ? min(await pct('sector', null, adv.sector_id), float) : float;
    const [eb, es, esec, etot] = [await expo('a.buyer_id', adv.buyer_id), await expo('a.supplier_id', adv.supplier_id), adv.sector_id ? await expo('b.sector_id', adv.sector_id) : 0n, await expo(null, null)];
    const fmt = (e: bigint, cap: bigint) => `${formatKes(e + principal)} of ${formatKes(cap)}`;
    return [
      { code: 'FLOAT_AVAILABLE', ok: float > 0n && etot + principal <= float, detail: fmt(etot, float) },
      { code: 'BUYER_LIMIT', ok: eb + principal <= buyerCap, detail: fmt(eb, buyerCap) },
      { code: 'SUPPLIER_LIMIT', ok: es + principal <= supplierCap, detail: fmt(es, supplierCap) },
      { code: 'SECTOR_LIMIT', ok: esec + principal <= sectorCap, detail: fmt(esec, sectorCap) },
    ];
  }

  async queue(status: string) {
    const rows = await this.db.query(
      `SELECT a.id, a.status, a.principal_cents, a.discount_fee_cents, a.verification_fee_cents, a.due_date, a.created_at, a.approved_by, a.fineract_loan_id,
              i.invoice_number, i.amount_cents AS invoice_amount_cents, b.legal_name AS buyer_name, s.legal_name AS supplier_name
       FROM advance a JOIN invoice i ON i.id = a.invoice_id JOIN organisation b ON b.id = a.buyer_id JOIN organisation s ON s.id = a.supplier_id
       WHERE a.status = $1 ORDER BY a.created_at`, [status]);
    const out = [];
    const decisionStage = ['requested', 'approved'].includes(status); // checks only matter before money moves
    for (const r of rows) out.push({ ...r, checks: decisionStage ? (await this.checks(this.db.pool, r.id)).checks : [] });
    return out;
  }

  // ------------------------------------------------------------------ credit decision (CRD-06/08)
  async decide(u: AuthUser, id: string, decision: 'approve' | 'decline', reason: string) {
    const r = await this.db.tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('mapema.release'))`); // approvals reserve limit headroom too: serialise with releases
      const a0 = (await c.query(`SELECT * FROM advance WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!a0) throw notFound('Advance');
      if (a0.status !== 'requested') throw conflict('BAD_STATE', `Advance is ${a0.status}`);
      if (decision === 'decline') {
        await c.query(`UPDATE advance SET status = 'declined', decline_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
        await c.query(`UPDATE invoice SET status = 'eligible', updated_at = now() WHERE id = $1`, [a0.invoice_id]);
        await this.audit.record(c, u.actor, 'advance.decline', 'advance', id, { status: 'requested' }, { status: 'declined', reason });
        return { id, status: 'declined' as const };
      }
      const { checks } = await this.checks(c, id);
      const failed = checks.filter((x) => !x.ok);
      if (failed.length) throw unprocessable('CHECKS_FAILED', 'Automatic checks failed; the advance cannot be approved', { failedChecks: failed });
      const ba = (await c.query(`SELECT id FROM bank_account WHERE org_id = $1 AND is_payout_default AND deactivated_at IS NULL`, [a0.supplier_id])).rows[0];
      await c.query(`UPDATE advance SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [id, u.id]);
      const p = (await c.query(
        `INSERT INTO payout (advance_id, type, amount_cents, currency, bank_account_id, rail, status, approved_by, idempotency_key)
         VALUES ($1,'advance',$2,'KES',$3,'pesalink','approved',$4, gen_random_uuid()::text) RETURNING id`, [id, a0.principal_cents, ba.id, u.id])).rows[0];
      await this.audit.record(c, u.actor, 'advance.approve', 'advance', id, { status: 'requested' }, { status: 'approved', reason, checks, payoutId: p.id });
      await this.notifier.toRole(c, 'ops', 'advance.approved', { invoice: a0.invoice_id }, { type: 'advance', id });
      return { id, status: 'approved' as const, payoutId: p.id, checks };
    });
    return r;
  }

  // ------------------------------------------------------------------ release (OPS-02)
  async release(u: AuthUser, id: string) {
    const out = await this.db.tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('mapema.release'))`); // serialise limit checks across releases
      const a0 = (await c.query(`SELECT * FROM advance WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!a0) throw notFound('Advance');
      if (a0.status !== 'approved') throw conflict('BAD_STATE', `Advance is ${a0.status}`);
      if (a0.approved_by === u.id) throw forbidden('FOUR_EYES', 'The credit officer who approved an advance cannot also release it');
      const { checks } = await this.checks(c, id);
      const failed = checks.filter((x) => !x.ok);
      if (failed.length) throw unprocessable('CHECKS_FAILED', 'Checks failed at release time; payment not released', { failedChecks: failed });
      const p = (await c.query(`UPDATE payout SET status = 'released', released_by = $2, released_at = now() WHERE advance_id = $1 AND type = 'advance' AND status = 'approved' RETURNING id`, [id, u.id])).rows[0];
      await c.query(`UPDATE advance SET status = 'released', released_by = $2, updated_at = now() WHERE id = $1`, [id, u.id]);
      const ob = await this.outbox.enqueue(c, 'advance.disburse', id, `disburse-${id}`, { advanceId: id });
      await this.audit.record(c, u.actor, 'advance.release', 'advance', id, { status: 'approved' }, { status: 'released', payoutId: p.id, checks });
      return { outboxId: ob };
    });
    await this.outbox.kick(out.outboxId);
    return this.get(u, id);
  }

  /** Outbox handler: ledger first, then bank; undo ledger on bank failure (D-15). Idempotent. */
  async disburse(advanceId: string) {
    const a = await this.db.one(
      `SELECT a.*, s.legal_name AS supplier_name, s.fineract_client_id, s.created_at AS supplier_created, i.invoice_number, i.amount_cents AS invoice_amount_cents,
              b.legal_name AS buyer_name, b.id AS buyer_org_id
       FROM advance a JOIN organisation s ON s.id = a.supplier_id JOIN invoice i ON i.id = a.invoice_id JOIN organisation b ON b.id = a.buyer_id WHERE a.id = $1`, [advanceId]);
    if (!a || a.status !== 'released') return;
    const payout = await this.db.one(`SELECT p.*, ba.bank_code, ba.account_name, ba.account_number_enc, ba.account_number_last4 FROM payout p JOIN bank_account ba ON ba.id = p.bank_account_id
      WHERE p.advance_id = $1 AND p.type = 'advance' AND p.status = 'released'`, [advanceId]);
    const ctx = { requestId: `disburse-${advanceId}`, idempotencyKey: payout.idempotency_key };
    const today = this.clock.today();
    // 1. ledger
    let clientId = a.fineract_client_id ? Number(a.fineract_client_id) : undefined;
    if (!clientId) {
      clientId = await this.adapters.ledger.createClient(ctx, { externalId: a.supplier_id, legalName: a.supplier_name, activationDate: today });
      await this.db.query(`UPDATE organisation SET fineract_client_id = $2 WHERE id = $1`, [a.supplier_id, clientId]);
    }
    const termDays = daysBetween(today, a.due_date);
    const { loanId } = await this.adapters.ledger.bookAdvance(ctx, {
      externalId: advanceId, clientId, principalCents: toCents(a.principal_cents), rateBpsPer30d: a.rate_bps_per_30d, days: termDays,
      disbursementDate: today, dueDate: a.due_date, verificationFeeCents: toCents(a.verification_fee_cents),
    });
    await this.db.query(`UPDATE advance SET fineract_loan_id = $2, disbursement_date = $3 WHERE id = $1`, [advanceId, loanId, today]);
    // 2. bank
    let bank: { bankRef: string; status: string; failureReason?: string };
    try {
      bank = await this.adapters.bank.sendPayout(ctx, {
        idempotencyKey: payout.idempotency_key, amountCents: toCents(payout.amount_cents), currency: 'KES', rail: payout.rail ?? 'pesalink',
        narrative: `Mapema advance ${a.invoice_number}`.slice(0, 35),
        beneficiary: { bankCode: payout.bank_code, accountNumber: this.crypto.decrypt(payout.account_number_enc)!, accountName: payout.account_name },
      });
    } catch (e) {
      if (e instanceof AdapterError && e.retryable) throw e; // outbox retries; ledger booking is idempotent
      bank = { bankRef: '', status: 'failed', failureReason: (e as Error).message.slice(0, 200) };
    }
    if (bank.status === 'failed') {
      await this.adapters.ledger.undoDisbursal(ctx, loanId);
      await this.db.tx(async (c) => {
        await c.query(`UPDATE payout SET status = 'failed', failure_reason = $2, bank_ref = NULLIF($3,'') WHERE id = $1`, [payout.id, bank.failureReason, bank.bankRef]);
        await c.query(`UPDATE advance SET status = 'release_failed', fineract_loan_id = NULL, decline_reason = $2, updated_at = now() WHERE id = $1`, [advanceId, `bank: ${bank.failureReason}`]);
        await c.query(`UPDATE invoice SET status = 'eligible', updated_at = now() WHERE id = $1`, [a.invoice_id]);
        await this.audit.record(c, SYSTEM, 'advance.release_failed', 'advance', advanceId, { status: 'released' }, { status: 'release_failed', reason: bank.failureReason, ledgerUndone: loanId });
        await this.notifier.toOrg(c, a.supplier_id, 'advance.release_failed', { invoice: a.invoice_number, reason: 'the bank rejected the payment' });
      });
      return;
    }
    // 3. funded + notice of assignment + alerts
    const acct = await this.db.one(`SELECT virtual_account_no FROM collection_account WHERE buyer_id = $1`, [a.buyer_id]);
    await this.db.tx(async (c) => {
      await c.query(`UPDATE payout SET bank_ref = $2 WHERE id = $1`, [payout.id, bank.bankRef]);
      await c.query(`UPDATE advance SET status = 'funded', disbursed_at = now(), mirror_principal_outstanding_cents = principal_cents, mirror_refreshed_at = now(), updated_at = now() WHERE id = $1`, [advanceId]);
      await c.query(`UPDATE invoice SET status = 'funded', updated_at = now() WHERE id = $1`, [a.invoice_id]);
      const notice = simplePdf('Notice of Assignment', [
        `To: ${a.buyer_name}`, `Invoice ${a.invoice_number} from ${a.supplier_name} for ${formatKes(toCents(a.invoice_amount_cents))} has been assigned to Mapema.`,
        `Pay the FULL invoice amount on ${a.due_date} into Mapema collection account ${acct?.virtual_account_no ?? '(pending)'}, reference ${a.invoice_number}.`,
        'Payment to anyone else will not discharge the debt. Your ILU waives set-off.',
      ]);
      const doc = await this.docs.store(c, { ownerOrgId: a.buyer_id, type: 'notice_of_assignment', fileName: `notice-${a.invoice_number}.pdf`, mimeType: 'application/pdf', body: notice, containsPii: false });
      await this.audit.record(c, SYSTEM, 'advance.funded', 'advance', advanceId, { status: 'released' }, { status: 'funded', fineractLoanId: loanId, bankRef: bank.bankRef, noticeDocId: doc.id });
      await this.notifier.toOrg(c, a.supplier_id, 'advance.funded', { amount: formatKes(toCents(payout.amount_cents)), invoice: a.invoice_number, last4: payout.account_number_last4, ref: bank.bankRef }, { type: 'advance', id: advanceId });
      await this.notifier.toOrg(c, a.buyer_id, 'notice.assignment', { invoice: a.invoice_number, amount: formatKes(toCents(a.invoice_amount_cents)), supplier: a.supplier_name, due: a.due_date, account: acct?.virtual_account_no ?? '' }, { type: 'advance', id: advanceId });
    });
  }

  /** OPS-03: poll bank for payout status. */
  async refreshPayoutStatuses() {
    const rows = await this.db.query(`SELECT id, advance_id, type, bank_ref FROM payout WHERE status = 'released' AND bank_ref IS NOT NULL`);
    for (const p of rows) {
      const s = await this.adapters.bank.getPayoutStatus(p.bank_ref);
      if (s.status === 'confirmed') await this.db.query(`UPDATE payout SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [p.id]);
      if (s.status === 'returned' || s.status === 'failed') {
        await this.db.tx(async (c) => {
          await c.query(`UPDATE payout SET status = $2, failure_reason = $3 WHERE id = $1`, [p.id, s.status, s.failureReason ?? null]);
          await c.query(`INSERT INTO aml_flag (entity_type, entity_id, rule_code) VALUES ('payout',$1,'PAYOUT_RETURNED')`, [p.id]);
          await this.audit.record(c, SYSTEM, `payout.${s.status}`, 'payout', p.id, null, { reason: s.failureReason });
        });
      }
    }
    return rows.length;
  }

  async get(u: AuthUser, id: string) {
    const a = await this.db.one(`SELECT a.*, i.invoice_number FROM advance a JOIN invoice i ON i.id = a.invoice_id WHERE a.id = $1`, [id]);
    if (!a) throw notFound('Advance');
    if (!isStaff(u) && !hasRole(u, 'auditor', 'lender') && !u.roles.some((r) => r.orgId === a.supplier_id || r.orgId === a.buyer_id)) throw notFound('Advance');
    const payouts = await this.db.query(`SELECT id, type, amount_cents, status, bank_ref, released_at, confirmed_at, failure_reason FROM payout WHERE advance_id = $1 ORDER BY created_at`, [id]);
    const allocations = await this.db.query(`SELECT pa.*, p.received_at FROM payment_allocation pa JOIN payment p ON p.id = pa.payment_id WHERE pa.advance_id = $1 ORDER BY pa.created_at`, [id]);
    const disclosure = this.disclosureView(await this.db.one(`SELECT * FROM price_disclosure WHERE id = $1`, [a.price_disclosure_id]));
    return { ...a, disclosure, payouts, allocations };
  }

  async listForUser(u: AuthUser) {
    if (isStaff(u) || hasRole(u, 'auditor', 'lender')) return this.db.query(`SELECT a.*, i.invoice_number FROM advance a JOIN invoice i ON i.id = a.invoice_id ORDER BY a.created_at DESC LIMIT 500`);
    const ids = u.roles.map((r) => r.orgId).filter(Boolean);
    return this.db.query(`SELECT a.*, i.invoice_number FROM advance a JOIN invoice i ON i.id = a.invoice_id WHERE a.supplier_id = ANY($1) OR a.buyer_id = ANY($1) ORDER BY a.created_at DESC`, [ids]);
  }

  async proposeWriteOff(u: AuthUser, id: string, reason: string) {
    return this.db.tx((c) => this.approvals.propose(c, u, { action: 'write_off', entityType: 'advance', entityId: id, payload: { reason }, requiredRole: 'ceo', reason }));
  }
}

@Controller()
export class AdvancesController {
  constructor(private readonly s: AdvancesService, private readonly idem: Idempotency) {}

  @Post('invoices/:id/quote')
  @Roles('supplier_admin', 'supplier_user')
  quote(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.quote(u, zUuid.parse(id));
  }

  @Post('advances')
  @Roles('supplier_admin', 'supplier_user')
  accept(@CurrentUser() u: AuthUser, @Body() b: unknown, @Headers('idempotency-key') key: string | undefined, @Req() req: any) {
    const body = z.object({ disclosureIds: z.array(zUuid).min(1).max(50), acceptTerms: z.literal(true, { error: 'You must accept the fee and terms' }) }).parse(b);
    return this.idem.run(key, u.id, body, () => this.s.accept(u, body.disclosureIds, req.ip));
  }

  @Get('advances')
  list(@CurrentUser() u: AuthUser) {
    return this.s.listForUser(u);
  }

  @Get('advances/queue')
  @Roles('credit', 'ops', 'ceo', 'admin')
  queue(@Query('status') status?: string) {
    return this.s.queue(z.enum(['requested', 'approved', 'released', 'funded', 'late', 'release_failed', 'recourse', 'non_performing']).default('requested').parse(status));
  }

  @Get('advances/:id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.get(u, zUuid.parse(id));
  }

  @Post('advances/:id/decision')
  @Roles('credit')
  @StepUp()
  decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ decision: z.enum(['approve', 'decline']), reason: zText(1000) }).parse(b);
    return this.s.decide(u, zUuid.parse(id), body.decision, body.reason);
  }

  @Post('advances/:id/release')
  @Roles('ops')
  @StepUp()
  release(@CurrentUser() u: AuthUser, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined) {
    const aid = zUuid.parse(id);
    return this.idem.run(key, u.id, { release: aid }, () => this.s.release(u, aid));
  }

  @Post('advances/:id/write-off')
  @Roles('admin', 'credit')
  writeOff(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.proposeWriteOff(u, zUuid.parse(id), z.object({ reason: zText(1000) }).parse(b).reason);
  }
}

