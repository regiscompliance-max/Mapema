/**
 * [Backend Engineer] Onboarding: buyer prospects, invitations, KYB/KYC, consent, CRB, bank
 * accounts, documents, e-signed agreements, buyer programmes and supplier limits.
 * Workflows 1 (buyer onboarding) and 2 (supplier onboarding) from the brief.
 */
import { Body, Controller, Get, Headers, Inject, Injectable, OnModuleInit, Param, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Adapters } from '@mapema/adapters';
import { Clock } from '../common/clock';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS, AppConfig, CONFIG } from '../common/config';
import { FieldCrypto, mask } from '../common/crypto';
import { Db, Q, toCents } from '../common/db';
import { badRequest, conflict, DomainError, forbidden, notFound, unprocessable } from '../common/errors';
import { zCents, zDate, zKraPin, zPhoneKe, zPositiveCents, zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { Outbox } from '../common/outbox';
import { assertOrgAccess, AuthUser, CurrentUser, hasRole, isStaff, orgIds, Public, Role, Roles, StepUp, STAFF_ROLES, TokenVerifier } from '../auth/auth';
import { render } from '../common/notify';
import { ApprovalsService } from './approvals';
import { DocumentsService, simplePdf } from './documents';
import { SettingsService } from './admin';

const ctxOf = (u?: AuthUser) => ({ requestId: u?.actor.requestId ?? 'system', actorUserId: u?.id });
export const TERMS_VERSION = 'MA-2026-11-v1';

type EsignHandler = (c: any, env: { envelope_id: string; entity_id: string; entity_type: string; created_by: string | null }, signed: { pdf: Buffer; sha256: string; signedAt: string }) => Promise<void>;

@Injectable()
export class OnboardingService implements OnModuleInit {
  private esignHandlers = new Map<string, EsignHandler>();
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly crypto: FieldCrypto,
    private readonly docs: DocumentsService,
    private readonly approvals: ApprovalsService,
    private readonly notifier: Notifier,
    private readonly outbox: Outbox,
    private readonly settings: SettingsService,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.approvals.register('buyer_programme_approve', async (c, a) => {
      await c.query(`UPDATE buyer_programme SET status = 'approved', approved_via = $2 WHERE id = $1 AND status = 'proposed'`, [a.entity_id, a.id]);
      const p = (await c.query(`SELECT buyer_id FROM buyer_programme WHERE id = $1`, [a.entity_id])).rows[0];
      await c.query(`UPDATE organisation SET status = 'approved', updated_at = now() WHERE id = $1`, [p.buyer_id]);
    });
    this.approvals.register('supplier_limit_set', async (c, a) => {
      await c.query(`UPDATE supplier_link SET supplier_limit_cents = $2 WHERE id = $1`, [a.entity_id, a.payload.limitCents]);
      const l = (await c.query(`SELECT supplier_id FROM supplier_link WHERE id = $1`, [a.entity_id])).rows[0];
      await this.maybeActivateSupplier(c, l.supplier_id);
    });
    this.approvals.register('user_role_change', async (c, a) => {
      const inv = (await c.query(`UPDATE invitation SET approved_via = $2 WHERE id = $1 AND requires_approval AND approved_via IS NULL RETURNING id, link_enc`, [a.entity_id, a.id])).rows[0];
      if (!inv) throw conflict('BAD_STATE', 'Invitation is not waiting for approval');
      await this.outbox.enqueue(c, 'invitation.send', inv.id, `invite-${inv.id}`, { invitationId: inv.id, linkEnc: Buffer.from(inv.link_enc).toString('base64'), buyerId: null });
      await c.query(`UPDATE invitation SET link_enc = NULL WHERE id = $1`, [inv.id]);
    });
    this.approvals.register('bank_account_verify', async (c, a) => {
      await c.query(`UPDATE bank_account SET verified_at = now(), verified_by = $2 WHERE id = $1`, [a.entity_id, a.maker_id]);
    });
    this.registerEsign('supplier_agreements', async (c, env, signed) => {
      const doc = await this.docs.store(c, { ownerOrgId: env.entity_id, type: 'master_agreement', fileName: 'master-agreement-and-deed-of-assignment.pdf', mimeType: 'application/pdf', body: signed.pdf, signedAt: signed.signedAt, envelopeId: env.envelope_id });
      await c.query(`UPDATE esign_envelope SET document_id = $2 WHERE envelope_id = $1`, [env.envelope_id, doc.id]);
      await c.query(`UPDATE organisation SET status = 'agreement_signed', updated_at = now() WHERE id = $1 AND status = 'kyc_passed'`, [env.entity_id]);
      await this.maybeActivateSupplier(c, env.entity_id);
    });
    this.registerEsign('programme_agreement', async (c, env, signed) => {
      const p = (await c.query(`SELECT * FROM buyer_programme WHERE id = $1`, [env.entity_id])).rows[0];
      const doc = await this.docs.store(c, { ownerOrgId: p.buyer_id, type: 'programme_agreement', fileName: 'programme-agreement.pdf', mimeType: 'application/pdf', body: signed.pdf, signedAt: signed.signedAt, envelopeId: env.envelope_id });
      await c.query(`UPDATE esign_envelope SET document_id = $2 WHERE envelope_id = $1`, [env.envelope_id, doc.id]);
      await c.query(`UPDATE buyer_programme SET status = 'live' WHERE id = $1`, [p.id]);
      await c.query(`UPDATE organisation SET status = 'live', updated_at = now() WHERE id = $1`, [p.buyer_id]);
      await this.outbox.enqueue(c, 'buyer.open_collection_account', p.buyer_id, `vacct-${p.buyer_id}`, { buyerId: p.buyer_id });
    });
    this.outbox.on('invitation.send', async (p, row) => {
      const inv = await this.db.one(`SELECT i.*, b.legal_name AS buyer_name FROM invitation i LEFT JOIN organisation b ON b.id = i.buyer_id WHERE i.id = $1`, [p.invitationId]);
      const link = p.linkEnc ? this.crypto.decrypt(Buffer.from(p.linkEnc, 'base64')) : null;
      if (!inv || inv.accepted_at || inv.revoked_at || !link) return;
      const text = inv.kind === 'supplier' ? render('invite.supplier', { buyer: inv.buyer_name ?? 'Your buyer', link }) : render('invite.user', { link });
      const ctx = { requestId: `invite-${inv.id}` };
      if (inv.email) await this.adapters.email.send(ctx, { to: inv.email, subject: 'Your Mapema invitation', text, reference: inv.id });
      const phone = this.crypto.decrypt(inv.phone_enc);
      if (phone) await this.adapters.sms.send(ctx, { to: phone, text, reference: inv.id });
      // the link carries the raw token: scrub it from the outbox once delivered
      await this.db.query(`UPDATE outbox SET payload = payload - 'linkEnc' WHERE id = $1`, [row.id]);
    });
    this.outbox.on('buyer.open_collection_account', async (p) => {
      const exists = await this.db.one(`SELECT id FROM collection_account WHERE buyer_id = $1`, [p.buyerId]);
      if (exists) return;
      const org = await this.db.one(`SELECT id, legal_name FROM organisation WHERE id = $1`, [p.buyerId]);
      const { virtualAccountNo } = await this.adapters.bank.openVirtualAccount({ requestId: 'vacct' }, { id: org.id, legalName: org.legal_name });
      await this.db.query(`INSERT INTO collection_account (buyer_id, bank_code, virtual_account_no, currency) VALUES ($1,$2,$3,'KES') ON CONFLICT DO NOTHING`, [org.id, this.adapters.bank.bankCode, virtualAccountNo]);
    });
  }

  registerEsign(purpose: string, h: EsignHandler) {
    this.esignHandlers.set(purpose, h);
  }

  async maybeActivateSupplier(c: Q, supplierId: string) {
    const org = (await c.query(`SELECT status FROM organisation WHERE id = $1`, [supplierId])).rows[0];
    if (!org || !['agreement_signed', 'active'].includes(org.status)) return;
    const r = await c.query(`UPDATE supplier_link SET status = 'active' WHERE supplier_id = $1 AND supplier_limit_cents IS NOT NULL AND status IN ('joined','active') RETURNING id`, [supplierId]);
    if (r.rows.length) await c.query(`UPDATE organisation SET status = 'active', updated_at = now() WHERE id = $1`, [supplierId]);
  }

  // ------------------------------------------------------------------ organisations
  async createBuyerProspect(u: AuthUser, b: { legalName: string; tradingName?: string; kraPin: string; registrationNo: string; sectorCode: string }) {
    return this.db.tx(async (c) => {
      const sector = (await c.query(`SELECT id FROM sector WHERE code = $1`, [b.sectorCode])).rows[0];
      if (!sector) throw badRequest('UNKNOWN_SECTOR', 'Unknown sector code');
      const r = (await c.query(
        `INSERT INTO organisation (type, legal_name, trading_name, kra_pin, registration_no, sector_id, status) VALUES ('buyer',$1,$2,$3,$4,$5,'prospect') RETURNING *`,
        [b.legalName, b.tradingName ?? null, b.kraPin, b.registrationNo, sector.id])).rows[0];
      await this.audit.record(c, u.actor, 'organisation.create', 'organisation', r.id, null, { type: 'buyer', legalName: b.legalName, kraPin: b.kraPin });
      return r;
    });
  }

  async listOrgs(u: AuthUser, type?: string) {
    if (isStaff(u) || hasRole(u, 'auditor', 'lender')) {
      return this.db.query(`SELECT o.*, s.code AS sector_code FROM organisation o LEFT JOIN sector s ON s.id = o.sector_id WHERE ($1::org_type IS NULL OR o.type = $1) ORDER BY o.created_at DESC`, [type ?? null]);
    }
    const ids = u.roles.map((r) => r.orgId).filter(Boolean);
    // buyers also see their linked suppliers
    return this.db.query(
      `SELECT o.*, s.code AS sector_code FROM organisation o LEFT JOIN sector s ON s.id = o.sector_id
       WHERE o.id = ANY($1) OR o.id IN (SELECT supplier_id FROM supplier_link WHERE buyer_id = ANY($1)) ORDER BY o.created_at DESC`, [ids]);
  }

  async getOrg(u: AuthUser, id: string) {
    assertOrgAccess(u, id, { allowReadOnly: true });
    const org = await this.db.one(`SELECT o.*, s.code AS sector_code FROM organisation o LEFT JOIN sector s ON s.id = o.sector_id WHERE o.id = $1`, [id]);
    if (!org) throw notFound('Organisation');
    const persons = (await this.db.query(`SELECT * FROM person WHERE org_id = $1 ORDER BY created_at`, [id])).map((p) => ({
      id: p.id, fullName: p.full_name, email: p.email, isDirector: p.is_director, isAuthorisedSignatory: p.is_authorised_signatory,
      isBeneficialOwner: p.is_beneficial_owner, nationalIdMasked: mask(this.crypto.decrypt(p.national_id_enc)), phoneMasked: mask(this.crypto.decrypt(p.phone_enc), 3),
    }));
    const bankAccounts = await this.db.query(`SELECT id, bank_code, branch_code, account_name, account_number_last4, is_payout_default, verified_at, cooling_off_until, deactivated_at FROM bank_account WHERE org_id = $1`, [id]);
    const links = await this.db.query(`SELECT l.*, b.legal_name AS buyer_name, s.legal_name AS supplier_name FROM supplier_link l JOIN organisation b ON b.id = l.buyer_id JOIN organisation s ON s.id = l.supplier_id WHERE l.buyer_id = $1 OR l.supplier_id = $1`, [id]);
    const programme = await this.db.one(`SELECT * FROM buyer_programme WHERE buyer_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]);
    const collection = await this.db.one(`SELECT bank_code, virtual_account_no FROM collection_account WHERE buyer_id = $1`, [id]);
    return { ...org, persons, bankAccounts, supplierLinks: links, programme, collectionAccount: collection };
  }

  async creditFile(id: string) {
    const kyc = await this.db.query(`SELECT check_type, provider, provider_ref, result, details, checked_at, subject_person_id FROM kyc_check WHERE subject_org_id = $1 OR subject_person_id IN (SELECT id FROM person WHERE org_id = $1) ORDER BY checked_at DESC`, [id]);
    const crb = await this.db.query(`SELECT id, bureau, score, bureau_ref, report_doc_id, pulled_at FROM credit_check WHERE subject_org_id = $1 ORDER BY pulled_at DESC`, [id]);
    const docs = await this.db.query(`SELECT id, type, file_name, file_sha256, signed_at, created_at FROM document WHERE owner_org_id = $1 ORDER BY created_at DESC`, [id]);
    const consents = await this.db.query(`SELECT id, purpose, text_version, granted_at, withdrawn_at FROM consent WHERE org_id = $1 OR person_id IN (SELECT id FROM person WHERE org_id = $1)`, [id]);
    const exposure = await this.db.one(`SELECT COALESCE(SUM(exposure_cents),0)::bigint AS buyer_exposure FROM v_exposure WHERE buyer_id = $1`, [id]);
    const supExposure = await this.db.one(`SELECT COALESCE(SUM(exposure_cents),0)::bigint AS supplier_exposure FROM v_exposure WHERE supplier_id = $1`, [id]);
    const aml = await this.db.query(`SELECT * FROM aml_flag WHERE org_id = $1`, [id]);
    return { kycChecks: kyc, creditChecks: crb, documents: docs, consents, exposure: { buyerCents: toCents(exposure.buyer_exposure), supplierCents: toCents(supExposure.supplier_exposure) }, amlFlags: aml };
  }

  async updateKyb(u: AuthUser, id: string, b: { tradingName?: string; address?: Record<string, string>; sectorCode?: string }) {
    assertOrgAccess(u, id);
    return this.db.tx(async (c) => {
      const before = (await c.query(`SELECT trading_name, address, sector_id FROM organisation WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw notFound('Organisation');
      const sector = b.sectorCode ? (await c.query(`SELECT id FROM sector WHERE code = $1`, [b.sectorCode])).rows[0] : null;
      if (b.sectorCode && !sector) throw badRequest('UNKNOWN_SECTOR', 'Unknown sector code');
      const after = (await c.query(`UPDATE organisation SET trading_name = COALESCE($2, trading_name), address = COALESCE($3::jsonb, address), sector_id = COALESCE($4, sector_id), updated_at = now() WHERE id = $1 RETURNING trading_name, address, sector_id`,
        [id, b.tradingName ?? null, b.address ? JSON.stringify(b.address) : null, sector?.id ?? null])).rows[0];
      await this.audit.record(c, u.actor, 'organisation.kyb.update', 'organisation', id, before, after);
      return after;
    });
  }

  async addPerson(u: AuthUser, orgId: string, b: { fullName: string; nationalId: string; idDocumentType: string; dateOfBirth?: string; phone?: string; email?: string; isDirector: boolean; isAuthorisedSignatory: boolean; isBeneficialOwner: boolean }) {
    assertOrgAccess(u, orgId);
    return this.db.tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO person (org_id, full_name, national_id_enc, national_id_bidx, id_document_type, date_of_birth_enc, phone_enc, phone_bidx, email, is_director, is_authorised_signatory, is_beneficial_owner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [orgId, b.fullName, this.crypto.encrypt(b.nationalId), this.crypto.blindIndex(b.nationalId), b.idDocumentType,
          b.dateOfBirth ? this.crypto.encrypt(b.dateOfBirth) : null, b.phone ? this.crypto.encrypt(b.phone) : null, b.phone ? this.crypto.blindIndex(b.phone) : null,
          b.email ?? null, b.isDirector, b.isAuthorisedSignatory, b.isBeneficialOwner])).rows[0];
      await this.audit.record(c, u.actor, 'person.create', 'person', r.id, null, { orgId, fullName: b.fullName, nationalId: mask(b.nationalId), roles: { director: b.isDirector, signatory: b.isAuthorisedSignatory } });
      return { id: r.id };
    });
  }

  async addBankAccount(u: AuthUser, orgId: string, b: { bankCode: string; branchCode?: string; accountName: string; accountNumber: string }) {
    assertOrgAccess(u, orgId);
    return this.db.tx(async (c) => {
      const current = (await c.query(`SELECT id FROM bank_account WHERE org_id = $1 AND is_payout_default AND deactivated_at IS NULL FOR UPDATE`, [orgId])).rows[0];
      // SUP-11: a CHANGE of payout account starts a cooling-off period and needs call-back verification again
      const coolingOff = current ? new Date(this.clock.now().getTime() + this.cfg.BANK_ACCOUNT_COOLING_OFF_HOURS * 3600_000) : null;
      if (current) await c.query(`UPDATE bank_account SET is_payout_default = false, deactivated_at = now() WHERE id = $1`, [current.id]);
      const r = (await c.query(
        `INSERT INTO bank_account (org_id, bank_code, branch_code, account_name, account_number_enc, account_number_bidx, account_number_last4, currency, is_payout_default, cooling_off_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'KES',true,$8) RETURNING id, account_number_last4, cooling_off_until`,
        [orgId, b.bankCode, b.branchCode ?? null, b.accountName, this.crypto.encrypt(b.accountNumber), this.crypto.blindIndex(b.accountNumber), b.accountNumber.slice(-4), coolingOff])).rows[0];
      await this.audit.record(c, u.actor, current ? 'bank_account.change' : 'bank_account.create', 'bank_account', r.id, current ? { previous: current.id } : null, { orgId, last4: r.account_number_last4, coolingOffUntil: coolingOff });
      if (current) await this.notifier.toOrg(c, orgId, 'invite.user', { link: 'Your payout bank account was changed. If this was not you, call Mapema now.' });
      return r;
    });
  }

  async proposeBankVerification(u: AuthUser, bankAccountId: string, note: string) {
    return this.db.tx(async (c) => {
      const ba = (await c.query(`SELECT id, org_id, verified_at FROM bank_account WHERE id = $1`, [bankAccountId])).rows[0];
      if (!ba) throw notFound('Bank account');
      if (ba.verified_at) throw conflict('ALREADY_VERIFIED', 'Bank account already verified');
      return this.approvals.propose(c, u, { action: 'bank_account_verify', entityType: 'bank_account', entityId: bankAccountId, payload: { callBackNote: note }, requiredRole: 'ops', reason: note });
    });
  }

  async uploadDocument(u: AuthUser, orgId: string, b: { type: string; fileName: string; mimeType: string; contentBase64: string; personId?: string }) {
    assertOrgAccess(u, orgId);
    return this.db.tx(async (c) => {
      const d = await this.docs.store(c, { ownerOrgId: orgId, ownerPersonId: b.personId ?? null, type: b.type, fileName: b.fileName, mimeType: b.mimeType, body: Buffer.from(b.contentBase64, 'base64'), uploadedBy: u.id });
      await this.audit.record(c, u.actor, 'document.upload', 'document', d.id, null, { orgId, type: b.type, sha256: d.file_sha256 });
      return d;
    });
  }

  // ------------------------------------------------------------------ invitations
  async invite(u: AuthUser, b: { kind: 'buyer_admin' | 'buyer_user' | 'supplier' | 'supplier_user' | 'staff' | 'auditor'; orgId?: string; email: string; phone?: string; role?: Role; accessExpiresAt?: string;
    supplier?: { legalName: string; kraPin: string; registrationNo: string } }) {
    // who may invite whom
    if (['staff', 'auditor', 'buyer_admin'].includes(b.kind) && !hasRole(u, 'admin', 'ops', 'ceo')) throw forbidden('ROLE_REQUIRED', 'Only Mapema staff can send this invitation');
    if (b.kind === 'auditor' && !b.accessExpiresAt) throw badRequest('EXPIRY_REQUIRED', 'Auditor and lender access must be time-boxed');
    if (b.kind === 'staff' && (!b.role || !STAFF_ROLES.includes(b.role))) throw badRequest('ROLE_REQUIRED', 'Staff invitations need a staff role');
    return this.db.tx(async (c) => {
      let orgId = b.orgId ?? null;
      let buyerId: string | null = null;
      if (b.kind === 'supplier') {
        buyerId = orgIds(u, ['buyer_admin', 'buyer_maker'])[0] ?? (isStaff(u) ? b.orgId ?? null : null);
        if (!buyerId) throw forbidden('ROLE_REQUIRED', 'Only a buyer can invite its suppliers');
        if (!b.supplier) throw badRequest('SUPPLIER_DETAILS', 'Supplier legal name, KRA PIN and registration number are required');
        const buyer = (await c.query(`SELECT status FROM organisation WHERE id = $1 AND type = 'buyer'`, [buyerId])).rows[0];
        if (!buyer) throw notFound('Buyer');
        let sup = (await c.query(`SELECT id FROM organisation WHERE type = 'supplier' AND kra_pin = $1`, [b.supplier.kraPin])).rows[0];
        if (!sup) {
          sup = (await c.query(`INSERT INTO organisation (type, legal_name, kra_pin, registration_no, status) VALUES ('supplier',$1,$2,$3,'invited') RETURNING id`,
            [b.supplier.legalName, b.supplier.kraPin, b.supplier.registrationNo])).rows[0];
        }
        await c.query(`INSERT INTO supplier_link (buyer_id, supplier_id, status, invited_by) VALUES ($1,$2,'invited',$3) ON CONFLICT (buyer_id, supplier_id) DO NOTHING`, [buyerId, sup.id, u.id]);
        orgId = sup.id;
      } else if (b.kind === 'buyer_user' || b.kind === 'supplier_user') {
        if (!orgId) throw badRequest('ORG_REQUIRED', 'orgId required');
        assertOrgAccess(u, orgId);
        if (!isStaff(u) && !hasRole(u, 'buyer_admin', 'supplier_admin')) throw forbidden('ROLE_REQUIRED', 'Only an admin of the organisation can add users');
      }
      const token = FieldCrypto.token();
      const inv = (await c.query(
        `INSERT INTO invitation (kind, org_id, invited_by, email, phone_enc, token_sha256, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval) RETURNING id, expires_at`,
        [b.kind, orgId, u.id, b.email, b.phone ? this.crypto.encrypt(b.phone) : null, FieldCrypto.sha256(token), String(this.cfg.INVITE_TTL_HOURS)])).rows[0];
      await c.query(`UPDATE invitation SET role_to_grant = $2, access_expires_at = $3, buyer_id = $4 WHERE id = $1`, [inv.id, b.role ?? null, b.accessExpiresAt ?? null, buyerId]);
      await this.audit.record(c, u.actor, 'invitation.create', 'invitation', inv.id, null, { kind: b.kind, orgId, email: b.email.replace(/^(.).*(@.*)$/, '$1***$2') });
      const link = `${this.cfg.WEB_ORIGIN}/join?token=${token}`;
      let approvalId: string | undefined;
      if (b.kind === 'staff' || b.kind === 'auditor') {
        // ADM-01: a staff/auditor role grant needs a second person; the link is held encrypted until then
        await c.query(`UPDATE invitation SET requires_approval = true, link_enc = $2 WHERE id = $1`, [inv.id, this.crypto.encrypt(link)]);
        approvalId = (await this.approvals.propose(c, u, { action: 'user_role_change', entityType: 'invitation', entityId: inv.id,
          payload: { kind: b.kind, role: b.role ?? 'auditor', email: b.email.replace(/^(.).*(@.*)$/, '$1***$2'), accessExpiresAt: b.accessExpiresAt ?? null },
          requiredRole: hasRole(u, 'ceo') ? 'admin' : 'ceo', reason: `Grant ${b.role ?? 'auditor'} access` })).id;
      } else {
        // the link carries the raw token: it is stored encrypted in the outbox and scrubbed once sent
        await this.outbox.enqueue(c, 'invitation.send', inv.id, `invite-${inv.id}`, { invitationId: inv.id, linkEnc: this.crypto.encrypt(link)!.toString('base64'), buyerId });
      }
      // the raw token is only returned outside production (dev/test convenience); in production it only travels by email/SMS
      return { id: inv.id, expiresAt: inv.expires_at, orgId, approvalId, ...(this.cfg.APP_ENV !== 'production' ? { devToken: token } : {}) };
    });
  }

  async acceptInvitation(idpToken: string, verifier: TokenVerifier, b: { token: string; displayName: string; phone?: string }) {
    const payload = await verifier.verify(idpToken);
    const sub = String(payload.sub); const email = payload.email as string | undefined; const amr = (payload.amr as string[]) ?? [];
    if (amr.length < 2) throw new DomainError(401, 'MFA_REQUIRED', 'Set up multi-factor sign-in before joining');
    return this.db.tx(async (c) => {
      const inv = (await c.query(`SELECT * FROM invitation WHERE token_sha256 = $1 FOR UPDATE`, [FieldCrypto.sha256(b.token)])).rows[0];
      if (!inv || inv.revoked_at || inv.accepted_at || new Date(inv.expires_at) < new Date()) throw new DomainError(410, 'INVITATION_INVALID', 'This invitation link is invalid or has expired');
      if (inv.email && email && inv.email.toLowerCase() !== email.toLowerCase()) throw forbidden('EMAIL_MISMATCH', 'Sign in with the email address the invitation was sent to');
      if (inv.requires_approval && !inv.approved_via) throw forbidden('INVITATION_NOT_APPROVED', 'This access has not been approved by a second person yet');
      const meta = { role: inv.role_to_grant as Role | null, accessExpiresAt: inv.access_expires_at as string | null };
      let personId: string | null = null;
      if (inv.org_id) {
        personId = (await c.query(`INSERT INTO person (org_id, full_name, email, phone_enc, phone_bidx) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [inv.org_id, b.displayName, inv.email, b.phone ? this.crypto.encrypt(b.phone) : null, b.phone ? this.crypto.blindIndex(b.phone) : null])).rows[0].id;
      }
      const user = (await c.query(
        `INSERT INTO user_account (person_id, idp_subject, email, display_name, mfa_enabled, mfa_methods, access_expires_at) VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`,
        [personId, sub, inv.email ?? email, b.displayName, amr.filter((m) => m !== 'pwd'), meta.accessExpiresAt ?? null])).rows[0];
      const role: Role = inv.kind === 'buyer_admin' ? 'buyer_admin' : inv.kind === 'supplier' ? 'supplier_admin' : inv.kind === 'auditor' ? 'auditor'
        : (meta.role as Role) ?? (inv.kind === 'buyer_user' ? 'buyer_maker' : 'supplier_user');
      await c.query(`INSERT INTO user_role_assignment (user_id, role, org_id) VALUES ($1,$2,$3)`, [user.id, role, ['staff', 'auditor'].includes(inv.kind) ? null : inv.org_id]);
      await c.query(`UPDATE invitation SET accepted_at = now() WHERE id = $1`, [inv.id]);
      if (inv.kind === 'supplier') {
        await c.query(`UPDATE supplier_link SET status = 'joined', joined_at = now() WHERE supplier_id = $1 AND status = 'invited'`, [inv.org_id]);
        await c.query(`UPDATE organisation SET status = 'kyc_pending', updated_at = now() WHERE id = $1 AND status = 'invited'`, [inv.org_id]);
      }
      await this.audit.record(c, { userId: user.id, role }, 'invitation.accept', 'invitation', inv.id, null, { userId: user.id, role, orgId: inv.org_id });
      return { userId: user.id, role, orgId: inv.org_id };
    });
  }

  // ------------------------------------------------------------------ consent, KYC, CRB
  async grantConsent(u: AuthUser, b: { orgId?: string; personId?: string; purpose: string; textVersion: string }, ip?: string) {
    if (b.orgId) assertOrgAccess(u, b.orgId);
    return this.db.tx(async (c) => {
      if (b.personId) {
        const p = (await c.query(`SELECT org_id FROM person WHERE id = $1`, [b.personId])).rows[0];
        if (!p) throw notFound('Person');
        assertOrgAccess(u, p.org_id);
      }
      const r = (await c.query(`INSERT INTO consent (person_id, org_id, purpose, text_version, granted_at, granted_ip) VALUES ($1,$2,$3,$4, now(), $5) RETURNING *`,
        [b.personId ?? null, b.orgId ?? null, b.purpose, b.textVersion, ip ?? null])).rows[0];
      await this.audit.record(c, u.actor, 'consent.grant', 'consent', r.id, null, { purpose: b.purpose, textVersion: b.textVersion });
      return r;
    });
  }

  async withdrawConsent(u: AuthUser, id: string) {
    return this.db.tx(async (c) => {
      const r = (await c.query(`SELECT * FROM consent WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r) throw notFound('Consent');
      const org = r.org_id ?? (await c.query(`SELECT org_id FROM person WHERE id = $1`, [r.person_id])).rows[0]?.org_id;
      assertOrgAccess(u, org);
      if (r.withdrawn_at) return r;
      const after = (await c.query(`UPDATE consent SET withdrawn_at = now() WHERE id = $1 RETURNING *`, [id])).rows[0];
      await this.audit.record(c, u.actor, 'consent.withdraw', 'consent', id, { withdrawn_at: null }, { withdrawn_at: after.withdrawn_at });
      return after;
    });
  }

  /** Submit KYB/KYC: runs ID checks on directors, registry lookup and sanctions screening. */
  async submitForReview(u: AuthUser, orgId: string) {
    assertOrgAccess(u, orgId);
    const org = await this.db.one(`SELECT * FROM organisation WHERE id = $1`, [orgId]);
    if (!org) throw notFound('Organisation');
    const persons = await this.db.query(`SELECT * FROM person WHERE org_id = $1 AND (is_director OR is_beneficial_owner OR is_authorised_signatory)`, [orgId]);
    if (persons.length === 0) throw unprocessable('DIRECTORS_REQUIRED', 'Add at least one director or signatory first');
    const bank = await this.db.one(`SELECT id FROM bank_account WHERE org_id = $1 AND deactivated_at IS NULL`, [orgId]);
    if (!bank) throw unprocessable('BANK_ACCOUNT_REQUIRED', 'Add the company bank account first');
    const ctx = ctxOf(u);
    const results: { check: string; result: string }[] = [];
    let anyFail = false; let anyReview = false;
    await this.db.tx(async (c) => {
      const reg = await this.adapters.kyc.companyLookup(ctx, { registrationNo: org.registration_no, kraPin: org.kra_pin });
      await c.query(`INSERT INTO kyc_check (subject_org_id, check_type, provider, provider_ref, result, details) VALUES ($1,'company_registry',$2,$3,$4,$5)`,
        [orgId, this.adapters.kyc.mode, reg.providerRef, reg.result, JSON.stringify({ directors: reg.directors.length })]);
      results.push({ check: 'company_registry', result: reg.result });
      const orgSan = await this.adapters.kyc.sanctionsScreen(ctx, { name: org.legal_name, type: 'company' });
      await c.query(`INSERT INTO kyc_check (subject_org_id, check_type, provider, provider_ref, result, details) VALUES ($1,'sanctions_pep',$2,$3,$4,$5)`,
        [orgId, this.adapters.kyc.mode, orgSan.providerRef, orgSan.hit ? 'review' : 'pass', JSON.stringify({ lists: orgSan.lists })]);
      if (orgSan.hit) { anyReview = true; await c.query(`INSERT INTO aml_flag (org_id, entity_type, entity_id, rule_code) VALUES ($1,'organisation',$1,'SANCTIONS_HIT')`, [orgId]); }
      if (reg.result === 'fail') anyFail = true;
      for (const p of persons) {
        const idr = await this.adapters.kyc.verifyId(ctx, { idNumber: this.crypto.decrypt(p.national_id_enc) ?? '', fullName: p.full_name });
        await c.query(`INSERT INTO kyc_check (subject_person_id, check_type, provider, provider_ref, result, details) VALUES ($1,'id_verification',$2,$3,$4,$5)`,
          [p.id, this.adapters.kyc.mode, idr.providerRef, idr.result, JSON.stringify({ reasons: idr.reasons })]);
        const san = await this.adapters.kyc.sanctionsScreen(ctx, { name: p.full_name, type: 'individual' });
        await c.query(`INSERT INTO kyc_check (subject_person_id, check_type, provider, provider_ref, result, details) VALUES ($1,'sanctions_pep',$2,$3,$4,$5)`,
          [p.id, this.adapters.kyc.mode, san.providerRef, san.hit ? 'review' : 'pass', JSON.stringify({ lists: san.lists })]);
        if (san.hit) { anyReview = true; await c.query(`INSERT INTO aml_flag (org_id, entity_type, entity_id, rule_code) VALUES ($1,'person',$2,'SANCTIONS_HIT')`, [orgId, p.id]); }
        if (idr.result === 'fail') anyFail = true;
        if (idr.result === 'review') anyReview = true;
        results.push({ check: `id:${p.full_name}`, result: idr.result }, { check: `sanctions:${p.full_name}`, result: san.hit ? 'review' : 'pass' });
      }
      const next = org.type === 'buyer' ? 'kyb_submitted' : anyFail ? 'kyc_failed' : anyReview ? 'kyc_review' : 'kyc_passed';
      await c.query(`UPDATE organisation SET status = $2, updated_at = now() WHERE id = $1`, [orgId, next]);
      await this.audit.record(c, u.actor, 'organisation.submit_review', 'organisation', orgId, { status: org.status }, { status: next, results });
    });
    return { results, status: (await this.db.one(`SELECT status FROM organisation WHERE id = $1`, [orgId])).status };
  }

  async pullCrb(u: AuthUser, orgId: string) {
    const org = await this.db.one(`SELECT * FROM organisation WHERE id = $1`, [orgId]);
    if (!org) throw notFound('Organisation');
    const consent = await this.db.one(`SELECT id FROM consent WHERE org_id = $1 AND purpose = 'crb_enquiry_and_reporting' AND withdrawn_at IS NULL ORDER BY granted_at DESC LIMIT 1`, [orgId]);
    if (!consent) throw unprocessable('NO_CONSENT', 'The organisation has not consented to a CRB check');
    const rep = await this.adapters.crb.pullReport(ctxOf(u), { subjectType: 'company', kraPin: org.kra_pin, consentRef: consent.id, purpose: 'new_facility' });
    return this.db.tx(async (c) => {
      const doc = await this.docs.store(c, { ownerOrgId: orgId, type: 'credit_report', fileName: `crb-${rep.bureauRef}.pdf`, mimeType: 'application/pdf', body: rep.reportPdf, uploadedBy: u.id });
      const r = (await c.query(`INSERT INTO credit_check (subject_org_id, bureau, consent_id, score, bureau_ref, report_doc_id, pulled_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [orgId, rep.bureau, consent.id, rep.score, rep.bureauRef, doc.id, u.id])).rows[0];
      if (org.type === 'buyer' && org.status === 'kyb_submitted') await c.query(`UPDATE organisation SET status = 'under_review' WHERE id = $1`, [orgId]);
      await this.audit.record(c, u.actor, 'crb.pull', 'organisation', orgId, null, { bureau: rep.bureau, score: rep.score, npl: rep.hasNonPerformingAccounts });
      return { ...r, hasNonPerformingAccounts: rep.hasNonPerformingAccounts };
    });
  }

  // ------------------------------------------------------------------ programmes & limits
  async proposeProgramme(u: AuthUser, buyerId: string, b: { limitCents: bigint; advanceRateBps: number; startDate: string; reviewDate: string; decisionReason: string }) {
    const pricing = await this.settings.activePricing();
    if (!pricing) throw unprocessable('NO_ACTIVE_PRICING', 'No active pricing version with a CBK approval reference');
    if (b.advanceRateBps > pricing.advance_rate_bps) throw unprocessable('ADVANCE_RATE_TOO_HIGH', `Advance rate cannot exceed the pricing version (${pricing.advance_rate_bps} bps)`);
    return this.db.tx(async (c) => {
      const org = (await c.query(`SELECT * FROM organisation WHERE id = $1 AND type = 'buyer'`, [buyerId])).rows[0];
      if (!org) throw notFound('Buyer');
      const crb = (await c.query(`SELECT id FROM credit_check WHERE subject_org_id = $1`, [buyerId])).rows[0];
      if (!crb) throw unprocessable('CRB_REQUIRED', 'Pull a CRB report before proposing a limit');
      const p = (await c.query(
        `INSERT INTO buyer_programme (buyer_id, pricing_version_id, advance_rate_bps, limit_cents, start_date, review_date, status) VALUES ($1,$2,$3,$4,$5,$6,'proposed') RETURNING *`,
        [buyerId, pricing.id, b.advanceRateBps, b.limitCents, b.startDate, b.reviewDate])).rows[0];
      const appr = await this.approvals.propose(c, u, { action: 'buyer_programme_approve', entityType: 'buyer_programme', entityId: p.id, payload: { limitCents: b.limitCents.toString(), advanceRateBps: b.advanceRateBps, reviewDate: b.reviewDate }, requiredRole: 'ceo', reason: b.decisionReason });
      return { programme: p, approval: appr };
    });
  }

  async proposeSupplierLimit(u: AuthUser, linkId: string, limitCents: bigint, reason: string) {
    return this.db.tx(async (c) => {
      const l = (await c.query(`SELECT * FROM supplier_link WHERE id = $1`, [linkId])).rows[0];
      if (!l) throw notFound('Supplier link');
      return this.approvals.propose(c, u, { action: 'supplier_limit_set', entityType: 'supplier_link', entityId: linkId, payload: { limitCents: limitCents.toString() }, requiredRole: 'credit', reason });
    });
  }

  // ------------------------------------------------------------------ e-signature
  async startAgreements(u: AuthUser, orgId: string) {
    assertOrgAccess(u, orgId);
    const org = await this.db.one(`SELECT * FROM organisation WHERE id = $1`, [orgId]);
    if (!org) throw notFound('Organisation');
    const signers = (await this.db.query(`SELECT full_name, email FROM person WHERE org_id = $1 AND is_authorised_signatory AND email IS NOT NULL`, [orgId]))
      .map((p) => ({ name: p.full_name, email: p.email, role: 'authorised_signatory' }));
    if (signers.length === 0) throw unprocessable('SIGNATORY_REQUIRED', 'Add an authorised signatory with an email address');
    let purpose: 'supplier_agreements' | 'programme_agreement'; let entityId: string; let pdf: Buffer;
    if (org.type === 'supplier') {
      if (org.status !== 'kyc_passed') throw unprocessable('KYC_NOT_PASSED', 'KYC must pass before signing the master agreement');
      purpose = 'supplier_agreements'; entityId = orgId;
      pdf = simplePdf('Mapema Master Receivables Purchase Agreement and Deed of Assignment', [
        `Supplier: ${org.legal_name} (KRA PIN ${org.kra_pin})`, `Terms version: ${TERMS_VERSION}`,
        'The supplier assigns each financed invoice in full to Mapema. Mapema pays the advance and,',
        'after the buyer pays, the balance of the purchase price (deferred price) within 1 business day.',
        'Discount fee is interest on actual days outstanding; the quote is the maximum.',
        'Early repayment: interest stops on the day the buyer pays. Recourse: day 30 after due date.',
        'DRAFT TEMPLATE - wording subject to Kenyan counsel review before go-live.',
      ]);
    } else {
      const p = await this.db.one(`SELECT * FROM buyer_programme WHERE buyer_id = $1 AND status = 'approved'`, [orgId]);
      if (!p) throw unprocessable('PROGRAMME_NOT_APPROVED', 'The buyer programme must be approved by the CEO first');
      purpose = 'programme_agreement'; entityId = p.id;
      pdf = simplePdf('Mapema Buyer Programme Agreement', [`Buyer: ${org.legal_name} (KRA PIN ${org.kra_pin})`, `Programme limit (cents): ${p.limit_cents}`,
        'The buyer will pay confirmed invoices in full into its Mapema collection account on the due date, without set-off.',
        'DRAFT TEMPLATE - wording subject to Kenyan counsel review before go-live.']);
    }
    const env = await this.adapters.esign.createEnvelope(ctxOf(u), { documentType: purpose, title: purpose, pdf, signers, reference: entityId });
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO esign_envelope (envelope_id, purpose, entity_type, entity_id, created_by) VALUES ($1,$2,$3,$4,$5)`, [env.envelopeId, purpose, purpose === 'programme_agreement' ? 'buyer_programme' : 'organisation', entityId, u.id]);
      await this.audit.record(c, u.actor, 'esign.envelope.create', purpose, entityId, null, { envelopeId: env.envelopeId });
    });
    return env;
  }

  /** Called from the e-sign webhook (or the dev completion endpoint). Idempotent. */
  async completeEnvelope(envelopeId: string) {
    const env = await this.db.one(`SELECT * FROM esign_envelope WHERE envelope_id = $1`, [envelopeId]);
    if (!env) throw notFound('Envelope');
    if (env.status === 'completed') return { envelopeId, status: 'completed' };
    const status = await this.adapters.esign.getStatus(envelopeId);
    if (status !== 'completed') {
      await this.db.query(`UPDATE esign_envelope SET status = $2 WHERE envelope_id = $1`, [envelopeId, status]);
      return { envelopeId, status };
    }
    const signed = await this.adapters.esign.downloadSigned(envelopeId);
    await this.db.tx(async (c) => {
      const locked = (await c.query(`SELECT status FROM esign_envelope WHERE envelope_id = $1 FOR UPDATE`, [envelopeId])).rows[0];
      if (locked.status === 'completed') return;
      const h = this.esignHandlers.get(env.purpose);
      if (!h) throw new Error(`no e-sign handler for ${env.purpose}`);
      await h(c, env, signed);
      await c.query(`UPDATE esign_envelope SET status = 'completed', completed_at = now() WHERE envelope_id = $1`, [envelopeId]);
      await this.audit.record(c, SYSTEM, 'esign.envelope.completed', env.entity_type, env.entity_id, null, { envelopeId, sha256: signed.sha256, signedAt: signed.signedAt });
    });
    return { envelopeId, status: 'completed' };
  }
}

const zOrgId = zUuid;

@Controller()
export class OnboardingController {
  constructor(private readonly s: OnboardingService, private readonly verifier: TokenVerifier, @Inject(ADAPTERS) private readonly adapters: Adapters) {}

  @Post('organisations')
  @Roles('ops', 'credit', 'admin')
  create(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ type: z.literal('buyer'), legalName: zText(200), tradingName: z.string().max(200).optional(), kraPin: zKraPin, registrationNo: zText(50), sectorCode: zText(20) }).parse(b);
    return this.s.createBuyerProspect(u, body);
  }

  @Get('organisations')
  list(@CurrentUser() u: AuthUser, @Query('type') type?: string) {
    return this.s.listOrgs(u, type ? z.enum(['buyer', 'supplier']).parse(type) : undefined);
  }

  @Get('organisations/:id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.getOrg(u, zOrgId.parse(id));
  }

  @Get('organisations/:id/credit-file')
  @Roles('credit', 'ceo', 'compliance', 'admin')
  creditFile(@Param('id') id: string) {
    return this.s.creditFile(zOrgId.parse(id));
  }

  @Put('organisations/:id/kyb')
  kyb(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ tradingName: z.string().max(200).optional(), address: z.record(z.string(), z.string().max(200)).optional(), sectorCode: z.string().max(20).optional() }).parse(b);
    return this.s.updateKyb(u, zOrgId.parse(id), body);
  }

  @Post('organisations/:id/persons')
  addPerson(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({
      fullName: zText(200), nationalId: z.string().regex(/^[A-Z0-9]{6,12}$/i, 'ID or passport number'), idDocumentType: z.enum(['national_id', 'passport', 'alien_id']).default('national_id'),
      dateOfBirth: z.string().optional(), phone: zPhoneKe.optional(), email: z.string().email().optional(),
      isDirector: z.boolean().default(false), isAuthorisedSignatory: z.boolean().default(false), isBeneficialOwner: z.boolean().default(false),
    }).parse(b);
    return this.s.addPerson(u, zOrgId.parse(id), body);
  }

  @Post('organisations/:id/bank-accounts')
  @StepUp()
  addBank(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ bankCode: z.string().regex(/^\d{2,4}$/), branchCode: z.string().max(10).optional(), accountName: zText(200), accountNumber: z.string().regex(/^\d{6,20}$/, 'digits only') }).parse(b);
    return this.s.addBankAccount(u, zOrgId.parse(id), body);
  }

  @Post('bank-accounts/:id/verify')
  @Roles('ops')
  verifyBank(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.proposeBankVerification(u, zUuid.parse(id), z.object({ callBackNote: zText() }).parse(b).callBackNote);
  }

  @Post('organisations/:id/documents')
  upload(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({
      type: z.enum(['certificate_of_incorporation', 'cr12', 'kra_pin_certificate', 'board_resolution', 'national_id', 'passport', 'selfie', 'bank_proof', 'audited_accounts', 'invoice_pdf', 'other']),
      fileName: zText(200), mimeType: z.string(), contentBase64: z.string().max(14_000_000), personId: zUuid.optional(),
    }).parse(b);
    return this.s.uploadDocument(u, zOrgId.parse(id), body);
  }

  @Post('organisations/:id/submit')
  submit(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.submitForReview(u, zOrgId.parse(id));
  }

  @Post('organisations/:id/crb-pull')
  @Roles('credit')
  crb(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.pullCrb(u, zOrgId.parse(id));
  }

  @Post('organisations/:id/programme')
  @Roles('credit')
  programme(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ limitCents: zPositiveCents, advanceRateBps: z.number().int().min(1).max(10000), startDate: zDate, reviewDate: zDate, decisionReason: zText(1000) }).parse(b);
    return this.s.proposeProgramme(u, zOrgId.parse(id), body);
  }

  @Post('supplier-links/:id/limit')
  @Roles('credit')
  supplierLimit(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ limitCents: zPositiveCents, reason: zText(1000) }).parse(b);
    return this.s.proposeSupplierLimit(u, zUuid.parse(id), body.limitCents, body.reason);
  }

  @Post('organisations/:id/agreements')
  agreements(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.startAgreements(u, zOrgId.parse(id));
  }

  @Post('invitations')
  @Roles('admin', 'ops', 'ceo', 'buyer_admin', 'buyer_maker', 'supplier_admin')
  invite(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({
      kind: z.enum(['buyer_admin', 'buyer_user', 'supplier', 'supplier_user', 'staff', 'auditor']), orgId: zUuid.optional(), email: z.string().email(), phone: zPhoneKe.optional(),
      role: z.enum(['buyer_admin', 'buyer_maker', 'buyer_checker', 'supplier_admin', 'supplier_user', 'credit', 'ops', 'compliance', 'admin', 'ceo', 'auditor', 'lender']).optional(),
      accessExpiresAt: z.string().datetime().optional(),
      supplier: z.object({ legalName: zText(200), kraPin: zKraPin, registrationNo: zText(50) }).optional(),
    }).parse(b);
    if (body.role && ['buyer_admin', 'buyer_maker', 'buyer_checker'].includes(body.role) && body.kind !== 'buyer_user' && body.kind !== 'buyer_admin') throw badRequest('ROLE_KIND', 'Role does not match invitation kind');
    return this.s.invite(u, body);
  }

  @Public()
  @Post('invitations/accept')
  accept(@Headers('authorization') auth: string | undefined, @Body() b: unknown) {
    // the invitee has no Mapema account yet, so no session: the fresh IdP token comes in the header (API
    // clients) or the body (browser, Phase 1b - never stored), and the browser then swaps it for a cookie session
    const body = z.object({ token: z.string().min(20).max(200), displayName: zText(200), phone: zPhoneKe.optional(), accessToken: z.string().min(1).max(8000).optional() }).parse(b);
    const idToken = auth?.startsWith('Bearer ') ? auth.slice(7) : body.accessToken;
    if (!idToken) throw new DomainError(401, 'UNAUTHENTICATED', 'Sign in first');
    const { accessToken: _drop, ...rest } = body;
    return this.s.acceptInvitation(idToken, this.verifier, rest);
  }

  @Post('consents')
  consent(@CurrentUser() u: AuthUser, @Body() b: unknown, @Req() req: any) {
    const body = z.object({ orgId: zUuid.optional(), personId: zUuid.optional(), purpose: z.enum(['crb_enquiry_and_reporting', 'data_sharing_with_buyer', 'marketing', 'cross_border_transfer']), textVersion: zText(40) })
      .refine((x) => x.orgId || x.personId, 'orgId or personId required').parse(b);
    return this.s.grantConsent(u, body, req.ip);
  }

  @Post('consents/:id/withdraw')
  withdraw(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.withdrawConsent(u, zUuid.parse(id));
  }

  @Public()
  @Post('webhooks/esign')
  async esignWebhook(@Req() req: any) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!this.adapters.esign.verifyWebhook(raw, req.headers)) throw new DomainError(401, 'BAD_SIGNATURE', 'Invalid webhook signature');
    const body = z.object({ envelopeId: z.string().min(3).max(100) }).parse(JSON.parse(raw));
    return this.s.completeEnvelope(body.envelopeId);
  }
}
