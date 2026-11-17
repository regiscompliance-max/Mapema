/**
 * [QA Engineer] In-memory ledger test double. Mirrors the Fineract product semantics proven in
 * test/fineract.live.test.ts: declining-balance daily interest on a 360-day year, interest on
 * actual days (capped by the scheduled term), strict principal -> fees -> interest allocation,
 * cash-based journals. Used in unit/API tests and local dev when Fineract isn't running.
 */
import { Cents, daysBetween, divHalfUp } from '@mapema/pricing';
import { AdapterContext, AdapterError, HealthCheck } from './common';
import { LedgerAdapter, LedgerGl, LedgerLoanRequest, LedgerLoanState, LedgerRepayment } from './ledger';

interface MockLoan {
  id: number;
  externalId: string;
  req: LedgerLoanRequest;
  principalPaid: Cents;
  feesPaid: Cents;
  interestPaid: Cents;
  // accrued interest numerator in (cents * bps * days) units, settled at each event
  accruedNum: bigint;
  lastEventDate: string;
  status: LedgerLoanState['status'];
  txns: Map<string, LedgerRepayment>;
}

export class MockLedger implements LedgerAdapter {
  readonly mode = 'mock' as const;
  private nextClient = 1;
  private nextLoan = 1;
  private nextTxn = 1;
  private clients = new Map<string, number>();
  private loans = new Map<number, MockLoan>();
  private gl = new Map<LedgerGl, Cents>();
  public failNext: string | null = null; // test hook: 'bookAdvance' | 'repay'

  async ensureSetup() {
    return { productId: 1, verificationChargeId: 1 };
  }

  private post(debit: LedgerGl, credit: LedgerGl, amt: Cents) {
    if (amt === 0n) return;
    this.gl.set(debit, (this.gl.get(debit) ?? 0n) + amt);
    this.gl.set(credit, (this.gl.get(credit) ?? 0n) - amt);
  }

  async createClient(_ctx: AdapterContext, org: { externalId: string }) {
    const ex = this.clients.get(org.externalId);
    if (ex) return ex;
    const id = this.nextClient++;
    this.clients.set(org.externalId, id);
    return id;
  }

  async bookAdvance(_ctx: AdapterContext, req: LedgerLoanRequest) {
    if (this.failNext === 'bookAdvance') {
      this.failNext = null;
      throw new AdapterError('ledger-mock', 'HTTP_503', 'simulated ledger outage', true, 503);
    }
    const existing = [...this.loans.values()].find((l) => l.externalId === req.externalId);
    if (existing) return { loanId: existing.id, scheduledInterestCents: this.scheduledInterest(existing) };
    const id = this.nextLoan++;
    const loan: MockLoan = {
      id, externalId: req.externalId, req, principalPaid: 0n, feesPaid: 0n, interestPaid: 0n,
      accruedNum: 0n, lastEventDate: req.disbursementDate, status: 'active', txns: new Map(),
    };
    this.loans.set(id, loan);
    this.post('loanPortfolio', 'bank', req.principalCents);
    return { loanId: id, scheduledInterestCents: this.scheduledInterest(loan) };
  }

  private scheduledInterest(l: MockLoan): Cents {
    return divHalfUp(l.req.principalCents * BigInt(l.req.rateBpsPer30d) * BigInt(l.req.days), 300000n);
  }

  /** accrue interest on outstanding principal from lastEventDate to `date` (capped at due date) */
  private accrueTo(l: MockLoan, date: string) {
    const end = date < l.req.dueDate ? date : l.req.dueDate;
    if (end <= l.lastEventDate) return;
    const days = daysBetween(l.lastEventDate, end);
    l.accruedNum += (l.req.principalCents - l.principalPaid) * BigInt(l.req.rateBpsPer30d) * BigInt(days);
    l.lastEventDate = end;
  }

  private interestCharged(l: MockLoan, date: string): Cents {
    // before maturity with principal still out, Fineract shows the full schedule; once principal is
    // repaid (or at/after maturity) interest is what actually accrued
    const accrued = divHalfUp(l.accruedNum, 300000n);
    if (l.principalPaid < l.req.principalCents && date < l.req.dueDate) return this.scheduledInterest(l);
    return accrued;
  }

  async undoDisbursal(_ctx: AdapterContext, loanId: number) {
    const l = this.mustLoan(loanId);
    if (l.principalPaid > 0n) throw new AdapterError('ledger-mock', 'HTTP_403', 'loan has repayments');
    this.post('bank', 'loanPortfolio', l.req.principalCents);
    l.status = 'approved';
  }

  async repay(_ctx: AdapterContext, loanId: number, amountCents: Cents, date: string, externalId: string): Promise<LedgerRepayment> {
    if (this.failNext === 'repay') {
      this.failNext = null;
      throw new AdapterError('ledger-mock', 'NETWORK', 'simulated timeout', true);
    }
    const l = this.mustLoan(loanId);
    const seen = l.txns.get(externalId);
    if (seen) return seen;
    this.accrueTo(l, date);
    let left = amountCents;
    const take = (owed: Cents) => {
      const x = left < owed ? left : owed;
      left -= x;
      return x;
    };
    const principal = take(l.req.principalCents - l.principalPaid);
    l.principalPaid += principal;
    const fees = take(l.req.verificationFeeCents - l.feesPaid);
    l.feesPaid += fees;
    const interest = take(this.interestCharged(l, date) - l.interestPaid);
    l.interestPaid += interest;
    const r: LedgerRepayment = {
      transactionId: this.nextTxn++, amountCents, principalCents: principal, feesCents: fees, penaltiesCents: 0n,
      interestCents: interest, overpaymentCents: left,
    };
    this.post('bank', 'loanPortfolio', principal);
    this.post('bank', 'feeIncome', fees);
    this.post('bank', 'interestIncome', interest);
    this.post('bank', 'overpayment', left);
    l.txns.set(externalId, r);
    const st = await this.getLoan(loanId, date);
    l.status = st.totalOutstandingCents === 0n ? (left > 0n ? 'overpaid' : 'closed') : 'active';
    return r;
  }

  async payoffQuote(loanId: number, date: string) {
    const l = this.mustLoan(loanId);
    const copy: MockLoan = { ...l };
    this.accrueTo(copy, date);
    // payoff = principal now, interest accrued to date
    const interest = divHalfUp(copy.accruedNum, 300000n) - l.interestPaid;
    const principal = l.req.principalCents - l.principalPaid;
    const fees = l.req.verificationFeeCents - l.feesPaid;
    return { totalCents: principal + fees + interest, principalCents: principal, feesCents: fees, interestCents: interest };
  }

  async getLoan(loanId: number, asOf?: string): Promise<LedgerLoanState> {
    const l = this.mustLoan(loanId);
    const date = asOf ?? l.lastEventDate;
    const interestCharged = this.interestCharged(l, date);
    const p = l.req.principalCents - l.principalPaid;
    const f = l.req.verificationFeeCents - l.feesPaid;
    const i = interestCharged - l.interestPaid;
    return {
      loanId, status: l.status, principalOutstandingCents: p, feesOutstandingCents: f, penaltiesOutstandingCents: 0n,
      interestOutstandingCents: i, interestChargedCents: interestCharged, totalOutstandingCents: p + f + i,
    };
  }

  async postJournal(_ctx: AdapterContext, j: { debit: LedgerGl; credit: LedgerGl; amountCents: Cents }) {
    this.post(j.debit, j.credit, j.amountCents);
    return `mock-je-${this.nextTxn++}`;
  }

  async glBalance(key: LedgerGl) {
    return this.gl.get(key) ?? 0n;
  }

  async trialBalance() {
    const keys: LedgerGl[] = ['bank', 'loanPortfolio', 'suspense', 'supplierPayable', 'overpayment', 'equity', 'interestIncome', 'feeIncome', 'penaltyIncome', 'recoveryIncome', 'writeOff'];
    return Object.fromEntries(keys.map((k) => [k, this.gl.get(k) ?? 0n])) as Record<LedgerGl, Cents>;
  }

  async writeOff(_ctx: AdapterContext, loanId: number) {
    const l = this.mustLoan(loanId);
    const out = l.req.principalCents - l.principalPaid;
    this.post('writeOff', 'loanPortfolio', out);
    l.status = 'written_off';
  }

  async health(): Promise<HealthCheck> {
    return { provider: 'ledger-mock', mode: 'mock', ok: true };
  }

  private mustLoan(id: number) {
    const l = this.loans.get(id);
    if (!l) throw new AdapterError('ledger-mock', 'HTTP_404', `loan ${id} not found`, false, 404);
    return l;
  }
}
