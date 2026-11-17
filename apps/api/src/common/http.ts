/** [Backend Engineer] Request validation helpers (zod) shared by controllers. */
import { z } from 'zod';
import { assertIsoDate, parseCents } from '@mapema/pricing';

export const zUuid = z.string().uuid();
export const zDate = z.string().refine((d) => {
  try { assertIsoDate(d); return true; } catch { return false; }
}, 'must be a real ISO date YYYY-MM-DD');
export const zCents = z.union([z.number(), z.string()]).transform((v, ctx) => {
  try { return parseCents(v); } catch (e) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message }); return z.NEVER; }
});
export const zPositiveCents = zCents.refine((v) => v > 0n, 'must be greater than zero');
export const zKes = z.literal('KES', { errorMap: () => ({ message: 'Only KES is supported' }) });
export const zKraPin = z.string().trim().toUpperCase().regex(/^[A-Z][0-9]{9}[A-Z]$/, 'KRA PIN format is A123456789B');
export const zPhoneKe = z.string().regex(/^\+254[17]\d{8}$/, 'Kenyan number in +2547XXXXXXXX format');
export const zText = (max = 500) => z.string().trim().min(1).max(max);

/** BigInt-safe JSON: integers within 2^53 as numbers, larger as strings. */
export function jsonReplacer(_k: string, v: unknown) {
  if (typeof v === 'bigint') return v.toString(); // money is always a decimal string of integer cents (same as int8 columns)
  return v;
}
