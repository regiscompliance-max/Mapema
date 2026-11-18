/**
 * [Backend Engineer + Ops] Phase 2 daily three-way reconciliation (REC-01..06).
 * bank balance (partner bank) = Fineract cash GL = platform records, compared as movements since the
 * approved baseline, with every difference itemised and classified by recon-engine.ts.
 * Unexplained breaks alert ops AND compliance. Resolution is maker-checker (a second ops user).
 * Balances are read at run time; the worker runs at 06:30 EAT labelled with the previous business
 * date, so overnight items land in the timing window (D-39).
 */
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS } from '../common/config';
import { Clock } from '../common/clock';
import { Db, toCents } from '../common/db';
import { conflict, notFound } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { AuthUser, CurrentUser, Roles } from '../auth/auth';
import { ApprovalsService } from './approvals';
import { HolidaysService } from './holidays';
import { classifyRecon, PendingPosting, PlatformItem } from './recon-engine';

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ZERO = { bankCents: 0n, fineractCents: 0n, platformCents: 0n };

@Injectable()
export class ReconciliationService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly clock: Clock,
    private readonly notifier: Notifier,
    private readonly approvals: ApprovalsService,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
    private readonly holidays: HolidaysService,
  ) {}

  onModuleInit() {
    this.approvals.register('reconciliation_baseline_set', async (c, a) => {
      const r = (await c.query(`INSERT INTO reconciliation_baseline (bank_cents, fineract_cents, platform_cents, note, approved_via) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [a.payload.bankCents, a.payload.fineractCents, a.payload.platformCents, a.payload.note, a.id])).rows[0];
      await this.audit.record(c, SYSTEM, 'reconciliation.baseline_set', 'reconciliation_baseline', r.id, null, a.payload);
    });
    const resolve = async (c: any, a: any) => {
      const b = (await c.query(`SELECT * FROM reconciliation_break WHERE id = $1 FOR UPDATE`, [a.entity_id])).rows[0];
      if (!b) throw notFound('Break');
      await c.query(`UPDATE reconciliation_break SET status = $2, resolution_note = $3, closed_via = $4, carry_forward = $5, updated_at = now() WHERE id = $1`,
        [a.entity_id, a.payload.resolution ?? 'closed', a.payload.note, a.id, a.payload.carryForward === true]);
      await this.audit.record(c, SYSTEM, 'reconciliation.break_resolved', 'reconciliation_break', a.entity_id, { status: b.status, classification: b.classification },
        { status: a.payload.resolution ?? 'closed', carryForward: a.payload.carryForward === true, note: a.payload.note, approvalId: a.id });
    };
    this.approvals.register('reconciliation_break_resolve', resolve);
    this.approvals.register('reconciliation_break_close', resolve); // Phase 1 route
  }

  // ------------------------------------------------------------------ inputs
  private async platform() {
    const items: PlatformItem[] = [];
    for (const f of await this.db.query(`SELECT reference, value_date, amount_cents, direction FROM funding_movement`))
      items.push({ ref: f.reference, date: f.value_date, amountCents: f.direction === 'in' ? toCents(f.amount_cents) : -toCents(f.amount_cents), source: 'funding' });
    for (const t of await this.db.query(`SELECT bank_ref, value_date, amount_cents FROM bank_transaction`))
      items.push({ ref: t.bank_ref, date: t.value_date, amountCents: toCents(t.amount_cents), source: 'bank_transaction' });
    for (const p of await this.db.query(`SELECT bank_ref, COALESCE(value_date, (released_at AT TIME ZONE 'Africa/Nairobi')::date) AS d, amount_cents, status FROM payout WHERE bank_ref IS NOT NULL AND status IN ('released','confirmed','returned')`)) {
      items.push({ ref: p.bank_ref, date: p.d, amountCents: -toCents(p.amount_cents), source: 'payout' });
      if (p.status === 'returned') items.push({ ref: `${p.bank_ref}-R`, date: p.d, amountCents: toCents(p.amount_cents), source: 'payout_return' });
    }
    const balance = items.reduce((s, i) => s + i.amountCents, 0n);
    return { items, balance };
  }

  private async pending(): Promise<PendingPosting[]> {
    const out: PendingPosting[] = [];
    for (const o of await this.db.query(`SELECT id, status, payload FROM outbox WHERE topic LIKE 'ledger.%' AND status <> 'done'`))
      out.push({ ref: `outbox-${o.id}`, amountCents: BigInt(o.payload?.bankEffectCents ?? 0), state: o.status === 'dead' ? 'dead' : o.status === 'failed' ? 'retrying' : 'pending' });
    for (const p of await this.db.query(`SELECT id, amount_cents, received_at FROM payment WHERE status = 'unmatched'`))
      out.push({ ref: `unmatched-${p.id}`, amountCents: toCents(p.amount_cents), state: 'unmatched', date: new Date(p.received_at).toISOString().slice(0, 10) });
    return out;
  }

  /** Phase 3 MP-05: cash = partner bank account + M-Pesa B2C float (same Fineract cash GL). */
  private async cash() {
    const balance0 = await this.adapters.bank.getBalance();
    const st0 = await this.adapters.bank.getStatement('0001-01-01', '9999-12-31');
    try {
      const mb = await this.adapters.mpesa.getBalance();
      const ms = await this.adapters.mpesa.getStatement('0001-01-01', '9999-12-31');
      return { balance: balance0 + mb, statement: [...st0, ...ms] };
    } catch {
      return { balance: balance0, statement: st0 }; // sandbox/live: no statement API yet (Q-M); M-Pesa payouts then show as breaks
    }
  }

  async baseline() {
    return this.db.one(`SELECT * FROM reconciliation_baseline ORDER BY effective_at DESC LIMIT 1`);
  }

  private async currentBalances() {
    const [bank, fineract, plat] = [(await this.cash()).balance, await this.adapters.ledger.glBalance('bank'), await this.platform()];
    return { bank, fineract, platform: plat.balance };
  }

  async proposeBaseline(u: AuthUser, note: string) {
    const cur = await this.currentBalances();
    return this.db.tx((c) => this.approvals.propose(c, u, {
      action: 'reconciliation_baseline_set', entityType: 'reconciliation_baseline', entityId: '00000000-0000-0000-0000-00000000000b',
      payload: { bankCents: cur.bank, fineractCents: cur.fineract, platformCents: cur.platform, note }, requiredRole: 'ops', reason: note,
    }));
  }

  // ------------------------------------------------------------------ run
  async reconcile(date = this.clock.today()) {
    const bl = await this.baseline();
    const baseline = bl ? { bankCents: toCents(bl.bank_cents), fineractCents: toCents(bl.fineract_cents), platformCents: toCents(bl.platform_cents) } : ZERO;
    const { balance: bank, statement } = await this.cash();
    const fineract = await this.adapters.ledger.glBalance('bank');
    const plat = await this.platform();
    const carry = (await this.db.query(`SELECT DISTINCT ON (item_key) item_key, closed_via, difference_cents FROM reconciliation_break
        WHERE item_key IS NOT NULL AND carry_forward AND status = 'explained' AND closed_via IS NOT NULL ORDER BY item_key, updated_at DESC`))
      .map((r) => ({ itemKey: r.item_key, approvalId: r.closed_via, amountCents: toCents(r.difference_cents) }));
    const res = classifyRecon({ asOf: date, bankBalanceCents: bank, fineractBalanceCents: fineract, platformBalanceCents: plat.balance, baseline,
      statement, platformItems: plat.items, pendingPostings: await this.pending(), carryForward: carry, timingWindowBusinessDays: 1, calendar: await this.holidays.calendar() });

    return this.db.tx(async (c) => {
      const detail = JSON.stringify({ movements: res.movements, differences: res.differences, baselineId: bl?.id ?? null }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      const run = (await c.query(`INSERT INTO reconciliation_run (as_of_date, bank_balance_cents, fineract_cash_cents, platform_cash_cents, status, unexplained_count, detail) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (as_of_date) DO UPDATE SET bank_balance_cents = EXCLUDED.bank_balance_cents, fineract_cash_cents = EXCLUDED.fineract_cash_cents,
          platform_cash_cents = EXCLUDED.platform_cash_cents, ran_at = now(), detail = EXCLUDED.detail RETURNING id`,
        [date, bank, fineract, plat.balance, res.status, res.unexplainedCount, detail])).rows[0];
      const keys: string[] = [];
      for (const b of res.breaks) {
        keys.push(b.itemKey);
        const prior = (await c.query(`SELECT id, status, difference_cents FROM reconciliation_break WHERE run_id = $1 AND item_key = $2`, [run.id, b.itemKey])).rows[0];
        const keepResolved = prior && ['explained', 'closed'].includes(prior.status) && toCents(prior.difference_cents) === b.amountCents;
        const status = keepResolved ? prior.status : b.classification === 'explained' ? 'explained' : 'open';
        const kind = b.kind;
        const ref = JSON.stringify({ ref: b.ref ?? null, detail: b.detail, approvalId: b.approvalId ?? null });
        if (prior) {
          await c.query(`UPDATE reconciliation_break SET kind = $2, difference_cents = $3, reference = $4::jsonb, classification = $5, category = $6, expected_clear_by = $7, status = $8, updated_at = now() WHERE id = $1`,
            [prior.id, kind, b.amountCents, ref, b.classification, b.category, b.expectedClearBy ?? null, status]);
        } else {
          await c.query(`INSERT INTO reconciliation_break (run_id, kind, difference_cents, reference, status, item_key, classification, category, expected_clear_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
            [run.id, kind, b.amountCents, ref, status, b.itemKey, b.classification, b.category, b.expectedClearBy ?? null]);
        }
      }
      // items that disappeared on this rerun are cleared (never deleted)
      await c.query(`UPDATE reconciliation_break SET status = 'cleared', updated_at = now() WHERE run_id = $1 AND item_key IS NOT NULL AND NOT (item_key = ANY($2::text[])) AND status IN ('open')`, [run.id, keys]);
      // Phase 1 detective breaks raised by payments (allocation/in duplum/overpayment) count as unexplained until resolved
      await c.query(`UPDATE reconciliation_break SET classification = 'unexplained', category = kind WHERE run_id = $1 AND item_key IS NULL AND classification IS NULL`, [run.id]);
      const legacy = (await c.query(`SELECT count(*)::int AS n FROM reconciliation_break WHERE run_id = $1 AND item_key IS NULL AND status = 'open'`, [run.id])).rows[0].n;
      const unexplained = (await c.query(`SELECT count(*)::int AS n FROM reconciliation_break WHERE run_id = $1 AND item_key IS NOT NULL AND classification = 'unexplained' AND status = 'open'`, [run.id])).rows[0].n + legacy;
      const live = (await c.query(`SELECT count(*)::int AS n FROM reconciliation_break WHERE run_id = $1 AND status <> 'cleared'`, [run.id])).rows[0].n;
      const status = live === 0 ? 'balanced' : unexplained === 0 ? 'explained' : 'breaks';
      await c.query(`UPDATE reconciliation_run SET status = $2, unexplained_count = $3 WHERE id = $1`, [run.id, status, unexplained]);
      await this.audit.record(c, SYSTEM, 'reconciliation.run', 'reconciliation_run', run.id, null, { date, bank, fineract, platform: plat.balance, status, unexplained, movements: res.movements });
      if (unexplained > 0) {
        await this.notifier.toRole(c, 'ops', 'recon.unexplained', { date, count: String(unexplained) }, { type: 'reconciliation_run', id: run.id });
        await this.notifier.toRole(c, 'compliance', 'recon.unexplained', { date, count: String(unexplained) }, { type: 'reconciliation_run', id: run.id });
      }
      const out = (await c.query(`SELECT * FROM reconciliation_run WHERE id = $1`, [run.id])).rows[0];
      const breaks = (await c.query(`SELECT id, kind, item_key, classification, category, difference_cents, status, expected_clear_by, reference, resolution_note FROM reconciliation_break
        WHERE run_id = $1 AND status <> 'cleared' ORDER BY classification DESC NULLS FIRST, created_at`, [run.id])).rows;
      return { ...out, movements: res.movements, differences: res.differences, breaks };
    });
  }

  async proposeResolve(u: AuthUser, id: string, b: { resolution: 'explained' | 'closed'; note: string; carryForward?: boolean }) {
    return this.db.tx(async (c) => {
      const br = (await c.query(`SELECT id, status FROM reconciliation_break WHERE id = $1`, [id])).rows[0];
      if (!br) throw notFound('Break');
      if (br.status === 'cleared') throw conflict('BAD_STATE', 'Break has cleared');
      return this.approvals.propose(c, u, { action: 'reconciliation_break_resolve', entityType: 'reconciliation_break', entityId: id, payload: b, requiredRole: 'ops', reason: b.note });
    });
  }

  runs() {
    return this.db.query(`SELECT r.*, (SELECT count(*) FROM reconciliation_break b WHERE b.run_id = r.id AND b.status = 'open')::int AS open_breaks FROM reconciliation_run r ORDER BY as_of_date DESC LIMIT 90`);
  }

  breaks(runId: string) {
    return this.db.query(`SELECT b.*, a.status AS approval_status FROM reconciliation_break b
      LEFT JOIN LATERAL (SELECT status FROM approval_request x WHERE x.entity_id = b.id ORDER BY created_at DESC LIMIT 1) a ON true
      WHERE b.run_id = $1 AND b.status <> 'cleared' ORDER BY b.classification DESC NULLS FIRST, b.created_at`, [runId]);
  }

  async latest() {
    return this.db.one(`SELECT as_of_date, status, unexplained_count, ran_at FROM reconciliation_run ORDER BY as_of_date DESC LIMIT 1`);
  }
}

@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly s: ReconciliationService) {}

  @Post('run') @Roles('ops')
  run(@Query('date') date?: string) { return this.s.reconcile(date ? ISO.parse(date) : undefined); }

  @Get('runs') @Roles('ops', 'ceo', 'compliance', 'auditor')
  runs() { return this.s.runs(); }

  @Get('runs/:id/breaks') @Roles('ops', 'ceo', 'compliance', 'auditor')
  breaks(@Param('id') id: string) { return this.s.breaks(zUuid.parse(id)); }

  @Post('breaks/:id/resolve') @Roles('ops')
  resolve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.proposeResolve(u, zUuid.parse(id), z.object({ resolution: z.enum(['explained', 'closed']), note: zText(2000), carryForward: z.boolean().optional() }).parse(b));
  }

  @Post('breaks/:id/close') @Roles('ops')
  close(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.proposeResolve(u, zUuid.parse(id), { resolution: 'closed', note: z.object({ note: zText(2000) }).parse(b).note });
  }

  @Get('baseline') @Roles('ops', 'ceo', 'compliance', 'auditor')
  baseline() { return this.s.baseline(); }

  @Post('baseline') @Roles('ops') 
  proposeBaseline(@CurrentUser() u: AuthUser, @Body() b: unknown) { return this.s.proposeBaseline(u, z.object({ note: zText(500) }).parse(b).note); }
}
