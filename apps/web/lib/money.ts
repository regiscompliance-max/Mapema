/** Display helpers. All arithmetic stays in integer cents (bigint) via @mapema/pricing. */
import { formatKes } from '@mapema/pricing';

export const kesFromCents = (c: string | number | bigint | null | undefined) => (c === null || c === undefined || c === '' ? '-' : formatKes(BigInt(c)));

/** "1,000,000.50" -> 100000050n. Rejects anything that is not a plain KES amount with at most 2 decimals. */
export function parseKesInput(s: string): bigint | null {
  const t = s.replace(/[,\s]/g, '').replace(/^KES/i, '');
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
}
export const bps = (b: number) => `${(b / 100).toFixed(2)}%`;
