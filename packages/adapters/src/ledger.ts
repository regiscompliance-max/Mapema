/**
 * [Integration Engineer + Backend Engineer] Ledger adapter. Apache Fineract is the system of
 * record for money (brief rule 4: never a custom ledger). The platform only keeps workflow state
 * and Fineract ids; balances are read back from Fineract.
 *
 * Product design proven against a real Fineract 1.16.1 (see test/fineract.live.test.ts):
 *  - one loan per advance, single instalment, term = days to due date
 *  - interest 3.5% per 30 days == 42% p.a. on a 360-day year, daily, declining balance
 *  - PROGRESSIVE schedule + interest recalculation (interest on actual days, D-03)
 *  - advanced payment allocation, VERTICAL processing, order
 *      principal (past due, due, in advance) -> fees -> penalties -> interest   (CBK order)
 *  - verification fee = flat loan charge due on the due date
 */
import { Cents } from '@mapema/pricing';
import { AdapterContext, AdapterMode, HealthCheck } from './common';

export type LedgerGl =
  | 'bank' | 'loanPortfolio' | 'suspense' | 'supplierPayable' | 'overpayment' | 'equity'
  | 'interestIncome' | 'feeIncome' | 'penaltyIncome' | 'recoveryIncome' | 'writeOff';

export interface LedgerLoanRequest {
  externalId: string; // = advance id (idempotency in Fineract)
  clientId: number;
  principalCents: Cents;
  rateBpsPer30d: number;
  days: number;
  disbursementDate: string; // ISO date (EAT)
  dueDate: string;
  verificationFeeCents: Cents;
}

export interface LedgerLoanState {
  loanId: number;
  status: 'approved' | 'active' | 'closed' | 'overpaid' | 'written_off' | 'other';
  principalOutstandingCents: Cents;
  feesOutstandingCents: Cents;
  penaltiesOutstandingCents: Cents;
  interestOutstandingCents: Cents;
  interestChargedCents: Cents;
  totalOutstandingCents: Cents;
}

export interface LedgerRepayment {
  transactionId: number;
  amountCents: Cents;
  principalCents: Cents;
  feesCents: Cents;
  penaltiesCents: Cents;
  interestCents: Cents;
  overpaymentCents: Cents;
}

export interface LedgerAdapter {
  readonly mode: AdapterMode;
  ensureSetup(): Promise<{ productId: number; verificationChargeId: number }>;
  createClient(ctx: AdapterContext, org: { externalId: string; legalName: string; activationDate: string }): Promise<number>;
  bookAdvance(ctx: AdapterContext, req: LedgerLoanRequest): Promise<{ loanId: number; scheduledInterestCents: Cents }>;
  undoDisbursal(ctx: AdapterContext, loanId: number): Promise<void>;
  repay(ctx: AdapterContext, loanId: number, amountCents: Cents, date: string, externalId: string): Promise<LedgerRepayment>;
  payoffQuote(loanId: number, date: string): Promise<{ totalCents: Cents; principalCents: Cents; feesCents: Cents; interestCents: Cents }>;
  getLoan(loanId: number): Promise<LedgerLoanState>;
  postJournal(ctx: AdapterContext, j: { date: string; debit: LedgerGl; credit: LedgerGl; amountCents: Cents; reference: string; note: string }): Promise<string>;
  glBalance(key: LedgerGl): Promise<Cents>;
  trialBalance(): Promise<Record<LedgerGl, Cents>>;
  writeOff(ctx: AdapterContext, loanId: number, date: string, note: string): Promise<void>;
  health(): Promise<HealthCheck>;
}
