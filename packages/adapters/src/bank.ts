/**
 * [Integration Engineer] Bank adapter: collections (virtual account per buyer, webhooks,
 * statement import) and disbursements (PesaLink/EFT/RTGS). Partner bank not yet chosen
 * (Stanbic / NCBA / KCB candidates) so only mock mode is implemented; sandbox/live fail fast.
 *
 * Mock magic values (documented in docs/phase-1/qa-report.md):
 *   beneficiary account ending 0002 -> payout fails immediately (ACCOUNT_CLOSED)
 *   beneficiary account ending 0003 -> payout is sent, then RETURNED on status check
 */
import { Cents } from '@mapema/pricing';
import { AdapterContext, AdapterError, AdapterMode, HealthCheck, notConfigured } from './common';
import { verifyWebhook } from './webhooks';

export type PayoutRail = 'pesalink' | 'eft' | 'rtgs' | 'internal';
export type BankPayoutStatus = 'sent' | 'confirmed' | 'failed' | 'returned';

export interface PayoutInstruction {
  idempotencyKey: string;
  amountCents: Cents;
  currency: 'KES';
  beneficiary: { bankCode: string; accountNumber: string; accountName: string };
  rail: PayoutRail;
  narrative: string;
}

export interface BankCredit {
  bankCode: string;
  accountNo: string; // virtual / collection account credited
  bankRef: string;
  valueDate: string;
  amountCents: Cents;
  currency: string;
  payerName?: string;
  payerAccount?: string;
  narrative?: string;
}

/** One line of the collection/disbursement account statement. Amount is signed: + money in, - money out. */
export interface StatementLine {
  bankRef: string;
  valueDate: string;
  amountCents: Cents;
  type: 'credit' | 'debit' | 'return' | 'charge' | 'interest';
  accountNo?: string;
  narrative?: string;
}

export interface BankAdapter {
  readonly mode: AdapterMode;
  readonly bankCode: string;
  openVirtualAccount(ctx: AdapterContext, buyer: { id: string; legalName: string }): Promise<{ virtualAccountNo: string }>;
  sendPayout(ctx: AdapterContext, p: PayoutInstruction, valueDate?: string): Promise<{ bankRef: string; status: BankPayoutStatus; failureReason?: string }>;
  getPayoutStatus(bankRef: string): Promise<{ status: BankPayoutStatus; failureReason?: string }>;
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): boolean;
  parseWebhook(rawBody: string): BankCredit;
  parseStatement(csv: string): BankCredit[];
  getBalance(accountNo?: string): Promise<Cents>;
  /** Statement lines with value date in [from, to] (Phase 2 REC-02 itemised reconciliation). */
  getStatement(from: string, to: string): Promise<StatementLine[]>;
  health(): Promise<HealthCheck>;
}

/** Statement CSV: bank_ref,value_date,account_no,amount_cents,currency,payer_name,narrative */
export function parseStatementCsv(bankCode: string, csv: string): BankCredit[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].toLowerCase();
  const rows = header.startsWith('bank_ref') ? lines.slice(1) : lines;
  return rows.map((line, i) => {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 5) throw new AdapterError('bank', 'BAD_STATEMENT', `line ${i + 2}: expected at least 5 columns`);
    const [bankRef, valueDate, accountNo, amount, currency, payerName, ...narr] = cols;
    if (!/^\d+$/.test(amount)) throw new AdapterError('bank', 'BAD_STATEMENT', `line ${i + 2}: amount must be integer cents`);
    return { bankCode, bankRef, valueDate, accountNo, amountCents: BigInt(amount), currency, payerName, narrative: narr.join(',') };
  });
}

export class MockBank implements BankAdapter {
  readonly mode = 'mock' as const;
  readonly bankCode = 'MOCKBANK';
  private seq = 1;
  private payouts = new Map<string, { bankRef: string; status: BankPayoutStatus; failureReason?: string; p: PayoutInstruction; valueDate?: string }>();
  private balance = 0n;
  readonly sent: PayoutInstruction[] = [];
  readonly statement: StatementLine[] = [];
  private today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

  constructor(private readonly webhookSecret = 'mock-bank-webhook-secret') {}

  async openVirtualAccount(_ctx: AdapterContext, buyer: { id: string }) {
    return { virtualAccountNo: `MAP${buyer.id.replace(/-/g, '').slice(0, 10).toUpperCase()}` };
  }

  async sendPayout(_ctx: AdapterContext, p: PayoutInstruction, valueDate?: string) {
    if (p.currency !== 'KES') throw new AdapterError('bank-mock', 'CURRENCY_NOT_SUPPORTED', 'KES only');
    const prior = this.payouts.get(p.idempotencyKey);
    if (prior) return { bankRef: prior.bankRef, status: prior.status, failureReason: prior.failureReason };
    const bankRef = `MB${String(this.seq++).padStart(8, '0')}`;
    if (p.beneficiary.accountNumber.endsWith('0002')) {
      const rec = { bankRef, status: 'failed' as const, failureReason: 'ACCOUNT_CLOSED', p };
      this.payouts.set(p.idempotencyKey, rec);
      return { bankRef, status: rec.status, failureReason: rec.failureReason };
    }
    if (this.balance < p.amountCents) {
      throw new AdapterError('bank-mock', 'INSUFFICIENT_FUNDS', 'disbursement account balance too low', false);
    }
    this.balance -= p.amountCents;
    this.sent.push(p);
    this.statement.push({ bankRef, valueDate: valueDate ?? this.today(), amountCents: -p.amountCents, type: 'debit', narrative: p.narrative });
    this.payouts.set(p.idempotencyKey, { bankRef, status: 'sent', p, valueDate: valueDate ?? this.today() });
    return { bankRef, status: 'sent' as const };
  }

  async getPayoutStatus(bankRef: string) {
    const rec = [...this.payouts.values()].find((r) => r.bankRef === bankRef);
    if (!rec) throw new AdapterError('bank-mock', 'NOT_FOUND', bankRef, false, 404);
    if (rec.status === 'sent') {
      if (rec.p.beneficiary.accountNumber.endsWith('0003')) {
        rec.status = 'returned';
        rec.failureReason = 'BENEFICIARY_NAME_MISMATCH';
        this.balance += rec.p.amountCents;
        this.statement.push({ bankRef: `${bankRef}-R`, valueDate: rec.valueDate ?? this.today(), amountCents: rec.p.amountCents, type: 'return', narrative: 'Returned payout' });
      } else rec.status = 'confirmed';
    }
    return { status: rec.status, failureReason: rec.failureReason };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>) {
    return verifyWebhook(this.webhookSecret, headers['x-bank-timestamp'], rawBody, headers['x-bank-signature']);
  }

  parseWebhook(rawBody: string): BankCredit {
    const j = JSON.parse(rawBody);
    if (typeof j.amount_cents !== 'string' && typeof j.amount_cents !== 'number') throw new AdapterError('bank-mock', 'BAD_WEBHOOK', 'amount_cents');
    return {
      bankCode: this.bankCode, accountNo: String(j.account_no), bankRef: String(j.bank_ref), valueDate: String(j.value_date),
      amountCents: BigInt(j.amount_cents), currency: String(j.currency), payerName: j.payer_name, payerAccount: j.payer_account, narrative: j.narrative,
    };
  }

  parseStatement(csv: string) {
    return parseStatementCsv(this.bankCode, csv);
  }

  /** test/dev hook: money arriving in the account (appears on the statement with this reference) */
  creditReceived(amountCents: Cents, o: { bankRef?: string; valueDate?: string; accountNo?: string; narrative?: string } = {}) {
    this.balance += amountCents;
    this.statement.push({ bankRef: o.bankRef ?? `MCR${String(this.seq++).padStart(8, '0')}`, valueDate: o.valueDate ?? this.today(), amountCents, type: 'credit', accountNo: o.accountNo, narrative: o.narrative });
  }

  /** test/dev hook: the bank debits a charge */
  bankCharge(amountCents: Cents, bankRef: string, valueDate: string, narrative = 'Bank charge') {
    this.balance -= amountCents;
    this.statement.push({ bankRef, valueDate, amountCents: -amountCents, type: 'charge', narrative });
  }

  async getBalance() {
    return this.balance;
  }

  async getStatement(from: string, to: string) {
    return this.statement.filter((l) => l.valueDate >= from && l.valueDate <= to).map((l) => ({ ...l }));
  }

  async health(): Promise<HealthCheck> {
    return { provider: 'bank-mock', mode: 'mock', ok: true };
  }
}

export class UnconfiguredBank implements BankAdapter {
  readonly bankCode = 'UNSET';
  constructor(readonly mode: AdapterMode) {}
  openVirtualAccount(): never { return notConfigured('bank', this.mode); }
  sendPayout(): never { return notConfigured('bank', this.mode); }
  getPayoutStatus(): never { return notConfigured('bank', this.mode); }
  verifyWebhook() { return false; }
  parseWebhook(): never { return notConfigured('bank', this.mode); }
  parseStatement(csv: string) { return parseStatementCsv(this.bankCode, csv); }
  getBalance(): never { return notConfigured('bank', this.mode); }
  async getStatement(): Promise<StatementLine[]> { return notConfigured('bank', this.mode); }
  async health(): Promise<HealthCheck> { return { provider: 'bank', mode: this.mode, ok: false, detail: 'provider not contracted' }; }
}
