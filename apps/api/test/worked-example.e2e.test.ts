/**
 * [QA Engineer] TC-E2E-01 - THE WORKED EXAMPLE, end to end through the HTTP API
 * (brief Phase 1 "done when"): KES 1,000,000 invoice, 48 days, 80% advance, 3.5%/30d, KES 2,500
 * verification fee. Buyer pays the full invoice on the due date.
 * Expected: advance 800,000.00; interest 44,800.00; fee 2,500.00; supplier balance 152,700.00;
 * repayment applied principal -> fees -> interest; balance released by ops; reconciliation balanced.
 * Ledger: MockLedger by default. With E2E_LEDGER=fineract the SAME test runs against a real
 * Apache Fineract (npm run test:e2e:fineract); dates then move into the past because Fineract
 * rejects future-dated transactions, and GL checks compare deltas (the tenant is shared).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, startHarness } from './harness';
import { AT, buildWorld, eligibleInvoice, fund, LEDGER_ENV, REAL_LEDGER, seedFunding, World, WORKED } from './world';

let h: Harness; let w: World;
let gl0: Record<string, bigint> = {};
beforeAll(async () => {
  h = await startHarness(LEDGER_ENV);
  gl0 = await h.adapters.ledger.trialBalance();
  w = await buildWorld(h);
  await seedFunding(h, w, 1_000_000_000n);
});
const delta = async (k: string) => ((await h.adapters.ledger.trialBalance()) as Record<string, bigint>)[k] - (gl0[k] ?? 0n);
afterAll(async () => { await h?.close(); });

describe(`TC-E2E-01 worked example KES 1,000,000 / 48 days [ledger=${REAL_LEDGER ? 'real Fineract' : 'mock'}]`, () => {
  let invoiceId: string; let advanceId: string;

  it('quotes exactly the worked example and stores the full disclosure', async () => {
    expect(h.adapters.ledger.mode).toBe(REAL_LEDGER ? 'sandbox' : 'mock');
    invoiceId = await eligibleInvoice(h, w, { number: 'INV-2027-0001', amountCents: WORKED.invoiceCents, dueDate: WORKED.dueDate });
    const q = await w.supplier.post(`/invoices/${invoiceId}/quote`);
    expect(q).toMatchObject({
      currency: 'KES', invoiceAmountCents: '100000000', days: 48, advanceCents: '80000000', discountFeeCents: '4480000',
      verificationFeeCents: '250000', totalCostCents: '4730000', mapemaKeepsCents: '84730000', supplierBalanceCents: '15270000', aprBps: 4496,
    });
    expect(q.explanation.join(' ')).not.toMatch(/one flat fee/i);
  });

  it('accept -> credit approve -> ops release -> funded (ledger first, then bank)', async () => {
    const r = await fund(h, w, invoiceId);
    advanceId = r.advanceId;
    expect(r.release.status).toBe('funded');
    const sent = h.adapters.bank.sent.at(-1)!;
    expect(sent.amountCents).toBe(80_000_000n);
    expect(sent.beneficiary.accountNumber).toBe('0123456789');
    const disc = (await h.admin.query(`SELECT d.accepted_at, d.discount_fee_cents, d.terms_version, d.kid_version FROM mapema.advance a JOIN mapema.price_disclosure d ON d.id = a.price_disclosure_id WHERE a.id = $1`, [advanceId])).rows[0];
    expect(disc.accepted_at).not.toBeNull();
    expect(disc.discount_fee_cents).toBe('4480000');
    const loan = await h.adapters.ledger.getLoan(Number((await h.admin.query(`SELECT fineract_loan_id FROM mapema.advance WHERE id = $1`, [advanceId])).rows[0].fineract_loan_id));
    expect(loan.principalOutstandingCents).toBe(80_000_000n);
    const notice = (await h.admin.query(`SELECT count(*)::int AS n FROM mapema.document WHERE type = 'notice_of_assignment'`)).rows[0].n;
    expect(notice).toBe(1);
  });

  it('buyer pays KES 1,000,000 on the due date: principal -> fees -> interest, then supplier balance', async () => {
    h.clock.set(AT(WORKED.dueDate));
    const res = await h.http.post('/v1/dev/bank/credit').send({ accountNo: w.virtualAccount, amountCents: '100000000', bankRef: 'FT27052ACME001', valueDate: WORKED.dueDate, payerName: 'ACME SUPERMARKETS LIMITED', narrative: 'PAYMENT INV-2027-0001' }).expect(201);
    expect(res.body.status).toBe('applied');
    const alloc = (await h.admin.query(`SELECT principal_cents, fees_charges_cents, interest_cents, supplier_balance_cents FROM mapema.payment_allocation WHERE advance_id = $1`, [advanceId])).rows[0];
    expect(alloc).toEqual({ principal_cents: '80000000', fees_charges_cents: '250000', interest_cents: '4480000', supplier_balance_cents: '15270000' });
    const a = (await h.admin.query(`SELECT a.status, i.status AS inv FROM mapema.advance a JOIN mapema.invoice i ON i.id = a.invoice_id WHERE a.id = $1`, [advanceId])).rows[0];
    expect(a).toEqual({ status: 'settled', inv: 'settled' });
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM mapema.aml_flag`)).rows[0].n).toBe(0); // payer name matches buyer
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM mapema.reconciliation_break`)).rows[0].n).toBe(0); // ledger split == platform expectation
  });

  it('system proposes the KES 152,700 balance; one ops user releases it the same day (D-06)', async () => {
    const payouts = await w.ops.get('/payouts?status=proposed');
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ type: 'balance', amount_cents: '15270000', proposed_by_system: true });
    const rel = await w.ops.post(`/payouts/${payouts[0].id}/release`);
    expect(rel.status).toBe('released');
    expect(rel.bank_ref).toMatch(/^MB/);
    expect(h.adapters.bank.sent.at(-1)!.amountCents).toBe(15_270_000n);
  });

  it('three-way reconciliation balances; ledger trial balance sums to zero; income = 44,800 + 2,500', async () => {
    const tb = await w.auditor.get('/ledger/trial-balance');
    expect(tb.balanced).toBe(true);
    expect(await delta('bank')).toBe(1_004_730_000n);
    expect(await delta('interestIncome')).toBe(-4_480_000n);
    expect(await delta('feeIncome')).toBe(-250_000n);
    expect(await delta('loanPortfolio')).toBe(0n);
    expect(await delta('supplierPayable')).toBe(0n);
    if (!REAL_LEDGER) { // a shared real tenant carries other runs' balances, so the absolute three-way match is mock-only
      const run = await w.ops.post(`/reconciliation/run?date=${WORKED.dueDate}`);
      expect(run.status).toBe('balanced');
      expect(run.bank_balance_cents).toBe('1004730000');
      expect(run.fineract_cash_cents).toBe('1004730000');
      expect(run.platform_cash_cents).toBe('1004730000');
    }
  });

  it('notifications went out in order and the audit chain verifies', async () => {
    await h.http.post('/v1/dev/jobs/run').expect(201); // worker tick: send queued notifications
    const keys = h.adapters.sms.outbox.map((m: any) => m.text);
    expect(keys.some((t: string) => /has sent KES 800,000\.00/.test(t))).toBe(true);
    expect(keys.some((t: string) => /balance of KES 152,700\.00/.test(t))).toBe(true);
    const v = await w.compliance.get('/audit/verify');
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(40);
    const actions = (await h.admin.query(`SELECT action FROM mapema.audit_event WHERE entity_id = $1 ORDER BY id`, [advanceId])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['advance.request', 'advance.approve', 'advance.release', 'advance.funded']));
  });
});
