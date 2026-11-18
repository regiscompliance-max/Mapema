/**
 * [Backend Engineer + Security Engineer] Phase 4 registry evidence and eTIMS override (D-73, D-78).
 * Search-before-funding and file-after-funding are maker-checker evidence uploads. There is no
 * invented registry API; the adapter is informational (mock) or a portal-only stub.
 */
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { Audit } from '../common/audit';
import { ADAPTERS } from '../common/config';
import { Db, Q } from '../common/db';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { zDate, zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { AuthUser, CurrentUser, hasRole, Roles, StepUp } from '../auth/auth';
import { ApprovalsService } from './approvals';
import { DocumentsService } from './documents';

const evidence = z.object({
  fileName: zText(200),
  mimeType: z.literal('application/pdf'),
  contentBase64: z.string().min(20).max(14_000_000),
});

@Injectable()
export class RegistryService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly approvals: ApprovalsService,
    private readonly docs: DocumentsService,
    private readonly notifier: Notifier,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
  ) {}

  onModuleInit() {
    this.approvals.register('registry_search', async (c, a, checker) => {
      const row = (await c.query(`SELECT * FROM registry_search WHERE id = $1 FOR UPDATE`, [a.payload.searchId])).rows[0];
      if (!row || row.status !== 'pending') throw conflict('BAD_STATE', 'Registry search is not pending');
      await c.query(`UPDATE registry_search SET status = 'approved', approved_via = $2 WHERE id = $1`, [row.id, a.id]);
      await this.audit.record(c, checker.actor, 'registry.search.approved', 'invoice', row.invoice_id, { status: 'pending' }, { result: row.result, searchId: row.id });
    });
    this.approvals.register('registry_filing', async (c, a, checker) => {
      const row = (await c.query(`SELECT * FROM registry_filing WHERE id = $1 FOR UPDATE`, [a.payload.filingId])).rows[0];
      if (!row || row.status !== 'pending') throw conflict('BAD_STATE', 'Registry filing is not pending');
      await c.query(`UPDATE registry_filing SET status = 'approved', approved_via = $2 WHERE id = $1`, [row.id, a.id]);
      await c.query(`UPDATE advance SET registry_registration_no = $2, registry_filing_id = $3 WHERE id = $1`, [row.advance_id, row.registration_no, row.id]);
      await c.query(`UPDATE ops_task SET status = 'done', done_at = now(), note = COALESCE(note, 'filing approved') WHERE kind = 'registry_filing_due' AND advance_id = $1 AND status = 'open'`, [row.advance_id]);
      await this.audit.record(c, checker.actor, 'registry.filing.approved', 'advance', row.advance_id, { status: 'pending' }, { registrationNo: row.registration_no, filingId: row.id });
    });
    this.approvals.register('etims_override', async (c, a, checker) => {
      const inv = (await c.query(`SELECT * FROM invoice WHERE id = $1 FOR UPDATE`, [a.entity_id])).rows[0];
      if (!inv) throw notFound('Invoice');
      const nextStatus = inv.status === 'ilu_signed' ? 'eligible' : inv.status;
      await c.query(`UPDATE invoice SET etims_status = 'overridden', status = $2, updated_at = now() WHERE id = $1`, [inv.id, nextStatus]);
      await this.audit.record(c, checker.actor, 'invoice.etims_overridden', 'invoice', inv.id, { etims_status: inv.etims_status, status: inv.status }, { etims_status: 'overridden', status: nextStatus, reason: a.payload?.reason });
      if (nextStatus === 'eligible' && inv.status !== 'eligible') {
        const buyer = (await c.query(`SELECT legal_name FROM organisation WHERE id = $1`, [inv.buyer_id])).rows[0];
        await this.notifier.toOrg(c, inv.supplier_id, 'invoice.eligible', { invoice: inv.invoice_number, buyer: buyer.legal_name }, { type: 'invoice', id: inv.id });
      }
    });
  }

  private pdf(b: { fileName: string; mimeType: string; contentBase64: string }) {
    if (b.mimeType !== 'application/pdf') throw unprocessable('FILE_TYPE', 'Upload a PDF of the registry portal certificate');
    const body = Buffer.from(b.contentBase64, 'base64');
    if (!body.length) throw unprocessable('FILE_SIZE', 'The evidence file is empty');
    return body;
  }

  async proposeSearch(u: AuthUser, invoiceId: string, b: { result: 'clear' | 'conflict' | 'conflict_waived'; notes?: string; searchedOn: string; fileName: string; mimeType: string; contentBase64: string }) {
    if (!hasRole(u, 'credit', 'ops', 'ceo')) throw forbidden('ROLE_REQUIRED', 'Only credit or ops can record a registry search');
    if (b.result === 'conflict_waived' && !(b.notes && b.notes.trim().length >= 3)) throw unprocessable('WAIVER_NOTE_REQUIRED', 'A waived conflict needs a short note');
    return this.db.tx(async (c) => {
      const inv = (await c.query(`SELECT i.*, sb.kra_pin AS supplier_pin, byr.kra_pin AS buyer_pin FROM invoice i JOIN organisation sb ON sb.id = i.supplier_id JOIN organisation byr ON byr.id = i.buyer_id WHERE i.id = $1 FOR UPDATE OF i`, [invoiceId])).rows[0];
      if (!inv) throw notFound('Invoice');
      const existing = (await c.query(`SELECT id, status FROM registry_search WHERE invoice_id = $1 AND status IN ('pending','approved')`, [invoiceId])).rows[0];
      if (existing) throw conflict(existing.status === 'approved' ? 'SEARCH_EXISTS' : 'APPROVAL_PENDING', existing.status === 'approved' ? 'An approved registry search is already on this invoice' : 'A registry search is already waiting for approval');
      const doc = await this.docs.store(c, { ownerOrgId: inv.buyer_id, type: 'registry_search_certificate', fileName: b.fileName, mimeType: b.mimeType, body: this.pdf(b), uploadedBy: u.id, containsPii: true });
      const adapterResult = await this.adapters.registry.search({ requestId: u.actor.requestId ?? 'registry' }, {
        supplierKraPin: inv.supplier_pin, buyerKraPin: inv.buyer_pin, invoiceNumber: inv.invoice_number, amountCents: BigInt(inv.amount_cents), issueDate: String(inv.issue_date).slice(0, 10),
      }).catch(() => ({ result: 'unavailable', reasons: ['ADAPTER_ERROR'] }));
      const row = (await c.query(
        `INSERT INTO registry_search (invoice_id, supplier_id, buyer_id, result, evidence_document_id, notes, searched_on, adapter_result, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [inv.id, inv.supplier_id, inv.buyer_id, b.result, doc.id, b.notes ?? null, b.searchedOn, JSON.stringify(adapterResult), u.id])).rows[0];
      const appr = await this.approvals.propose(c, u, {
        action: 'registry_search', entityType: 'invoice', entityId: inv.id,
        payload: { searchId: row.id, result: b.result, searchedOn: b.searchedOn, documentId: doc.id },
        requiredRole: 'credit', reason: b.notes ?? `Registry search ${b.result}`,
      });
      await c.query(`UPDATE registry_search SET proposed_via = $2 WHERE id = $1`, [row.id, appr.id]);
      await this.audit.record(c, u.actor, 'registry.search.proposed', 'invoice', inv.id, null, { searchId: row.id, result: b.result, documentId: doc.id });
      return { search: row, approval: appr };
    });
  }

  async proposeFiling(u: AuthUser, advanceId: string, b: { registrationNo: string; notes?: string; filedOn: string; fileName: string; mimeType: string; contentBase64: string }) {
    if (!hasRole(u, 'credit', 'ops', 'ceo')) throw forbidden('ROLE_REQUIRED', 'Only credit or ops can record a registry filing');
    return this.db.tx(async (c) => {
      const adv = (await c.query(`SELECT a.*, i.buyer_id, i.invoice_number FROM advance a JOIN invoice i ON i.id = a.invoice_id WHERE a.id = $1 FOR UPDATE OF a`, [advanceId])).rows[0];
      if (!adv) throw notFound('Advance');
      if (!['funded', 'late', 'recourse', 'non_performing'].includes(adv.status)) throw conflict('BAD_STATE', 'File the assignment after the advance is funded');
      const existing = (await c.query(`SELECT id, status FROM registry_filing WHERE advance_id = $1 AND status IN ('pending','approved')`, [advanceId])).rows[0];
      if (existing) throw conflict(existing.status === 'approved' ? 'FILING_EXISTS' : 'APPROVAL_PENDING', existing.status === 'approved' ? 'An approved filing is already on this advance' : 'A filing is already waiting for approval');
      const doc = await this.docs.store(c, { ownerOrgId: adv.buyer_id, type: 'registry_filing_evidence', fileName: b.fileName, mimeType: b.mimeType, body: this.pdf(b), uploadedBy: u.id, containsPii: true });
      const row = (await c.query(
        `INSERT INTO registry_filing (advance_id, invoice_id, registration_no, evidence_document_id, notes, filed_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [adv.id, adv.invoice_id, b.registrationNo.trim(), doc.id, b.notes ?? null, b.filedOn, u.id])).rows[0];
      const appr = await this.approvals.propose(c, u, {
        action: 'registry_filing', entityType: 'advance', entityId: adv.id,
        payload: { filingId: row.id, registrationNo: b.registrationNo.trim(), filedOn: b.filedOn, documentId: doc.id },
        requiredRole: 'ops', reason: b.notes ?? `Registry filing ${b.registrationNo}`,
      });
      await c.query(`UPDATE registry_filing SET proposed_via = $2 WHERE id = $1`, [row.id, appr.id]);
      await this.audit.record(c, u.actor, 'registry.filing.proposed', 'advance', adv.id, null, { filingId: row.id, registrationNo: b.registrationNo.trim() });
      return { filing: row, approval: appr };
    });
  }

  async proposeEtimsOverride(u: AuthUser, invoiceId: string, reason: string) {
    if (!hasRole(u, 'credit', 'ceo')) throw forbidden('ROLE_REQUIRED', 'Only a credit officer can propose an eTIMS override');
    return this.db.tx(async (c) => {
      const inv = (await c.query(`SELECT * FROM invoice WHERE id = $1 FOR UPDATE`, [invoiceId])).rows[0];
      if (!inv) throw notFound('Invoice');
      if (inv.etims_status === 'valid' || inv.etims_status === 'overridden') throw conflict('BAD_STATE', 'eTIMS is already valid or overridden');
      const appr = await this.approvals.propose(c, u, {
        action: 'etims_override', entityType: 'invoice', entityId: inv.id,
        payload: { reason, previous: inv.etims_status }, requiredRole: 'credit', reason,
      });
      await this.audit.record(c, u.actor, 'invoice.etims_override.proposed', 'invoice', inv.id, { etims_status: inv.etims_status }, { approvalId: appr.id, reason });
      return { approval: appr };
    });
  }

  searches(invoiceId: string) {
    return this.db.query(`SELECT s.*, d.file_name, d.file_sha256 FROM registry_search s JOIN document d ON d.id = s.evidence_document_id WHERE s.invoice_id = $1 ORDER BY s.created_at DESC`, [invoiceId]);
  }

  filings(advanceId: string) {
    return this.db.query(`SELECT f.*, d.file_name, d.file_sha256 FROM registry_filing f JOIN document d ON d.id = f.evidence_document_id WHERE f.advance_id = $1 ORDER BY f.created_at DESC`, [advanceId]);
  }

  async opsTasks(kind?: string, status?: string) {
    return this.db.query(
      `SELECT t.*, i.invoice_number, s.legal_name AS supplier_name, a.status AS advance_status, a.registry_registration_no
       FROM ops_task t JOIN advance a ON a.id = t.advance_id JOIN invoice i ON i.id = a.invoice_id JOIN organisation s ON s.id = a.supplier_id
       WHERE ($1::text IS NULL OR t.kind = $1) AND ($2::text IS NULL OR t.status = $2) ORDER BY t.created_at DESC LIMIT 200`,
      [kind ?? null, status ?? 'open'],
    );
  }
}

@Controller()
export class RegistryController {
  constructor(private readonly s: RegistryService) {}

  @Post('invoices/:id/registry-search')
  @Roles('credit', 'ops', 'ceo')
  @StepUp()
  search(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = evidence.extend({
      result: z.enum(['clear', 'conflict', 'conflict_waived']),
      notes: z.string().max(1000).optional(),
      searchedOn: zDate,
    }).parse(b);
    return this.s.proposeSearch(u, zUuid.parse(id), body);
  }

  @Get('invoices/:id/registry-searches')
  @Roles('credit', 'ops', 'ceo', 'admin', 'compliance', 'auditor')
  listSearches(@Param('id') id: string) {
    return this.s.searches(zUuid.parse(id));
  }

  @Post('invoices/:id/etims-override')
  @Roles('credit', 'ceo')
  @StepUp()
  override(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ reason: zText(1000) }).parse(b);
    return this.s.proposeEtimsOverride(u, zUuid.parse(id), body.reason);
  }

  @Post('advances/:id/registry-filing')
  @Roles('credit', 'ops', 'ceo')
  @StepUp()
  filing(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = evidence.extend({
      registrationNo: z.string().trim().min(3).max(80),
      notes: z.string().max(1000).optional(),
      filedOn: zDate,
    }).parse(b);
    return this.s.proposeFiling(u, zUuid.parse(id), body);
  }

  @Get('advances/:id/registry-filings')
  @Roles('credit', 'ops', 'ceo', 'admin', 'compliance', 'auditor')
  listFilings(@Param('id') id: string) {
    return this.s.filings(zUuid.parse(id));
  }

  @Get('ops/tasks')
  @Roles('ops', 'credit', 'ceo', 'admin', 'compliance')
  tasks(@Query('kind') kind?: string, @Query('status') status?: string) {
    return this.s.opsTasks(kind, status);
  }
}

/** Used by AdvancesService.checks (fail closed if missing or conflict not waived). */
export async function approvedRegistrySearch(c: Q, invoiceId: string) {
  return (await c.query(`SELECT * FROM registry_search WHERE invoice_id = $1 AND status = 'approved' ORDER BY created_at DESC LIMIT 1`, [invoiceId])).rows[0] ?? null;
}
