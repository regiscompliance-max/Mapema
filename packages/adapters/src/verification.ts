/**
 * [Integration Engineer] eTIMS invoice validation, credit bureau and KYC/KYB/sanctions adapters.
 * Providers are not yet contracted (KRA eTIMS direct vs approved integrator; Metropol /
 * TransUnion / Creditinfo; Smile ID or similar), so Phase 1 ships mock mode and fail-fast
 * placeholders for sandbox/live. See phase-0/integration-contracts.md for the full contracts.
 */
import { createHash } from 'node:crypto';
import { Cents } from '@mapema/pricing';
import { AdapterContext, AdapterError, AdapterMode, HealthCheck, notConfigured, stableHash } from './common';

// ---------------------------------------------------------------- eTIMS
export interface EtimsCheckRequest {
  supplierPin: string;
  buyerPin: string;
  invoiceNumber: string;
  cuInvoiceNo?: string;
  amountCents: Cents;
  issueDate: string;
}
export interface EtimsCheckResult {
  status: 'valid' | 'invalid' | 'unavailable';
  reasons: string[];
  providerRef?: string;
}
export interface EtimsAdapter {
  readonly mode: AdapterMode;
  validateInvoice(ctx: AdapterContext, r: EtimsCheckRequest): Promise<EtimsCheckResult>;
  health(): Promise<HealthCheck>;
}

/** Mock magic: invoice number starting BAD -> invalid; DOWN -> unavailable; ending -AMT -> amount mismatch. */
export class MockEtims implements EtimsAdapter {
  readonly mode = 'mock' as const;
  async validateInvoice(_ctx: AdapterContext, r: EtimsCheckRequest): Promise<EtimsCheckResult> {
    const n = r.invoiceNumber.toUpperCase();
    if (n.startsWith('DOWN')) return { status: 'unavailable', reasons: ['ETIMS_TIMEOUT'] };
    if (n.startsWith('BAD')) return { status: 'invalid', reasons: ['INVOICE_NOT_FOUND'] };
    if (n.endsWith('-AMT')) return { status: 'invalid', reasons: ['AMOUNT_MISMATCH'] };
    return { status: 'valid', reasons: [], providerRef: `ETIMS-MOCK-${stableHash(r.supplierPin + n)}` };
  }
  async health(): Promise<HealthCheck> { return { provider: 'etims-mock', mode: 'mock', ok: true }; }
}
export class UnconfiguredEtims implements EtimsAdapter {
  constructor(readonly mode: AdapterMode) {}
  validateInvoice(): never { return notConfigured('etims', this.mode); }
  async health(): Promise<HealthCheck> { return { provider: 'etims', mode: this.mode, ok: false, detail: 'provider not contracted' }; }
}

// ---------------------------------------------------------------- Credit bureau
export interface CrbRequest {
  subjectType: 'company' | 'individual';
  kraPin?: string;
  nationalId?: string;
  consentRef: string; // consent record id; no pull without consent
  purpose: 'new_facility' | 'review';
}
export interface CrbReport {
  bureau: string;
  bureauRef: string;
  score: number;
  hasNonPerformingAccounts: boolean;
  reportPdf: Buffer;
}
export interface CrbAdapter {
  readonly mode: AdapterMode;
  pullReport(ctx: AdapterContext, r: CrbRequest): Promise<CrbReport>;
  health(): Promise<HealthCheck>;
}
/** Mock magic: PIN or ID starting with P000 / 0000 -> score 250 with NPL; otherwise 500-800 deterministic. */
export class MockCrb implements CrbAdapter {
  readonly mode = 'mock' as const;
  async pullReport(_ctx: AdapterContext, r: CrbRequest): Promise<CrbReport> {
    if (!r.consentRef) throw new AdapterError('crb-mock', 'NO_CONSENT', 'a consent reference is required');
    const subject = r.kraPin ?? r.nationalId ?? '';
    if (!subject) throw new AdapterError('crb-mock', 'BAD_REQUEST', 'kraPin or nationalId required');
    const bad = /^(P000|0000)/.test(subject);
    const score = bad ? 250 : 500 + (stableHash(subject) % 300);
    const bureauRef = `CRB-MOCK-${createHash('sha256').update(subject).digest('hex').slice(0, 10)}`;
    return {
      bureau: 'mock-bureau', bureauRef, score, hasNonPerformingAccounts: bad,
      reportPdf: Buffer.from(`%PDF-1.4\n% Mock credit report ${bureauRef} score ${score}\n%%EOF\n`),
    };
  }
  async health(): Promise<HealthCheck> { return { provider: 'crb-mock', mode: 'mock', ok: true }; }
}
export class UnconfiguredCrb implements CrbAdapter {
  constructor(readonly mode: AdapterMode) {}
  pullReport(): never { return notConfigured('crb', this.mode); }
  async health(): Promise<HealthCheck> { return { provider: 'crb', mode: this.mode, ok: false, detail: 'provider not contracted' }; }
}

// ---------------------------------------------------------------- KYC / KYB / sanctions
export type KycResult = 'pass' | 'fail' | 'review';
export interface KycAdapter {
  readonly mode: AdapterMode;
  verifyId(ctx: AdapterContext, r: { idNumber: string; fullName: string; dateOfBirth?: string; selfieSha256?: string }): Promise<{ result: KycResult; providerRef: string; reasons: string[] }>;
  companyLookup(ctx: AdapterContext, r: { registrationNo: string; kraPin: string }): Promise<{ result: KycResult; providerRef: string; legalName?: string; directors: string[] }>;
  sanctionsScreen(ctx: AdapterContext, r: { name: string; type: 'individual' | 'company' }): Promise<{ hit: boolean; lists: string[]; providerRef: string }>;
  health(): Promise<HealthCheck>;
}
/** Mock magic: ID 00000000 -> fail; ID 11111111 -> review; registration starting FAIL -> fail; name containing SANCTIONED -> hit. */
export class MockKyc implements KycAdapter {
  readonly mode = 'mock' as const;
  async verifyId(_ctx: AdapterContext, r: { idNumber: string; fullName: string }) {
    const result: KycResult = r.idNumber === '00000000' ? 'fail' : r.idNumber === '11111111' ? 'review' : 'pass';
    return { result, providerRef: `KYC-MOCK-${stableHash(r.idNumber)}`, reasons: result === 'pass' ? [] : ['ID_NOT_MATCHED'] };
  }
  async companyLookup(_ctx: AdapterContext, r: { registrationNo: string; kraPin: string }) {
    const fail = r.registrationNo.toUpperCase().startsWith('FAIL');
    return { result: (fail ? 'fail' : 'pass') as KycResult, providerRef: `KYB-MOCK-${stableHash(r.registrationNo)}`, legalName: fail ? undefined : 'Registry Name Ltd', directors: fail ? [] : ['Director One'] };
  }
  async sanctionsScreen(_ctx: AdapterContext, r: { name: string }) {
    const hit = /SANCTIONED/i.test(r.name);
    return { hit, lists: hit ? ['UN-1267-MOCK'] : [], providerRef: `SAN-MOCK-${stableHash(r.name)}` };
  }
  async health(): Promise<HealthCheck> { return { provider: 'kyc-mock', mode: 'mock', ok: true }; }
}
export class UnconfiguredKyc implements KycAdapter {
  constructor(readonly mode: AdapterMode) {}
  verifyId(): never { return notConfigured('kyc', this.mode); }
  companyLookup(): never { return notConfigured('kyc', this.mode); }
  sanctionsScreen(): never { return notConfigured('kyc', this.mode); }
  async health(): Promise<HealthCheck> { return { provider: 'kyc', mode: this.mode, ok: false, detail: 'provider not contracted' }; }
}
