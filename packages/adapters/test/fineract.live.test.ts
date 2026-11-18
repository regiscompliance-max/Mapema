/**
 * [QA Engineer] FINERACT PROOF TEST (phase-0 qa-report TC-FIN-01..05) against a REAL Apache
 * Fineract (1.16.1 used in Phase 1 build). Run: FINERACT_BASE_URL=... npm run test:fineract
 * Proves: interest exactly KES 44,800 for the worked example; principal-first CBK allocation
 * on full and partial payments; interest on actual days for early settlement (D-03); journal
 * balances for the trial balance / reconciliation.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, kes, quote, todayEAT } from '@mapema/pricing';
import { FineractLedger } from '../src';

const cfg = {
  baseUrl: process.env.FINERACT_BASE_URL ?? 'http://localhost:8443/fineract-provider/api/v1',
  tenant: process.env.FINERACT_TENANT ?? 'default',
  username: process.env.FINERACT_USERNAME ?? 'mifos',
  password: process.env.FINERACT_PASSWORD ?? 'password',
};
const ledger = new FineractLedger(cfg);
const ctx = { requestId: 'fineract-proof' };
const run = `${Date.now()}`;
const disb = addDays(todayEAT(), -60); // Fineract rejects future-dated transactions
const due = addDays(disb, 48);
let clientId: number;

async function newAdvance(tag: string) {
  const q = quote(kes(1_000_000), 48);
  return ledger.bookAdvance(ctx, {
    externalId: `proof-${run}-${tag}`, clientId, principalCents: q.advanceCents, rateBpsPer30d: 350, days: 48,
    disbursementDate: disb, dueDate: due, verificationFeeCents: q.verificationFeeCents,
  });
}

describe('Fineract proof (real Fineract)', () => {
  beforeAll(async () => {
    const h = await ledger.health();
    if (!h.ok) throw new Error(`Fineract not reachable at ${cfg.baseUrl}: ${h.detail}`);
    await ledger.ensureSetup();
    clientId = await ledger.createClient(ctx, { externalId: `proof-sup-${run}`, legalName: `Proof Supplier ${run}`, activationDate: addDays(disb, -1) });
  }, 60000);

  it('TC-FIN-01 worked example books exactly 44,800 interest and 2,500 fee; total 847,300', async () => {
    const { loanId, scheduledInterestCents } = await newAdvance('a');
    expect(scheduledInterestCents).toBe(kes(44_800));
    const l = await ledger.getLoan(loanId);
    expect(l.principalOutstandingCents).toBe(kes(800_000));
    expect(l.feesOutstandingCents).toBe(kes(2_500));
    expect(l.totalOutstandingCents).toBe(kes(847_300));
  });

  it('TC-FIN-02 full payment on due date allocates principal -> fees -> interest and closes', async () => {
    const { loanId } = await newAdvance('b');
    const r = await ledger.repay(ctx, loanId, kes(847_300), due, `proof-${run}-b-pay`);
    expect([r.principalCents, r.feesCents, r.interestCents, r.overpaymentCents]).toEqual([kes(800_000), kes(2_500), kes(44_800), 0n]);
    expect((await ledger.getLoan(loanId)).status).toBe('closed');
  });

  it('TC-FIN-03 partial payments follow CBK order (500k -> principal; 310k -> 300k P, 2.5k F, 7.5k I)', async () => {
    const { loanId } = await newAdvance('c');
    const r1 = await ledger.repay(ctx, loanId, kes(500_000), due, `proof-${run}-c-1`);
    expect([r1.principalCents, r1.feesCents, r1.interestCents]).toEqual([kes(500_000), 0n, 0n]);
    const r2 = await ledger.repay(ctx, loanId, kes(310_000), due, `proof-${run}-c-2`);
    expect([r2.principalCents, r2.feesCents, r2.interestCents]).toEqual([kes(300_000), kes(2_500), kes(7_500)]);
    const r3 = await ledger.repay(ctx, loanId, kes(37_300), due, `proof-${run}-c-3`);
    expect(r3.interestCents).toBe(kes(37_300));
    expect((await ledger.getLoan(loanId)).status).toBe('closed');
  });

  it('TC-FIN-04 early settlement at day 30 charges interest on actual days only (28,000)', async () => {
    const { loanId } = await newAdvance('d');
    const day30 = addDays(disb, 30);
    const payoff = await ledger.payoffQuote(loanId, day30);
    expect(payoff).toEqual({ totalCents: kes(830_500), principalCents: kes(800_000), feesCents: kes(2_500), interestCents: kes(28_000) });
    const r = await ledger.repay(ctx, loanId, payoff.totalCents, day30, `proof-${run}-d-pay`);
    expect([r.principalCents, r.feesCents, r.interestCents]).toEqual([kes(800_000), kes(2_500), kes(28_000)]);
    const l = await ledger.getLoan(loanId);
    expect(l.status).toBe('closed');
    expect(l.interestChargedCents).toBe(kes(28_000));
  });

  it('TC-FIN-05 idempotent booking: same advance externalId returns the same loan', async () => {
    const a = await newAdvance('e');
    const b = await newAdvance('e');
    expect(b.loanId).toBe(a.loanId);
  });

  it('TC-FIN-06 journals: disbursement and repayment hit the bank GL; supplier deferred price journal works', async () => {
    const before = await ledger.glBalance('bank');
    const { loanId } = await newAdvance('f');
    expect(await ledger.glBalance('bank')).toBe(before - kes(800_000));
    await ledger.repay(ctx, loanId, kes(847_300), due, `proof-${run}-f-pay`);
    await ledger.postJournal(ctx, { date: due, debit: 'bank', credit: 'supplierPayable', amountCents: kes(152_700), reference: `proof-${run}-f-bal`, note: 'buyer paid supplier balance portion' });
    expect(await ledger.glBalance('bank')).toBe(before + kes(47_300) + kes(152_700));
    const tb = await ledger.trialBalance();
    const sum = Object.values(tb).reduce((a, b) => a + b, 0n);
    expect(sum).toBe(0n); // double entry: debits == credits
  }, 60000);
});

describe('Fineract funding tags (Phase 3 TC-P3U-FUND-04, real Fineract)', () => {
  it('ensureFund is idempotent; the native fund is set at booking; the current tag lives in a loan datatable and can be re-tagged', async () => {
    const fa = await ledger.ensureFund('P3-FAC-A', 'Debt facility A (test)');
    expect(await ledger.ensureFund('P3-FAC-A', 'Debt facility A (test)')).toBe(fa);
    const eq = await ledger.ensureFund('P3-EQUITY', 'Equity (test)');
    expect(eq).not.toBe(fa);
    const q = quote(kes(1_000_000), 48);
    const { loanId } = await ledger.bookAdvance(ctx, {
      externalId: `proof-${run}-fund`, clientId, principalCents: q.advanceCents, rateBpsPer30d: 350, days: 48,
      disbursementDate: disb, dueDate: due, verificationFeeCents: q.verificationFeeCents, fundId: fa,
    });
    await ledger.setFundingTag(loanId, 'P3-FAC-A', disb);
    expect(await ledger.getFundingTag(loanId)).toEqual({ fundId: fa, tagCode: 'P3-FAC-A' });
    await ledger.setFundingTag(loanId, 'P3-EQUITY', addDays(disb, 5));
    expect(await ledger.getFundingTag(loanId)).toEqual({ fundId: fa, tagCode: 'P3-EQUITY' }); // fund at origination is immutable once active; the tag moves
    expect((await ledger.getLoan(loanId)).interestChargedCents).toBe(kes(44_800)); // money unchanged
  }, 60000);
});
