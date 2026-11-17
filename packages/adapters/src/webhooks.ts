/**
 * [Security Engineer] Inbound webhook verification shared by all providers that sign callbacks:
 * HMAC-SHA256 over `${timestamp}.${rawBody}`, hex, constant-time compare, 5-minute replay window.
 * Each provider adapter maps its own header names onto this.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyWebhook(
  secret: string,
  timestamp: string | undefined,
  rawBody: string,
  signature: string | undefined,
  now = Date.now(),
  toleranceSec = 300,
): boolean {
  if (!secret || !timestamp || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), 'hex');
  const got = Buffer.from(signature, 'hex');
  return expected.length === got.length && timingSafeEqual(expected, got);
}
