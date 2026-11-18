/** [QA Engineer + DevOps] Go-live: deployed environments refuse unsafe auth / callback configuration at start-up. */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/common/config';

const hex = 'a'.repeat(64);
const base = { DATABASE_URL: 'postgres://x', PII_ENCRYPTION_KEY: hex, PII_BLIND_INDEX_KEY: hex, STORAGE_ENCRYPTION_KEY: hex, BANK_WEBHOOK_SECRET: 'b'.repeat(16), ESIGN_WEBHOOK_SECRET: 'c'.repeat(16) };
const prod = { ...base, APP_ENV: 'production', OIDC_ISSUER: 'https://id.example/realms/mapema', OIDC_REDIRECT_URI: 'https://api.example/v1/auth/oidc/callback', OIDC_CLIENT_SECRET: 's'.repeat(32) };

describe('TC-GL-CFG config guards', () => {
  it('production with https issuer/redirect and a client secret loads', () => {
    expect(loadConfig(prod).APP_ENV).toBe('production');
  });
  it('refuses http redirect, missing client secret, http issuer, dev IdP, bad IP allow-list', () => {
    expect(() => loadConfig({ ...prod, OIDC_REDIRECT_URI: 'http://api.example/cb' })).toThrow(/OIDC_REDIRECT_URI/);
    expect(() => loadConfig({ ...prod, OIDC_CLIENT_SECRET: '' })).toThrow(/OIDC_CLIENT_SECRET/);
    expect(() => loadConfig({ ...prod, OIDC_ISSUER: 'http://id.example' })).toThrow(/OIDC_ISSUER/);
    expect(() => loadConfig({ ...prod, DEV_IDP_ENABLED: 'true' })).toThrow(/DEV_IDP_ENABLED/);
    expect(() => loadConfig({ ...base, MPESA_CALLBACK_ALLOWED_IPS: '196.201.214.0/24, not-an-ip' })).toThrow(/MPESA_CALLBACK_ALLOWED_IPS/);
  });
  it('development keeps working without any of them', () => {
    expect(loadConfig(base).APP_ENV).toBe('development');
  });
});
