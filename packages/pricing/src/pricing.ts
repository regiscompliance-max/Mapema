/**
 * [Backend Engineer + Compliance & Risk Analyst] Mapema pricing engine.
 *
 * Brief pricing rules: advance 80% of invoice (configurable per buyer, never above the
 * pricing version), discount fee 3.5% per 30 days on the amount advanced pro-rated by days,
 * verification fee KES 2,500 per invoice, KES only.
 *
 * CEO-approved decisions applied here (phase-0/README.md decisions log):
 *  D-03  discount fee is INTEREST charged on actual days outstanding; the quote is the maximum.
 *  D-07  minimum invoice KES 50,000 (configurable); quotes with a negative supplier balance rejected.
 *  D-11  integer cents; half-up to the cent once per derived amount; supplier balance is the residual.
 *  D-17  tenor 1-120 days.
 */
import { Cents, divHalfUp, MoneyError } from './money';

export interface PricingParams {
  advanceRateBps: number; // 8000 = 80.00%
  discountRateBpsPer30d: number; // 350 = 3.50% per 30 days
  verificationFeeCents: Cents; // 250000 = KES 2,500.00
  minDays: number; // 1
  maxDays: number; // 120
  minInvoiceCents: Cents; // 5000000 = KES 50,000.00
}

export const STANDARD_PRICING: PricingParams = Object.freeze({
  advanceRateBps: 8000,
  discountRateBpsPer30d: 350,
  verificationFeeCents: 250000n,
  minDays: 1,
  maxDays: 120,
  minInvoiceCents: 5000000n,
});

export interface Quote {
  invoiceCents: Cents;
  days: number;
  advanceRateBps: number;
  discountRateBpsPer30d: number;
  advanceCents: Cents;
  discountFeeCents: Cents; // maximum interest
  verificationFeeCents: Cents;
  totalCostCents: Cents;
  mapemaKeepsCents: Cents;
  supplierBalanceCents: Cents;
  aprBps: number; // simple annualised cost (display only)
}

export class PricingError extends MoneyError {}

function checkBps(v: number, field: string) {
  if (!Number.isInteger(v) || v < 0 || v > 10000) throw new PricingError('BAD_RATE', `${field} must be integer bps 0..10000`);
}

/** Interest for `days` on `principal` at `rateBpsPer30d`, half-up to the cent. */
export function interestForDays(principalCents: Cents, rateBpsPer30d: number, days: number): Cents {
  checkBps(rateBpsPer30d, 'rate');
  if (!Number.isInteger(days) || days < 0) throw new PricingError('BAD_DAYS', 'days must be a non-negative integer');
  return divHalfUp(principalCents * BigInt(rateBpsPer30d) * BigInt(days), 10000n * 30n);
}

export function quote(invoiceCents: Cents, days: number, p: PricingParams = STANDARD_PRICING): Quote {
  checkBps(p.advanceRateBps, 'advanceRateBps');
  checkBps(p.discountRateBpsPer30d, 'discountRateBpsPer30d');
  if (typeof invoiceCents !== 'bigint' || invoiceCents <= 0n) throw new PricingError('BAD_AMOUNT', 'invoice amount must be > 0 cents');
  if (invoiceCents < p.minInvoiceCents) {
    throw new PricingError('BELOW_MINIMUM_INVOICE', `invoice is below the minimum of ${p.minInvoiceCents} cents`);
  }
  if (!Number.isInteger(days) || days < p.minDays || days > p.maxDays) {
    throw new PricingError('TENOR_OUT_OF_RANGE', `days to due date must be ${p.minDays}..${p.maxDays}`);
  }
  const advanceCents = divHalfUp(invoiceCents * BigInt(p.advanceRateBps), 10000n);
  if (advanceCents <= 0n) throw new PricingError('BAD_AMOUNT', 'advance would be zero');
  const discountFeeCents = interestForDays(advanceCents, p.discountRateBpsPer30d, days);
  const verificationFeeCents = p.verificationFeeCents;
  const totalCostCents = discountFeeCents + verificationFeeCents;
  const mapemaKeepsCents = advanceCents + totalCostCents;
  const supplierBalanceCents = invoiceCents - mapemaKeepsCents;
  if (supplierBalanceCents < 0n) throw new PricingError('NEGATIVE_SUPPLIER_BALANCE', 'fees exceed the invoice remainder');
  // In duplum at origination: the total cost of credit may never exceed the principal, so with no
  // late charges (D-09) recoveries can never pass the NPL cap (C-07; counsel to confirm the cap wording).
  if (totalCostCents > advanceCents) throw new PricingError('IN_DUPLUM', 'interest and fees would exceed the amount advanced');
  const aprBps = Number(divHalfUp(totalCostCents * 365n * 10000n, advanceCents * BigInt(days)));
  return {
    invoiceCents,
    days,
    advanceRateBps: p.advanceRateBps,
    discountRateBpsPer30d: p.discountRateBpsPer30d,
    advanceCents,
    discountFeeCents,
    verificationFeeCents,
    totalCostCents,
    mapemaKeepsCents,
    supplierBalanceCents,
    aprBps,
  };
}

/**
 * Actual interest at settlement (D-03): interest on days actually outstanding, never more
 * than the disclosed maximum. Minimum charge is 1 day once funds were disbursed.
 */
export function actualInterest(
  principalCents: Cents,
  rateBpsPer30d: number,
  daysOutstanding: number,
  disclosedMaxCents: Cents,
): Cents {
  const d = Math.max(1, daysOutstanding);
  const i = interestForDays(principalCents, rateBpsPer30d, d);
  return i < disclosedMaxCents ? i : disclosedMaxCents;
}

export interface Dues {
  principalCents: Cents;
  feesCents: Cents;
  interestCents: Cents;
}

export interface Allocation {
  principalCents: Cents;
  feesCents: Cents;
  interestCents: Cents;
  supplierBalanceCents: Cents;
  unappliedCents: Cents;
}

/**
 * CBK repayment order (brief + Regulations): (1) principal, (2) fees and charges, (3) interest,
 * on every payment including partials. Anything left goes to the supplier's deferred price
 * (D-01) up to what is still owed to them; the remainder is unapplied (refund to buyer).
 */
export function allocate(paymentCents: Cents, dues: Dues, supplierBalanceOwedCents: Cents): Allocation {
  if (paymentCents < 0n) throw new PricingError('NEGATIVE_AMOUNT', 'payment must be >= 0');
  let left = paymentCents;
  const take = (owed: Cents): Cents => {
    if (owed < 0n) throw new PricingError('NEGATIVE_AMOUNT', 'owed must be >= 0');
    const x = left < owed ? left : owed;
    left -= x;
    return x;
  };
  const principalCents = take(dues.principalCents);
  const feesCents = take(dues.feesCents);
  const interestCents = take(dues.interestCents);
  const supplierBalanceCents = take(supplierBalanceOwedCents);
  return { principalCents, feesCents, interestCents, supplierBalanceCents, unappliedCents: left };
}

/**
 * Settlement of one funded invoice paid by the buyer.
 * supplierBalanceOwed = invoice - (principal + verification fee + actual interest).
 */
export function settlementFor(args: {
  invoiceCents: Cents;
  principalCents: Cents;
  verificationFeeCents: Cents;
  disclosedInterestMaxCents: Cents;
  rateBpsPer30d: number;
  daysOutstanding: number;
  paymentCents: Cents;
  alreadyPaid?: Dues & { supplierBalanceCents: Cents };
}) {
  const interest = actualInterest(args.principalCents, args.rateBpsPer30d, args.daysOutstanding, args.disclosedInterestMaxCents);
  const paid = args.alreadyPaid ?? { principalCents: 0n, feesCents: 0n, interestCents: 0n, supplierBalanceCents: 0n };
  const dues: Dues = {
    principalCents: args.principalCents - paid.principalCents,
    feesCents: args.verificationFeeCents - paid.feesCents,
    interestCents: interest - paid.interestCents,
  };
  const supplierOwedTotal = args.invoiceCents - (args.principalCents + args.verificationFeeCents + interest);
  const supplierOwed = supplierOwedTotal - paid.supplierBalanceCents;
  if (supplierOwed < 0n) throw new PricingError('NEGATIVE_SUPPLIER_BALANCE', 'supplier balance negative');
  const allocation = allocate(args.paymentCents, dues, supplierOwed);
  return { actualInterestCents: interest, dues, supplierOwedCents: supplierOwed, allocation };
}

/**
 * Non-performing loans (in duplum, Banking Act s.44A style as carried into the NDTCP
 * Regulations - counsel to confirm wording): once a loan is non-performing, interest and
 * charges recoverable may not exceed the principal outstanding when it became non-performing.
 * Returns the amount of additional charges that may still be accrued.
 */
export function inDuplumHeadroom(principalAtNplCents: Cents, chargesAndInterestSinceNplCents: Cents): Cents {
  const h = principalAtNplCents - chargesAndInterestSinceNplCents;
  return h > 0n ? h : 0n;
}

/**
 * Days past due after which an advance is non-performing (C-07, per law-firm commentary on the
 * NDTCP Regulations 2026: 30 days for loans of up to 30 days, otherwise 90 days, unless the
 * agreement sets a default period). Counsel to confirm against the gazetted text.
 */
export function nplDaysFor(termDays: number): number {
  return termDays <= 30 ? 30 : 90;
}
