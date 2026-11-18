/**
 * [DevOps] Typed configuration from environment variables. See /.env.example for the full list.
 * No secret has a default outside development/test.
 */
import { z } from 'zod';
import { ipAllowList } from './redact';

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  OIDC_ISSUER: z.string().default('http://localhost:4000/dev-idp'),
  OIDC_AUDIENCE: z.string().default('mapema-api'),
  OIDC_JWKS_URL: z.string().optional(),
  DEV_IDP_ENABLED: z.enum(['true', 'false']).default('false'),
  PII_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'PII_ENCRYPTION_KEY must be 32 bytes hex'),
  PII_BLIND_INDEX_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'PII_BLIND_INDEX_KEY must be 32 bytes hex'),
  STORAGE_DIR: z.string().default('./storage-local'),
  STORAGE_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  BANK_WEBHOOK_SECRET: z.string().min(16),
  ESIGN_WEBHOOK_SECRET: z.string().min(16),
  STEP_UP_MAX_AGE_SEC: z.coerce.number().int().default(300),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(15),
  KYC_REFRESH_MONTHS: z.coerce.number().int().min(1).max(60).default(12),
  RATE_LIMIT_STORE: z.enum(['postgres', 'memory']).default('postgres'),
  SESSION_MAX_HOURS: z.coerce.number().int().min(1).default(8),
  INVITE_TTL_HOURS: z.coerce.number().int().default(72),
  QUOTE_TTL_MINUTES: z.coerce.number().int().default(30),
  BANK_ACCOUNT_COOLING_OFF_HOURS: z.coerce.number().int().default(24),
});

export type AppConfig = z.infer<typeof schema> & { raw: Record<string, string | undefined> };

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.DEV_IDP_ENABLED === 'true') {
    throw new Error('DEV_IDP_ENABLED must be false in production');
  }
  // go-live hardening: fail at start-up, not at the first request
  const deployed = parsed.data.APP_ENV === 'staging' || parsed.data.APP_ENV === 'production';
  if (deployed) {
    if (!/^https:\/\//.test(env.OIDC_REDIRECT_URI ?? '')) throw new Error('OIDC_REDIRECT_URI must be an https URL in staging/production (D-32)');
    if (!env.OIDC_CLIENT_SECRET || env.OIDC_CLIENT_SECRET.length < 16) throw new Error('OIDC_CLIENT_SECRET (confidential BFF client) is required in staging/production (D-32)');
    if (!/^https:\/\//.test(parsed.data.OIDC_ISSUER)) throw new Error('OIDC_ISSUER must be https in staging/production');
  }
  try { ipAllowList(env.MPESA_CALLBACK_ALLOWED_IPS); } catch (e) { throw new Error(`Invalid configuration: MPESA_CALLBACK_ALLOWED_IPS: ${(e as Error).message}`, { cause: e }); }
  return { ...parsed.data, raw: env };
}

export const CONFIG = Symbol('CONFIG');
export const ADAPTERS = Symbol('ADAPTERS');
export const STORAGE = Symbol('STORAGE');
