/**
 * [Security Engineer] DEVELOPMENT/TEST identity provider. Stands in for Keycloak where it can't
 * run (local dev, CI unit stage, this build box). Issues RS256 tokens with the same claims
 * Keycloak issues (sub, email, amr, auth_time). Hard-disabled when APP_ENV=production
 * (config validation) and only mounted when DEV_IDP_ENABLED=true.
 */
import { Injectable } from '@nestjs/common';
import { createLocalJWKSet, exportJWK, generateKeyPair, JWK, JWTVerifyGetKey, SignJWT } from 'jose';

type PrivKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

@Injectable()
export class DevIdp {
  readonly issuer = 'http://localhost/dev-idp';
  private keys?: { privateKey: PrivKey; jwk: JWK };
  private local?: JWTVerifyGetKey;

  async init() {
    if (this.keys) return;
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'dev-1', alg: 'RS256', use: 'sig' };
    this.keys = { privateKey, jwk };
    this.local = createLocalJWKSet({ keys: [jwk] });
  }

  keySet(): JWTVerifyGetKey {
    if (!this.local) throw new Error('dev IdP not initialised');
    return this.local;
  }

  jwks() {
    return { keys: this.keys ? [this.keys.jwk] : [] };
  }

  async issue(sub: string, opts: { email?: string; amr?: string[]; authAgeSec?: number; audience?: string; ttlSec?: number } = {}) {
    await this.init();
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email: opts.email, amr: opts.amr ?? ['pwd', 'otp'], auth_time: now - (opts.authAgeSec ?? 0) })
      .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
      .setIssuer(this.issuer)
      .setAudience(opts.audience ?? 'mapema-api')
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.ttlSec ?? 900))
      .sign(this.keys!.privateKey);
  }
}
