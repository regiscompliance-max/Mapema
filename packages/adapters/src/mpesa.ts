/**
 * [Integration Engineer + Payments] M-Pesa Daraja B2C adapter (Phase 3 MP-01..04) for small supplier payouts.
 *   mock    - deterministic in-memory float with a statement; test hooks build Daraja-shaped callbacks.
 *   sandbox - Daraja sandbox (https://sandbox.safaricom.co.ke): OAuth client credentials, B2C v3
 *             payment request, Transaction Status query. Needs a Daraja app + test shortcode; NOT
 *             exercised against Safaricom in this phase (injected fetch only).
 *   live    - production only, after Safaricom go-live approval.
 * Rules enforced before any call: whole shillings only (Daraja Amount is an integer), KES 10 - 250,000
 * per transaction, MSISDN in 2547/2541 format. B2C is asynchronous: the request is ACCEPTED, the RESULT
 * arrives on ResultURL (or QueueTimeOutURL). Callers must never resend on a timeout; they query status.
 */
import { Cents } from '@mapema/pricing';
import { AdapterContext, AdapterError, AdapterMode, decimalToCents, HealthCheck, stableHash } from './common';
import type { StatementLine } from './bank';

export const MPESA_MIN_CENTS = 1_000n; // KES 10
export const MPESA_MAX_CENTS = 25_000_000n; // KES 250,000 per B2C transaction
export interface B2cRequest { idempotencyKey: string; amountCents: Cents; msisdn: string; remarks: string }
export interface B2cAccepted { originatorConversationId: string; conversationId: string; accepted: true }
export interface B2cResult {
  originatorConversationId: string; conversationId?: string; resultCode: number; resultDesc: string; timeout?: boolean;
  transactionId?: string; amountCents?: Cents; receiverName?: string; completedAt?: string;
}
export type MpesaStatus = { state: 'completed' | 'failed' | 'pending' | 'unknown'; result?: B2cResult };
export interface MpesaAdapter {
  readonly mode: AdapterMode;
  b2cPayment(ctx: AdapterContext, req: B2cRequest): Promise<B2cAccepted>;
  queryStatus(ctx: AdapterContext, originatorConversationId: string): Promise<MpesaStatus>;
  getBalance(): Promise<Cents>;
  getStatement(from: string, to: string): Promise<StatementLine[]>;
  health(): Promise<HealthCheck>;
}

const e = (code: string, msg: string, retryable = false, status?: number) => new AdapterError('mpesa', code, msg, retryable, status);
export function assertB2c(req: B2cRequest) {
  if (req.amountCents % 100n !== 0n) throw e('MPESA_WHOLE_SHILLINGS', 'M-Pesa pays whole shillings only');
  if (req.amountCents < MPESA_MIN_CENTS || req.amountCents > MPESA_MAX_CENTS) throw e('MPESA_AMOUNT_RANGE', 'B2C amount must be KES 10 - 250,000');
  if (!/^254[17]\d{8}$/.test(req.msisdn)) throw e('MPESA_BAD_MSISDN', 'MSISDN must look like 2547XXXXXXXX');
}
export const normaliseMsisdn = (s: string): string | null => {
  const d = s.replace(/[\s-]/g, '');
  const m = /^(?:\+?254|0)([17]\d{8})$/.exec(d);
  return m ? `254${m[1]}` : null;
};

/** Parses a Daraja B2C Result / QueueTimeOut callback body. */
export function parseB2cResult(body: any): B2cResult {
  const r = body?.Result;
  if (!r || typeof r.OriginatorConversationID !== 'string') throw e('MPESA_BAD_CALLBACK', 'not a Daraja B2C result');
  const params = new Map<string, unknown>((r.ResultParameters?.ResultParameter ?? []).map((p: any) => [p.Key, p.Value]));
  const code = Number(r.ResultCode);
  const out: B2cResult = { originatorConversationId: r.OriginatorConversationID, conversationId: r.ConversationID, resultCode: code, resultDesc: String(r.ResultDesc ?? '') };
  if (r.ResultType === 'timeout' || body?.Timeout === true) out.timeout = true;
  if (code === 0) {
    out.transactionId = String(params.get('TransactionReceipt') ?? r.TransactionID);
    if (params.has('TransactionAmount')) out.amountCents = decimalToCents(params.get('TransactionAmount') as any);
    if (params.has('ReceiverPartyPublicName')) out.receiverName = String(params.get('ReceiverPartyPublicName'));
    if (params.has('TransactionCompletedDateTime')) out.completedAt = String(params.get('TransactionCompletedDateTime'));
  }
  return out;
}

const resultBody = (r: { orig: string; conv: string; code: number; desc: string; receipt?: string; amountCents?: Cents; name?: string; when?: string; timeout?: boolean }) => ({
  ...(r.timeout ? { Timeout: true } : {}),
  Result: {
    ResultType: r.timeout ? 'timeout' : 0, ResultCode: r.code, ResultDesc: r.desc, OriginatorConversationID: r.orig, ConversationID: r.conv, TransactionID: r.receipt ?? 'NA',
    ...(r.code === 0 ? { ResultParameters: { ResultParameter: [
      { Key: 'TransactionAmount', Value: Number(r.amountCents! / 100n) }, { Key: 'TransactionReceipt', Value: r.receipt },
      { Key: 'ReceiverPartyPublicName', Value: r.name }, { Key: 'TransactionCompletedDateTime', Value: r.when },
      { Key: 'B2CRecipientIsRegisteredCustomer', Value: 'Y' },
    ] } } : {}),
  },
});

export class MockMpesa implements MpesaAdapter {
  readonly mode = 'mock' as const;
  readonly requests: B2cRequest[] = [];
  readonly statement: StatementLine[] = [];
  readonly statusOverride = new Map<string, 'pending' | 'unknown'>();
  chargeCents = 0n; // B2C transaction charge debited from the float (tariff not modelled: set per test)
  failNext: string | null = null; // test hook: synchronous rejection code on the next b2cPayment
  private acc = new Map<string, B2cAccepted>();
  private results = new Map<string, B2cResult>();

  fund(amountCents: Cents, bankRef: string, valueDate: string) { this.statement.push({ bankRef, valueDate, amountCents, type: 'credit', narrative: 'B2C float top-up' }); }
  async b2cPayment(_ctx: AdapterContext, req: B2cRequest): Promise<B2cAccepted> {
    assertB2c(req);
    const prior = this.acc.get(req.idempotencyKey);
    if (prior) return prior;
    if (this.failNext) { const c = this.failNext; this.failNext = null; throw e(c, 'mock rejection'); }
    this.requests.push(req);
    const a: B2cAccepted = { originatorConversationId: req.idempotencyKey, conversationId: `AG_${stableHash(req.idempotencyKey).toString(16).toUpperCase()}`, accepted: true };
    this.acc.set(req.idempotencyKey, a);
    return a;
  }
  private req(orig: string) { const r = this.requests.find((x) => x.idempotencyKey === orig); if (!r) throw e('MPESA_UNKNOWN_REQUEST', orig); return r; }
  /** Safaricom pays: debits the float, writes the statement, returns the ResultURL body. */
  complete(orig: string, o: { receiverName: string; date: string }) {
    const r = this.req(orig);
    const receipt = (`Q${stableHash(orig).toString(36).toUpperCase()}XXXXXXXXXX`).slice(0, 10);
    const masked = `${r.msisdn.slice(0, 6)}***${r.msisdn.slice(-3)} - ${o.receiverName}`;
    if (!this.results.has(orig)) {
      this.statement.push({ bankRef: receipt, valueDate: o.date, amountCents: -r.amountCents, type: 'debit', narrative: `B2C ${masked}` });
      if (this.chargeCents > 0n) this.statement.push({ bankRef: `${receipt}-CHG`, valueDate: o.date, amountCents: -this.chargeCents, type: 'charge', narrative: 'B2C transaction charge' });
      this.results.set(orig, { originatorConversationId: orig, resultCode: 0, resultDesc: 'The service request is processed successfully.', transactionId: receipt, amountCents: r.amountCents, receiverName: masked, completedAt: o.date });
    }
    return resultBody({ orig, conv: this.acc.get(orig)!.conversationId, code: 0, desc: 'The service request is processed successfully.', receipt, amountCents: r.amountCents, name: masked, when: o.date });
  }
  fail(orig: string, code: number, desc: string) {
    this.req(orig);
    this.results.set(orig, { originatorConversationId: orig, resultCode: code, resultDesc: desc });
    return resultBody({ orig, conv: this.acc.get(orig)!.conversationId, code, desc });
  }
  timeoutBody(orig: string) {
    this.req(orig);
    return resultBody({ orig, conv: this.acc.get(orig)!.conversationId, code: 1037, desc: 'Request timed out in the queue', timeout: true });
  }
  async queryStatus(_ctx: AdapterContext, orig: string): Promise<MpesaStatus> {
    const o = this.statusOverride.get(orig);
    if (o) return { state: o };
    const r = this.results.get(orig);
    if (!r) return { state: this.acc.has(orig) ? 'pending' : 'unknown' };
    return { state: r.resultCode === 0 ? 'completed' : 'failed', result: r };
  }
  async getBalance() { return this.statement.reduce((s, l) => s + l.amountCents, 0n); }
  async getStatement(from: string, to: string) { return this.statement.filter((l) => l.valueDate >= from && l.valueDate <= to); }
  async health(): Promise<HealthCheck> { return { provider: 'mpesa-mock', mode: 'mock', ok: true }; }
}

export interface DarajaConfig { baseUrl: string; consumerKey: string; consumerSecret: string; shortcode: string; initiatorName: string; securityCredential: string; resultUrl: string; timeoutUrl: string; timeoutMs?: number }
export class DarajaMpesa implements MpesaAdapter {
  private token: { value: string; until: number } | null = null;
  constructor(readonly mode: AdapterMode, private readonly cfg: DarajaConfig, private readonly f: typeof fetch = fetch) {}
  private async call(path: string, init: RequestInit): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    let res: Response;
    try { res = await this.f(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}`, { ...init, signal: ctrl.signal }); } catch (x) { throw e('MPESA_UNAVAILABLE', `network: ${(x as Error).message}`, true); } finally { clearTimeout(t); }
    if (res.status === 401 || res.status === 403) { this.token = null; throw e('MPESA_AUTH_FAILED', `HTTP ${res.status}`, false, res.status); }
    if (res.status >= 500 || res.status === 429) throw e('MPESA_UNAVAILABLE', `HTTP ${res.status}`, true, res.status);
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw e('MPESA_REJECTED', `${body?.errorCode ?? res.status}: ${body?.errorMessage ?? ''}`.slice(0, 200), false, res.status);
    return body;
  }
  private async bearer(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const b = await this.call('/oauth/v1/generate?grant_type=client_credentials', { method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64')}` } });
    if (!b?.access_token) throw e('MPESA_AUTH_FAILED', 'no access token');
    this.token = { value: b.access_token, until: Date.now() + (Number(b.expires_in ?? 3599) - 60) * 1000 };
    return this.token.value;
  }
  private async post(path: string, body: unknown) {
    return this.call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.bearer()}` }, body: JSON.stringify(body) });
  }
  async b2cPayment(_ctx: AdapterContext, req: B2cRequest): Promise<B2cAccepted> {
    assertB2c(req);
    const b = await this.post('/mpesa/b2c/v3/paymentrequest', {
      OriginatorConversationID: req.idempotencyKey, InitiatorName: this.cfg.initiatorName, SecurityCredential: this.cfg.securityCredential, CommandID: 'BusinessPayment',
      Amount: Number(req.amountCents / 100n), PartyA: this.cfg.shortcode, PartyB: req.msisdn, Remarks: req.remarks.slice(0, 100),
      QueueTimeOutURL: this.cfg.timeoutUrl, ResultURL: this.cfg.resultUrl, Occassion: req.idempotencyKey.slice(0, 100),
    });
    if (String(b?.ResponseCode) !== '0') throw e('MPESA_REJECTED', `${b?.ResponseCode}: ${b?.ResponseDescription ?? ''}`);
    return { originatorConversationId: req.idempotencyKey, conversationId: String(b.ConversationID), accepted: true };
  }
  /** Daraja's Transaction Status API answers on a callback too: the state stays pending until it arrives. */
  async queryStatus(_ctx: AdapterContext, orig: string): Promise<MpesaStatus> {
    await this.post('/mpesa/transactionstatus/v1/query', {
      Initiator: this.cfg.initiatorName, SecurityCredential: this.cfg.securityCredential, CommandID: 'TransactionStatusQuery', OriginatorConversationID: orig,
      PartyA: this.cfg.shortcode, IdentifierType: '4', ResultURL: this.cfg.resultUrl, QueueTimeOutURL: this.cfg.timeoutUrl, Remarks: 'Mapema status check', Occasion: orig.slice(0, 100),
    });
    return { state: 'pending' };
  }
  async getBalance(): Promise<Cents> { throw e('MPESA_STATEMENT_NOT_AVAILABLE', 'Daraja AccountBalance is asynchronous; balance comes from the org portal statement import (not built)'); }
  async getStatement(): Promise<StatementLine[]> { throw e('MPESA_STATEMENT_NOT_AVAILABLE', 'No statement API on Daraja; import the M-Pesa org portal statement (not built)'); }
  async health(): Promise<HealthCheck> { return { provider: 'mpesa-daraja', mode: this.mode, ok: Boolean(this.cfg.consumerKey && this.cfg.shortcode), detail: 'not exercised against Safaricom in this phase' }; }
}
