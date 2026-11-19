/**
 * [Backend Engineer + Ops] Bulk tools (Phase 3 BULK-01..04).
 *  - buyers: bulk confirmation (one decision applied invoice by invoice, per-item results; the ILU for
 *    many invoices already exists: POST /confirmations takes up to 200)
 *  - suppliers: bulk quotes (one disclosure per invoice, totals); acceptance of many quotes already
 *    exists (POST /advances with disclosureIds[])
 *  - ops: payout batches. Maker (ops) builds a batch of approved advances; a DIFFERENT ops user approves
 *    it with step-up MFA and may reject single items. Approved items are released ONE BY ONE through the
 *    normal release path (four eyes vs credit, all checks incl. concentration limits and funding source
 *    re-run per item, under the release lock), so one failure never stops the others. Every step is
 *    audited at batch and item level.
 */
import { Body, Controller, Get, Inject, Injectable, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { formatKes } from '@mapema/pricing';
import { Audit } from '../common/audit';
import { AppConfig, CONFIG } from '../common/config';
import { Db, toCents } from '../common/db';
import { badRequest, conflict, DomainError, forbidden, notFound } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { AuthUser, CurrentUser, Roles, StepUp } from '../auth/auth';
import { AdvancesService } from './advances';
import { InvoicesService } from './invoices';

/**
 * S-15 (go-live): a batch is released item by item after the approval; a long batch could outlive the
 * approver's step-up. Each item re-checks that the approver's authentication (auth_time) is still within
 * BATCH_STEP_UP_WINDOW_SEC (default 900 s); once it is not, the remaining items are NOT released
 * (status failed, STEP_UP_EXPIRED) and the batch ends partially_failed / failed. The advances stay
 * approved, so ops can put them in a new batch for a fresh approval.
 */
export function batchStepUpValid(authTimeSec: number, nowSec: number, windowSec: number): boolean {
  return Number.isFinite(authTimeSec) && authTimeSec > 0 && nowSec - authTimeSec <= windowSec;
}

const err = (e: unknown) => (e instanceof DomainError ? { error: e.code, message: e.message, ...(e.extra ?? {}) } : { error: 'INTERNAL', message: (e as Error).message.slice(0, 200) });

@Injectable()
export class BulkService {
  constructor(private readonly db: Db, private readonly audit: Audit, private readonly notifier: Notifier, private readonly invoices: InvoicesService, private readonly advances: AdvancesService,
    @Inject(CONFIG) private readonly cfg: AppConfig) {}
  /** wall clock (auth_time is wall-clock epoch seconds from the IdP); replaceable in tests */
  nowSec: () => number = () => Math.floor(Date.now() / 1000);
  private windowSec() { return Math.max(60, Number(this.cfg.raw.BATCH_STEP_UP_WINDOW_SEC ?? 900)); }

  async bulkDecision(u: AuthUser, ids: string[], decision: 'approve' | 'reject', reasonCode?: string, reasonText?: string, att?: { goodsReceived?: boolean; goodsReceivedNote?: string; poReference?: string }) {
    const results = [];
    for (const id of ids) {
      try { const r: any = await this.invoices.decide(u, id, decision, reasonCode, reasonText, att); results.push({ invoiceId: id, status: 'ok', newStatus: r?.status ?? (decision === 'approve' ? 'confirmed' : 'rejected') }); }
      catch (e) { results.push({ invoiceId: id, status: 'error', ...err(e) }); }
    }
    return { decision, ok: results.filter((r) => r.status === 'ok').length, failed: results.filter((r) => r.status === 'error').length, results };
  }

  async bulkQuote(u: AuthUser, ids: string[]) {
    const results = []; let adv = 0n; let cost = 0n; let n = 0;
    for (const id of ids) {
      try { const q = await this.advances.quote(u, id); results.push({ invoiceId: id, status: 'ok', quote: q }); adv += q.advanceCents; cost += q.totalCostCents; n++; }
      catch (e) { results.push({ invoiceId: id, status: 'error', ...err(e) }); }
    }
    return { results, totals: { invoices: n, advanceCents: adv, totalCostCents: cost } };
  }

  // ------------------------------------------------------------------ payout batches
  async createBatch(u: AuthUser, advanceIds: string[], note: string) {
    if (new Set(advanceIds).size !== advanceIds.length) throw badRequest('DUPLICATE_ITEMS', 'An advance appears twice');
    return this.db.tx(async (c) => {
      const rows = (await c.query(`SELECT a.id, a.status, p.amount_cents, p.rail, i.invoice_number FROM advance a JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN payout p ON p.advance_id = a.id AND p.type = 'advance' AND p.status = 'approved' WHERE a.id = ANY($1::uuid[]) FOR UPDATE OF a`, [advanceIds])).rows;
      const byId = new Map(rows.map((r: any) => [r.id, r]));
      const bad = advanceIds.filter((id) => byId.get(id)?.status !== 'approved' || !byId.get(id)?.amount_cents);
      if (bad.length) throw conflict('NOT_APPROVED', 'Only approved advances can be batched', { advanceIds: bad });
      const busy = (await c.query(`SELECT advance_id FROM payout_batch_item WHERE advance_id = ANY($1::uuid[]) AND status = 'pending'`, [advanceIds])).rows;
      if (busy.length) throw conflict('IN_BATCH', 'Some advances are already in a pending batch', { advanceIds: busy.map((b: any) => b.advance_id) });
      const total = advanceIds.reduce((s, id) => s + toCents(byId.get(id).amount_cents), 0n);
      const b = (await c.query(`INSERT INTO payout_batch (note, total_cents, item_count, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [note, total, advanceIds.length, u.id])).rows[0];
      for (const [i, id] of advanceIds.entries()) {
        await c.query(`INSERT INTO payout_batch_item (batch_id, seq, advance_id, amount_cents, rail) VALUES ($1,$2,$3,$4,$5)`, [b.id, i + 1, id, byId.get(id).amount_cents, byId.get(id).rail]);
      }
      await this.audit.record(c, u.actor, 'payout_batch.create', 'payout_batch', b.id, null, { items: advanceIds.length, totalCents: total, note });
      await this.notifier.toRole(c, 'ops', 'payout_batch.pending', { count: String(advanceIds.length), amount: formatKes(total) }, { type: 'payout_batch', id: b.id });
      return b.id as string;
    }).then((id) => this.get(id));
  }

  async get(id: string) {
    const b = await this.db.one(`SELECT b.*, m.display_name AS created_by_name, k.display_name AS approved_by_name FROM payout_batch b JOIN user_account m ON m.id = b.created_by LEFT JOIN user_account k ON k.id = b.approved_by WHERE b.id = $1`, [id]);
    if (!b) throw notFound('Payout batch');
    const items = await this.db.query(`SELECT t.id, t.seq, t.advance_id, t.amount_cents, t.rail, t.status, t.error_code, t.error_detail, t.reject_reason, t.decided_at, i.invoice_number, s.legal_name AS supplier_name, a.status AS advance_status
      FROM payout_batch_item t JOIN advance a ON a.id = t.advance_id JOIN invoice i ON i.id = a.invoice_id JOIN organisation s ON s.id = a.supplier_id WHERE t.batch_id = $1 ORDER BY t.seq`, [id]);
    return { id: b.id, status: b.status, note: b.note, totalCents: toCents(b.total_cents), itemCount: b.item_count, releasedCents: toCents(b.released_cents), createdBy: b.created_by_name, approvedBy: b.approved_by_name,
      createdAt: b.created_at, approvedAt: b.approved_at, finishedAt: b.finished_at,
      items: items.map((t: any) => ({ id: t.id, seq: t.seq, advanceId: t.advance_id, invoiceNumber: t.invoice_number, supplierName: t.supplier_name, amountCents: toCents(t.amount_cents), rail: t.rail, status: t.status,
        errorCode: t.error_code, failedChecks: t.error_detail?.failedChecks ?? undefined, rejectReason: t.reject_reason, advanceStatus: t.advance_status })) };
  }

  list() {
    return this.db.query(`SELECT b.id, b.status, b.note, b.total_cents, b.item_count, b.released_cents, b.created_at, b.approved_at, b.finished_at, m.display_name AS created_by_name
      FROM payout_batch b JOIN user_account m ON m.id = b.created_by ORDER BY b.created_at DESC LIMIT 100`);
  }

  async approve(u: AuthUser, id: string, rejectItems: { itemId: string; reason: string }[]) {
    const items = await this.db.tx(async (c) => {
      const b = (await c.query(`SELECT * FROM payout_batch WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!b) throw notFound('Payout batch');
      if (b.status !== 'pending_approval') throw conflict('BAD_STATE', `Batch is ${b.status}`);
      if (b.created_by === u.id) throw forbidden('FOUR_EYES', 'The person who built a batch cannot approve it');
      const its = (await c.query(`SELECT id, advance_id FROM payout_batch_item WHERE batch_id = $1 ORDER BY seq`, [id])).rows;
      const unknown = rejectItems.filter((r) => !its.some((i: any) => i.id === r.itemId));
      if (unknown.length) throw badRequest('UNKNOWN_ITEM', 'An item to reject is not in this batch');
      await c.query(`UPDATE payout_batch SET status = 'processing', approved_by = $2, approved_at = now(), step_up_auth_ref = $3 WHERE id = $1`, [id, u.id, `auth_time:${u.authTime}`]);
      await this.audit.record(c, u.actor, 'payout_batch.approve', 'payout_batch', id, { status: 'pending_approval' }, { status: 'processing', rejectedItems: rejectItems.length });
      return its;
    });
    let released = 0n; let ok = 0; let failed = 0;
    for (const it of items) {
      const rej = rejectItems.find((r) => r.itemId === it.id);
      if (rej) {
        await this.db.tx(async (c) => {
          await c.query(`UPDATE payout_batch_item SET status = 'rejected', reject_reason = $2, decided_at = now() WHERE id = $1`, [it.id, rej.reason]);
          await this.audit.record(c, u.actor, 'payout_batch.item_rejected', 'payout_batch_item', it.id, { status: 'pending' }, { status: 'rejected', reason: rej.reason, batchId: id, advanceId: it.advance_id });
        });
        continue;
      }
      let status: 'released' | 'failed' = 'released'; let code: string | null = null; let detail: unknown = null;
      if (!batchStepUpValid(u.authTime, this.nowSec(), this.windowSec())) {
        status = 'failed'; code = 'STEP_UP_EXPIRED'; detail = { message: 'The approver\'s step-up expired during the batch; re-batch the remaining advances and approve again', windowSec: this.windowSec() };
      } else try {
        const a: any = await this.advances.release(u, it.advance_id, { fromBatch: id });
        if (a.status === 'release_failed') { status = 'failed'; code = String(a.decline_reason ?? '').replace(/^(bank|mpesa): /, '').split(':')[0] || 'RELEASE_FAILED'; }
      } catch (e) {
        status = 'failed';
        code = e instanceof DomainError ? e.code : 'INTERNAL';
        const fc = (e as DomainError).extra?.failedChecks as { code: string }[] | undefined;
        detail = { message: (e as Error).message.slice(0, 300), failedChecks: fc?.map((x) => x.code) };
      }
      const amt = (await this.db.one(`SELECT amount_cents FROM payout_batch_item WHERE id = $1`, [it.id])).amount_cents;
      if (status === 'released') { released += toCents(amt); ok++; } else failed++;
      await this.db.tx(async (c) => {
        await c.query(`UPDATE payout_batch_item SET status = $2, error_code = $3, error_detail = $4::jsonb, decided_at = now() WHERE id = $1`, [it.id, status, code, detail ? JSON.stringify(detail) : null]);
        await this.audit.record(c, u.actor, `payout_batch.item_${status}`, 'payout_batch_item', it.id, { status: 'pending' }, { status, errorCode: code, batchId: id, advanceId: it.advance_id });
      });
    }
    const final = failed === 0 ? 'completed' : ok === 0 ? 'failed' : 'partially_failed';
    await this.db.tx(async (c) => {
      await c.query(`UPDATE payout_batch SET status = $2, released_cents = $3, finished_at = now() WHERE id = $1`, [id, final, released]);
      await this.audit.record(c, u.actor, 'payout_batch.completed', 'payout_batch', id, { status: 'processing' }, { status: final, releasedCents: released, released: ok, failed, rejected: rejectItems.length });
    });
    return this.get(id);
  }

  async cancel(u: AuthUser, id: string, reason: string) {
    return this.db.tx(async (c) => {
      const r = (await c.query(`UPDATE payout_batch SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'pending_approval' RETURNING id`, [id])).rows[0];
      if (!r) throw conflict('BAD_STATE', 'Only a batch waiting for approval can be cancelled');
      await c.query(`UPDATE payout_batch_item SET status = 'rejected', reject_reason = 'batch cancelled', decided_at = now() WHERE batch_id = $1 AND status = 'pending'`, [id]);
      await this.audit.record(c, u.actor, 'payout_batch.cancel', 'payout_batch', id, { status: 'pending_approval' }, { status: 'cancelled', reason });
      return { id, status: 'cancelled' };
    });
  }
}

@Controller()
export class BulkController {
  constructor(private readonly s: BulkService) {}

  @Post('invoices/bulk-decision') @Roles('buyer_checker')
  decision(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ invoiceIds: z.array(zUuid).min(1).max(200), decision: z.enum(['approve', 'reject']), reasonCode: z.string().max(40).optional(), reasonText: z.string().max(500).optional(),
      goodsReceived: z.boolean().optional(), goodsReceivedNote: z.string().max(500).optional(), poReference: z.string().max(60).optional() }).parse(b);
    if (body.decision === 'reject' && !body.reasonCode) throw badRequest('REASON_REQUIRED', 'A rejection needs a reason code');
    return this.s.bulkDecision(u, body.invoiceIds, body.decision, body.reasonCode, body.reasonText, { goodsReceived: body.goodsReceived, goodsReceivedNote: body.goodsReceivedNote, poReference: body.poReference });
  }

  @Post('invoices/bulk-quote') @Roles('supplier_admin', 'supplier_user')
  quote(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    return this.s.bulkQuote(u, z.object({ invoiceIds: z.array(zUuid).min(1).max(50) }).parse(b).invoiceIds);
  }

  @Get('payout-batches') @Roles('ops', 'ceo', 'compliance', 'auditor')
  list() { return this.s.list(); }

  @Get('payout-batches/:id') @Roles('ops', 'ceo', 'compliance', 'auditor')
  get(@Param('id') id: string) { return this.s.get(zUuid.parse(id)); }

  @Post('payout-batches') @Roles('ops')
  create(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ advanceIds: z.array(zUuid).min(1).max(100), note: zText(300) }).parse(b);
    return this.s.createBatch(u, body.advanceIds, body.note);
  }

  @Post('payout-batches/:id/approve') @Roles('ops') @StepUp()
  approve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ rejectItems: z.array(z.object({ itemId: zUuid, reason: zText(300) })).max(100).default([]) }).parse(b);
    return this.s.approve(u, zUuid.parse(id), body.rejectItems);
  }

  @Post('payout-batches/:id/cancel') @Roles('ops')
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.cancel(u, zUuid.parse(id), z.object({ reason: zText(300) }).parse(b).reason);
  }
}
