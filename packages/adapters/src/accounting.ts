/**
 * [Integration Engineer] Accounting adapter (Phase 2 ACC-01/02). Xero first (QuickBooks would be a
 * second implementation of the same interface). Fineract stays the ledger: the accounting package only
 * receives a DAILY SUMMARY journal derived from Fineract's trial balance movement, so the books of
 * account match the ledger without double-keying.
 *  - mock    : in-memory, idempotent by key
 *  - sandbox : Xero API with a Xero demo-company tenant (OAuth2 access token + tenant id). Journals are
 *              created as DRAFT so an accountant posts them. NOT exercised in this phase (no account).
 * Fee invoices are behind a hook that stays DISABLED until tax advice lands (D-24).
 */
import { Cents } from '@mapema/pricing';
import { AdapterContext, AdapterError, AdapterMode, centsToDecimal, HealthCheck, notConfigured } from './common';

export interface JournalLine { accountCode: string; debitCents: Cents; creditCents: Cents; description: string }
export interface DailyJournal { date: string; idempotencyKey: string; narration: string; lines: JournalLine[] }
export interface FeeInvoice { idempotencyKey: string; contactName: string; date: string; lines: { description: string; amountCents: Cents; accountCode?: string }[] }

export interface AccountingAdapter {
  readonly mode: AdapterMode;
  readonly provider: string;
  pushJournal(ctx: AdapterContext, j: DailyJournal): Promise<{ providerRef: string; duplicate: boolean }>;
  /** D-24: disabled until tax advice; implementations throw FEE_INVOICES_DISABLED unless explicitly enabled. */
  createFeeInvoice(ctx: AdapterContext, inv: FeeInvoice): Promise<{ providerRef: string }>;
  health(): Promise<HealthCheck>;
}

export function assertBalanced(j: DailyJournal) {
  const d = j.lines.reduce((s, l) => s + l.debitCents, 0n);
  const c = j.lines.reduce((s, l) => s + l.creditCents, 0n);
  if (d !== c || j.lines.length < 2) throw new AdapterError('accounting', 'UNBALANCED', `debits ${d} != credits ${c}`);
  for (const l of j.lines) if (l.debitCents < 0n || l.creditCents < 0n || (l.debitCents > 0n && l.creditCents > 0n)) throw new AdapterError('accounting', 'BAD_LINE', l.accountCode);
}

export class MockAccounting implements AccountingAdapter {
  readonly mode = 'mock' as const;
  readonly provider = 'accounting-mock';
  readonly journals: DailyJournal[] = [];
  readonly invoices: FeeInvoice[] = [];
  private refs = new Map<string, string>();
  constructor(private readonly feeInvoicesEnabled = false) {}

  async pushJournal(_ctx: AdapterContext, j: DailyJournal) {
    const prior = this.refs.get(j.idempotencyKey);
    if (prior) return { providerRef: prior, duplicate: true };
    assertBalanced(j);
    const ref = `mock-mj-${this.journals.length + 1}`;
    this.journals.push(j);
    this.refs.set(j.idempotencyKey, ref);
    return { providerRef: ref, duplicate: false };
  }

  async createFeeInvoice(_ctx: AdapterContext, inv: FeeInvoice) {
    if (!this.feeInvoicesEnabled) throw new AdapterError('accounting-mock', 'FEE_INVOICES_DISABLED', 'fee invoices are disabled pending tax advice (D-24)');
    this.invoices.push(inv);
    return { providerRef: `mock-inv-${this.invoices.length}` };
  }

  async health(): Promise<HealthCheck> { return { provider: this.provider, mode: 'mock', ok: true }; }
}

export class XeroAccounting implements AccountingAdapter {
  readonly provider = 'xero';
  constructor(readonly mode: AdapterMode, private readonly cfg: { accessToken: string; tenantId: string; baseUrl?: string }, private readonly fetchImpl: typeof fetch = fetch) {}

  private headers(idem: string) {
    if (!this.cfg.accessToken || !this.cfg.tenantId) return notConfigured('xero', this.mode);
    return { Authorization: `Bearer ${this.cfg.accessToken}`, 'xero-tenant-id': this.cfg.tenantId, 'Idempotency-Key': idem, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  async pushJournal(_ctx: AdapterContext, j: DailyJournal) {
    const headers = this.headers(j.idempotencyKey);
    assertBalanced(j);
    const body = { ManualJournals: [{
      Narration: j.narration, Date: j.date, Status: 'DRAFT', LineAmountTypes: 'NoTax',
      // Xero: positive LineAmount = debit, negative = credit
      JournalLines: j.lines.map((l) => ({ AccountCode: l.accountCode, LineAmount: l.debitCents > 0n ? centsToDecimal(l.debitCents) : `-${centsToDecimal(l.creditCents)}`, Description: l.description })),
    }] };
    const res = await this.fetchImpl(`${this.cfg.baseUrl ?? 'https://api.xero.com'}/api.xro/2.0/ManualJournals`, { method: 'PUT', headers, body: JSON.stringify(body) } as any);
    if (!res.ok) throw new AdapterError('xero', `HTTP_${res.status}`, await res.text(), res.status >= 500 || res.status === 429, res.status);
    const out: any = await res.json();
    return { providerRef: String(out.ManualJournals?.[0]?.ManualJournalID ?? ''), duplicate: false };
  }

  async createFeeInvoice(): Promise<{ providerRef: string }> {
    throw new AdapterError('xero', 'FEE_INVOICES_DISABLED', 'fee invoices are disabled pending tax advice (D-24)');
  }

  async health(): Promise<HealthCheck> {
    return { provider: 'xero', mode: this.mode, ok: Boolean(this.cfg.accessToken && this.cfg.tenantId), detail: this.cfg.accessToken ? undefined : 'XERO_ACCESS_TOKEN / XERO_TENANT_ID not set' };
  }
}
