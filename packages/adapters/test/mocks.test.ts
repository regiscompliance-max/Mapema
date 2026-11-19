/** [QA Engineer] Adapter mock contract tests: magic values, idempotency, webhook signatures. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kes } from '@mapema/pricing';
import {
  annualRateFromBpsPer30d, CBK_ALLOCATION_ORDER, centsToDecimal, createAdapters, decimalToCents,
  EXCISE_CHARGE_NAME, LocalEncryptedStorage, MockBank, MockCrb, MockEsign, MockEtims, MockKyc, MockLedger, MockSms,
  PROCESSING_CHARGE_NAME, signWebhook, verifyWebhook, VERIFICATION_CHARGE_NAME,
} from '../src';

const ctx = { requestId: 't' };

describe('money conversions for provider APIs', () => {
  it('cents <-> decimal are exact', () => {
    expect(centsToDecimal(kes(800_000))).toBe('800000.00');
    expect(centsToDecimal(5n)).toBe('0.05');
    expect(decimalToCents(44800.0)).toBe(kes(44_800));
    expect(decimalToCents('7500.55')).toBe(750055n);
    expect(decimalToCents(0.1 + 0.2)).toBe(30n);
  });
  it('3.5% per 30 days == 42.00% p.a. on 360 days', () => {
    expect(annualRateFromBpsPer30d(350)).toBe('42.00');
    expect(annualRateFromBpsPer30d(325)).toBe('39.00');
  });
});

describe('MockLedger mirrors the proven Fineract product', () => {
  it('worked example: 44,800 interest, CBK order, early payoff on actual days', async () => {
    const l = new MockLedger();
    const req = { externalId: 'x', clientId: 1, principalCents: kes(800_000), rateBpsPer30d: 350, days: 48, disbursementDate: '2027-01-04', dueDate: '2027-02-21', verificationFeeCents: kes(2_500) };
    const { loanId, scheduledInterestCents } = await l.bookAdvance(ctx, req);
    expect(scheduledInterestCents).toBe(kes(44_800));
    const r = await l.repay(ctx, loanId, kes(810_000), '2027-02-21', 'p1');
    expect([r.principalCents, r.feesCents, r.interestCents]).toEqual([kes(800_000), kes(2_500), kes(7_500)]);
    const l2 = new MockLedger();
    const b = await l2.bookAdvance(ctx, { ...req, externalId: 'y' });
    expect(await l2.payoffQuote(b.loanId, '2027-02-03')).toEqual({ totalCents: kes(830_500), principalCents: kes(800_000), feesCents: kes(2_500), interestCents: kes(28_000) });
  });
  it('repay is idempotent per externalId', async () => {
    const l = new MockLedger();
    const { loanId } = await l.bookAdvance(ctx, { externalId: 'z', clientId: 1, principalCents: kes(800_000), rateBpsPer30d: 350, days: 48, disbursementDate: '2027-01-04', dueDate: '2027-02-21', verificationFeeCents: kes(2_500) });
    const a = await l.repay(ctx, loanId, kes(100), '2027-02-21', 'same');
    const b = await l.repay(ctx, loanId, kes(100), '2027-02-21', 'same');
    expect(b).toEqual(a);
    expect((await l.getLoan(loanId)).principalOutstandingCents).toBe(kes(800_000) - kes(100));
  });
});

describe('MockBank', () => {
  it('pays out idempotently and honours magic failure accounts', async () => {
    const bank = new MockBank();
    bank.creditReceived(kes(1_000_000));
    const p = { idempotencyKey: 'k1', amountCents: kes(800_000), currency: 'KES' as const, rail: 'pesalink' as const, narrative: 'adv', beneficiary: { bankCode: '01', accountNumber: '1234560001', accountName: 'Sup' } };
    const a = await bank.sendPayout(ctx, p);
    const b = await bank.sendPayout(ctx, p);
    expect(b.bankRef).toBe(a.bankRef);
    expect(await bank.getBalance()).toBe(kes(200_000));
    expect((await bank.getPayoutStatus(a.bankRef)).status).toBe('confirmed');
    const f = await bank.sendPayout(ctx, { ...p, idempotencyKey: 'k2', amountCents: kes(1), beneficiary: { ...p.beneficiary, accountNumber: '9990002' } });
    expect(f.status).toBe('failed');
    const r = await bank.sendPayout(ctx, { ...p, idempotencyKey: 'k3', amountCents: kes(1), beneficiary: { ...p.beneficiary, accountNumber: '9990003' } });
    expect((await bank.getPayoutStatus(r.bankRef)).status).toBe('returned');
  });
  it('rejects non-KES and parses statements in integer cents only', async () => {
    const bank = new MockBank();
    await expect(bank.sendPayout(ctx, { idempotencyKey: 'u', amountCents: 1n, currency: 'USD' as any, rail: 'eft', narrative: '', beneficiary: { bankCode: '', accountNumber: '1', accountName: '' } })).rejects.toThrow(/KES/);
    expect(bank.parseStatement('bank_ref,value_date,account_no,amount_cents,currency,payer_name,narrative\nR1,2027-02-21,MAP1,100000000,KES,Buyer Ltd,INV-1')[0].amountCents).toBe(kes(1_000_000));
    expect(() => bank.parseStatement('R1,2027-02-21,MAP1,1000.50,KES')).toThrow(/integer cents/);
  });
});

describe('webhook signatures', () => {
  it('accepts valid, rejects tampered, stale or malformed', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook('s3cret', ts, '{"a":1}');
    expect(verifyWebhook('s3cret', ts, '{"a":1}', sig)).toBe(true);
    expect(verifyWebhook('s3cret', ts, '{"a":2}', sig)).toBe(false);
    expect(verifyWebhook('s3cret', String(Number(ts) - 3600), '{"a":1}', signWebhook('s3cret', String(Number(ts) - 3600), '{"a":1}'))).toBe(false);
    expect(verifyWebhook('s3cret', ts, '{"a":1}', 'zz')).toBe(false);
  });
});

describe('verification mocks', () => {
  it('eTIMS magic values', async () => {
    const e = new MockEtims();
    const base = { supplierPin: 'P051234567A', buyerPin: 'P059876543B', amountCents: kes(1), issueDate: '2027-01-01' };
    expect((await e.validateInvoice(ctx, { ...base, invoiceNumber: 'INV-1' })).status).toBe('valid');
    expect((await e.validateInvoice(ctx, { ...base, invoiceNumber: 'BAD-1' })).status).toBe('invalid');
    expect((await e.validateInvoice(ctx, { ...base, invoiceNumber: 'DOWN-1' })).status).toBe('unavailable');
  });
  it('CRB requires consent; KYC magic values', async () => {
    await expect(new MockCrb().pullReport(ctx, { subjectType: 'company', kraPin: 'P051234567A', consentRef: '', purpose: 'new_facility' })).rejects.toThrow(/consent/);
    expect((await new MockCrb().pullReport(ctx, { subjectType: 'company', kraPin: 'P000000001Z', consentRef: 'c', purpose: 'review' })).hasNonPerformingAccounts).toBe(true);
    const k = new MockKyc();
    expect((await k.verifyId(ctx, { idNumber: '00000000', fullName: 'x' })).result).toBe('fail');
    expect((await k.sanctionsScreen(ctx, { name: 'SANCTIONED Person', type: 'individual' })).hit).toBe(true);
  });
  it('e-sign envelope lifecycle', async () => {
    const s = new MockEsign();
    const { envelopeId } = await s.createEnvelope(ctx, { documentType: 'ilu', title: 'ILU', pdf: Buffer.from('%PDF'), signers: [{ name: 'A', email: 'a@b.co', role: 'signatory' }], reference: 'r' });
    await expect(s.downloadSigned(envelopeId)).rejects.toThrow(/NOT_SIGNED/);
    s.complete(envelopeId);
    expect((await s.downloadSigned(envelopeId)).sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('SMS mock validates Kenyan numbers', async () => {
    const sms = new MockSms();
    await sms.send(ctx, { to: '+254712345678', text: 'hi', reference: 'r' });
    await expect(sms.send(ctx, { to: '0712345678', text: 'hi', reference: 'r' })).rejects.toThrow(/E.164/);
  });
});

describe('storage and factory', () => {
  it('encrypts at rest and enforces WORM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mapema-st-'));
    const s = new LocalEncryptedStorage(dir, 'a'.repeat(64));
    await s.put('docs', 'k/1.pdf', Buffer.from('secret national id'), { worm: true });
    expect((await s.get('docs', 'k/1.pdf')).toString()).toBe('secret national id');
    await expect(s.put('docs', 'k/1.pdf', Buffer.from('x'), { worm: true })).rejects.toThrow(/WORM/);
    await expect(s.put('docs', '../escape', Buffer.from('x'))).rejects.toThrow();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(dir, 'docs', 'k', '1.pdf')).toString()).not.toContain('national');
  });
  it('factory refuses mock in production and live outside production', () => {
    expect(() => createAdapters({ APP_ENV: 'production' })).toThrow(/not allowed in production/);
    expect(() => createAdapters({ APP_ENV: 'staging', ADAPTER_MODE_BANK: 'live' })).toThrow(/only allowed in production/);
    expect(createAdapters({ APP_ENV: 'test' }).ledger.mode).toBe('mock');
  });
});

describe('D-82 Fineract charge mapping for bank-funded-A', () => {
  it('keeps distinct charge names and the CBK principal-fees-interest order', () => {
    expect(VERIFICATION_CHARGE_NAME).toMatch(/verification/i);
    expect(PROCESSING_CHARGE_NAME).toMatch(/processing fee/i);
    expect(EXCISE_CHARGE_NAME).toMatch(/excise/i);
    expect(EXCISE_CHARGE_NAME).toMatch(/pending counsel/i);
    const names = CBK_ALLOCATION_ORDER.join(',');
    expect(names.indexOf('DUE_PRINCIPAL')).toBeLessThan(names.indexOf('DUE_FEE'));
    expect(names.indexOf('DUE_FEE')).toBeLessThan(names.indexOf('DUE_INTEREST'));
  });
  it('3.5% per 30 days is 42% p.a. and 1.5% per 30 days is 18% p.a. on a 360-day year', () => {
    expect(annualRateFromBpsPer30d(350)).toBe('42.00');
    expect(annualRateFromBpsPer30d(150)).toBe('18.00');
  });
  it('mock ledger still allocates a 5,000 processing fee after principal', async () => {
    const l = new MockLedger();
    const { loanId, scheduledInterestCents } = await l.bookAdvance(ctx, {
      externalId: 'bank-a', clientId: 1, principalCents: kes(800_000), rateBpsPer30d: 150, days: 48,
      disbursementDate: '2027-01-04', dueDate: '2027-02-21', verificationFeeCents: kes(5_000),
      feeChargeKind: 'processing', processingFeeCents: kes(5_000),
    });
    expect(scheduledInterestCents).toBe(kes(19_200));
    const r = await l.repay(ctx, loanId, kes(1_000_000), '2027-02-21', 'p1');
    expect(r.principalCents).toBe(kes(800_000));
    expect(r.feesCents).toBe(kes(5_000));
    expect(r.interestCents).toBe(kes(19_200));
  });
});
