/**
 * [Backend Engineer] Phase 1b read APIs behind the new portal screens.
 *  - documents list + download (BUY-09 notice of assignment, BUY-12 receipts, KYB/KYC uploads), org-scoped, audited
 *  - buyer programme utilisation (BUY-13)
 *  - consent list (SUP-03)
 *  - self-service "my data" view (SUP-13, DPA 2019 s.26 right of access - a convenience view; formal requests still go through the DSR queue)
 *  - staff user list (ADM-01)
 */
import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Audit } from '../common/audit';
import { FieldCrypto, mask } from '../common/crypto';
import { Db, toCents } from '../common/db';
import { forbidden, notFound } from '../common/errors';
import { zUuid } from '../common/http';
import { assertOrgAccess, AuthUser, BUYER_ROLES, CurrentUser, hasRole, isStaff, orgIds, Roles } from '../auth/auth';
import { DocumentsService } from './documents';

const DOC_TYPES = ['programme_agreement', 'master_agreement', 'deed_of_assignment', 'ilu', 'notice_of_assignment', 'receipt', 'credit_report',
  'certificate_of_incorporation', 'cr12', 'kra_pin_certificate', 'board_resolution', 'national_id', 'passport', 'selfie', 'bank_proof', 'audited_accounts', 'invoice_pdf', 'other'] as const;
/** Customer-visible document types; internal ones (credit reports, CBK letters) are staff/auditor only. */
const CUSTOMER_HIDDEN = new Set(['credit_report', 'cbk_approval_letter']);

@Injectable()
export class SelfService {
  constructor(private readonly db: Db, private readonly docs: DocumentsService, private readonly audit: Audit, private readonly crypto: FieldCrypto) {}

  async listDocuments(u: AuthUser, orgId: string, type?: string) {
    assertOrgAccess(u, orgId, { allowReadOnly: true });
    const rows = await this.db.query(`SELECT id, type, file_name, mime_type, size_bytes, file_sha256, signed_at, created_at FROM document
      WHERE owner_org_id = $1 AND ($2::text IS NULL OR type::text = $2::text) ORDER BY created_at DESC LIMIT 500`, [orgId, type ?? null]);
    return isStaff(u) || hasRole(u, 'auditor') ? rows : rows.filter((d) => !CUSTOMER_HIDDEN.has(d.type));
  }

  async download(u: AuthUser, id: string) {
    const meta = await this.db.one(`SELECT id, owner_org_id, type, file_name, mime_type FROM document WHERE id = $1`, [id]);
    const privileged = isStaff(u) || hasRole(u, 'auditor');
    // not found (rather than forbidden) for documents outside the caller's orgs, so ids can't be probed
    if (!meta || (!privileged && (!meta.owner_org_id || !u.roles.some((r) => r.orgId === meta.owner_org_id) || CUSTOMER_HIDDEN.has(meta.type)))) throw notFound('Document');
    const { body } = await this.docs.read(this.db.pool, id);
    await this.db.tx((c) => this.audit.record(c, u.actor, 'document.download', 'document', id, null, { type: meta.type }));
    return { meta, body };
  }

  async buyerProgramme(u: AuthUser) {
    const buyerId = orgIds(u, BUYER_ROLES)[0];
    if (!buyerId) throw forbidden('ROLE_REQUIRED', 'Buyer users only');
    const p = await this.db.one(`SELECT id, limit_cents, advance_rate_bps, start_date, review_date, status FROM buyer_programme WHERE buyer_id = $1 AND status IN ('approved','live','suspended') ORDER BY created_at DESC LIMIT 1`, [buyerId]);
    if (!p) return { status: 'none', suppliers: [] };
    const sup = await this.db.query(`SELECT s.legal_name AS supplier_name, l.supplier_limit_cents, COALESCE(e.exposure_cents,0)::bigint AS exposure_cents,
        (SELECT count(*)::int FROM advance a WHERE a.buyer_id = $1 AND a.supplier_id = l.supplier_id AND a.status IN ('approved','released','funded','late','recourse','non_performing')) AS open_advances
      FROM supplier_link l JOIN organisation s ON s.id = l.supplier_id LEFT JOIN v_exposure e ON e.buyer_id = l.buyer_id AND e.supplier_id = l.supplier_id
      WHERE l.buyer_id = $1 ORDER BY s.legal_name`, [buyerId]);
    const used = sup.reduce((t, s) => t + toCents(s.exposure_cents), 0n);
    const limit = toCents(p.limit_cents);
    return { ...p, used_cents: used, available_cents: limit > used ? limit - used : 0n, suppliers: sup.map((s) => ({ ...s, exposure_cents: toCents(s.exposure_cents) })) };
  }

  async consents(u: AuthUser, orgId: string) {
    assertOrgAccess(u, orgId, { allowReadOnly: true });
    return this.db.query(`SELECT c.id, c.purpose, c.text_version, c.granted_at, c.withdrawn_at, c.person_id, p.full_name AS person_name FROM consent c LEFT JOIN person p ON p.id = c.person_id
      WHERE c.org_id = $1 OR c.person_id IN (SELECT id FROM person WHERE org_id = $1) ORDER BY c.granted_at DESC`, [orgId]);
  }

  async myData(u: AuthUser) {
    const profile = await this.db.one(`SELECT id, email, display_name, mfa_methods, created_at, last_login_at FROM user_account WHERE id = $1`, [u.id]);
    const ids = u.roles.map((r) => r.orgId).filter(Boolean) as string[];
    const organisations = [];
    for (const id of ids) {
      const o = await this.db.one(`SELECT id, type, legal_name, trading_name, kra_pin, registration_no, status, created_at FROM organisation WHERE id = $1`, [id]);
      if (!o) continue;
      const people = (await this.db.query(`SELECT id, full_name, email, national_id_enc, phone_enc, is_director, is_authorised_signatory, is_beneficial_owner FROM person WHERE org_id = $1`, [id])).map((p) => ({
        id: p.id, fullName: p.full_name, email: p.email, nationalIdMasked: mask(this.crypto.decrypt(p.national_id_enc)), phoneMasked: mask(this.crypto.decrypt(p.phone_enc), 3),
        isDirector: p.is_director, isAuthorisedSignatory: p.is_authorised_signatory, isBeneficialOwner: p.is_beneficial_owner }));
      const bankAccounts = await this.db.query(`SELECT bank_code, account_name, account_number_last4, is_payout_default, verified_at, deactivated_at FROM bank_account WHERE org_id = $1`, [id]);
      const activity = await this.db.one(`SELECT (SELECT count(*)::int FROM invoice WHERE supplier_id = $1 OR buyer_id = $1) AS invoices,
        (SELECT count(*)::int FROM advance WHERE supplier_id = $1 OR buyer_id = $1) AS advances,
        (SELECT count(*)::int FROM document WHERE owner_org_id = $1) AS documents`, [id]);
      organisations.push({ ...o, people, bankAccounts, activity });
    }
    const consents = ids.length ? await this.db.query(`SELECT purpose, text_version, granted_at, withdrawn_at FROM consent WHERE org_id = ANY($1::uuid[]) OR person_id IN (SELECT id FROM person WHERE org_id = ANY($1::uuid[])) ORDER BY granted_at DESC`, [ids]) : [];
    const notifications = await this.db.query(`SELECT channel, template_key, status, created_at FROM notification WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [u.id]);
    return {
      generatedAt: new Date().toISOString(), profile, roles: u.roles, organisations, consents, notifications,
      rights: 'You can ask us to correct or delete your personal data, or for a full copy, from Privacy > Make a data request. Some records (for example anti-money-laundering and lending records) may have to be kept for a legal retention period; we will tell you if that applies.',
    };
  }

  async staffUsers() {
    const rows = await this.db.query(`SELECT u.id, u.email, u.display_name, u.active, u.access_expires_at, u.mfa_methods, array_agg(r.role::text ORDER BY r.role::text) AS roles
      FROM user_account u JOIN user_role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
      WHERE r.role IN ('credit','ops','compliance','admin','ceo','auditor','lender') AND NOT u.is_integration GROUP BY u.id ORDER BY u.email`);
    return rows;
  }

  /** S-14: service accounts are reviewed separately (they have no roles and cannot sign in). */
  serviceAccounts() {
    return this.db.query(`SELECT u.id, u.display_name, u.active, u.created_at, c.id AS connection_id, c.name AS connection_name, c.status AS connection_status, o.legal_name AS buyer
      FROM user_account u LEFT JOIN erp_connection c ON c.integration_user_id = u.id LEFT JOIN organisation o ON o.id = c.buyer_id
      WHERE u.is_integration ORDER BY u.created_at`);
  }
}

@Controller()
export class SelfServiceController {
  constructor(private readonly s: SelfService) {}

  @Get('documents')
  documents(@CurrentUser() u: AuthUser, @Query('orgId') orgId: string, @Query('type') type?: string) {
    return this.s.listDocuments(u, zUuid.parse(orgId), type ? z.enum(DOC_TYPES).parse(type) : undefined);
  }

  @Get('documents/:id/content')
  async content(@CurrentUser() u: AuthUser, @Param('id') id: string, @Res() res: any) {
    const { meta, body } = await this.s.download(u, zUuid.parse(id));
    res.setHeader('Content-Type', meta.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${String(meta.file_name).replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  }

  @Get('buyer/programme') @Roles(...BUYER_ROLES)
  programme(@CurrentUser() u: AuthUser) { return this.s.buyerProgramme(u); }

  @Get('consents')
  consents(@CurrentUser() u: AuthUser, @Query('orgId') orgId: string) { return this.s.consents(u, zUuid.parse(orgId)); }

  @Get('me/data')
  myData(@CurrentUser() u: AuthUser) { return this.s.myData(u); }

  @Get('admin/users') @Roles('admin', 'ceo', 'compliance')
  staff() { return this.s.staffUsers(); }

  @Get('admin/service-accounts') @Roles('admin', 'ceo', 'compliance')
  serviceAccounts() { return this.s.serviceAccounts(); }
}
