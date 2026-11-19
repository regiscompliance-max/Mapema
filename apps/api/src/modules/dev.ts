/**
 * [QA Engineer + DevOps] DEVELOPMENT/TEST-ONLY endpoints. Mounted only when DEV_IDP_ENABLED=true
 * and APP_ENV is development or test (see AppModule.forRoot). Lets the web app and the E2E
 * worked example sign in, move the business clock, simulate bank credits and e-sign completion,
 * and run scheduled jobs on demand.
 */
import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Adapters, MockBank, MockEsign, MockMpesa } from '@mapema/adapters';
import { ADAPTERS } from '../common/config';
import { Clock } from '../common/clock';
import { Db } from '../common/db';
import { DomainError, notFound } from '../common/errors';
import { Outbox } from '../common/outbox';
import { Public } from '../auth/auth';
import { DevIdp } from '../auth/dev-idp';
import { AdvancesService } from './advances';
import { CreditReviewService } from './credit-reviews';
import { OnboardingService } from './onboarding';
import { CollectionsService } from './collections';
import { IntegrationsService } from './integrations';
import { ReconciliationService } from './reconciliation';
import { RegulatoryService } from './regulatory';
import { PaymentsService } from './payments';
import { MpesaService } from './mpesa';
import { ErpService } from './erp';

@Controller()
@Public()
export class DevController {
  constructor(
    private readonly idp: DevIdp, private readonly db: Db, private readonly clock: Clock, private readonly outbox: Outbox,
    private readonly onboarding: OnboardingService, private readonly payments: PaymentsService, private readonly collections: CollectionsService, private readonly advances: AdvancesService,
    private readonly reviews: CreditReviewService, private readonly recon: ReconciliationService, private readonly regulatory: RegulatoryService,
    private readonly integrations: IntegrationsService, private readonly mpesa: MpesaService, private readonly erp: ErpService,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
  ) {}

  @Get('dev-idp/jwks') jwks() { return this.idp.jwks(); }

  @Post('dev-idp/token')
  async token(@Body() b: unknown) {
    const body = z.object({ email: z.string().email(), factor: z.enum(['otp', 'sms', 'none']).default('otp'), authAgeSec: z.number().int().min(0).default(0) }).parse(b);
    const u = await this.db.one(`SELECT idp_subject, email FROM user_account WHERE email = $1`, [body.email]);
    const sub = u?.idp_subject ?? `dev:${body.email}`;
    const amr = body.factor === 'none' ? ['pwd'] : ['pwd', body.factor];
    return { accessToken: await this.idp.issue(sub, { email: body.email, amr, authAgeSec: body.authAgeSec }), sub };
  }

  @Post('dev/clock')
  setClock(@Body() b: unknown) {
    const { iso } = z.object({ iso: z.string().datetime().nullable() }).parse(b);
    this.clock.set(iso ?? undefined);
    return { now: this.clock.now().toISOString(), today: this.clock.today() };
  }

  @Post('dev/esign/:envelopeId/complete')
  async esign(@Param('envelopeId') id: string) {
    const es = this.adapters.esign;
    if (!(es instanceof MockEsign)) throw new DomainError(400, 'NOT_MOCK', 'e-sign adapter is not in mock mode');
    es.complete(id);
    return this.onboarding.completeEnvelope(id);
  }

  /** Simulates the bank: money lands in the account and the bank calls our signed webhook path. */
  @Post('dev/bank/credit')
  async credit(@Body() b: unknown) {
    const body = z.object({ accountNo: z.string(), amountCents: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]), bankRef: z.string().min(3), valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      payerName: z.string().optional(), narrative: z.string().optional() }).parse(b);
    const bank = this.adapters.bank;
    if (!(bank instanceof MockBank)) throw new DomainError(400, 'NOT_MOCK', 'bank adapter is not in mock mode');
    bank.creditReceived(BigInt(body.amountCents), { bankRef: body.bankRef, valueDate: body.valueDate, accountNo: body.accountNo, narrative: body.narrative });
    return this.payments.ingest({ bankCode: bank.bankCode, accountNo: body.accountNo, bankRef: body.bankRef, valueDate: body.valueDate, amountCents: BigInt(body.amountCents), currency: 'KES', payerName: body.payerName, narrative: body.narrative }, 'webhook');
  }

  /** Simulates equity landing in the disbursement account (record it with POST /funding). */
  @Post('dev/bank/fund')
  fund(@Body() b: unknown) {
    const { amountCents, reference, valueDate } = z.object({ amountCents: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]), reference: z.string().min(3).max(64).optional(), valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(b);
    const bank = this.adapters.bank;
    if (!(bank instanceof MockBank)) throw new DomainError(400, 'NOT_MOCK', 'bank adapter is not in mock mode');
    bank.creditReceived(BigInt(amountCents), { bankRef: reference, valueDate: valueDate ?? this.clock.today(), narrative: 'Funding' });
    return { ok: true };
  }

  /** Simulates topping up the M-Pesa B2C float (utility account) from the bank. */
  @Post('dev/mpesa/fund')
  mpesaFund(@Body() b: unknown) {
    const { amountCents, reference, valueDate } = z.object({ amountCents: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]), reference: z.string().min(3).max(64), valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(b);
    const m = this.adapters.mpesa;
    if (!(m instanceof MockMpesa)) throw new DomainError(400, 'NOT_MOCK', 'M-Pesa adapter is not in mock mode');
    m.fund(BigInt(amountCents), reference, valueDate ?? this.clock.today());
    return { ok: true };
  }

  /** Simulates Safaricom calling the result URL for a pending mock payout (outcome success|failure). */
  @Post('dev/mpesa/complete')
  async mpesaComplete(@Body() b: unknown) {
    const { conversationId, outcome } = z.object({ conversationId: z.string().min(3), outcome: z.enum(['success', 'failure']).default('success') }).parse(b);
    const m = this.adapters.mpesa;
    if (!(m instanceof MockMpesa)) throw new DomainError(400, 'NOT_MOCK', 'M-Pesa adapter is not in mock mode');
    const p = await this.db.one(`SELECT ba.account_name FROM payout p JOIN bank_account ba ON ba.id = p.bank_account_id WHERE p.bank_ref = $1 OR p.mpesa_conversation_id = $1`, [conversationId]);
    const body = outcome === 'success' ? m.complete(conversationId, { receiverName: p?.account_name ?? 'UNKNOWN', date: this.clock.today() }) : m.fail(conversationId, 2001, 'The initiator information is invalid.');
    return this.mpesa.onCallback('result', body);
  }

  /** Pushes fixture records into a mock-mode ERP connection (seed demo). */
  @Post('dev/erp/:id/push')
  erpPush(@Param('id') id: string, @Body() b: unknown) {
    const { records } = z.object({ records: z.array(z.object({ externalId: z.string(), version: z.string(), data: z.record(z.string(), z.unknown()) })).min(1).max(500) }).parse(b);
    return this.erp.devPush(id, records as any);
  }

  /** Simulates the statement import of a line that is already on the mock bank statement (REC-06). */
  @Post('dev/bank/ingest-statement')
  async ingestStatement(@Body() b: unknown) {
    const { bankRef } = z.object({ bankRef: z.string().min(3) }).parse(b);
    const bank = this.adapters.bank;
    if (!(bank instanceof MockBank)) throw new DomainError(400, 'NOT_MOCK', 'bank adapter is not in mock mode');
    const line = bank.statement.find((l) => l.bankRef === bankRef && l.amountCents > 0n);
    if (!line) throw notFound('Statement line');
    return this.payments.ingest({ bankCode: bank.bankCode, accountNo: line.accountNo ?? 'MOCK-COLLECTION', bankRef, valueDate: line.valueDate, amountCents: line.amountCents, currency: 'KES', narrative: line.narrative }, 'statement_import');
  }

  /** Runs the daily worker jobs once for the business clock (collections, reconciliation for yesterday, accounting, CRM, month end). */
  @Post('dev/jobs/daily')
  async daily() {
    const today = this.clock.today();
    const y = new Date(`${today}T00:00:00Z`); y.setUTCDate(y.getUTCDate() - 1);
    const yesterday = y.toISOString().slice(0, 10);
    return {
      collections: await this.collections.runDaily(today),
      reconciliation: await this.recon.reconcile(yesterday),
      accounting: await this.integrations.pushDailyJournal(yesterday),
      crm: await this.integrations.importLeads(),
      monthEnd: await this.regulatory.monthEnd(today),
    };
  }

  @Post('dev/jobs/run')
  async jobs() {
    let outbox = 0;
    for (let i = 0; i < 20; i++) {
      const n = await this.outbox.processDue(100);
      outbox += n;
      if (!n) break;
    }
    const held = await this.payments.postHeld();
    const ladder = await this.collections.runDaily();
    const payouts = await this.advances.refreshPayoutStatuses();
    const reviews = await this.reviews.run();
    const mpesa = await this.mpesa.checkPending();
    const erp = await this.erp.runDue();
    return { outbox, held, ladder, payouts, reviews, mpesa, erp };
  }

  @Get('dev/outbox/:id')
  async outboxRow(@Param('id') id: string) {
    const r = await this.db.one(`SELECT id, topic, status, attempts, last_error FROM outbox WHERE id = $1`, [id]);
    if (!r) throw notFound('Outbox row');
    return r;
  }
}

