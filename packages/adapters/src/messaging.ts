/**
 * [Integration Engineer] SMS and email adapters.
 * SMS: Africa's Talking messaging API (sandbox: api.sandbox.africastalking.com, username "sandbox").
 * Email: Postmark /email API. Both HTTP clients follow the providers' public docs but were NOT
 * exercised against the network in Phase 1 (no accounts may be created); tests use the mocks.
 */
import { AdapterContext, AdapterError, AdapterMode, HealthCheck } from './common';

export interface SmsAdapter {
  readonly mode: AdapterMode;
  send(ctx: AdapterContext, m: { to: string; text: string; reference: string }): Promise<{ providerRef: string; status: 'sent' | 'failed' }>;
  health(): Promise<HealthCheck>;
}
export interface EmailAdapter {
  readonly mode: AdapterMode;
  send(ctx: AdapterContext, m: { to: string; subject: string; text: string; reference: string }): Promise<{ providerRef: string; status: 'sent' | 'failed' }>;
  health(): Promise<HealthCheck>;
}

const E164_KE = /^\+2547\d{8}$|^\+2541\d{8}$/;

export class MockSms implements SmsAdapter {
  readonly mode = 'mock' as const;
  readonly outbox: { to: string; text: string; reference: string }[] = [];
  async send(_ctx: AdapterContext, m: { to: string; text: string; reference: string }) {
    if (!E164_KE.test(m.to)) throw new AdapterError('sms-mock', 'BAD_NUMBER', 'Kenyan E.164 number required');
    this.outbox.push(m);
    return { providerRef: `SMS-MOCK-${this.outbox.length}`, status: 'sent' as const };
  }
  async health(): Promise<HealthCheck> { return { provider: 'sms-mock', mode: 'mock', ok: true }; }
}

export class AfricasTalkingSms implements SmsAdapter {
  constructor(readonly mode: 'sandbox' | 'live', private readonly cfg: { username: string; apiKey: string; senderId?: string }) {}
  async send(_ctx: AdapterContext, m: { to: string; text: string; reference: string }) {
    if (!E164_KE.test(m.to)) throw new AdapterError('africastalking', 'BAD_NUMBER', 'Kenyan E.164 number required');
    const host = this.mode === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
    const body = new URLSearchParams({ username: this.cfg.username, to: m.to, message: m.text, ...(this.cfg.senderId ? { from: this.cfg.senderId } : {}) });
    const res = await fetch(`${host}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: this.cfg.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new AdapterError('africastalking', `HTTP_${res.status}`, await res.text(), res.status >= 500, res.status);
    const j: any = await res.json();
    const r = j?.SMSMessageData?.Recipients?.[0];
    return { providerRef: String(r?.messageId ?? ''), status: r?.status === 'Success' ? 'sent' as const : 'failed' as const };
  }
  async health(): Promise<HealthCheck> { return { provider: 'africastalking', mode: this.mode, ok: Boolean(this.cfg.apiKey) }; }
}

export class MockEmail implements EmailAdapter {
  readonly mode = 'mock' as const;
  readonly outbox: { to: string; subject: string; text: string; reference: string }[] = [];
  async send(_ctx: AdapterContext, m: { to: string; subject: string; text: string; reference: string }) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.to)) throw new AdapterError('email-mock', 'BAD_ADDRESS', m.to);
    this.outbox.push(m);
    return { providerRef: `EMAIL-MOCK-${this.outbox.length}`, status: 'sent' as const };
  }
  async health(): Promise<HealthCheck> { return { provider: 'email-mock', mode: 'mock', ok: true }; }
}

export class PostmarkEmail implements EmailAdapter {
  constructor(readonly mode: 'sandbox' | 'live', private readonly cfg: { serverToken: string; from: string; messageStream?: string }) {}
  async send(_ctx: AdapterContext, m: { to: string; subject: string; text: string; reference: string }) {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'X-Postmark-Server-Token': this.cfg.serverToken, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ From: this.cfg.from, To: m.to, Subject: m.subject, TextBody: m.text, MessageStream: this.cfg.messageStream ?? 'outbound', Metadata: { reference: m.reference } }),
    });
    if (!res.ok) throw new AdapterError('postmark', `HTTP_${res.status}`, await res.text(), res.status >= 500, res.status);
    const j: any = await res.json();
    return { providerRef: String(j.MessageID ?? ''), status: j.ErrorCode === 0 ? 'sent' as const : 'failed' as const };
  }
  async health(): Promise<HealthCheck> { return { provider: 'postmark', mode: this.mode, ok: Boolean(this.cfg.serverToken) }; }
}
