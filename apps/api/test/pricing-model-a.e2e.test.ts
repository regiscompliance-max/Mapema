/**
 * [QA Engineer] D-82 bank-billed fee structure (model A): pricing profiles per programme,
 * bank-funded-A worked examples, buyer-pays, revenue split in finance reports, maker-checker
 * on profile and split changes. Existing Phase 0 worked example stays on direct-legacy
 * (see worked-example.e2e.test.ts and buildWorld's default profile).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, startHarness } from './harness';
import { AT, buildWorld, eligibleInvoice, fund, LEDGER_ENV, seedFunding, World, WORKED } from './world';

let h: Harness; let w: World;
beforeAll(async () => {
  h = await startHarness(LEDGER_ENV);
  w = await buildWorld(h, { tag: 'pa', supplierLimitCents: 200_000_000n });
  await seedFunding(h, w, 1_000_000_000n, 'EQ-PA-0001');
});
afterAll(async () => { await h?.close(); });

const monthOf = (d: string) => d.slice(0, 7);

describe('D-82 bank-funded-A pricing (model A)', () => {
  it('a new programme defaults to bank-funded-A when no profile is sent', async () => {
    const p = await w.credit.post(`/organisations/${w.buyerId}/programme`, {
      limitCents: '100000000', advanceRateBps: 8000, startDate: WORKED.issueDate, reviewDate: WORKED.dueDate,
      decisionReason: 'Second proposed programme to check the default profile', governmentPayerDependent: false,
    });
    expect(p.programme.pricing_profile_code).toBe('bank-funded-A');
    expect(p.programme.processing_fee_payer).toBe('supplier');
    expect(p.programme.status).toBe('proposed');
  });

  it('changing a live programme to bank-funded-A is maker-checker (credit proposes, CEO approves)', async () => {
    const proposed = await w.credit.post(`/organisations/${w.buyerId}/programme/pricing-profile`, {
      pricingProfileCode: 'bank-funded-A', processingFeePayer: 'supplier', lenderDisplayName: 'KCB Bank Kenya',
    });
    expect((await w.credit.post(`/approvals/${proposed.id}/approve`, { reason: 'self' }, 403)).title).toBe('FOUR_EYES');
    await w.approve(proposed.id);
    const row = (await h.admin.query(`SELECT pricing_profile_code, processing_fee_payer, lender_display_name FROM mapema.buyer_programme WHERE buyer_id = $1 AND status = 'live'`, [w.buyerId])).rows[0];
    expect(row).toMatchObject({ pricing_profile_code: 'bank-funded-A', processing_fee_payer: 'supplier', lender_display_name: 'KCB Bank Kenya' });
  });

  it('KES 1,000,000 / 48 days quotes discount 19,200, processing 5,000, total 24,200, balance 175,800, bank as lender', async () => {
    h.clock.set(AT(WORKED.quoteDate));
    const invoiceId = await eligibleInvoice(h, w, { number: 'INV-PA-1M', amountCents: 100_000_000n, dueDate: WORKED.dueDate });
    const q = await w.supplier.post(`/invoices/${invoiceId}/quote`);
    expect(q).toMatchObject({
      currency: 'KES', invoiceAmountCents: '100000000', days: 48, advanceCents: '80000000',
      discountFeeCents: '1920000', processingFeeCents: '500000', verificationFeeCents: '500000',
      totalCostCents: '2420000', supplierBalanceCents: '17580000', aprBps: 2300,
      pricingProfileCode: 'bank-funded-A', billedBy: 'funding_bank', lenderDisplayName: 'KCB Bank Kenya',
    });
    const text = q.explanation.join(' ');
    expect(text).toMatch(/KCB Bank Kenya is the lender and charges these fees/i);
    expect(text).toMatch(/Mapema is the technology provider/i);
    expect(text).toMatch(/not yet licensed/i);
    expect(text).toMatch(/23\.00%/);
    expect(q.revenueSplit.mapemaVatCents).toBeTruthy();
    expect(q.revenueSplit.vatPendingCounsel).toBe(true);
    (globalThis as any).__inv1m = invoiceId;
  });

  it('KES 200,000 / 48 days quotes discount 3,840, processing 1,500, total 5,340', async () => {
    const invoiceId = await eligibleInvoice(h, w, { number: 'INV-PA-200K', amountCents: 20_000_000n, dueDate: WORKED.dueDate });
    const q = await w.supplier.post(`/invoices/${invoiceId}/quote`);
    expect(q).toMatchObject({
      discountFeeCents: '384000', processingFeeCents: '150000', totalCostCents: '534000', aprBps: 2538,
      pricingProfileCode: 'bank-funded-A',
    });
  });

  it('buyer-pays variant: the supplier pays only the 19,200 discount fee', async () => {
    const ch = await w.credit.post(`/organisations/${w.buyerId}/programme/pricing-profile`, {
      pricingProfileCode: 'bank-funded-A', processingFeePayer: 'buyer', lenderDisplayName: 'KCB Bank Kenya',
    });
    await w.approve(ch.id);
    const invoiceId = await eligibleInvoice(h, w, { number: 'INV-PA-BUYER', amountCents: 100_000_000n, dueDate: WORKED.dueDate });
    const q = await w.supplier.post(`/invoices/${invoiceId}/quote`);
    expect(q).toMatchObject({
      processingFeeCents: '500000', verificationFeeCents: '0', totalCostCents: '1920000',
      supplierBalanceCents: '18080000', aprBps: 1825, processingFeePayer: 'buyer',
    });
    expect(q.explanation.join(' ')).toMatch(/billed to your buyer/i);
    const back = await w.credit.post(`/organisations/${w.buyerId}/programme/pricing-profile`, {
      pricingProfileCode: 'bank-funded-A', processingFeePayer: 'supplier', lenderDisplayName: 'KCB Bank Kenya',
    });
    await w.approve(back.id);
  });

  it('funding and settlement of the 1,000,000 invoice: principal, then 5,000 fee, then 19,200 interest, balance 175,800', async () => {
    const invoiceId = (globalThis as any).__inv1m as string;
    const r = await fund(h, w, invoiceId);
    expect(r.release.status).toBe('funded');
    h.clock.set(AT(WORKED.dueDate));
    const res = await h.http.post('/v1/dev/bank/credit').send({
      accountNo: w.virtualAccount, amountCents: '100000000', bankRef: 'FT-PA-1M', valueDate: WORKED.dueDate,
      payerName: 'ACME SUPERMARKETS LIMITED', narrative: 'PAYMENT INV-PA-1M',
    }).expect(201);
    expect(res.body.status).toBe('applied');
    const alloc = (await h.admin.query(`SELECT principal_cents, fees_charges_cents, interest_cents, supplier_balance_cents FROM mapema.payment_allocation WHERE advance_id = $1`, [r.advanceId])).rows[0];
    expect(alloc).toEqual({ principal_cents: '80000000', fees_charges_cents: '500000', interest_cents: '1920000', supplier_balance_cents: '17580000' });
    (globalThis as any).__adv1m = r.advanceId;
  });

  it('month-end finance report shows the bank / Mapema split and a VAT 16% line pending counsel', async () => {
    const period = monthOf(WORKED.dueDate);
    const s = await w.compliance.post('/reports/snapshots', { period });
    const data = (await w.compliance.get(`/reports/snapshots/${s.id}`)).data;
    const row = data.loans.find((l: any) => l.invoiceNumber === 'INV-PA-1M');
    expect(row).toMatchObject({ pricingProfileCode: 'bank-funded-A', billedBy: 'funding_bank', principalCents: '80000000', discountFeeCents: '1920000' });
    expect(row.revenueSplitInMonth.vatPendingCounsel).toBe(true);
    expect(data.aggregates.incomeInMonth.vatPendingCounsel).toBe(true);
    expect(BigInt(data.aggregates.incomeInMonth.bankShareCents)).toBe(BigInt(row.revenueSplitInMonth.bankShareCents));
    expect(BigInt(data.aggregates.incomeInMonth.mapemaPlatformFeeCents)).toBe(BigInt(row.revenueSplitInMonth.mapemaPlatformFeeCents));
    expect(BigInt(data.aggregates.incomeInMonth.mapemaVatCents)).toBeGreaterThan(0n);
    // D-11 cent rounding: bank 14,200.11 and Mapema 9,999.89 on the worked example
    expect(row.revenueSplitInMonth.bankShareCents).toBe('1420011');
    expect(row.revenueSplitInMonth.mapemaPlatformFeeCents).toBe('999989');
  });

  it('revenue-split and excise flags are maker-checker; excise defaults off and is labelled pending counsel', async () => {
    const cur = await w.admin.get('/admin/revenue-split');
    expect(cur).toMatchObject({ cost_of_funds_annual_ppm: 87450, bank_margin_share_bps: 5000, vat_rate_bps: 1600, vat_pending_counsel: true, excise_on_processing_fee: false, excise_pending_counsel: true });
    const proposed = await w.admin.post('/admin/revenue-split', {
      costOfFundsAnnualPpm: 87450, bankMarginShareBps: 7000, vatRateBps: 1600, vatPendingCounsel: true,
      exciseOnProcessingFee: false, exciseRateBps: 2000, excisePendingCounsel: true,
    });
    expect((await w.admin.post(`/approvals/${proposed.id}/approve`, { reason: 'self' }, 403)).title).toBe('FOUR_EYES');
    await w.approve(proposed.id);
    const after = await w.admin.get('/admin/revenue-split');
    expect(after.bank_margin_share_bps).toBe(7000);
    expect(after.excise_on_processing_fee).toBe(false);
  });

  it('public fee-quote without a profile keeps the active (legacy) worked example; profile=bank-funded-A returns the new numbers', async () => {
    const legacy = await h.http.post('/v1/public/fee-quote').send({ invoiceAmountCents: '100000000', days: 48 }).expect(201);
    expect(legacy.body).toMatchObject({ advanceCents: '80000000', discountFeeCents: '4480000', verificationFeeCents: '250000', supplierBalanceCents: '15270000' });
    const bank = await h.http.post('/v1/public/fee-quote').send({ invoiceAmountCents: '100000000', days: 48, profileCode: 'bank-funded-A' }).expect(201);
    expect(bank.body).toMatchObject({ discountFeeCents: '1920000', processingFeeCents: '500000', totalCostCents: '2420000', supplierBalanceCents: '17580000', billedBy: 'funding_bank' });
    expect(bank.body.explanation).toMatch(/not yet licensed/i);
  });
});
