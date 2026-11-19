/**
 * [Backend Engineer + Product Designer] Public endpoints behind the marketing site: health, fee
 * calculator (no data stored), book-a-call lead capture (consent recorded), CBK licence status
 * (shown on every public page footer; lending stays off until the licence number is entered).
 */
import { Body, Controller, Get, Inject, Injectable, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { BANK_FUNDED_A_PRICING, pricingParamsFor, quote, STANDARD_PRICING } from '@mapema/pricing';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS, AppConfig, CONFIG } from '../common/config';
import { FieldCrypto } from '../common/crypto';
import { Db, toCents } from '../common/db';
import { zPhoneKe, zPositiveCents, zText } from '../common/http';
import { Public } from '../auth/auth';
import { SettingsService } from './admin';

export const PRIVACY_NOTICE_VERSION = 'PN-2026-11-v1';

@Injectable()
export class PublicService {
  constructor(private readonly db: Db, private readonly audit: Audit, private readonly crypto: FieldCrypto, private readonly settings: SettingsService, @Inject(ADAPTERS) private readonly adapters: Adapters, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  async health() {
    let db: boolean;
    try { await this.db.query('SELECT 1'); db = true; } catch { db = false; }
    const providers = [];
    for (const [name, a] of Object.entries(this.adapters)) {
      try { providers.push({ name, ...(await (a as any).health()) }); } catch (e) { providers.push({ name, ok: false, error: (e as Error).message }); }
    }
    return { ok: db && providers.every((p: any) => p.ok), db, providers };
  }

  async feeQuote(invoiceCents: bigint, days: number, profileCode?: 'direct-legacy' | 'bank-funded-A', processingFeePayer: 'supplier' | 'buyer' = 'supplier') {
    const p = await this.settings.activePricing();
    const minInvoiceCents = await this.settings.invoiceMinimum();
    const params = profileCode === 'bank-funded-A'
      ? pricingParamsFor({ profileCode, advanceRateBps: BANK_FUNDED_A_PRICING.advanceRateBps, minInvoiceCents, processingFeePayer })
      : p
        ? pricingParamsFor({
            profileCode: 'direct-legacy', advanceRateBps: p.advance_rate_bps, discountRateBpsPer30d: p.discount_rate_bps_per_30d,
            verificationFeeCents: toCents(p.verification_fee_cents), minDays: p.min_days, maxDays: p.max_days, minInvoiceCents,
          })
        : STANDARD_PRICING;
    const q = quote(invoiceCents, days, params);
    const bankNote = q.billedBy === 'funding_bank'
      ? ' The funding bank is the lender and charges these fees. Mapema is the technology provider and is not yet licensed by the Central Bank of Kenya as a non-deposit-taking credit provider.'
      : '';
    const feeNote = q.profileCode === 'bank-funded-A'
      ? ' The processing fee is 0.5% of the invoice, at least KES 1,500 and at most KES 5,000, taken at funding.'
      : ' The verification fee is fixed.';
    return { ...q, illustrative: true, pricingVersion: q.profileCode === 'bank-funded-A' ? 'bank-funded-A (illustrative, not yet CBK-approved)' : (p?.code ?? 'STANDARD (not yet CBK-approved)'), explanation:
      'The discount fee is interest for the days the advance is outstanding. The figure shown is the maximum; if your buyer pays early you pay less.' + feeNote + bankNote };
  }

  async lead(b: { contactName: string; company: string; email: string; phone?: string; spendBand?: string; role: 'buyer' | 'supplier'; privacyNoticeVersion: string }) {
    return this.db.tx(async (c) => {
      const r = (await c.query(`INSERT INTO lead (contact_name, email, phone_enc, spend_band, crm_ref) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [b.contactName, b.email, b.phone ? this.crypto.encrypt(b.phone) : null, b.spendBand ?? null, `${b.role}:${b.company}`.slice(0, 200)])).rows[0];
      await this.audit.record(c, SYSTEM, 'lead.created', 'lead', r.id, null, { role: b.role, privacyNoticeVersion: b.privacyNoticeVersion, lawfulBasis: 'pre-contract steps at the request of the data subject' });
      return { id: r.id, message: 'Thanks. We will call you within one business day.' };
    });
  }

  async cbkStatus() {
    const l = await this.settings.lending();
    const notYet = 'Mapema is not yet licensed by the Central Bank of Kenya as a non-deposit-taking credit provider. We do not provide credit until we are licensed.';
    // D-42: outside production a licence number is always test data, so the public wording never claims a licence there.
    if (this.cfg.APP_ENV !== 'production') return { lendingEnabled: l.enabled, cbkLicenceNo: l.cbk_licence_no, demo: true, statement: l.cbk_licence_no ? `DEMO ENVIRONMENT - test data only (fictitious licence reference ${l.cbk_licence_no}). ${notYet}` : notYet };
    return { lendingEnabled: l.enabled, cbkLicenceNo: l.cbk_licence_no, statement: l.cbk_licence_no
      ? `Mapema is licensed by the Central Bank of Kenya as a non-deposit-taking credit provider, licence ${l.cbk_licence_no}.`
      : notYet };
  }
}

@Controller('public')
@Public()
export class PublicController {
  constructor(private readonly s: PublicService) {}

  @Get('health') health() { return this.s.health(); }

  @Post('fee-quote') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  feeQuote(@Body() b: unknown) {
    const body = z.object({
      invoiceAmountCents: zPositiveCents, days: z.number().int().min(1).max(120), currency: z.literal('KES').default('KES'),
      profileCode: z.enum(['direct-legacy', 'bank-funded-A']).optional(),
      processingFeePayer: z.enum(['supplier', 'buyer']).optional(),
    }).parse(b);
    return this.s.feeQuote(body.invoiceAmountCents, body.days, body.profileCode, body.processingFeePayer);
  }

  @Post('leads') @Throttle({ default: { limit: 5, ttl: 60_000 } })
  lead(@Body() b: unknown, @Req() _req: any) {
    return this.s.lead(z.object({ contactName: zText(120), company: zText(200), email: z.string().email().max(254), phone: zPhoneKe.optional(), spendBand: z.enum(['<10m', '10-50m', '50-250m', '>250m']).optional(),
      role: z.enum(['buyer', 'supplier']), privacyNoticeAccepted: z.literal(true), privacyNoticeVersion: z.string().max(40).default(PRIVACY_NOTICE_VERSION) }).parse(b));
  }

  @Get('cbk-status') cbk() { return this.s.cbkStatus(); }
}
