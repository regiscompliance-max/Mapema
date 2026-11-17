/**
 * [Security Engineer] Field-level encryption for PII (national IDs, bank account numbers,
 * phone numbers): AES-256-GCM, random 96-bit IV, versioned envelope "v1|iv|tag|ct".
 * Blind index = HMAC-SHA256 with a separate key for exact-match lookup without decrypting.
 * Production: keys come from the cloud KMS / secrets manager (envelope data keys), not env files.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from './config';

@Injectable()
export class FieldCrypto {
  private readonly key: Buffer;
  private readonly bidxKey: Buffer;
  constructor(@Inject(CONFIG) cfg: AppConfig) {
    this.key = Buffer.from(cfg.PII_ENCRYPTION_KEY, 'hex');
    this.bidxKey = Buffer.from(cfg.PII_BLIND_INDEX_KEY, 'hex');
  }

  encrypt(plain: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer | null | undefined): string | null {
    if (!blob) return null;
    if (blob[0] !== 1) throw new Error('unknown PII envelope version');
    const d = createDecipheriv('aes-256-gcm', this.key, blob.subarray(1, 13));
    d.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([d.update(blob.subarray(29)), d.final()]).toString('utf8');
  }

  blindIndex(value: string): Buffer {
    return createHmac('sha256', this.bidxKey).update(value.trim().toUpperCase()).digest();
  }

  static sha256(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  static token(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }
}

export const mask = (s: string | null | undefined, keep = 4) => (s ? `${'•'.repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}` : null);
