/**
 * [QA Engineer + DevOps] DEVELOPMENT/TEST-ONLY endpoints. Mounted only when DEV_IDP_ENABLED=true
 * and APP_ENV is development or test (see AppModule.forRoot). Lets the web app and the E2E
 * worked example sign in, move the business clock, simulate bank credits and e-sign completion,
 * and run scheduled jobs on demand.
 */
import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Adapters, MockBank, MockEsign } from '@mapema/adapters';
import { ADAPTERS } from '../common/config';
import { Clock } from '../common/clock';
import { Db } from '../common/db';
import { DomainError, notFound } from '../common/errors';
import { Outbox } from '../common/outbox';
import { Public } from '../auth/auth';
import { DevIdp } from '../auth/dev-idp';
import { AdvancesService } from './advances';
import { OnboardingService } from './onboarding';
import { OpsService } from './ops';
import { PaymentsService } from './payments';

@Controller()
@Public()
export class DevController {
  constructor(
    private readonly idp: DevIdp, private readonly db: Db, private readonly clock: Clock, private readonly outbox: Outbox,
    private readonly onboarding: OnboardingService, private readonly payments: PaymentsService, private readonly ops: OpsService, private readonly advances: AdvancesService,
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
    bank.creditReceived(BigInt(body.amountCents));
    return this.payments.ingest({ bankCode: bank.bankCode, accountNo: body.accountNo, bankRef: body.bankRef, valueDate: body.valueDate, amountCents: BigInt(body.amountCents), currency: 'KES', payerName: body.payerName, narrative: body.narrative }, 'webhook');
  }

  /** Simulates equity landing in the disbursement account (record it with POST /funding). */
  @Post('dev/bank/fund')
  fund(@Body() b: unknown) {
    const { amountCents } = z.object({ amountCents: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]) }).parse(b);
    const bank = this.adapters.bank;
    if (!(bank instanceof MockBank)) throw new DomainError(400, 'NOT_MOCK', 'bank adapter is not in mock mode');
    bank.creditReceived(BigInt(amountCents));
    return { ok: true };
  }

  @Post('dev/jobs/run')
  async jobs() {
    const outbox = await this.outbox.processDue(100);
    const held = await this.payments.postHeld();
    const ladder = await this.ops.runLateLadder();
    const payouts = await this.advances.refreshPayoutStatuses();
    return { outbox, held, ladder, payouts };
  }

  @Get('dev/outbox/:id')
  async outboxRow(@Param('id') id: string) {
    const r = await this.db.one(`SELECT id, topic, status, attempts, last_error FROM outbox WHERE id = $1`, [id]);
    if (!r) throw notFound('Outbox row');
    return r;
  }
}

