/**
 * [Integration Engineer] Common adapter contract (phase-0/integration-contracts.md section 1).
 * Every provider sits behind an adapter with modes:
 *   mock    - deterministic in-memory test double with documented magic values (tests, local dev)
 *   sandbox - the provider's sandbox/UAT endpoint (needs provider credentials)
 *   live    - production endpoint (production only)
 */
export type AdapterMode = 'mock' | 'sandbox' | 'live';

export interface AdapterContext {
  requestId: string;
  idempotencyKey?: string;
  actorUserId?: string;
}

export class AdapterError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly httpStatus?: number,
  ) {
    super(`[${provider}] ${code}: ${message}`);
    this.name = 'AdapterError';
  }
}

export interface HealthCheck {
  provider: string;
  mode: AdapterMode;
  ok: boolean;
  detail?: string;
}

/** Provider chosen commercially later: sandbox/live calls fail fast with a clear error. */
export function notConfigured(provider: string, mode: AdapterMode): never {
  throw new AdapterError(
    provider,
    'PROVIDER_NOT_CONFIGURED',
    `${mode} mode needs a contracted provider and credentials; only mock mode is available in Phase 1 build`,
  );
}

/** cents -> "800000.00" (exact, for decimal-string provider APIs). */
export function centsToDecimal(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** provider decimal (number or string, up to 2dp) -> cents, exactly. */
export function decimalToCents(v: number | string | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  const s = typeof v === 'number' ? v.toFixed(2) : v.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(s);
  if (!m) throw new AdapterError('money', 'BAD_DECIMAL', `cannot parse amount ${String(v)}`);
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? '0').padEnd(2, '0'));
  return m[1] === '-' ? -cents : cents;
}

export function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
