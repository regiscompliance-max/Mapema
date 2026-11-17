/**
 * [Integration Engineer + Security Engineer] Document storage. Production target is
 * S3-compatible storage with SSE-KMS and Object Lock (WORM) for signed documents. Phase 1 ships a
 * local filesystem store that encrypts every object with AES-256-GCM (dev/test stand-in for the
 * bucket) and refuses overwrites of WORM keys. The S3 client is a Phase 1 gap (see qa-report).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AdapterError } from './common';

export interface StoredObject { bucket: string; key: string; sha256: string; sizeBytes: number }
export interface StorageAdapter {
  put(bucket: string, key: string, body: Buffer, opts?: { worm?: boolean }): Promise<StoredObject>;
  get(bucket: string, key: string): Promise<Buffer>;
}

export class LocalEncryptedStorage implements StorageAdapter {
  private readonly key: Buffer;
  constructor(private readonly root: string, keyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new AdapterError('storage', 'BAD_KEY', 'STORAGE_ENCRYPTION_KEY must be 32 bytes hex');
    this.key = Buffer.from(keyHex, 'hex');
  }
  private path(bucket: string, key: string) {
    if (!/^[a-z0-9-]+$/.test(bucket) || key.includes('..') || key.startsWith('/')) throw new AdapterError('storage', 'BAD_KEY', 'invalid bucket/key');
    const p = resolve(join(this.root, bucket, key));
    if (!p.startsWith(resolve(this.root))) throw new AdapterError('storage', 'BAD_KEY', 'path escape');
    return p;
  }
  async put(bucket: string, key: string, body: Buffer, opts?: { worm?: boolean }) {
    const p = this.path(bucket, key);
    if (opts?.worm) {
      const exists = await access(p).then(() => true, () => false);
      if (exists) throw new AdapterError('storage', 'WORM_OBJECT_EXISTS', `${bucket}/${key} is write-once`);
    }
    await mkdir(dirname(p), { recursive: true });
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(body), c.final()]);
    await writeFile(p, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
    return { bucket, key, sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: body.length };
  }
  async get(bucket: string, key: string) {
    const raw = await readFile(this.path(bucket, key));
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  }
}

export class MemoryStorage implements StorageAdapter {
  private m = new Map<string, Buffer>();
  async put(bucket: string, key: string, body: Buffer, opts?: { worm?: boolean }) {
    const k = `${bucket}/${key}`;
    if (opts?.worm && this.m.has(k)) throw new AdapterError('storage', 'WORM_OBJECT_EXISTS', k);
    this.m.set(k, Buffer.from(body));
    return { bucket, key, sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: body.length };
  }
  async get(bucket: string, key: string) {
    const b = this.m.get(`${bucket}/${key}`);
    if (!b) throw new AdapterError('storage', 'NOT_FOUND', key, false, 404);
    return b;
  }
}
