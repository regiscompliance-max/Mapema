/**
 * [Backend Engineer + Compliance & Risk Analyst] Collections & settlement (workflow 4).
 * Bank webhook / statement import -> idempotent ingest -> auto-match (reference, then amount)
 * -> post to Fineract in CBK order (principal -> fees -> interest; proven in the Fineract proof
 * test) -> remainder up to the invoice is the supplier's deferred price (D-01), journalled as a
 * payable -> system proposes the balance payout, one ops user releases it (D-06).
 *
 * Before the due date only principal is posted immediately; a remainder that can't pay off the
 * loan is HELD and posted on the due date, because Fineract would otherwise apply an early partial
 * remainder to accrued interest before the not-yet-due fee (found in the Phase 1 spike).
 */
import { PoolClient } from 'pg';
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters, BankCredit } from '@mapema/adapters';
import { allocate, assertKes, Cents, formatKes, inDuplumHeadroom } from '@mapema/pricing';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS } from '../common/config';
import { Clock } from '../common/clock';
import { FieldCrypto } from '../common/crypto';
import { Db, toCents } from '../common/db';
import { conflict, DomainError, notFound, unprocessable } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { AuthUser, CurrentUser, Public, Roles, StepUp } from '../auth/auth';
import { ApprovalsService } from './approvals';
import { normaliseInvoiceNo } from './invoices';

const OPEN = `('funded','late','recourse','non_performing')`;

@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly clock: Clock,
    private readonly notifier: Notifier,
    private readonly approvals: ApprovalsService,
    private readonly crypto: FieldCrypto,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
  ) {}

  onModuleInit() {
    this.approvals.register('manual_payment_match', async (c, a) => {
      await c.query(`UPDATE payment SET advance_id = $2, match_method = 'manual', matched_by = $3, approval_id = $4, status = 'matched' WHERE id = $1 AND status = 'unmatched'`,
        [a.entity_id, a.payload.advanceId, a.maker_id, a.id]);
    }, async (a) => { await this.apply(a.entity_id); });
  }

  // ------------------------------------------------------------------ ingest & match (OPS-04)
  async ingest(credit: BankCredit, source: 'webhook' | 'statement_import' | 'manual') {
    try { assertKes(credit.currency); } catch {
      await this.db.tx((c) => this.audit.record(c, SYSTEM, 'bank.credit.rejected_non_kes', 'bank_transaction', null, null, { bankRef: credit.bankRef, currency: credit.currency }));
      throw unprocessable('CURRENCY_NOT_SUPPORTED', 'Only KES credits can be applied');
    }
    const created = await this.db.tx(async (c) => {
      const t = (await c.query(
        `INSERT INTO bank_transaction (bank_code, account_no, bank_ref, value_date, amount_cents, currency, payer_name, payer_account_enc, narrative, source)
         VALUES ($1,$2,$3,$4,$5,'KES',$6,$7,$8,$9) ON CONFLICT (bank_code, bank_ref) DO NOTHING RETURNING *`,
        [credit.bankCode, credit.accountNo, credit.bankRef, credit.valueDate, credit.amountCents, credit.payerName ?? null,
          credit.payerAccount ? this.crypto.encrypt(credit.payerAccount) : null, credit.narrative ?? null, source])).rows[0];
      if (!t) return null; // duplicate delivery: idempotent
      const buyer = (await c.query(`SELECT o.id, o.legal_name FROM collection_account ca JOIN organisation o ON o.id = ca.buyer_id WHERE ca.virtual_account_no = $1`, [credit.accountNo])).rows[0];
      let advanceId: string | null = null; let method: string | null = null;
      if (buyer) {
        const cands = (await c.query(`SELECT a.id, i.invoice_number_norm, i.amount_cents FROM advance a JOIN invoice i ON i.id = a.invoice_id WHERE a.buyer_id = $1 AND a.status IN ${OPEN}`, [buyer.id])).rows;
        const narr = normaliseInvoiceNo(credit.narrative ?? '');
        const byRef = cands.filter((x: any) => narr.includes(x.invoice_number_norm));
        const byAmt = cands.filter((x: any) => toCents(x.amount_cents) === credit.amountCents);
        if (byRef.length === 1) { advanceId = byRef[0].id; method = 'auto_reference'; } else if (byAmt.length === 1) { advanceId = byAmt[0].id; method = 'auto_amount'; }
        if (credit.payerName && !similar(credit.payerName, buyer.legal_name)) {
          await c.query(`INSERT INTO aml_flag (org_id, entity_type, entity_id, rule_code) VALUES ($1,'bank_transaction',$2,'PAYER_NOT_BUYER')`, [buyer.id, t.id]);
        }
      }
      const p = (await c.query(
        `INSERT INTO payment (bank_transaction_id, buyer_id, amount_cents, received_at, match_method, advance_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [t.id, buyer?.id ?? null, credit.amountCents, credit.valueDate, method, advanceId, advanceId ? 'matched' : 'unmatched'])).rows[0];
      await this.audit.record(c, SYSTEM, 'bank.credit.ingest', 'payment', p.id, null, { bankRef: credit.bankRef, amountCents: credit.amountCents, matched: method, advanceId });
      return { paymentId: p.id as string, matched: Boolean(advanceId) };
    });
    if (!created) {
      const existing = await this.db.one(`SELECT p.id, p.status FROM payment p JOIN bank_transaction t ON t.id = p.bank_transaction_id WHERE t.bank_code = $1 AND t.bank_ref = $2`, [credit.bankCode, credit.bankRef]);
      return { duplicate: true, paymentId: existing?.id, status: existing?.status };
    }
    if (created.matched) await this.apply(created.paymentId);
    return { duplicate: false, ...(await this.db.one(`SELECT id AS "paymentId", status, held_cents, unapplied_cents FROM payment WHERE id = $1`, [created.paymentId])) };
  }

  // ------------------------------------------------------------------ apply (SYS-04 / OPS-04)
  async apply(paymentId: string) {
    const p = await this.db.one(`SELECT p.*, t.value_date, t.bank_ref FROM payment p JOIN bank_transaction t ON t.id = p.bank_transaction_id WHERE p.id = $1`, [paymentId]);
    if (!p || p.status !== 'matched') return;
    const a = await this.db.one(`SELECT a.*, i.amount_cents AS invoice_amount_cents, i.invoice_number FROM advance a JOIN invoice i ON i.id = a.invoice_id WHERE a.id = $1`, [p.advance_id]);
    if (!a?.fineract_loan_id) throw conflict('NOT_FUNDED', 'Advance has no ledger loan');
    const ledger = this.adapters.ledger;
    const ctx = { requestId: `apply-${paymentId}` };
    const loanId = Number(a.fineract_loan_id);
    const date: string = p.value_date;
    let remaining = toCents(p.amount_cents);
    let held = 0n;
    const loan = await ledger.getLoan(loanId);
    let rep = { transactionId: 0, principalCents: 0n, feesCents: 0n, penaltiesCents: 0n, interestCents: 0n, overpaymentCents: 0n, amountCents: 0n };
    let expected: ReturnType<typeof allocate> | null = null;
    let ledgerOverpaid = 0n;
    if (loan.totalOutstandingCents > 0n) {
      let post: Cents;
      // amounts due AS OF the value date (a plain loan read can show the scheduled, not the accrued, interest)
      const payoff = await ledger.payoffQuote(loanId, date);
      const dues = { principalCents: payoff.principalCents, feesCents: payoff.feesCents, interestCents: payoff.interestCents };
      if (date >= a.due_date) {
        post = remaining < payoff.totalCents ? remaining : payoff.totalCents;
      } else if (remaining >= payoff.totalCents) post = payoff.totalCents;
      else if (remaining <= payoff.principalCents) post = remaining;
      else { post = payoff.principalCents; held = remaining - post; }
      expected = allocate(post, dues, 0n);
      rep = await ledger.repay(ctx, loanId, post, date, `pay-${paymentId}`);
      if (rep.overpaymentCents > 0n) ledgerOverpaid = rep.overpaymentCents; // should never happen: payoff was read first
      remaining -= post + held;
    }
    const after = await ledger.getLoan(loanId);
    const closed = after.totalOutstandingCents === 0n;
    let supplierPortion = 0n;
    if (closed && remaining > 0n) {
      // the loan is closed, so everything the ledger collected (earlier payments + this one) is the final cost
      const prev = await this.db.one(`SELECT COALESCE(SUM(principal_cents + fees_charges_cents + interest_cents),0)::bigint AS loan, COALESCE(SUM(supplier_balance_cents),0)::bigint AS sup
        FROM payment_allocation WHERE advance_id = $1`, [a.id]);
      const loanCollected = toCents(prev.loan) + rep.principalCents + rep.feesCents + rep.penaltiesCents + rep.interestCents;
      const owed = toCents(a.invoice_amount_cents) - loanCollected - toCents(prev.sup);
      supplierPortion = owed > 0n ? (remaining < owed ? remaining : owed) : 0n;
      remaining -= supplierPortion;
    }
    const unapplied = remaining;
    if (supplierPortion > 0n) await ledger.postJournal(ctx, { date, debit: 'bank', credit: 'supplierPayable', amountCents: supplierPortion, reference: `sup-${paymentId}`, note: `Deferred price for ${a.invoice_number}` });
    if (unapplied > 0n) await ledger.postJournal(ctx, { date, debit: 'bank', credit: 'overpayment', amountCents: unapplied, reference: `over-${paymentId}`, note: `Overpayment ${p.bank_ref}` });
    if (held > 0n) await ledger.postJournal(ctx, { date, debit: 'bank', credit: 'suspense', amountCents: held, reference: `held-${paymentId}`, note: `Held until due date ${a.due_date}` });

    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO payment_allocation (payment_id, advance_id, principal_cents, fees_charges_cents, interest_cents, supplier_balance_cents, fineract_txn_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (payment_id, advance_id) DO NOTHING`,
        [paymentId, a.id, rep.principalCents, rep.feesCents + rep.penaltiesCents, rep.interestCents, supplierPortion, rep.transactionId || null]);
      const status = held > 0n ? 'partially_applied' : unapplied > 0n ? 'refund_due' : 'applied';
      await c.query(`UPDATE payment SET status = $2, held_cents = $3, unapplied_cents = $4 WHERE id = $1`, [paymentId, status, held, unapplied]);
      await c.query(`UPDATE advance SET mirror_principal_outstanding_cents = $2, mirror_fees_outstanding_cents = $3, mirror_interest_outstanding_cents = $4, mirror_refreshed_at = now(), updated_at = now() WHERE id = $1`,
        [a.id, after.principalOutstandingCents, after.feesOutstandingCents, after.interestOutstandingCents]);
      if (ledgerOverpaid > 0n) {
        const run = await this.reconRunFor(c, this.clock.today());
        await c.query(`INSERT INTO reconciliation_break (run_id, kind, difference_cents, reference) VALUES ($1,'ledger_overpayment',$2,$3)`, [run, ledgerOverpaid, JSON.stringify({ paymentId })]);
      }
      if (expected && (expected.principalCents !== rep.principalCents || expected.feesCents !== rep.feesCents + rep.penaltiesCents || expected.interestCents !== rep.interestCents)) {
        const run = await this.reconRunFor(c, this.clock.today());
        await c.query(`INSERT INTO reconciliation_break (run_id, kind, difference_cents, reference) VALUES ($1,'allocation_mismatch',$2,$3)`,
          [run, (expected.interestCents - rep.interestCents).toString(), JSON.stringify({ paymentId, expected, ledger: rep }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))]);
      }
      await this.inDuplumGuard(c, a.id, toCents(a.principal_cents), paymentId);
      if (closed) {
        await c.query(`UPDATE advance SET status = 'settled', updated_at = now() WHERE id = $1`, [a.id]);
        await c.query(`UPDATE invoice SET status = 'settled', updated_at = now() WHERE id = $1`, [a.invoice_id]);
      }
      let payoutId: string | null = null;
      if (supplierPortion > 0n) {
        const ba = (await c.query(`SELECT id FROM bank_account WHERE org_id = $1 AND is_payout_default AND deactivated_at IS NULL`, [a.supplier_id])).rows[0];
        payoutId = (await c.query(
          `INSERT INTO payout (advance_id, type, amount_cents, currency, bank_account_id, rail, status, proposed_by_system, payment_id, idempotency_key)
           VALUES ($1,'balance',$2,'KES',$3,'pesalink','proposed',true,$4, gen_random_uuid()::text) RETURNING id`, [a.id, supplierPortion, ba.id, paymentId])).rows[0].id;
        await this.notifier.toOrg(c, a.supplier_id, 'settlement.balance_proposed', { invoice: a.invoice_number, amount: formatKes(supplierPortion) }, { type: 'payout', id: payoutId! });
        await this.notifier.toRole(c, 'ops', 'settlement.balance_proposed', { invoice: a.invoice_number, amount: formatKes(supplierPortion) }, { type: 'payout', id: payoutId! });
      }
      await this.notifier.toOrg(c, a.buyer_id, 'payment.receipt.buyer', { amount: formatKes(toCents(p.amount_cents)), date, invoice: a.invoice_number }, { type: 'payment', id: paymentId });
      await this.audit.record(c, SYSTEM, 'payment.apply', 'payment', paymentId, { status: 'matched' }, {
        status, advanceId: a.id, ledgerTxn: rep.transactionId, principal: rep.principalCents, fees: rep.feesCents, interest: rep.interestCents, supplierBalance: supplierPortion, held, unapplied, settled: closed, payoutId,
      });
    });
  }

  /** Post held remainders on/after the due date (worker job). */
  /** In duplum guard (C-07): interest + fees ever collected on an advance may not exceed its principal; a breach is a reconciliation break. */
  private async inDuplumGuard(c: PoolClient, advanceId: string, principal: Cents, paymentId: string) {
    const chg = await c.query(`SELECT COALESCE(SUM(fees_charges_cents + interest_cents),0)::bigint AS charges FROM payment_allocation WHERE advance_id = $1`, [advanceId]);
    const charges = toCents(chg.rows[0].charges);
    if (charges > principal && inDuplumHeadroom(principal, charges) === 0n) {
      const run = await this.reconRunFor(c, this.clock.today());
      await c.query(`INSERT INTO reconciliation_break (run_id, kind, difference_cents, reference) VALUES ($1,'in_duplum_breach',$2,$3)`,
        [run, (charges - principal).toString(), JSON.stringify({ paymentId, advanceId })]);
    }
  }

  async postHeld(today = this.clock.today()) {
    const rows = await this.db.query(`SELECT p.id, p.held_cents, a.id AS advance_id, a.principal_cents, a.fineract_loan_id, a.due_date FROM payment p JOIN advance a ON a.id = p.advance_id WHERE p.held_cents > 0 AND a.due_date <= $1`, [today]);
    for (const r of rows) {
      const ctx = { requestId: `held-${r.id}` };
      const rep = await this.adapters.ledger.repay(ctx, Number(r.fineract_loan_id), toCents(r.held_cents), r.due_date, `held-${r.id}`);
      await this.adapters.ledger.postJournal(ctx, { date: r.due_date, debit: 'suspense', credit: 'bank', amountCents: toCents(r.held_cents), reference: `held-release-${r.id}`, note: 'Held remainder posted' });
      const after = await this.adapters.ledger.getLoan(Number(r.fineract_loan_id));
      await this.db.tx(async (c) => {
        await c.query(`UPDATE payment_allocation SET principal_cents = principal_cents + $3, fees_charges_cents = fees_charges_cents + $4, interest_cents = interest_cents + $5 WHERE payment_id = $1 AND advance_id = $2`,
          [r.id, r.advance_id, rep.principalCents, rep.feesCents + rep.penaltiesCents, rep.interestCents]);
        await this.inDuplumGuard(c, r.advance_id, toCents(r.principal_cents), r.id);
        await c.query(`UPDATE payment SET held_cents = 0, status = 'applied' WHERE id = $1`, [r.id]);
        await c.query(`UPDATE advance SET mirror_principal_outstanding_cents = $2, mirror_fees_outstanding_cents = $3, mirror_interest_outstanding_cents = $4, mirror_refreshed_at = now() WHERE id = $1`,
          [r.advance_id, after.principalOutstandingCents, after.feesOutstandingCents, after.interestOutstandingCents]);
        await this.audit.record(c, SYSTEM, 'payment.held_posted', 'payment', r.id, null, { fees: rep.feesCents, interest: rep.interestCents });
      });
    }
    return rows.length;
  }

  async reconRunFor(c: any, date: string): Promise<string> {
    const r = (await c.query(`INSERT INTO reconciliation_run (as_of_date, bank_balance_cents, fineract_cash_cents, platform_cash_cents, status) VALUES ($1,0,0,0,'breaks')
      ON CONFLICT (as_of_date) DO UPDATE SET as_of_date = EXCLUDED.as_of_date RETURNING id`, [date])).rows[0];
    return r.id;
  }

  // ------------------------------------------------------------------ balance release (SUP-09, D-06)
  async releaseBalance(u: AuthUser, payoutId: string) {
    const p = await this.db.tx(async (c) => {
      const p = (await c.query(`SELECT * FROM payout WHERE id = $1 FOR UPDATE`, [payoutId])).rows[0];
      if (!p) throw notFound('Payout');
      if (p.type !== 'balance' || p.status !== 'proposed') throw conflict('BAD_STATE', `Payout is ${p.type}/${p.status}`);
      await c.query(`UPDATE payout SET status = 'released', released_by = $2, released_at = now() WHERE id = $1`, [payoutId, u.id]);
      await this.audit.record(c, u.actor, 'payout.balance.release', 'payout', payoutId, { status: 'proposed' }, { status: 'released' });
      return p;
    });
    const ba = await this.db.one(`SELECT * FROM bank_account WHERE id = $1`, [p.bank_account_id]);
    const inv = await this.db.one(`SELECT i.invoice_number, a.supplier_id FROM advance a JOIN invoice i ON i.id = a.invoice_id WHERE a.id = $1`, [p.advance_id]);
    const ctx = { requestId: `balance-${payoutId}`, idempotencyKey: p.idempotency_key };
    const r = await this.adapters.bank.sendPayout(ctx, {
      idempotencyKey: p.idempotency_key, amountCents: toCents(p.amount_cents), currency: 'KES', rail: 'pesalink', narrative: `Mapema balance ${inv.invoice_number}`.slice(0, 35),
      beneficiary: { bankCode: ba.bank_code, accountNumber: this.crypto.decrypt(ba.account_number_enc)!, accountName: ba.account_name },
    });
    await this.db.tx(async (c) => {
      if (r.status === 'failed') {
        await c.query(`UPDATE payout SET status = 'failed', failure_reason = $2, bank_ref = $3 WHERE id = $1`, [payoutId, r.failureReason, r.bankRef]);
        await this.audit.record(c, SYSTEM, 'payout.balance.failed', 'payout', payoutId, null, { reason: r.failureReason });
        return;
      }
      await c.query(`UPDATE payout SET bank_ref = $2 WHERE id = $1`, [payoutId, r.bankRef]);
      await this.notifier.toOrg(c, inv.supplier_id, 'payout.balance_sent', { amount: formatKes(toCents(p.amount_cents)), invoice: inv.invoice_number, ref: r.bankRef }, { type: 'payout', id: payoutId });
    });
    if (r.status !== 'failed') {
      await this.adapters.ledger.postJournal(ctx, { date: this.clock.today(), debit: 'supplierPayable', credit: 'bank', amountCents: toCents(p.amount_cents), reference: `balpay-${payoutId}`, note: `Balance paid ${inv.invoice_number}` });
    }
    return this.db.one(`SELECT id, type, amount_cents, status, bank_ref, released_by, released_at, failure_reason FROM payout WHERE id = $1`, [payoutId]);
  }

  async proposeManualMatch(u: AuthUser, paymentId: string, advanceId: string, reason: string) {
    return this.db.tx(async (c) => {
      const p = (await c.query(`SELECT status FROM payment WHERE id = $1`, [paymentId])).rows[0];
      if (!p) throw notFound('Payment');
      if (p.status !== 'unmatched') throw conflict('BAD_STATE', `Payment is ${p.status}`);
      const a = (await c.query(`SELECT status FROM advance WHERE id = $1`, [advanceId])).rows[0];
      if (!a || !['funded', 'late', 'recourse', 'non_performing'].includes(a.status)) throw unprocessable('ADVANCE_NOT_OPEN', 'Advance is not open for repayment');
      return this.approvals.propose(c, u, { action: 'manual_payment_match', entityType: 'payment', entityId: paymentId, payload: { advanceId }, requiredRole: 'ops', reason });
    });
  }

  list(status?: string) {
    return this.db.query(
      `SELECT p.id, p.amount_cents, p.received_at, p.status, p.match_method, p.held_cents, p.unapplied_cents, p.advance_id, t.bank_ref, t.narrative, t.payer_name, b.legal_name AS buyer_name
       FROM payment p JOIN bank_transaction t ON t.id = p.bank_transaction_id LEFT JOIN organisation b ON b.id = p.buyer_id
       WHERE ($1::text IS NULL OR p.status = $1) ORDER BY t.received_at DESC LIMIT 500`, [status ?? null]);
  }

  payouts(status?: string) {
    return this.db.query(
      `SELECT p.id, p.advance_id, p.type, p.amount_cents, p.status, p.bank_ref, p.proposed_by_system, p.released_at, p.created_at, i.invoice_number, s.legal_name AS supplier_name
       FROM payout p JOIN advance a ON a.id = p.advance_id JOIN invoice i ON i.id = a.invoice_id JOIN organisation s ON s.id = a.supplier_id
       WHERE ($1::text IS NULL OR p.status::text = $1) ORDER BY p.created_at DESC LIMIT 500`, [status ?? null]);
  }
}

/** crude payer-name similarity for the AML rule (token overlap) */
export function similar(a: string, b: string): boolean {
  const toks = (s: string) => new Set(s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !['LTD', 'LIMITED', 'THE', 'AND', 'PLC', 'CO'].includes(t)));
  const ta = toks(a); const tb = toks(b);
  return [...ta].some((t) => tb.has(t));
}

@Controller()
export class PaymentsController {
  constructor(private readonly s: PaymentsService, @Inject(ADAPTERS) private readonly adapters: Adapters) {}

  @Public()
  @Post('webhooks/bank')
  async bankWebhook(@Req() req: any) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!this.adapters.bank.verifyWebhook(raw, req.headers)) throw new DomainError(401, 'BAD_SIGNATURE', 'Invalid webhook signature');
    return this.s.ingest(this.adapters.bank.parseWebhook(raw), 'webhook');
  }

  @Post('bank/statements')
  @Roles('ops')
  async statement(@Body() b: unknown) {
    const { csv } = z.object({ csv: z.string().min(1).max(2_000_000) }).parse(b);
    const credits = this.adapters.bank.parseStatement(csv);
    const results = [];
    for (const cr of credits) results.push({ bankRef: cr.bankRef, ...(await this.s.ingest(cr, 'statement_import').catch((e) => ({ error: e.message }))) });
    return { lines: credits.length, results };
  }

  @Get('payments')
  @Roles('ops', 'credit', 'ceo', 'admin', 'compliance', 'auditor')
  list(@Query('status') status?: string) {
    return this.s.list(status ? z.enum(['unmatched', 'matched', 'applied', 'partially_applied', 'refund_due', 'refunded']).parse(status) : undefined);
  }

  @Post('payments/:id/match')
  @Roles('ops')
  match(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ advanceId: zUuid, reason: zText() }).parse(b);
    return this.s.proposeManualMatch(u, zUuid.parse(id), body.advanceId, body.reason);
  }

  @Get('payouts')
  @Roles('ops', 'credit', 'ceo', 'admin', 'auditor')
  payouts(@Query('status') status?: string) {
    return this.s.payouts(status ? z.enum(['proposed', 'approved', 'released', 'confirmed', 'failed', 'returned', 'cancelled']).parse(status) : undefined);
  }

  @Post('payouts/:id/release')
  @Roles('ops')
  @StepUp()
  release(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.releaseBalance(u, zUuid.parse(id));
  }
}
