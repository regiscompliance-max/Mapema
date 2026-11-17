/**
 * [Backend Engineer] Invoices and buyer confirmations (workflow 3, steps 1-3):
 * buyer upload (single/CSV) or supplier submit -> eTIMS validation + duplicate block ->
 * buyer checker approve/reject/hold (maker != checker) -> buyer signs the ILU (per invoice or
 * batch) -> invoice becomes eligible for early payment.
 */
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { daysBetween, formatKes } from '@mapema/pricing';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS } from '../common/config';
import { FieldCrypto } from '../common/crypto';
import { Clock } from '../common/clock';
import { Db, Q, toCents } from '../common/db';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { zDate, zKes, zKraPin, zPositiveCents, zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { assertOrgAccess, AuthUser, BUYER_ROLES, CurrentUser, hasRole, isStaff, orgIds, Roles, StepUp, SUPPLIER_ROLES } from '../auth/auth';
import { SettingsService } from './admin';
import { simplePdf, DocumentsService } from './documents';
import { OnboardingService } from './onboarding';

export const normaliseInvoiceNo = (n: string) => n.toUpperCase().replace(/[\s\-_/\\.]/g, '');

export interface NewInvoice {
  supplierKraPin: string;
  invoiceNumber: string;
  amountCents: bigint;
  currency: 'KES';
  issueDate: string;
  dueDate: string;
  etimsCuInvoiceNo?: string;
  poReference?: string;
}

@Injectable()
export class InvoicesService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly notifier: Notifier,
    private readonly docs: DocumentsService,
    private readonly onboarding: OnboardingService,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
  ) {}

  onModuleInit() {
    this.onboarding.registerEsign('ilu', async (c, env, signed) => {
      const conf = (await c.query(`SELECT * FROM confirmation WHERE id = $1`, [env.entity_id])).rows[0];
      const doc = await this.docs.store(c, { ownerOrgId: conf.buyer_id, type: 'ilu', fileName: `ilu-${conf.id}.pdf`, mimeType: 'application/pdf', body: signed.pdf, signedAt: signed.signedAt, envelopeId: env.envelope_id });
      await c.query(`UPDATE confirmation SET ilu_document_id = $2, signed_at = $3 WHERE id = $1`, [conf.id, doc.id, signed.signedAt]);
      await c.query(`UPDATE esign_envelope SET document_id = $2 WHERE envelope_id = $1`, [env.envelope_id, doc.id]);
      const invs = (await c.query(
        `UPDATE invoice i SET status = CASE WHEN i.etims_status IN ('valid','overridden') THEN 'eligible'::invoice_status ELSE 'ilu_signed'::invoice_status END, updated_at = now()
         FROM confirmation_invoice ci WHERE ci.invoice_id = i.id AND ci.confirmation_id = $1 RETURNING i.id, i.status, i.supplier_id, i.invoice_number`, [conf.id])).rows;
      const buyer = (await c.query(`SELECT legal_name FROM organisation WHERE id = $1`, [conf.buyer_id])).rows[0];
      for (const i of invs) {
        await this.audit.record(c, SYSTEM, 'invoice.ilu_signed', 'invoice', i.id, null, { status: i.status, confirmationId: conf.id });
        if (i.status === 'eligible') await this.notifier.toOrg(c, i.supplier_id, 'invoice.eligible', { invoice: i.invoice_number, buyer: buyer.legal_name }, { type: 'invoice', id: i.id });
      }
    });
  }

  /** Validate and insert one invoice (shared by single upload, CSV and supplier submission). */
  private async insertOne(c: Q, u: AuthUser, buyerId: string, supplierId: string | null, inv: NewInvoice, source: string) {
    const today = this.clock.today();
    const min = await this.settings.invoiceMinimum(c);
    if (inv.amountCents < min) throw unprocessable('BELOW_MINIMUM_INVOICE', `Invoices must be at least ${formatKes(min)}`);
    if (inv.dueDate < inv.issueDate) throw unprocessable('DUE_BEFORE_ISSUE', 'Due date is before the issue date');
    const days = daysBetween(today, inv.dueDate);
    if (days < 1 || days > 120) throw unprocessable('TENOR_OUT_OF_RANGE', 'Due date must be 1 to 120 days from today');
    const sup = (await c.query(`SELECT o.id, o.kra_pin FROM organisation o JOIN supplier_link l ON l.supplier_id = o.id AND l.buyer_id = $1
      WHERE o.type = 'supplier' AND o.kra_pin = $2 AND l.status IN ('joined','active')`, [buyerId, inv.supplierKraPin])).rows[0];
    if (!sup) throw unprocessable('SUPPLIER_NOT_LINKED', 'This supplier has not joined your programme');
    if (supplierId && sup.id !== supplierId) throw forbidden('ORG_SCOPE', 'KRA PIN does not match your company');
    const buyer = (await c.query(`SELECT kra_pin FROM organisation WHERE id = $1`, [buyerId])).rows[0];
    const norm = normaliseInvoiceNo(inv.invoiceNumber);
    const dupHash = FieldCrypto.sha256(`${inv.supplierKraPin}|${norm}|${inv.amountCents}`);
    const dup = (await c.query(`SELECT id FROM invoice WHERE duplicate_hash = $1 OR (supplier_kra_pin = $2 AND invoice_number_norm = $3)`, [dupHash, inv.supplierKraPin, norm])).rows[0];
    if (dup) {
      await this.audit.record(c, u.actor, 'invoice.duplicate_blocked', 'invoice', dup.id, null, { invoiceNumber: inv.invoiceNumber, supplierKraPin: inv.supplierKraPin });
      throw conflict('DUPLICATE_INVOICE', 'This invoice number has already been submitted for this supplier', { existingInvoiceId: dup.id });
    }
    const et = await this.adapters.etims.validateInvoice({ requestId: u.actor.requestId ?? 'inv' }, {
      supplierPin: inv.supplierKraPin, buyerPin: buyer.kra_pin, invoiceNumber: inv.invoiceNumber, cuInvoiceNo: inv.etimsCuInvoiceNo, amountCents: inv.amountCents, issueDate: inv.issueDate,
    });
    const r = (await c.query(
      `INSERT INTO invoice (supplier_id, buyer_id, supplier_kra_pin, invoice_number, invoice_number_norm, etims_cu_invoice_no, issue_date, due_date, amount_cents, currency, po_reference,
         etims_status, etims_checked_at, etims_response, duplicate_hash, status, uploaded_by, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'KES',$10,$11, now(), $12, $13, 'awaiting_confirmation', $14, $15) RETURNING *`,
      [sup.id, buyerId, inv.supplierKraPin, inv.invoiceNumber, norm, inv.etimsCuInvoiceNo ?? null, inv.issueDate, inv.dueDate, inv.amountCents, inv.poReference ?? null,
        et.status, JSON.stringify(et), dupHash, u.id, source])).rows[0];
    await this.audit.record(c, u.actor, 'invoice.create', 'invoice', r.id, null, { invoiceNumber: inv.invoiceNumber, amountCents: inv.amountCents, dueDate: inv.dueDate, etims: et.status, source });
    return r;
  }

  async createByBuyer(u: AuthUser, inv: NewInvoice) {
    const buyerId = orgIds(u, ['buyer_maker', 'buyer_admin'])[0];
    if (!buyerId) throw forbidden('ROLE_REQUIRED', 'Only a buyer maker can upload invoices');
    return this.db.tx((c) => this.insertOne(c, u, buyerId, null, inv, 'buyer_upload'));
  }

  async createBySupplier(u: AuthUser, buyerId: string, inv: NewInvoice) {
    const supplierId = orgIds(u, SUPPLIER_ROLES)[0];
    if (!supplierId) throw forbidden('ROLE_REQUIRED', 'Only a supplier can submit invoices');
    return this.db.tx((c) => this.insertOne(c, u, buyerId, supplierId, inv, 'supplier_submit'));
  }

  /** BUY-06 CSV: supplier_kra_pin,invoice_number,amount_cents,currency,issue_date,due_date[,etims_cu_invoice_no,po_reference] */
  async uploadCsv(u: AuthUser, csv: string) {
    const buyerId = orgIds(u, ['buyer_maker', 'buyer_admin'])[0];
    if (!buyerId) throw forbidden('ROLE_REQUIRED', 'Only a buyer maker can upload invoices');
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 501) throw unprocessable('CSV_TOO_LARGE', 'Upload at most 500 invoices per file');
    const rows = lines[0]?.toLowerCase().startsWith('supplier_kra_pin') ? lines.slice(1) : lines;
    const results: { line: number; status: 'created' | 'error'; invoiceId?: string; error?: string }[] = [];
    for (const [i, line] of rows.entries()) {
      const [pin, number, amount, currency, issue, due, cu, po] = line.split(',').map((x) => x?.trim());
      try {
        const parsed = invoiceSchema.parse({ supplierKraPin: pin, invoiceNumber: number, amountCents: amount, currency, issueDate: issue, dueDate: due, etimsCuInvoiceNo: cu || undefined, poReference: po || undefined });
        const r = await this.db.tx((c) => this.insertOne(c, u, buyerId, null, parsed, 'buyer_csv'));
        results.push({ line: i + 2, status: 'created', invoiceId: r.id });
      } catch (e: any) {
        results.push({ line: i + 2, status: 'error', error: e?.issues ? e.issues.map((x: any) => `${x.path.join('.')}: ${x.message}`).join('; ') : e?.message });
      }
    }
    return { created: results.filter((r) => r.status === 'created').length, failed: results.filter((r) => r.status === 'error').length, results };
  }

  async decide(u: AuthUser, invoiceId: string, decision: 'approve' | 'reject' | 'hold' | 'release_hold', reasonCode?: string, reasonText?: string) {
    return this.db.tx(async (c) => {
      const inv = (await c.query(`SELECT * FROM invoice WHERE id = $1 FOR UPDATE`, [invoiceId])).rows[0];
      if (!inv) throw notFound('Invoice');
      if (!orgIds(u, ['buyer_checker', 'buyer_admin']).includes(inv.buyer_id)) throw forbidden('ORG_SCOPE', 'Only a checker at this buyer can decide');
      if (inv.uploaded_by === u.id) throw forbidden('FOUR_EYES', 'The person who uploaded an invoice cannot also approve it');
      const allowed: Record<string, string[]> = { approve: ['awaiting_confirmation', 'on_hold'], reject: ['awaiting_confirmation', 'on_hold'], hold: ['awaiting_confirmation'], release_hold: ['on_hold'] };
      if (!allowed[decision].includes(inv.status)) throw conflict('BAD_STATE', `Invoice is ${inv.status}`);
      if (decision === 'approve' && inv.etims_status === 'invalid') throw unprocessable('ETIMS_INVALID', 'eTIMS says this invoice is not valid; it cannot be confirmed');
      const next = { approve: 'confirmed', reject: 'rejected', hold: 'on_hold', release_hold: 'awaiting_confirmation' }[decision];
      await c.query(`INSERT INTO invoice_decision (invoice_id, decision, reason_code, reason_text, decided_by) VALUES ($1,$2,$3,$4,$5)`, [invoiceId, decision, reasonCode ?? null, reasonText ?? null, u.id]);
      await c.query(`UPDATE invoice SET status = $2, updated_at = now() WHERE id = $1`, [invoiceId, next]);
      await this.audit.record(c, u.actor, `invoice.${decision}`, 'invoice', invoiceId, { status: inv.status }, { status: next, reasonCode });
      return { id: invoiceId, status: next };
    });
  }

  /** BUY-08: buyer signs the ILU for one or many confirmed invoices. */
  async startIlu(u: AuthUser, invoiceIds: string[]) {
    const buyerId = orgIds(u, ['buyer_checker', 'buyer_admin'])[0];
    if (!buyerId) throw forbidden('ROLE_REQUIRED', 'Only a buyer checker or admin can sign ILUs');
    const invs = await this.db.query(`SELECT * FROM invoice WHERE id = ANY($1)`, [invoiceIds]);
    if (invs.length !== invoiceIds.length) throw notFound('Invoice');
    for (const i of invs) {
      if (i.buyer_id !== buyerId) throw forbidden('ORG_SCOPE', 'Invoice belongs to another buyer');
      if (i.status !== 'confirmed') throw conflict('BAD_STATE', `Invoice ${i.invoice_number} is ${i.status}`);
    }
    if (invs.length > 200) throw unprocessable('BATCH_TOO_LARGE', 'At most 200 invoices per ILU (D-17)');
    const buyer = await this.db.one(`SELECT * FROM organisation WHERE id = $1`, [buyerId]);
    const signers = (await this.db.query(`SELECT full_name, email FROM person WHERE org_id = $1 AND is_authorised_signatory AND email IS NOT NULL`, [buyerId])).map((p) => ({ name: p.full_name, email: p.email, role: 'authorised_signatory' }));
    if (!signers.length) throw unprocessable('SIGNATORY_REQUIRED', 'Your company needs an authorised signatory with an email address');
    const conf = await this.db.tx(async (c) => {
      const conf = (await c.query(`INSERT INTO confirmation (buyer_id, confirmed_by, set_off_waiver, is_batch) VALUES ($1,$2,true,$3) RETURNING *`, [buyerId, u.id, invs.length > 1])).rows[0];
      for (const i of invs) await c.query(`INSERT INTO confirmation_invoice (confirmation_id, invoice_id, confirmed_amount_cents, confirmed_due_date) VALUES ($1,$2,$3,$4)`, [conf.id, i.id, i.amount_cents, i.due_date]);
      await this.audit.record(c, u.actor, 'confirmation.create', 'confirmation', conf.id, null, { invoices: invs.map((i) => i.id) });
      return conf;
    });
    const pdf = simplePdf('Irrevocable Letter of Undertaking (ILU)', [
      `Buyer: ${buyer.legal_name} (KRA PIN ${buyer.kra_pin})`,
      'The buyer irrevocably undertakes to pay the following invoices in full on their due dates into',
      "Mapema's collection account, without any set-off, counterclaim or deduction:",
      ...invs.map((i) => `${i.invoice_number}  supplier PIN ${i.supplier_kra_pin}  ${formatKes(toCents(i.amount_cents))}  due ${i.due_date}`),
      'DRAFT TEMPLATE - wording subject to Kenyan counsel review before go-live.',
    ]);
    const env = await this.adapters.esign.createEnvelope({ requestId: 'ilu' }, { documentType: 'ilu', title: 'ILU', pdf, signers, reference: conf.id });
    await this.db.query(`INSERT INTO esign_envelope (envelope_id, purpose, entity_type, entity_id, created_by) VALUES ($1,'ilu','confirmation',$2,$3)`, [env.envelopeId, conf.id, u.id]);
    return { confirmationId: conf.id, ...env };
  }

  async list(u: AuthUser, f: { status?: string; buyerId?: string; supplierId?: string }) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (!isStaff(u) && !hasRole(u, 'auditor', 'lender')) {
      params.push(u.roles.map((r) => r.orgId).filter(Boolean));
      where.push(`(i.buyer_id = ANY($${params.length}) OR i.supplier_id = ANY($${params.length}))`);
    }
    if (f.status) { params.push(f.status); where.push(`i.status = $${params.length}`); }
    if (f.buyerId) { params.push(f.buyerId); where.push(`i.buyer_id = $${params.length}`); }
    if (f.supplierId) { params.push(f.supplierId); where.push(`i.supplier_id = $${params.length}`); }
    return this.db.query(
      `SELECT i.id, i.invoice_number, i.amount_cents, i.currency, i.issue_date, i.due_date, i.status, i.etims_status, i.source, i.created_at,
              b.legal_name AS buyer_name, s.legal_name AS supplier_name, i.buyer_id, i.supplier_id
       FROM invoice i JOIN organisation b ON b.id = i.buyer_id JOIN organisation s ON s.id = i.supplier_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.due_date, i.created_at LIMIT 500`, params);
  }

  async get(u: AuthUser, id: string) {
    const i = await this.db.one(`SELECT * FROM invoice WHERE id = $1`, [id]);
    if (!i) throw notFound('Invoice');
    if (!isStaff(u) && !hasRole(u, 'auditor', 'lender') && !u.roles.some((r) => r.orgId === i.buyer_id || r.orgId === i.supplier_id)) throw notFound('Invoice');
    const decisions = await this.db.query(`SELECT decision, reason_code, reason_text, decided_at FROM invoice_decision WHERE invoice_id = $1 ORDER BY decided_at`, [id]);
    return { ...i, decisions };
  }

  /** BUY-10 payment calendar: amounts due to Mapema by date with payment instructions. */
  async paymentCalendar(u: AuthUser) {
    const buyerId = orgIds(u, BUYER_ROLES)[0];
    if (!buyerId) throw forbidden('ROLE_REQUIRED', 'Buyer users only');
    const acct = await this.db.one(`SELECT bank_code, virtual_account_no FROM collection_account WHERE buyer_id = $1`, [buyerId]);
    const rows = await this.db.query(
      `SELECT i.due_date, COUNT(*)::int AS invoices, SUM(i.amount_cents)::bigint AS amount_cents, array_agg(i.invoice_number ORDER BY i.invoice_number) AS invoice_numbers
       FROM invoice i JOIN advance a ON a.invoice_id = i.id AND a.status IN ('funded','late','recourse')
       WHERE i.buyer_id = $1 GROUP BY i.due_date ORDER BY i.due_date`, [buyerId]);
    return { payTo: acct ? { bankCode: acct.bank_code, accountNumber: acct.virtual_account_no, reference: 'Use the invoice number as the payment reference' } : null, due: rows };
  }
}

export const invoiceSchema = z.object({
  supplierKraPin: zKraPin, invoiceNumber: zText(60), amountCents: zPositiveCents, currency: zKes, issueDate: zDate, dueDate: zDate,
  etimsCuInvoiceNo: z.string().max(60).optional(), poReference: z.string().max(60).optional(),
});

@Controller()
export class InvoicesController {
  constructor(private readonly s: InvoicesService) {}

  @Post('invoices')
  @Roles('buyer_maker', 'buyer_admin', 'supplier_admin', 'supplier_user')
  create(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    if (hasRole(u, ...SUPPLIER_ROLES)) {
      const body = invoiceSchema.extend({ buyerId: zUuid }).parse(b);
      return this.s.createBySupplier(u, body.buyerId, body);
    }
    return this.s.createByBuyer(u, invoiceSchema.parse(b));
  }

  @Post('invoices/csv')
  @Roles('buyer_maker', 'buyer_admin')
  csv(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    return this.s.uploadCsv(u, z.object({ csv: z.string().min(1).max(200_000) }).parse(b).csv);
  }

  @Get('invoices')
  list(@CurrentUser() u: AuthUser, @Query() q: Record<string, string>) {
    const f = z.object({ status: z.string().max(40).optional(), buyerId: zUuid.optional(), supplierId: zUuid.optional() }).parse(q);
    return this.s.list(u, f);
  }

  @Get('invoices/:id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.get(u, zUuid.parse(id));
  }

  @Post('invoices/:id/decision')
  @Roles('buyer_checker', 'buyer_admin')
  decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ decision: z.enum(['approve', 'reject', 'hold', 'release_hold']), reasonCode: z.string().max(40).optional(), reasonText: z.string().max(500).optional() })
      .refine((x) => x.decision !== 'reject' || x.reasonCode, 'A reason is required to reject').parse(b);
    return this.s.decide(u, zUuid.parse(id), body.decision, body.reasonCode, body.reasonText);
  }

  @Post('confirmations')
  @Roles('buyer_checker', 'buyer_admin')
  @StepUp()
  ilu(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    return this.s.startIlu(u, z.object({ invoiceIds: z.array(zUuid).min(1).max(200) }).parse(b).invoiceIds);
  }

  @Get('buyer/payment-calendar')
  @Roles(...BUYER_ROLES)
  calendar(@CurrentUser() u: AuthUser) {
    return this.s.paymentCalendar(u);
  }
}

