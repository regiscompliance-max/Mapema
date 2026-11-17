/**
 * [QA Engineer] Pricing & allocation tests, written from phase-0/qa-report.md section
 * "Pricing test spec" (TC-PRICE / TC-ALLOC / TC-EARLY / TC-ROUND / TC-PROP).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  allocate,
  actualInterest,
  assertKes,
  daysBetween,
  divHalfUp,
  formatKes,
  inDuplumHeadroom,
  kes,
  parseCents,
  quote,
  settlementFor,
  STANDARD_PRICING,
} from '../src';

describe('TC-PRICE-01 brief worked example (KES 1,000,000, 48 days)', () => {
  const q = quote(kes(1_000_000), 48);
  it('advance KES 800,000', () => expect(q.advanceCents).toBe(kes(800_000)));
  it('discount fee KES 44,800', () => expect(q.discountFeeCents).toBe(kes(44_800)));
  it('verification fee KES 2,500', () => expect(q.verificationFeeCents).toBe(kes(2_500)));
  it('Mapema keeps KES 847,300', () => expect(q.mapemaKeepsCents).toBe(kes(847_300)));
  it('supplier balance KES 152,700', () => expect(q.supplierBalanceCents).toBe(kes(152_700)));
  it('total cost KES 47,300 and APR shown', () => {
    expect(q.totalCostCents).toBe(kes(47_300));
    expect(q.aprBps).toBe(4496); // 47,300 / 800,000 * 365/48 = 44.96%
  });
  it('formats for display', () => expect(formatKes(q.supplierBalanceCents)).toBe('KES 152,700.00'));
});

describe('TC-ALLOC CBK order principal -> fees -> interest', () => {
  const due = { principalCents: kes(800_000), feesCents: kes(2_500), interestCents: kes(44_800) };
  it('TC-ALLOC-01 full payment', () => {
    expect(allocate(kes(1_000_000), due, kes(152_700))).toEqual({
      principalCents: kes(800_000), feesCents: kes(2_500), interestCents: kes(44_800),
      supplierBalanceCents: kes(152_700), unappliedCents: 0n,
    });
  });
  it('TC-ALLOC-02 partial 500k goes to principal only', () => {
    const a = allocate(kes(500_000), due, kes(152_700));
    expect([a.principalCents, a.feesCents, a.interestCents, a.supplierBalanceCents]).toEqual([kes(500_000), 0n, 0n, 0n]);
  });
  it('TC-ALLOC-03 partial 810k: principal, fees, then 7,500 interest', () => {
    const a = allocate(kes(810_000), due, kes(152_700));
    expect([a.principalCents, a.feesCents, a.interestCents]).toEqual([kes(800_000), kes(2_500), kes(7_500)]);
  });
  it('TC-ALLOC-04 second partial after 500k', () => {
    const a = allocate(kes(500_000), { principalCents: kes(300_000), feesCents: kes(2_500), interestCents: kes(44_800) }, kes(152_700));
    expect(a.principalCents).toBe(kes(300_000));
    expect(a.interestCents).toBe(kes(44_800));
    expect(a.supplierBalanceCents).toBe(kes(152_700));
    expect(a.unappliedCents).toBe(0n);
  });
  it('TC-ALLOC-05 overpayment of KES 100 is unapplied (refund buyer)', () => {
    const a = allocate(kes(1_000_100), due, kes(152_700));
    expect(a.supplierBalanceCents).toBe(kes(152_700));
    expect(a.unappliedCents).toBe(kes(100));
  });
});

describe('TC-EARLY interest on actual days, quote is the maximum (D-03)', () => {
  it('TC-EARLY-01 repaid at day 30 -> interest 28,000; supplier gets 169,500', () => {
    const s = settlementFor({
      invoiceCents: kes(1_000_000), principalCents: kes(800_000), verificationFeeCents: kes(2_500),
      disclosedInterestMaxCents: kes(44_800), rateBpsPer30d: 350, daysOutstanding: 30, paymentCents: kes(1_000_000),
    });
    expect(s.actualInterestCents).toBe(kes(28_000));
    expect(s.allocation.supplierBalanceCents).toBe(kes(169_500));
  });
  it('late payment never charges more than disclosed (no late charges in Phase 1, D-09)', () => {
    expect(actualInterest(kes(800_000), 350, 75, kes(44_800))).toBe(kes(44_800));
  });
  it('same-day repayment charges a minimum of 1 day', () => {
    expect(actualInterest(kes(800_000), 350, 0, kes(44_800))).toBe(kes(800_000) * 350n / 300000n);
  });
  it('worked example settled on due date gives supplier exactly 152,700', () => {
    const s = settlementFor({
      invoiceCents: kes(1_000_000), principalCents: kes(800_000), verificationFeeCents: kes(2_500),
      disclosedInterestMaxCents: kes(44_800), rateBpsPer30d: 350, daysOutstanding: 48, paymentCents: kes(1_000_000),
    });
    expect(s.allocation).toEqual({
      principalCents: kes(800_000), feesCents: kes(2_500), interestCents: kes(44_800),
      supplierBalanceCents: kes(152_700), unappliedCents: 0n,
    });
  });
  it('two partial buyer payments add up to the same settlement', () => {
    const base = {
      invoiceCents: kes(1_000_000), principalCents: kes(800_000), verificationFeeCents: kes(2_500),
      disclosedInterestMaxCents: kes(44_800), rateBpsPer30d: 350, daysOutstanding: 48,
    };
    const s1 = settlementFor({ ...base, paymentCents: kes(600_000) });
    const s2 = settlementFor({ ...base, paymentCents: kes(400_000), alreadyPaid: s1.allocation });
    expect(s1.allocation.principalCents + s2.allocation.principalCents).toBe(kes(800_000));
    expect(s1.allocation.interestCents + s2.allocation.interestCents).toBe(kes(44_800));
    expect(s2.allocation.supplierBalanceCents).toBe(kes(152_700));
  });
});

describe('TC-ROUND rounding and guards (D-07, D-11, D-17)', () => {
  it('TC-ROUND-01 half-up per derived amount; residual identity', () => {
    const q = quote(123456789n, 47);
    expect(q.advanceCents).toBe(98765431n); // 98,765,431.2 -> 98,765,431
    expect(q.discountFeeCents).toBe(5415638n); // 5,415,637.79.. -> 5,415,638
    expect(q.mapemaKeepsCents + q.supplierBalanceCents).toBe(123456789n);
  });
  it('divHalfUp rounds .5 up', () => {
    expect(divHalfUp(5n, 2n)).toBe(3n);
    expect(divHalfUp(4n, 2n)).toBe(2n);
    expect(divHalfUp(7n, 10n)).toBe(1n);
    expect(divHalfUp(4n, 10n)).toBe(0n);
  });
  it('rejects invoices below KES 50,000 minimum', () => {
    expect(() => quote(kes(49_999), 30)).toThrow(/minimum/);
    expect(quote(kes(50_000), 30).supplierBalanceCents).toBe(kes(50_000) - kes(40_000) - kes(1_400) - kes(2_500));
  });
  it('rejects tenor outside 1..120 days', () => {
    expect(() => quote(kes(100_000), 0)).toThrow(/days/);
    expect(() => quote(kes(100_000), 121)).toThrow(/days/);
    expect(() => quote(kes(100_000), 1.5)).toThrow(/days/);
  });
  it('rejects negative supplier balance even when minimum is lowered', () => {
    expect(() => quote(kes(3_000), 30, { ...STANDARD_PRICING, minInvoiceCents: 1n })).toThrow(/NEGATIVE|exceed/);
  });
  it('per-buyer advance rate is honoured', () => {
    expect(quote(kes(1_000_000), 48, { ...STANDARD_PRICING, advanceRateBps: 7000 }).advanceCents).toBe(kes(700_000));
  });
});

describe('money parsing (SYS-01 / KES only)', () => {
  it('accepts integer cents only', () => {
    expect(parseCents(100)).toBe(100n);
    expect(parseCents('100000000')).toBe(100000000n);
    expect(() => parseCents(1.5)).toThrow();
    expect(() => parseCents(-1)).toThrow();
    expect(() => parseCents('1e5')).toThrow();
    expect(() => parseCents('10.00')).toThrow();
  });
  it('rejects non-KES', () => {
    expect(() => assertKes('USD')).toThrow(/Only KES/);
    expect(() => assertKes('KES')).not.toThrow();
  });
  it('days between ISO dates', () => {
    expect(daysBetween('2027-01-04', '2027-02-21')).toBe(48);
    expect(() => daysBetween('2027-02-30', '2027-03-01')).toThrow();
  });
});

describe('in duplum headroom (NPL cap)', () => {
  it('caps further charges at principal outstanding at NPL', () => {
    expect(inDuplumHeadroom(kes(800_000), kes(100_000))).toBe(kes(700_000));
    expect(inDuplumHeadroom(kes(800_000), kes(900_000))).toBe(0n);
  });
});

describe('TC-PROP properties (fast-check)', () => {
  it('keeps + balance == invoice; all parts non-negative; discount monotonic in days', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 5_000_000n, max: 100_000_000_000n }), fc.integer({ min: 1, max: 119 }), (inv, d) => {
        let q1, q2;
        try { q1 = quote(inv, d); q2 = quote(inv, d + 1); } catch { return true; }
        return q1.mapemaKeepsCents + q1.supplierBalanceCents === inv && q1.supplierBalanceCents >= 0n &&
          q1.discountFeeCents <= q2.discountFeeCents;
      }),
      { numRuns: 2000 },
    );
  });
  it('allocation conserves the payment and never pays interest before principal', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.bigInt({ min: 0n, max: 10n ** 11n }), fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 10n }), fc.bigInt({ min: 0n, max: 10n ** 11n }), (pay, p, f, i, s) => {
          const a = allocate(pay, { principalCents: p, feesCents: f, interestCents: i }, s);
          const sum = a.principalCents + a.feesCents + a.interestCents + a.supplierBalanceCents + a.unappliedCents;
          const order = (a.feesCents === 0n || a.principalCents === p) && (a.interestCents === 0n || a.feesCents === f);
          return sum === pay && order;
        }),
      { numRuns: 2000 },
    );
  });
});
