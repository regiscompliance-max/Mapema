/**
 * [Integration Engineer] E-signature adapter (master agreement, deed of assignment, ILU,
 * programme agreement). Provider and its legal validity under the Kenya Information and
 * Communications Act are still open (counsel), so Phase 1 ships mock mode only.
 */
import { createHash } from 'node:crypto';
import { AdapterContext, AdapterError, AdapterMode, HealthCheck, notConfigured } from './common';
import { verifyWebhook } from './webhooks';

export type EnvelopeStatus = 'sent' | 'completed' | 'declined' | 'expired';
export interface Signer { name: string; email: string; phone?: string; role: string }
export interface EsignAdapter {
  readonly mode: AdapterMode;
  createEnvelope(ctx: AdapterContext, r: { documentType: string; title: string; pdf: Buffer; signers: Signer[]; reference: string }): Promise<{ envelopeId: string; signingUrls: string[] }>;
  getStatus(envelopeId: string): Promise<EnvelopeStatus>;
  downloadSigned(envelopeId: string): Promise<{ pdf: Buffer; sha256: string; signedAt: string; auditTrail: string }>;
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): boolean;
  health(): Promise<HealthCheck>;
}

export class MockEsign implements EsignAdapter {
  readonly mode = 'mock' as const;
  private seq = 1;
  private envelopes = new Map<string, { status: EnvelopeStatus; pdf: Buffer; signedAt?: string; signers: Signer[]; title: string }>();
  constructor(private readonly webhookSecret = 'mock-esign-webhook-secret', private readonly autoComplete = false) {}

  async createEnvelope(_ctx: AdapterContext, r: { title: string; pdf: Buffer; signers: Signer[] }) {
    if (r.signers.length === 0) throw new AdapterError('esign-mock', 'NO_SIGNERS', 'at least one signer');
    const envelopeId = `ENV-MOCK-${String(this.seq++).padStart(6, '0')}`;
    this.envelopes.set(envelopeId, { status: this.autoComplete ? 'completed' : 'sent', pdf: r.pdf, signers: r.signers, title: r.title, signedAt: this.autoComplete ? new Date().toISOString() : undefined });
    return { envelopeId, signingUrls: r.signers.map((_, i) => `https://esign.mock.invalid/sign/${envelopeId}/${i}`) };
  }
  /** test/dev hook: all signers sign (or one declines) */
  complete(envelopeId: string, outcome: 'completed' | 'declined' = 'completed') {
    const e = this.must(envelopeId);
    e.status = outcome;
    if (outcome === 'completed') e.signedAt = new Date().toISOString();
  }
  async getStatus(envelopeId: string) { return this.must(envelopeId).status; }
  async downloadSigned(envelopeId: string) {
    const e = this.must(envelopeId);
    if (e.status !== 'completed' || !e.signedAt) throw new AdapterError('esign-mock', 'NOT_SIGNED', envelopeId);
    const pdf = Buffer.concat([e.pdf, Buffer.from(`\n% signed ${e.signedAt} by ${e.signers.map((s) => s.name).join('; ')}\n`)]);
    return { pdf, sha256: createHash('sha256').update(pdf).digest('hex'), signedAt: e.signedAt, auditTrail: `mock audit trail for ${envelopeId}` };
  }
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>) {
    return verifyWebhook(this.webhookSecret, headers['x-esign-timestamp'], rawBody, headers['x-esign-signature']);
  }
  async health(): Promise<HealthCheck> { return { provider: 'esign-mock', mode: 'mock', ok: true }; }
  private must(id: string) {
    const e = this.envelopes.get(id);
    if (!e) throw new AdapterError('esign-mock', 'NOT_FOUND', id, false, 404);
    return e;
  }
}
export class UnconfiguredEsign implements EsignAdapter {
  constructor(readonly mode: AdapterMode) {}
  createEnvelope(): never { return notConfigured('esign', this.mode); }
  getStatus(): never { return notConfigured('esign', this.mode); }
  downloadSigned(): never { return notConfigured('esign', this.mode); }
  verifyWebhook() { return false; }
  async health(): Promise<HealthCheck> { return { provider: 'esign', mode: this.mode, ok: false, detail: 'provider not contracted' }; }
}
