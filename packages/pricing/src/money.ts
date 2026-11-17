/**
 * [Backend Engineer] Money primitives. All money is KES integer cents held as BigInt.
 * Floating point is never used for money anywhere in Mapema (SYS-01).
 */
export type Cents = bigint;
export const CURRENCY = 'KES' as const;

export class MoneyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Round a non-negative rational n/d half-up to an integer. */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new MoneyError('BAD_DIVISOR', 'divisor must be positive');
  if (n < 0n) throw new MoneyError('NEGATIVE', 'divHalfUp only accepts non-negative numerators');
  return (n * 2n + d) / (2n * d);
}

/** Reject anything that is not KES (brief: "KES only: reject any non-KES amount at the API"). */
export function assertKes(currency: string | undefined | null): asserts currency is 'KES' {
  if (currency !== CURRENCY) {
    throw new MoneyError('CURRENCY_NOT_SUPPORTED', `Only KES is supported (got ${String(currency)})`);
  }
}

/**
 * Parse an API cents value. Accepts a JSON integer or a decimal-digit string.
 * Rejects floats, negatives, exponents and anything above 2^53 when passed as number.
 */
export function parseCents(v: unknown, field = 'amount'): Cents {
  if (typeof v === 'bigint') {
    if (v < 0n) throw new MoneyError('NEGATIVE_AMOUNT', `${field} must be >= 0`);
    return v;
  }
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new MoneyError('NOT_INTEGER_CENTS', `${field} must be integer cents`);
    if (v < 0) throw new MoneyError('NEGATIVE_AMOUNT', `${field} must be >= 0`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^[0-9]{1,18}$/.test(v)) return BigInt(v);
  throw new MoneyError('NOT_INTEGER_CENTS', `${field} must be integer cents`);
}

/** "KES 1,234,567.89" (display only). */
export function formatKes(c: Cents): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}KES ${whole}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** Whole shillings to cents. */
export const kes = (shillings: number | bigint): Cents => BigInt(shillings) * 100n;
