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

/**
 * [Security Engineer] S-09 (go-live): report artefacts (CRB submission files carry borrower
 * identifiers; CBK returns, lender packs, loan tapes) are encrypted at the application level before
 * they reach Postgres, so a database dump, replica or backup alone does not disclose them.
 *  - AES-256-GCM, random 96-bit IV, envelope "MRA1" | iv(12) | tag(16) | ciphertext
 *  - key = HMAC-SHA256(STORAGE_ENCRYPTION_KEY, "mapema-report-artifact-v1") (domain-separated from
 *    the document store's use of the same key); production key from the KMS / secrets manager
 *  - AAD binds the ciphertext to its row (snapshot, template, filename): moving it to another row fails
 *  - sha256 stays over the PLAINTEXT, so reproducibility checks and download hashes are unchanged
 *  - legacy plaintext rows (encrypted = false) are still readable; scripts/encrypt-report-artifacts.mjs
 *    re-encrypts them as the migration owner (the app role cannot UPDATE artefacts: append-only)
 */
const ARTIFACT_MAGIC = Buffer.from('MRA1');
@Injectable()
export class ArtifactCrypto {
  private readonly key: Buffer;
  constructor(@Inject(CONFIG) cfg: AppConfig) {
    this.key = ArtifactCrypto.deriveKey(cfg.STORAGE_ENCRYPTION_KEY);
  }
  static deriveKey(storageKeyHex: string) {
    return createHmac('sha256', Buffer.from(storageKeyHex, 'hex')).update('mapema-report-artifact-v1').digest();
  }
  static aad(snapshotId: string, templateId: string | null, filename: string) {
    return Buffer.from(`${snapshotId}|${templateId ?? ''}|${filename}`, 'utf8');
  }
  static isEnvelope(b: Buffer) { return b.length > 32 && b.subarray(0, 4).equals(ARTIFACT_MAGIC); }
  static sealWith(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([ARTIFACT_MAGIC, iv, c.getAuthTag(), ct]);
  }
  static openWith(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
    if (!ArtifactCrypto.isEnvelope(blob)) throw new Error('not an encrypted report artefact');
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
    d.setAAD(aad);
    d.setAuthTag(blob.subarray(16, 32));
    return Buffer.concat([d.update(blob.subarray(32)), d.final()]);
  }
  seal(plain: Buffer, aad: Buffer) { return ArtifactCrypto.sealWith(this.key, plain, aad); }
  open(blob: Buffer, aad: Buffer, encrypted: boolean): Buffer { return encrypted ? ArtifactCrypto.openWith(this.key, blob, aad) : blob; }
}
