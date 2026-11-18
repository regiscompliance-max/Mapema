/**
 * [Integration Engineer] Apache Fineract ledger gateway (REST API v1, tenant header, basic auth
 * for the service account; production should use the OAuth2 resource-server mode).
 */
import { Cents } from '@mapema/pricing';
import { AdapterContext, AdapterError, AdapterMode, centsToDecimal, decimalToCents, HealthCheck } from './common';
import { LedgerAdapter, LedgerLoanRequest, LedgerLoanState, LedgerRepayment } from './ledger';

export interface FineractConfig {
  baseUrl: string; // e.g. http://localhost:8443/fineract-provider/api/v1
  tenant: string;
  username: string;
  password: string;
  mode?: AdapterMode;
  timeoutMs?: number;
}

export const PRODUCT_SHORT_NAME = 'MPA1';
export const PRODUCT_NAME = 'Mapema Supplier Advance (P-F-I)';
export const VERIFICATION_CHARGE_NAME = 'Mapema verification fee';

/** CBK order: principal -> fees and charges (fees, then penalties) -> interest. */
export const CBK_ALLOCATION_ORDER = [
  'PAST_DUE_PRINCIPAL', 'DUE_PRINCIPAL', 'IN_ADVANCE_PRINCIPAL',
  'PAST_DUE_FEE', 'DUE_FEE', 'IN_ADVANCE_FEE',
  'PAST_DUE_PENALTY', 'DUE_PENALTY', 'IN_ADVANCE_PENALTY',
  'PAST_DUE_INTEREST', 'DUE_INTEREST', 'IN_ADVANCE_INTEREST',
] as const;

/** 3.5% per 30 days -> 42.00 % p.a. on a 360-day year (exact for any bps). */
export function annualRateFromBpsPer30d(bps: number): string {
  const annualBps = bps * 12; // 30-day months * 12 = 360-day year
  return `${Math.trunc(annualBps / 100)}.${String(annualBps % 100).padStart(2, '0')}`;
}

type Json = Record<string, any>;

/** Mapema chart of accounts in Fineract (cash-based accounting). Codes are Mapema's own. */
export const GL_ACCOUNTS = {
  bank: { glCode: '1100', name: 'Bank - collection and disbursement accounts', type: 1 },
  loanPortfolio: { glCode: '1200', name: 'Supplier advances (loan portfolio)', type: 1 },
  suspense: { glCode: '1300', name: 'Transfers in suspense', type: 1 },
  supplierPayable: { glCode: '2100', name: 'Deferred purchase price payable to suppliers', type: 2 },
  overpayment: { glCode: '2200', name: 'Buyer overpayments (refundable)', type: 2 },
  equity: { glCode: '3100', name: 'Lending float - capital and facility', type: 3 },
  interestIncome: { glCode: '4100', name: 'Discount fee income (interest)', type: 4 },
  feeIncome: { glCode: '4200', name: 'Verification fee income', type: 4 },
  penaltyIncome: { glCode: '4300', name: 'Penalty income', type: 4 },
  recoveryIncome: { glCode: '4400', name: 'Recoveries of written-off advances', type: 4 },
  writeOff: { glCode: '5100', name: 'Losses written off', type: 5 },
} as const;
export type GlKey = keyof typeof GL_ACCOUNTS;

export class FineractLedger implements LedgerAdapter {
  readonly mode: AdapterMode;
  private setup?: { productId: number; verificationChargeId: number; gl: Record<GlKey, number> };

  constructor(private readonly cfg: FineractConfig) {
    this.mode = cfg.mode ?? 'sandbox';
  }

  private async call(method: string, path: string, body?: unknown): Promise<Json> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 20000);
    try {
      const res = await fetch(this.cfg.baseUrl + path, {
        method,
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Fineract-Platform-TenantId': this.cfg.tenant,
          Authorization: 'Basic ' + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64'),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const msg = json?.errors?.[0]?.defaultUserMessage ?? json?.defaultUserMessage ?? text.slice(0, 300);
        throw new AdapterError('fineract', `HTTP_${res.status}`, msg, res.status >= 500, res.status);
      }
      return json;
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      throw new AdapterError('fineract', 'NETWORK', (e as Error).message, true);
    } finally {
      clearTimeout(t);
    }
  }

  private static D = { locale: 'en', dateFormat: 'yyyy-MM-dd' };

  async ensureSetup() {
    if (this.setup) return this.setup;
    // 1. KES enabled as an organisation currency (keep any already enabled)
    const cur = await this.call('GET', '/currencies');
    const selected: string[] = (cur.selectedCurrencyOptions ?? []).map((c: Json) => c.code);
    if (!selected.includes('KES')) await this.call('PUT', '/currencies', { currencies: [...selected, 'KES'] });

    // 2. Chart of accounts (idempotent by glCode)
    const existingGl = (await this.call('GET', '/glaccounts')) as unknown as Json[];
    const gl = {} as Record<GlKey, number>;
    for (const [key, a] of Object.entries(GL_ACCOUNTS) as [GlKey, (typeof GL_ACCOUNTS)[GlKey]][]) {
      const found = existingGl.find((g) => g.glCode === a.glCode);
      gl[key] = found
        ? Number(found.id)
        : Number((await this.call('POST', '/glaccounts', { name: a.name, glCode: a.glCode, type: a.type, usage: 1, manualEntriesAllowed: true })).resourceId);
    }

    // 3. Verification fee charge (flat, specified due date)
    const charges = (await this.call('GET', '/charges')) as unknown as Json[];
    let charge = charges.find((c) => c.name === VERIFICATION_CHARGE_NAME);
    if (!charge) {
      const r = await this.call('POST', '/charges', {
        name: VERIFICATION_CHARGE_NAME, currencyCode: 'KES', chargeAppliesTo: 1, chargeTimeType: 2,
        chargeCalculationType: 1, chargePaymentMode: 0, amount: '2500.00', active: true, penalty: false, locale: 'en',
      });
      charge = { id: r.resourceId };
    }

    // 4. Loan product
    const products = (await this.call('GET', '/loanproducts')) as unknown as Json[];
    let product = products.find((p) => p.shortName === PRODUCT_SHORT_NAME);
    if (!product) {
      const r = await this.call('POST', '/loanproducts', {
        name: PRODUCT_NAME, shortName: PRODUCT_SHORT_NAME, currencyCode: 'KES', digitsAfterDecimal: 2, inMultiplesOf: 0,
        principal: '800000.00', minPrincipal: '1.00', maxPrincipal: '1000000000.00',
        numberOfRepayments: 1, repaymentEvery: 48, repaymentFrequencyType: 0,
        interestRatePerPeriod: '42.00', interestRateFrequencyType: 3,
        amortizationType: 1, interestType: 0, interestCalculationPeriodType: 0,
        daysInMonthType: 30, daysInYearType: 360,
        isInterestRecalculationEnabled: true, interestRecalculationCompoundingMethod: 0, rescheduleStrategyMethod: 4,
        recalculationRestFrequencyType: 2, recalculationRestFrequencyInterval: 1, preClosureInterestCalculationStrategy: 1,
        isArrearsBasedOnOriginalSchedule: false,
        accountingRule: 2, // cash based
        fundSourceAccountId: gl.bank, loanPortfolioAccountId: gl.loanPortfolio, transfersInSuspenseAccountId: gl.suspense,
        interestOnLoanAccountId: gl.interestIncome, incomeFromFeeAccountId: gl.feeIncome, incomeFromPenaltyAccountId: gl.penaltyIncome,
        incomeFromRecoveryAccountId: gl.recoveryIncome, writeOffAccountId: gl.writeOff, overpaymentLiabilityAccountId: gl.overpayment,
        transactionProcessingStrategyCode: 'advanced-payment-allocation-strategy',
        loanScheduleType: 'PROGRESSIVE', loanScheduleProcessingType: 'VERTICAL',
        paymentAllocation: [{
          transactionType: 'DEFAULT',
          paymentAllocationOrder: CBK_ALLOCATION_ORDER.map((r, i) => ({ paymentAllocationRule: r, order: i + 1 })),
          futureInstallmentAllocationRule: 'NEXT_INSTALLMENT',
        }],
        ...FineractLedger.D,
      });
      product = { id: r.resourceId };
    }
    this.setup = { productId: Number(product.id), verificationChargeId: Number(charge.id), gl };
    return this.setup;
  }

  async createClient(_ctx: AdapterContext, org: { externalId: string; legalName: string; activationDate: string }) {
    try {
      const existing = await this.call('GET', `/clients/external-id/${encodeURIComponent(org.externalId)}`);
      if (existing?.id) return Number(existing.id);
    } catch (e) {
      if (!(e instanceof AdapterError) || e.httpStatus !== 404) throw e;
    }
    const r = await this.call('POST', '/clients', {
      officeId: 1, legalFormId: 2, fullname: org.legalName.slice(0, 100), active: true,
      activationDate: org.activationDate, submittedOnDate: org.activationDate, externalId: org.externalId, ...FineractLedger.D,
    });
    return Number(r.clientId);
  }

  async bookAdvance(_ctx: AdapterContext, req: LedgerLoanRequest) {
    const { productId, verificationChargeId } = await this.ensureSetup();
    const rate = annualRateFromBpsPer30d(req.rateBpsPer30d);
    let loanId: number | undefined;
    try {
      const ex = await this.call('GET', `/loans/external-id/${encodeURIComponent(req.externalId)}`);
      loanId = Number(ex.id);
    } catch (e) {
      if (!(e instanceof AdapterError) || e.httpStatus !== 404) throw e;
    }
    if (!loanId) {
      const r = await this.call('POST', '/loans', {
        clientId: req.clientId, productId, externalId: req.externalId, loanType: 'individual', ...(req.fundId ? { fundId: req.fundId } : {}),
        principal: centsToDecimal(req.principalCents),
        loanTermFrequency: req.days, loanTermFrequencyType: 0, numberOfRepayments: 1, repaymentEvery: req.days, repaymentFrequencyType: 0,
        interestRatePerPeriod: rate, interestType: 0, interestCalculationPeriodType: 0, amortizationType: 1,
        transactionProcessingStrategyCode: 'advanced-payment-allocation-strategy',
        expectedDisbursementDate: req.disbursementDate, submittedOnDate: req.disbursementDate,
        charges: req.verificationFeeCents > 0n
          ? [{ chargeId: verificationChargeId, amount: centsToDecimal(req.verificationFeeCents), dueDate: req.dueDate }]
          : [],
        ...FineractLedger.D,
      });
      loanId = Number(r.loanId);
    }
    const state = await this.call('GET', `/loans/${loanId}`);
    const status: string = state.status?.code ?? '';
    if (status === 'loanStatusType.submitted.and.pending.approval') {
      await this.call('POST', `/loans/${loanId}?command=approve`, { approvedOnDate: req.disbursementDate, ...FineractLedger.D });
    }
    if (status !== 'loanStatusType.active') {
      await this.call('POST', `/loans/${loanId}?command=disburse`, {
        actualDisbursementDate: req.disbursementDate, transactionAmount: centsToDecimal(req.principalCents), ...FineractLedger.D,
      });
    }
    const after = await this.getLoan(loanId);
    return { loanId, scheduledInterestCents: after.interestChargedCents };
  }

  // ---------------------------------------------------------------- Phase 3 funding sources
  static readonly TAG_TABLE = 'mapema_funding_tag';
  private tagTableReady = false;
  async ensureFund(code: string, name: string): Promise<number> {
    const externalId = `mapema-fund-${code}`;
    const funds = (await this.call('GET', '/funds')) as unknown as Json[];
    const found = funds.find((f) => f.externalId === externalId);
    if (found) return Number(found.id);
    const r = await this.call('POST', '/funds', { name: `${name} (${code})`.slice(0, 100), externalId });
    return Number(r.resourceId);
  }
  private async ensureTagTable() {
    if (this.tagTableReady) return;
    // GET /datatables/{name} answers 204 (not 404) for a missing table, so look in the list
    const all = (await this.call('GET', '/datatables')) as unknown as Json[];
    if (!all.some((t) => t.registeredTableName === FineractLedger.TAG_TABLE)) {
      await this.call('POST', '/datatables', { datatableName: FineractLedger.TAG_TABLE, apptableName: 'm_loan', multiRow: false,
        columns: [{ name: 'tag_code', type: 'String', length: 24, mandatory: true }, { name: 'tagged_on', type: 'Date', mandatory: true }] });
    }
    this.tagTableReady = true;
  }
  async setFundingTag(loanId: number, code: string, date: string) {
    await this.ensureTagTable();
    const body = { tag_code: code, tagged_on: date, dateFormat: 'yyyy-MM-dd', locale: 'en' };
    const cur = (await this.call('GET', `/datatables/${FineractLedger.TAG_TABLE}/${loanId}`)) as unknown as Json[];
    if (Array.isArray(cur) && cur.length) await this.call('PUT', `/datatables/${FineractLedger.TAG_TABLE}/${loanId}`, body);
    else await this.call('POST', `/datatables/${FineractLedger.TAG_TABLE}/${loanId}`, body);
  }
  async getFundingTag(loanId: number) {
    await this.ensureTagTable();
    const loan = await this.call('GET', `/loans/${loanId}`);
    const cur = (await this.call('GET', `/datatables/${FineractLedger.TAG_TABLE}/${loanId}`)) as unknown as Json[];
    return { fundId: loan.fundId ? Number(loan.fundId) : null, tagCode: Array.isArray(cur) && cur[0] ? String(cur[0].tag_code) : null };
  }

  async undoDisbursal(_ctx: AdapterContext, loanId: number) {
    await this.call('POST', `/loans/${loanId}?command=undodisbursal`, {});
  }

  async repay(_ctx: AdapterContext, loanId: number, amountCents: Cents, date: string, externalId: string): Promise<LedgerRepayment> {
    let txnId: number;
    try {
      const r = await this.call('POST', `/loans/${loanId}/transactions?command=repayment`, {
        transactionDate: date, transactionAmount: centsToDecimal(amountCents), paymentTypeId: 1, externalId, ...FineractLedger.D,
      });
      txnId = Number(r.resourceId);
    } catch (e) {
      // idempotent retry: same externalId already posted
      if (e instanceof AdapterError && (e.httpStatus === 403 || e.httpStatus === 409) && /external/i.test(e.message)) {
        const t = await this.call('GET', `/loans/${loanId}/transactions/external-id/${encodeURIComponent(externalId)}`);
        txnId = Number(t.id);
      } else throw e;
    }
    const t = await this.call('GET', `/loans/${loanId}/transactions/${txnId}`);
    return {
      transactionId: txnId,
      amountCents: decimalToCents(t.amount),
      principalCents: decimalToCents(t.principalPortion),
      feesCents: decimalToCents(t.feeChargesPortion),
      penaltiesCents: decimalToCents(t.penaltyChargesPortion),
      interestCents: decimalToCents(t.interestPortion),
      overpaymentCents: decimalToCents(t.overpaymentPortion),
    };
  }

  async payoffQuote(loanId: number, date: string) {
    const t = await this.call('GET', `/loans/${loanId}/transactions/template?command=prepayLoan&transactionDate=${date}&dateFormat=yyyy-MM-dd&locale=en`);
    return {
      totalCents: decimalToCents(t.amount),
      principalCents: decimalToCents(t.principalPortion),
      feesCents: decimalToCents(t.feeChargesPortion),
      interestCents: decimalToCents(t.interestPortion),
    };
  }

  async getLoan(loanId: number): Promise<LedgerLoanState> {
    const d = await this.call('GET', `/loans/${loanId}`);
    const s = d.summary ?? {};
    const code: string = d.status?.code ?? '';
    const status: LedgerLoanState['status'] = code.includes('active') ? 'active'
      : code.includes('closed.obligations') ? 'closed'
      : code.includes('overpaid') ? 'overpaid'
      : code.includes('written') ? 'written_off'
      : code.includes('approved') ? 'approved' : 'other';
    return {
      loanId,
      status,
      principalOutstandingCents: decimalToCents(s.principalOutstanding),
      feesOutstandingCents: decimalToCents(s.feeChargesOutstanding),
      penaltiesOutstandingCents: decimalToCents(s.penaltyChargesOutstanding),
      interestOutstandingCents: decimalToCents(s.interestOutstanding),
      interestChargedCents: decimalToCents(s.interestCharged),
      interestWaivedCents: decimalToCents(s.interestWaived ?? 0),
      totalOutstandingCents: decimalToCents(s.totalOutstanding),
    };
  }

  async writeOff(_ctx: AdapterContext, loanId: number, date: string, note: string) {
    await this.call('POST', `/loans/${loanId}/transactions?command=writeoff`, { transactionDate: date, note, ...FineractLedger.D });
  }

  /** In duplum waiver (COL-03): Fineract `waiveinterest` loan transaction; principal is untouched. */
  async waiveInterest(_ctx: AdapterContext, loanId: number, amountCents: Cents, date: string, note: string, externalId?: string) {
    const r = await this.call('POST', `/loans/${loanId}/transactions?command=waiveinterest`, {
      transactionDate: date, transactionAmount: centsToDecimal(amountCents), note, ...(externalId ? { externalId } : {}), ...FineractLedger.D,
    });
    return String(r.resourceId ?? r.transactionId ?? '');
  }

  /** Manual journal for money that is not loan repayment (supplier deferred price, float funding, refunds). */
  async postJournal(_ctx: AdapterContext, j: { date: string; debit: GlKey; credit: GlKey; amountCents: Cents; reference: string; note: string }) {
    const { gl } = await this.ensureSetup();
    const amount = centsToDecimal(j.amountCents);
    const r = await this.call('POST', '/journalentries', {
      officeId: 1, transactionDate: j.date, currencyCode: 'KES', referenceNumber: j.reference, comments: j.note,
      debits: [{ glAccountId: gl[j.debit], amount }], credits: [{ glAccountId: gl[j.credit], amount }], ...FineractLedger.D,
    });
    return String(r.transactionId ?? r.resourceId);
  }

  /** Net balance (debits - credits) of a GL account from Fineract journal entries. */
  async glBalance(key: GlKey): Promise<Cents> {
    const { gl } = await this.ensureSetup();
    let offset = 0;
    let total = 0n;
    for (;;) {
      const page = await this.call('GET', `/journalentries?glAccountId=${gl[key]}&offset=${offset}&limit=500`);
      const items: Json[] = page.pageItems ?? [];
      for (const e of items) {
        const amt = decimalToCents(e.amount);
        total += e.entryType?.value === 'DEBIT' || e.entryType?.code === 'journalEntryType.debit' ? amt : -amt;
      }
      offset += items.length;
      if (items.length === 0 || offset >= Number(page.totalFilteredRecords ?? 0)) break;
    }
    return total;
  }

  /** Trial balance: net balance per Mapema GL account. */
  async trialBalance(): Promise<Record<GlKey, Cents>> {
    const out = {} as Record<GlKey, Cents>;
    for (const k of Object.keys(GL_ACCOUNTS) as GlKey[]) out[k] = await this.glBalance(k);
    return out;
  }

  async health(): Promise<HealthCheck> {
    try {
      await this.call('GET', '/offices');
      return { provider: 'fineract', mode: this.mode, ok: true };
    } catch (e) {
      return { provider: 'fineract', mode: this.mode, ok: false, detail: (e as Error).message };
    }
  }
}
