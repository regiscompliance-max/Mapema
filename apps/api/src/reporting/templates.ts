/**
 * [Compliance & Risk Analyst + Technical Writer] DEFAULT report templates (Phase 2 RPT-02/03/04).
 *
 * IMPORTANT - these layouts are ASSUMPTIONS. CBK has not supplied the NDTCP monthly return format to
 * Mapema and no CRB data-submission specification has been obtained. Field codes and labels here are
 * Mapema's own working layout, NOT official field definitions; every label says "(assumed)". Output
 * generated from an `assumed_draft` template is stamped DRAFT and must not be submitted.
 * When the official formats arrive, compliance loads them as a new template version (status
 * `official`, sourceRef = the document reference) and the CEO approves it (maker-checker).
 */
export type Fmt = 'kes' | 'int' | 'text' | 'pct_bps' | 'date';
export interface ReturnField { section: string; code: string; label: string; path: string; format: Fmt }
export interface ReturnMapping { type: 'return'; fields: ReturnField[] }
export interface FileColumn { name: string; path?: string; const?: string; format: Fmt }
export interface FileMapping { type: 'file'; recordSource: 'loans'; columns: FileColumn[] }
export interface PackMapping { type: 'pack'; tapeColumns: FileColumn[]; summary: ReturnField[] }

const A = ' (assumed)';
export const CBK_RETURN_ASSUMED: ReturnMapping = {
  type: 'return',
  fields: [
    { section: 'A Institution', code: 'A01', label: `Lender name${A}`, path: 'lender.name', format: 'text' },
    { section: 'A Institution', code: 'A02', label: `CBK licence number${A}`, path: 'lender.licence', format: 'text' },
    { section: 'A Institution', code: 'A03', label: `Reporting period${A}`, path: 'period', format: 'text' },
    { section: 'A Institution', code: 'A04', label: `Reporting date (month end)${A}`, path: 'asOfDate', format: 'date' },
    { section: 'B Portfolio', code: 'B01', label: `Number of loans outstanding${A}`, path: 'aggregates.loansOutstanding.count', format: 'int' },
    { section: 'B Portfolio', code: 'B02', label: `Gross loans outstanding (principal)${A}`, path: 'aggregates.loansOutstanding.principalCents', format: 'kes' },
    { section: 'B Portfolio', code: 'B03', label: `Number of borrowers with loans outstanding${A}`, path: 'aggregates.borrowersOutstanding', format: 'int' },
    { section: 'B Portfolio', code: 'B04', label: `Number of loans disbursed in the month${A}`, path: 'aggregates.disbursedInMonth.count', format: 'int' },
    { section: 'B Portfolio', code: 'B05', label: `Value of loans disbursed in the month${A}`, path: 'aggregates.disbursedInMonth.principalCents', format: 'kes' },
    { section: 'B Portfolio', code: 'B06', label: `Principal repaid in the month${A}`, path: 'aggregates.repaidInMonth.principalCents', format: 'kes' },
    { section: 'C Income', code: 'C01', label: `Interest income received in the month (cash basis)${A}`, path: 'aggregates.incomeInMonth.interestCents', format: 'kes' },
    { section: 'C Income', code: 'C02', label: `Fee income received in the month (cash basis)${A}`, path: 'aggregates.incomeInMonth.feesCents', format: 'kes' },
    { section: 'C Income', code: 'C03', label: `Bank share of income in the month (model A)${A}`, path: 'aggregates.incomeInMonth.bankShareCents', format: 'kes' },
    { section: 'C Income', code: 'C04', label: `Mapema platform fee in the month${A}`, path: 'aggregates.incomeInMonth.mapemaPlatformFeeCents', format: 'kes' },
    { section: 'C Income', code: 'C05', label: `VAT 16% on Mapema's fee to the bank (pending counsel)${A}`, path: 'aggregates.incomeInMonth.mapemaVatCents', format: 'kes' },
    { section: 'D Asset quality', code: 'D01', label: `Principal current (0 DPD)${A}`, path: 'aggregates.ageing.current.principalCents', format: 'kes' },
    { section: 'D Asset quality', code: 'D02', label: `Principal 1-30 DPD${A}`, path: 'aggregates.ageing.dpd_1_30.principalCents', format: 'kes' },
    { section: 'D Asset quality', code: 'D03', label: `Principal 31-60 DPD${A}`, path: 'aggregates.ageing.dpd_31_60.principalCents', format: 'kes' },
    { section: 'D Asset quality', code: 'D04', label: `Principal 61-90 DPD${A}`, path: 'aggregates.ageing.dpd_61_90.principalCents', format: 'kes' },
    { section: 'D Asset quality', code: 'D05', label: `Principal over 90 DPD${A}`, path: 'aggregates.ageing.dpd_91_plus.principalCents', format: 'kes' },
    { section: 'D Asset quality', code: 'D06', label: `Non-performing loans (principal)${A}`, path: 'aggregates.statusAtMonthEnd.non_performing.principalCents', format: 'kes' },
    { section: 'D Asset quality', code: 'D07', label: `NPL ratio${A}`, path: 'aggregates.nplRatioBps', format: 'pct_bps' },
    { section: 'D Asset quality', code: 'D08', label: `Loans written off in the month (principal)${A}`, path: 'aggregates.writtenOffInMonth.principalCents', format: 'kes' },
    { section: 'D Asset quality', code: 'D09', label: `Interest waived under the in duplum rule in the month${A}`, path: 'aggregates.inDuplumWaivedInMonthCents', format: 'kes' },
    { section: 'E Concentration', code: 'E01', label: `Largest single buyer exposure as % of lending float${A}`, path: 'aggregates.concentration.largestBuyerBps', format: 'pct_bps' },
    { section: 'E Concentration', code: 'E02', label: `Largest single supplier exposure as % of lending float${A}`, path: 'aggregates.concentration.largestSupplierBps', format: 'pct_bps' },
    { section: 'E Concentration', code: 'E03', label: `Largest sector exposure as % of lending float${A}`, path: 'aggregates.concentration.largestSectorBps', format: 'pct_bps' },
    { section: 'F Consumer protection', code: 'F01', label: `Complaints received in the month${A}`, path: 'aggregates.complaints.received', format: 'int' },
    { section: 'F Consumer protection', code: 'F02', label: `Complaints resolved in the month${A}`, path: 'aggregates.complaints.resolved', format: 'int' },
    { section: 'F Consumer protection', code: 'F03', label: `Complaints open at month end${A}`, path: 'aggregates.complaints.openAtMonthEnd', format: 'int' },
    { section: 'G Pricing', code: 'G01', label: `Active pricing version and CBK approval reference${A}`, path: 'pricing.label', format: 'text' },
  ],
};

export const CRB_FILE_ASSUMED: FileMapping = {
  type: 'file', recordSource: 'loans',
  columns: [
    { name: 'record_type', const: 'FACILITY', format: 'text' },
    { name: 'reporting_date', path: '$.asOfDate', format: 'date' },
    { name: 'lender_account_ref', path: 'advanceId', format: 'text' },
    { name: 'borrower_name', path: 'supplierName', format: 'text' },
    { name: 'borrower_kra_pin', path: 'supplierKraPin', format: 'text' },
    { name: 'borrower_registration_no', path: 'supplierRegNo', format: 'text' },
    { name: 'facility_type', const: 'INVOICE_ADVANCE', format: 'text' },
    { name: 'currency', const: 'KES', format: 'text' },
    { name: 'disbursement_date', path: 'disbursementDate', format: 'date' },
    { name: 'maturity_date', path: 'dueDate', format: 'date' },
    { name: 'original_amount', path: 'principalCents', format: 'kes' },
    { name: 'outstanding_principal', path: 'outstandingPrincipalCents', format: 'kes' },
    { name: 'days_in_arrears', path: 'dpd', format: 'int' },
    { name: 'account_status', path: 'statusAtMonthEnd', format: 'text' },
  ],
};

export const LENDER_PACK_V1: PackMapping = {
  type: 'pack',
  tapeColumns: [
    { name: 'invoice_number', path: 'invoiceNumber', format: 'text' },
    { name: 'buyer', path: 'buyerName', format: 'text' },
    { name: 'supplier', path: 'supplierName', format: 'text' },
    { name: 'sector', path: 'sector', format: 'text' },
    { name: 'disbursement_date', path: 'disbursementDate', format: 'date' },
    { name: 'due_date', path: 'dueDate', format: 'date' },
    { name: 'term_days', path: 'termDays', format: 'int' },
    { name: 'invoice_amount_kes', path: 'invoiceAmountCents', format: 'kes' },
    { name: 'principal_kes', path: 'principalCents', format: 'kes' },
    { name: 'discount_fee_kes', path: 'discountFeeCents', format: 'kes' },
    { name: 'verification_fee_kes', path: 'verificationFeeCents', format: 'kes' },
    { name: 'principal_repaid_kes', path: 'principalRepaidCents', format: 'kes' },
    { name: 'fees_repaid_kes', path: 'feesRepaidCents', format: 'kes' },
    { name: 'interest_repaid_kes', path: 'interestRepaidCents', format: 'kes' },
    { name: 'supplier_balance_kes', path: 'supplierBalanceCents', format: 'kes' },
    { name: 'outstanding_principal_kes', path: 'outstandingPrincipalCents', format: 'kes' },
    { name: 'dpd', path: 'dpd', format: 'int' },
    { name: 'bucket', path: 'bucket', format: 'text' },
    { name: 'status_at_month_end', path: 'statusAtMonthEnd', format: 'text' },
  ],
  summary: [
    { section: 'Portfolio', code: 'P01', label: 'Loans outstanding (number)', path: 'aggregates.loansOutstanding.count', format: 'int' },
    { section: 'Portfolio', code: 'P02', label: 'Principal outstanding', path: 'aggregates.loansOutstanding.principalCents', format: 'kes' },
    { section: 'Portfolio', code: 'P03', label: 'Disbursed in month', path: 'aggregates.disbursedInMonth.principalCents', format: 'kes' },
    { section: 'Portfolio', code: 'P04', label: 'Principal repaid in month', path: 'aggregates.repaidInMonth.principalCents', format: 'kes' },
    { section: 'Portfolio', code: 'P05', label: 'Lending float', path: 'float.floatCents', format: 'kes' },
    { section: 'Income', code: 'I01', label: 'Interest received in month', path: 'aggregates.incomeInMonth.interestCents', format: 'kes' },
    { section: 'Income', code: 'I02', label: 'Fees received in month', path: 'aggregates.incomeInMonth.feesCents', format: 'kes' },
    { section: 'Income', code: 'I03', label: 'Bank share of income in month (model A)', path: 'aggregates.incomeInMonth.bankShareCents', format: 'kes' },
    { section: 'Income', code: 'I04', label: "Mapema platform fee in month (processing fee plus margin share)", path: 'aggregates.incomeInMonth.mapemaPlatformFeeCents', format: 'kes' },
    { section: 'Income', code: 'I05', label: 'VAT 16% on Mapema fee to the bank (pending counsel, not charged to the supplier)', path: 'aggregates.incomeInMonth.mapemaVatCents', format: 'kes' },
    { section: 'Ageing', code: 'G01', label: 'Current', path: 'aggregates.ageing.current.principalCents', format: 'kes' },
    { section: 'Ageing', code: 'G02', label: '1-30 DPD', path: 'aggregates.ageing.dpd_1_30.principalCents', format: 'kes' },
    { section: 'Ageing', code: 'G03', label: '31-60 DPD', path: 'aggregates.ageing.dpd_31_60.principalCents', format: 'kes' },
    { section: 'Ageing', code: 'G04', label: '61-90 DPD', path: 'aggregates.ageing.dpd_61_90.principalCents', format: 'kes' },
    { section: 'Ageing', code: 'G05', label: 'Over 90 DPD', path: 'aggregates.ageing.dpd_91_plus.principalCents', format: 'kes' },
    { section: 'Credit quality', code: 'Q01', label: 'Late (principal)', path: 'aggregates.statusAtMonthEnd.late.principalCents', format: 'kes' },
    { section: 'Credit quality', code: 'Q02', label: 'Recourse (principal)', path: 'aggregates.statusAtMonthEnd.recourse.principalCents', format: 'kes' },
    { section: 'Credit quality', code: 'Q03', label: 'Non-performing (principal)', path: 'aggregates.statusAtMonthEnd.non_performing.principalCents', format: 'kes' },
    { section: 'Credit quality', code: 'Q04', label: 'NPL ratio', path: 'aggregates.nplRatioBps', format: 'pct_bps' },
    { section: 'Credit quality', code: 'Q05', label: 'Written off in month', path: 'aggregates.writtenOffInMonth.principalCents', format: 'kes' },
    { section: 'Concentration', code: 'C01', label: 'Largest buyer % of float (limit 25%)', path: 'aggregates.concentration.largestBuyerBps', format: 'pct_bps' },
    { section: 'Concentration', code: 'C02', label: 'Largest supplier % of float (limit 10%)', path: 'aggregates.concentration.largestSupplierBps', format: 'pct_bps' },
    { section: 'Concentration', code: 'C03', label: 'Largest sector % of float (limit 35%)', path: 'aggregates.concentration.largestSectorBps', format: 'pct_bps' },
    { section: 'Collections', code: 'L01', label: 'Cash collected in month', path: 'aggregates.collectionsInMonthCents', format: 'kes' },
    { section: 'Collections', code: 'L02', label: 'Recourse cases open at month end', path: 'aggregates.recourse.openCases', format: 'int' },
    { section: 'Reconciliation', code: 'R01', label: 'Daily reconciliation runs in month', path: 'aggregates.reconciliation.runs', format: 'int' },
    { section: 'Reconciliation', code: 'R02', label: 'Runs with unexplained breaks', path: 'aggregates.reconciliation.withUnexplained', format: 'int' },
  ],
};

export const DEFAULT_TEMPLATES = [
  { kind: 'cbk_return', version: 'ASSUMED-0.1', status: 'assumed_draft', sourceRef: 'ASSUMPTION - official CBK NDTCP monthly return format not yet supplied (Q-A)', mapping: CBK_RETURN_ASSUMED },
  { kind: 'crb_file', version: 'ASSUMED-0.1', status: 'assumed_draft', sourceRef: 'ASSUMPTION - CRB data submission specification not yet obtained (Q-A, Q-C)', mapping: CRB_FILE_ASSUMED },
  { kind: 'lender_pack', version: 'MAPEMA-1', status: 'official', sourceRef: 'Mapema lender pack v1 (own format; lenders may request changes)', mapping: LENDER_PACK_V1 },
] as const;
