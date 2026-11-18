/**
 * [Backend Engineer + Payments + Compliance] M-Pesa B2C payouts (Phase 3 MP-01..05).
 *  - supplier registers an M-Pesa wallet (stored like a bank account: MSISDN encrypted, bank_code MPESA,
 *    not the default); ops verifies it by call-back (same maker-checker as bank accounts)
 *  - credit approval picks the rail: M-Pesa when the wallet is verified and the advance is whole
 *    shillings within the cap (default KES 150,000; change = maker-checker, CEO); else bank
 *  - release stays maker-checker with step-up and re-checks limits (AdvancesService.release)
 *  - Daraja callbacks: ResultURL / QueueTimeOutURL carry a secret path token (Daraja does not sign
 *    callbacks; IP allow-listing at the edge is a deployment item). Success -> funded with the receipt as
 *    bank reference; failure -> ledger disbursal undone, invoice freed; timeout -> status query, and if
 *    still unknown the payout is parked for ops. NOTHING IS EVER RESENT AUTOMATICALLY.
 *  - receiver name returned by M-Pesa is compared with the registered wallet name -> AML flag on mismatch
 */
import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Injectable, OnModuleInit, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { type Adapters, AdapterError, B2cResult, MPESA_MAX_CENTS, MPESA_MIN_CENTS, normaliseMsisdn, parseB2cResult } from '@mapema/adapters';
import { formatKes } from '@mapema/pricing';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS, AppConfig, CONFIG } from '../common/config';
import { Clock } from '../common/clock';
import { FieldCrypto } from '../common/crypto';
import { Db, toCents } from '../common/db';
import { badRequest, DomainError, forbidden, notFound } from '../common/errors';
import { zCents, zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { assertOrgAccess, AuthUser, CurrentUser, Public, Roles, StepUp } from '../auth/auth';
import { AdvancesService } from './advances';
import { SettingsService } from './admin';
import { ApprovalsService } from './approvals';

const CAP_ENTITY = '00000000-0000-0000-0000-0000000000c1';
const words = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

@Injectable()
export class MpesaService implements OnModuleInit {
  constructor(
    private readonly db: Db, private readonly audit: Audit, private readonly clock: Clock, private readonly notifier: Notifier, private readonly crypto: FieldCrypto,
    private readonly approvals: ApprovalsService, private readonly settings: SettingsService, private readonly advances: AdvancesService,
    @Inject(ADAPTERS) private readonly adapters: Adapters, @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit() {
    this.approvals.register('mpesa_cap_change', async (c, a) => {
      await c.query(`INSERT INTO platform_setting (key, value) VALUES ('mpesa_payout_cap_cents', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_via = $2, updated_at = now()`, [JSON.stringify(Number(a.payload.capCents)), a.id]);
    });
  }

  timeoutMinutes() { return Number(this.cfg.raw.MPESA_RESULT_TIMEOUT_MINUTES ?? 30); }

  async settingsView() {
    return { capCents: await this.settings.mpesaCap(), mode: this.adapters.mpesa.mode, resultTimeoutMinutes: this.timeoutMinutes(), minCents: MPESA_MIN_CENTS, maxCents: MPESA_MAX_CENTS };
  }

  async proposeCap(u: AuthUser, capCents: bigint, reason: string) {
    if (capCents < MPESA_MIN_CENTS || capCents > MPESA_MAX_CENTS || capCents % 100n !== 0n) throw badRequest('CAP_OUT_OF_RANGE', `The cap must be whole shillings between ${formatKes(MPESA_MIN_CENTS)} and ${formatKes(MPESA_MAX_CENTS)} (Daraja B2C maximum)`);
    const current = await this.settings.mpesaCap();
    return this.db.tx((c) => this.approvals.propose(c, u, { action: 'mpesa_cap_change', entityType: 'platform_setting', entityId: CAP_ENTITY, payload: { capCents, previousCents: current }, requiredRole: 'ceo', reason }));
  }

  async addWallet(u: AuthUser, orgId: string, msisdnIn: string, accountName: string) {
    assertOrgAccess(u, orgId);
    // the API takes the canonical 2547XXXXXXXX form; the web form normalises 07... / +254... before sending
    const msisdn = /^254[17]\d{8}$/.test(msisdnIn) ? normaliseMsisdn(msisdnIn) : null;
    if (!msisdn) throw badRequest('BAD_MSISDN', 'Use the 2547XXXXXXXX format');
    return this.db.tx(async (c) => {
      const org = (await c.query(`SELECT type FROM organisation WHERE id = $1`, [orgId])).rows[0];
      if (!org) throw notFound('Organisation');
      if (org.type !== 'supplier') throw forbidden('SUPPLIERS_ONLY', 'Only suppliers receive M-Pesa payouts');
      const prev = (await c.query(`SELECT id FROM bank_account WHERE org_id = $1 AND bank_code = 'MPESA' AND deactivated_at IS NULL FOR UPDATE`, [orgId])).rows[0];
      const coolingOff = prev ? new Date(this.clock.now().getTime() + this.cfg.BANK_ACCOUNT_COOLING_OFF_HOURS * 3600_000) : null;
      if (prev) await c.query(`UPDATE bank_account SET deactivated_at = now() WHERE id = $1`, [prev.id]);
      const r = (await c.query(`INSERT INTO bank_account (org_id, bank_code, account_name, account_number_enc, account_number_bidx, account_number_last4, currency, is_payout_default, cooling_off_until)
        VALUES ($1,'MPESA',$2,$3,$4,$5,'KES',false,$6) RETURNING id, account_number_last4, cooling_off_until`, [orgId, accountName, this.crypto.encrypt(msisdn), this.crypto.blindIndex(msisdn), msisdn.slice(-4), coolingOff])).rows[0];
      await this.audit.record(c, u.actor, prev ? 'mpesa_wallet.change' : 'mpesa_wallet.create', 'bank_account', r.id, prev ? { previous: prev.id } : null, { orgId, last4: r.account_number_last4, coolingOffUntil: coolingOff });
      if (prev) await this.notifier.toOrg(c, orgId, 'invite.user', { link: 'Your M-Pesa payout number was changed. If this was not you, call Mapema now.' });
      return { ...r, verification: 'pending_call_back' };
    });
  }

  // ------------------------------------------------------------------ callbacks
  checkToken(token: string) {
    const want = this.cfg.raw.MPESA_CALLBACK_TOKEN ?? '';
    const a = Buffer.from(token); const b = Buffer.from(want);
    if (want.length < 16 || a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainError(401, 'BAD_CALLBACK_TOKEN', 'Unknown callback');
  }

  private async payoutFor(orig: string) {
    return this.db.one(`SELECT p.*, ba.account_name, i.invoice_number FROM payout p JOIN bank_account ba ON ba.id = p.bank_account_id JOIN advance a ON a.id = p.advance_id JOIN invoice i ON i.id = a.invoice_id
      WHERE p.idempotency_key = $1 AND p.rail = 'mpesa_b2c'`, [orig]);
  }

  async onCallback(kind: 'result' | 'timeout', body: unknown) {
    let r: B2cResult;
    try { r = parseB2cResult(body); } catch { throw badRequest('BAD_CALLBACK', 'Not a Daraja B2C result'); }
    const p = await this.payoutFor(r.originatorConversationId);
    await this.db.tx((c) => this.audit.record(c, SYSTEM, `mpesa.callback_${kind}`, 'payout', p?.id ?? null, null, { originatorConversationId: r.originatorConversationId, resultCode: r.resultCode, known: Boolean(p) }));
    if (!p) return { ResultCode: 0, ResultDesc: 'Accepted' }; // never tell the caller what we know
    if (kind === 'timeout' || r.timeout) {
      if (p.mpesa_state === 'accepted') await this.db.query(`UPDATE payout SET mpesa_state = 'timeout' WHERE id = $1 AND mpesa_state = 'accepted'`, [p.id]);
      await this.query(p.id);
    } else {
      await this.apply(p.id, r);
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  /** Applies a final result once; duplicates and late callbacks after a final state are ignored. */
  async apply(payoutId: string, r: B2cResult) {
    const p = await this.db.one(`SELECT p.*, ba.account_name, a.fineract_loan_id, i.invoice_number FROM payout p JOIN bank_account ba ON ba.id = p.bank_account_id JOIN advance a ON a.id = p.advance_id JOIN invoice i ON i.id = a.invoice_id WHERE p.id = $1`, [payoutId]);
    if (!p || p.status !== 'released' || ['completed', 'failed'].includes(p.mpesa_state)) return 'ignored';
    const json = JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    if (r.resultCode === 0 && r.transactionId) {
      const won = await this.db.tx(async (c) => {
        const u = (await c.query(`UPDATE payout SET status = 'confirmed', confirmed_at = now(), mpesa_state = 'completed', mpesa_result = $2::jsonb, bank_ref = $3 WHERE id = $1 AND status = 'released' AND mpesa_state <> 'completed' RETURNING id`, [payoutId, json, r.transactionId])).rows[0];
        if (!u) return false;
        if (r.amountCents !== undefined && r.amountCents !== toCents(p.amount_cents)) await c.query(`INSERT INTO aml_flag (entity_type, entity_id, rule_code) VALUES ('payout',$1,'MPESA_AMOUNT_MISMATCH')`, [payoutId]);
        const shown = words((r.receiverName ?? '').split(' - ').slice(1).join(' - '));
        const reg = words(p.account_name);
        if (r.receiverName && !reg.every((w) => shown.includes(w))) {
          await c.query(`INSERT INTO aml_flag (entity_type, entity_id, rule_code) VALUES ('payout',$1,'MPESA_NAME_MISMATCH')`, [payoutId]);
          await this.notifier.toRole(c, 'compliance', 'mpesa.name_mismatch', { invoice: p.invoice_number }, { type: 'payout', id: payoutId });
        }
        await this.audit.record(c, SYSTEM, 'payout.mpesa_completed', 'payout', payoutId, { mpesaState: p.mpesa_state }, { receipt: r.transactionId, receiverName: r.receiverName });
        return true;
      });
      if (won) await this.advances.markFunded(p.advance_id, payoutId, r.transactionId!);
      return 'completed';
    }
    await this.db.query(`UPDATE payout SET mpesa_result = $2::jsonb WHERE id = $1`, [payoutId, json]);
    await this.advances.failDisbursal(p.advance_id, payoutId, Number(p.fineract_loan_id), `MPESA_${r.resultCode}: ${r.resultDesc}`.slice(0, 200), '', 'mpesa');
    return 'failed';
  }

  /** Transaction status query; an unresolved answer parks the payout as unknown for ops. */
  async query(payoutId: string): Promise<'completed' | 'failed' | 'unknown' | 'pending' | 'ignored'> {
    const p = await this.db.one(`SELECT p.*, i.invoice_number FROM payout p JOIN advance a ON a.id = p.advance_id JOIN invoice i ON i.id = a.invoice_id WHERE p.id = $1`, [payoutId]);
    if (!p || p.status !== 'released') return 'ignored';
    let st;
    try { st = await this.adapters.mpesa.queryStatus({ requestId: `mpesa-q-${payoutId}` }, p.idempotency_key); } catch (e) { st = { state: 'unknown' as const, error: e instanceof AdapterError ? e.code : 'ERROR' }; }
    await this.db.query(`UPDATE payout SET mpesa_last_query_at = $2 WHERE id = $1`, [payoutId, this.clock.now()]);
    if ((st.state === 'completed' || st.state === 'failed') && st.result) return (await this.apply(payoutId, st.result)) as any;
    if (p.mpesa_state !== 'unknown' && (p.mpesa_state === 'timeout' || st.state === 'unknown' || this.isOverdue(p))) {
      await this.db.tx(async (c) => {
        await c.query(`UPDATE payout SET mpesa_state = 'unknown' WHERE id = $1`, [payoutId]);
        await this.audit.record(c, SYSTEM, 'payout.mpesa_unknown', 'payout', payoutId, { mpesaState: p.mpesa_state }, { query: st.state });
        await this.notifier.toRole(c, 'ops', 'mpesa.unknown', { invoice: p.invoice_number }, { type: 'payout', id: payoutId });
      });
      return 'unknown';
    }
    return p.mpesa_state === 'unknown' ? 'unknown' : 'pending';
  }
  private isOverdue(p: any) { return p.mpesa_requested_at && this.clock.now().getTime() - new Date(p.mpesa_requested_at).getTime() >= this.timeoutMinutes() * 60_000; }

  /** Worker every 5 minutes: payouts with no final result after MPESA_RESULT_TIMEOUT_MINUTES (or parked) are queried. */
  async checkPending() {
    const rows = await this.db.query(`SELECT id, mpesa_state, mpesa_requested_at FROM payout WHERE rail = 'mpesa_b2c' AND status = 'released' AND mpesa_state IN ('accepted','timeout','unknown') ORDER BY mpesa_requested_at`);
    const out = { checked: 0, completed: 0, failed: 0, unknown: 0, pending: 0 };
    for (const r of rows) {
      if (r.mpesa_state === 'accepted' && !this.isOverdue(r)) continue;
      out.checked++;
      const s = await this.query(r.id);
      if (s in out) (out as any)[s]++;
    }
    return out;
  }

  list() {
    return this.db.query(`SELECT p.id, p.advance_id, p.amount_cents, p.status, p.mpesa_state, p.bank_ref, p.mpesa_requested_at, p.mpesa_last_query_at, ba.account_number_last4, i.invoice_number
      FROM payout p JOIN bank_account ba ON ba.id = p.bank_account_id JOIN advance a ON a.id = p.advance_id JOIN invoice i ON i.id = a.invoice_id WHERE p.rail = 'mpesa_b2c' ORDER BY p.created_at DESC LIMIT 200`);
  }
}

@Controller()
export class MpesaController {
  constructor(private readonly s: MpesaService) {}

  @Get('mpesa/settings') @Roles('ops', 'ceo', 'admin', 'credit', 'compliance')
  settings() { return this.s.settingsView(); }

  @Post('mpesa/cap') @Roles('admin', 'ceo')
  cap(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ capCents: zCents, reason: zText(500) }).parse(b);
    return this.s.proposeCap(u, body.capCents, body.reason);
  }

  @Get('mpesa/payouts') @Roles('ops', 'ceo', 'compliance')
  payouts() { return this.s.list(); }

  @Post('mpesa/payouts/check') @Roles('ops')
  check() { return this.s.checkPending(); }

  @Post('organisations/:id/mpesa-wallet') @Roles('supplier_admin') @StepUp()
  wallet(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ msisdn: z.string().max(20), accountName: zText(120) }).parse(b);
    return this.s.addWallet(u, zUuid.parse(id), body.msisdn, body.accountName);
  }

  @Public() @HttpCode(200) @Post('webhooks/mpesa/b2c/result/:token')
  result(@Param('token') token: string, @Body() b: unknown) { this.s.checkToken(token); return this.s.onCallback('result', b); }

  @Public() @HttpCode(200) @Post('webhooks/mpesa/b2c/timeout/:token')
  timeout(@Param('token') token: string, @Body() b: unknown) { this.s.checkToken(token); return this.s.onCallback('timeout', b); }
}
