/**
 * [DevOps + Integration Engineer] Build the adapter set from environment configuration.
 * ADAPTER_MODE_<NAME> = mock | sandbox | live. Production refuses mock mode (ADM-08).
 */
import { ErpRegistry } from './erp';
import { createScanner } from './scan';
import { DarajaMpesa, MockMpesa, MpesaAdapter } from './mpesa';
import { AdapterMode } from './common';
import { BankAdapter, MockBank, UnconfiguredBank } from './bank';
import { EsignAdapter, MockEsign, UnconfiguredEsign } from './esign';
import { FineractLedger } from './fineract';
import { LedgerAdapter } from './ledger';
import { MockLedger } from './ledger.mock';
import { AfricasTalkingSms, EmailAdapter, MockEmail, MockSms, PostmarkEmail, SmsAdapter } from './messaging';
import { AccountingAdapter, MockAccounting, XeroAccounting } from './accounting';
import { CrmAdapter, HubSpotCrm, MockCrm } from './crm';
import { D1SiteLeadSource, LeadSourceAdapter, MockSiteLeadSource } from './leads';
import { CrbAdapter, EtimsAdapter, KycAdapter, MockCrb, MockEtims, MockKyc, UnconfiguredCrb, UnconfiguredEtims, UnconfiguredKyc } from './verification';

export interface Adapters {
  ledger: LedgerAdapter;
  bank: BankAdapter;
  etims: EtimsAdapter;
  crb: CrbAdapter;
  kyc: KycAdapter;
  esign: EsignAdapter;
  sms: SmsAdapter;
  email: EmailAdapter;
  accounting: AccountingAdapter;
  crm: CrmAdapter;
  leads: LeadSourceAdapter;
  erp: ErpRegistry;
  mpesa: MpesaAdapter;
}

function mode(env: Record<string, string | undefined>, name: string): AdapterMode {
  const v = (env[`ADAPTER_MODE_${name}`] ?? 'mock') as AdapterMode;
  if (!['mock', 'sandbox', 'live'].includes(v)) throw new Error(`ADAPTER_MODE_${name} must be mock|sandbox|live`);
  if (env.APP_ENV === 'production' && v !== 'live') throw new Error(`ADAPTER_MODE_${name}=${v} is not allowed in production`);
  if (env.APP_ENV !== 'production' && v === 'live') throw new Error(`ADAPTER_MODE_${name}=live is only allowed in production`);
  return v;
}

export function createAdapters(env: Record<string, string | undefined>): Adapters {
  const ledgerMode = mode(env, 'LEDGER');
  const ledger = ledgerMode === 'mock'
    ? new MockLedger()
    : new FineractLedger({
        baseUrl: env.FINERACT_BASE_URL ?? 'http://localhost:8443/fineract-provider/api/v1',
        tenant: env.FINERACT_TENANT ?? 'default',
        username: env.FINERACT_USERNAME ?? '',
        password: env.FINERACT_PASSWORD ?? '',
        mode: ledgerMode,
      });
  const bankMode = mode(env, 'BANK');
  const smsMode = mode(env, 'SMS');
  const emailMode = mode(env, 'EMAIL');
  const etimsMode = mode(env, 'ETIMS');
  const crbMode = mode(env, 'CRB');
  const kycMode = mode(env, 'KYC');
  const esignMode = mode(env, 'ESIGN');
  const accountingMode = mode(env, 'ACCOUNTING');
  const crmMode = mode(env, 'CRM');
  const leadsMode = mode(env, 'SITE_LEADS');
  const erpMode = mode(env, 'ERP');
  const mpesaMode = mode(env, 'MPESA');
  const cb = (env.MPESA_CALLBACK_BASE_URL ?? '').replace(/\/$/, '');
  return {
    ledger,
    bank: bankMode === 'mock' ? new MockBank(env.BANK_WEBHOOK_SECRET) : new UnconfiguredBank(bankMode),
    etims: etimsMode === 'mock' ? new MockEtims() : new UnconfiguredEtims(etimsMode),
    crb: crbMode === 'mock' ? new MockCrb() : new UnconfiguredCrb(crbMode),
    kyc: kycMode === 'mock' ? new MockKyc() : new UnconfiguredKyc(kycMode),
    esign: esignMode === 'mock' ? new MockEsign(env.ESIGN_WEBHOOK_SECRET, env.ESIGN_MOCK_AUTOCOMPLETE === 'true') : new UnconfiguredEsign(esignMode),
    sms: smsMode === 'mock' ? new MockSms() : new AfricasTalkingSms(smsMode, { username: env.AT_USERNAME ?? 'sandbox', apiKey: env.AT_API_KEY ?? '', senderId: env.AT_SENDER_ID }),
    email: emailMode === 'mock' ? new MockEmail() : new PostmarkEmail(emailMode, { serverToken: env.POSTMARK_SERVER_TOKEN ?? '', from: env.EMAIL_FROM ?? 'no-reply@mapema.example' }),
    accounting: accountingMode === 'mock' ? new MockAccounting() : new XeroAccounting(accountingMode, { accessToken: env.XERO_ACCESS_TOKEN ?? '', tenantId: env.XERO_TENANT_ID ?? '' }),
    crm: crmMode === 'mock' ? new MockCrm() : new HubSpotCrm(crmMode, { token: env.HUBSPOT_PRIVATE_APP_TOKEN ?? '', pipelineId: env.HUBSPOT_BUYER_PIPELINE_ID, dealStageId: env.HUBSPOT_BUYER_DEAL_STAGE_ID }),
    erp: new ErpRegistry(erpMode, env, fetch, createScanner(env)),
    mpesa: mpesaMode === 'mock' ? new MockMpesa() : new DarajaMpesa(mpesaMode, {
      baseUrl: env.MPESA_BASE_URL ?? 'https://sandbox.safaricom.co.ke', consumerKey: env.MPESA_CONSUMER_KEY ?? '', consumerSecret: env.MPESA_CONSUMER_SECRET ?? '',
      shortcode: env.MPESA_SHORTCODE ?? '', initiatorName: env.MPESA_INITIATOR_NAME ?? '', securityCredential: env.MPESA_SECURITY_CREDENTIAL ?? '',
      resultUrl: `${cb}/v1/webhooks/mpesa/b2c/result/${env.MPESA_CALLBACK_TOKEN ?? ''}`, timeoutUrl: `${cb}/v1/webhooks/mpesa/b2c/timeout/${env.MPESA_CALLBACK_TOKEN ?? ''}`,
    }),
    leads: leadsMode === 'mock' ? new MockSiteLeadSource() : new D1SiteLeadSource(leadsMode, { accountId: env.SITE_D1_ACCOUNT_ID ?? '', databaseId: env.SITE_D1_DATABASE_ID ?? '', token: env.SITE_D1_API_TOKEN ?? '' }),
  };
}
