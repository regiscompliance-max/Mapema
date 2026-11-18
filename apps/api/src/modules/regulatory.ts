/**
 * [Backend Engineer + Compliance & Risk Analyst] Phase 2 month-end reporting (RPT-01..06).
 *  - month-end snapshot: built ONLY from system data (advances, allocations, payments, limits, float,
 *    complaints, reconciliation, recourse, waivers); stored append-only with its SHA-256
 *  - CBK monthly return and CRB data-submission file through the template layer (DRAFT until official)
 *  - lender pack (loan tape CSV, summary CSV, PDF), reproducible byte-for-byte from the snapshot
 * Figures are cash-basis (Fineract product accounting is cash based) and as at month end: balances use
 * allocations whose payment value date is on or before the month end (D-40).
 */
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';
import { AGEING_BUCKETS, ageingBucket, CollectionsPolicy, DEFAULT_COLLECTIONS_POLICY, dpd, dpdStage } from '@mapema/pricing';
import { Audit, SYSTEM } from '../common/audit';
import { Clock } from '../common/clock';
import { ArtifactCrypto } from '../common/crypto';
import { AppConfig, CONFIG } from '../common/config';
import { Db, toCents } from '../common/db';
import { badRequest, conflict, notFound } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { AuthUser, CurrentUser, Roles } from '../auth/auth';
import { ApprovalsService } from './approvals';
import { SettingsService } from './admin';
import { FundingService } from './funding';
import { canonical, lenderPackLines, pdfDocument, renderFileCsv, renderReturnCsv, renderTapeCsv, sha256, TemplateMeta } from '../reporting/render';
import { DEFAULT_TEMPLATES, FileMapping, PackMapping, ReturnMapping } from '../reporting/templates';

const READERS = ['compliance', 'ceo', 'credit', 'auditor'] as const;
const lastDay = (period: string) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const s = (b: bigint) => b.toString();
const bpsOf = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 10000n * 2n + whole) / (whole * 2n)) : 0);

/**
 * Per-funder view of a month-end snapshot (Phase 3 FUND-05): only that funder's loans, and the loan-level
 * aggregates (portfolio, ageing, status, flows, NPL ratio) recomputed from them. Platform-wide items
 * (float, concentration vs float, complaints, recourse, reconciliation) stay as they are: they describe the
 * lender, not the facility, and the pack title names the funding source. Integer cents throughout.
 */
function funderView(data: any, keep: (l: any) => boolean) {
  const loans = data.loans.filter(keep);
  const live = loans.filter((l: any) => BigInt(l.outstandingPrincipalCents) > 0n);
  const tot = (xs: any[], k: string) => xs.reduce((t: bigint, l: any) => t + BigInt(l[k]), 0n);
  const sumM = (k: string) => s(loans.reduce((t: bigint, l: any) => t + BigInt(l.repaidInMonth[k]), 0n));
  const ageing = Object.fromEntries(AGEING_BUCKETS.map((b) => { const xs = live.filter((l: any) => l.bucket === b); return [b, { count: xs.length, principalCents: s(tot(xs, 'outstandingPrincipalCents')) }]; }));
  const statusAtMonthEnd = Object.fromEntries(['current', 'late', 'recourse', 'non_performing'].map((st) => { const xs = live.filter((l: any) => l.statusAtMonthEnd === st); return [st, { count: xs.length, principalCents: s(tot(xs, 'outstandingPrincipalCents')) }]; }));
  const outstanding = tot(live, 'outstandingPrincipalCents');
  const disb = loans.filter((l: any) => l.disbursedInMonth); const wo = loans.filter((l: any) => l.writtenOffInMonth);
  return { ...data, loans, aggregates: { ...data.aggregates,
    loansOutstanding: { count: live.length, principalCents: s(outstanding) },
    borrowersOutstanding: new Set(live.map((l: any) => l.supplierKraPin)).size,
    buyersOutstanding: new Set(live.map((l: any) => l.buyerKraPin)).size,
    disbursedInMonth: { count: disb.length, principalCents: s(tot(disb, 'principalCents')) },
    repaidInMonth: { principalCents: sumM('principalCents'), feesCents: sumM('feesCents'), interestCents: sumM('interestCents'), supplierBalanceCents: sumM('supplierBalanceCents') },
    incomeInMonth: { interestCents: sumM('interestCents'), feesCents: sumM('feesCents') },
    ageing, statusAtMonthEnd,
    nplRatioBps: bpsOf(BigInt(statusAtMonthEnd.non_performing.principalCents), outstanding),
    writtenOffInMonth: { count: wo.length, principalCents: s(tot(wo, 'writtenOffPrincipalCents')) },
    inDuplumWaivedInMonthCents: s(tot(loans, 'inDuplumWaivedInMonthCents')),
  } };
}

@Injectable()
export class RegulatoryService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly clock: Clock,
    private readonly artifactCrypto: ArtifactCrypto,
    private readonly approvals: ApprovalsService,
    private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly funding: FundingService,
  ) {}

  async onModuleInit() {
    this.approvals.register('report_template_activate', async (c, a) => {
      const t = (await c.query(`SELECT * FROM report_template WHERE id = $1 FOR UPDATE`, [a.entity_id])).rows[0];
      if (!t) throw notFound('Template');
      await c.query(`UPDATE report_template SET active = false WHERE kind = $1 AND active`, [t.kind]);
      await c.query(`UPDATE report_template SET active = true, approved_via = $2 WHERE id = $1`, [t.id, a.id]);
      await this.audit.record(c, SYSTEM, 'report.template_activated', 'report_template', t.id, null, { kind: t.kind, version: t.version, status: t.status, sourceRef: t.source_ref });
    });
    for (const t of DEFAULT_TEMPLATES) {
      await this.db.query(`INSERT INTO report_template (kind, version, status, source_ref, mapping, active)
        SELECT $1,$2,$3,$4,$5::jsonb, NOT EXISTS (SELECT 1 FROM report_template WHERE kind = $1 AND active) ON CONFLICT (kind, version) DO NOTHING`,
        [t.kind, t.version, t.status, t.sourceRef, JSON.stringify(t.mapping)]).catch(() => undefined); // DB may not be migrated yet (openapi gen)
    }
  }

  // ------------------------------------------------------------------ snapshot data (system data only)
  async build(period: string) {
    const asOf = lastDay(period); const monthStart = `${period}-01`;
    const pol: CollectionsPolicy = { ...DEFAULT_COLLECTIONS_POLICY, ...((await this.db.one(`SELECT value FROM platform_setting WHERE key = 'collections_policy'`))?.value ?? {}) };
    const lending = await this.settings.lending();
    const floatRow = await this.db.one(`SELECT amount_cents FROM lending_float WHERE effective_from <= ($1::date + 1) ORDER BY effective_from DESC LIMIT 1`, [asOf])
      ?? await this.db.one(`SELECT amount_cents FROM lending_float ORDER BY effective_from DESC LIMIT 1`);
    const float = floatRow ? toCents(floatRow.amount_cents) : 0n;
    const pricing = await this.db.one(`SELECT code, cbk_approval_ref FROM pricing_version WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`);
    const requireConsent = (this.cfg.raw.CRB_SUBMISSION_REQUIRE_CONSENT ?? 'true') !== 'false';
    const adv = await this.db.query(
      `SELECT a.id, a.fineract_loan_id, a.status, a.principal_cents, a.discount_fee_cents, a.verification_fee_cents, a.disbursement_date, a.due_date, a.term_days, a.rate_bps_per_30d,
              a.npl_at, a.recourse_at, a.written_off_on, a.settled_on, a.supplier_id, a.buyer_id,
              i.invoice_number, i.amount_cents AS invoice_amount_cents, b.legal_name AS buyer_name, b.kra_pin AS buyer_kra_pin, sec.code AS sector,
              sp.legal_name AS supplier_name, sp.kra_pin AS supplier_kra_pin, sp.registration_no AS supplier_reg_no,
              EXISTS (SELECT 1 FROM consent k WHERE k.org_id = a.supplier_id AND k.purpose = 'crb_enquiry_and_reporting' AND k.withdrawn_at IS NULL) AS crb_consent
       FROM advance a JOIN invoice i ON i.id = a.invoice_id JOIN organisation b ON b.id = a.buyer_id JOIN organisation sp ON sp.id = a.supplier_id LEFT JOIN sector sec ON sec.id = b.sector_id
       WHERE a.disbursement_date IS NOT NULL AND a.disbursement_date <= $1 AND a.status IN ('funded','late','recourse','non_performing','written_off','settled')
       ORDER BY a.disbursement_date, i.invoice_number, a.id`, [asOf]);
    const alloc = await this.db.query(
      `SELECT pa.advance_id, (p.received_at AT TIME ZONE 'UTC')::date AS d, pa.principal_cents, pa.fees_charges_cents, pa.interest_cents, pa.supplier_balance_cents
       FROM payment_allocation pa JOIN payment p ON p.id = pa.payment_id WHERE (p.received_at AT TIME ZONE 'UTC')::date <= $1`, [asOf]);
    const waivers = await this.db.query(`SELECT advance_id, as_of_date, amount_cents FROM in_duplum_waiver WHERE as_of_date <= $1`, [asOf]);
    const loans: any[] = [];
    for (const a of adv) {
      const al = alloc.filter((x) => x.advance_id === a.id);
      const sum = (k: string, f?: (x: any) => boolean) => al.filter(f ?? (() => true)).reduce((t, x) => t + toCents(x[k]), 0n);
      const inMonth = (x: any) => x.d >= monthStart;
      const principal = toCents(a.principal_cents);
      const pRepaid = sum('principal_cents');
      const outstanding = principal - pRepaid > 0n ? principal - pRepaid : 0n;
      const writtenOff = a.written_off_on && a.written_off_on <= asOf;
      const closedOn = a.settled_on ?? (outstanding === 0n && al.length ? al.map((x) => x.d).sort().at(-1) : null);
      if (closedOn && closedOn < monthStart) continue;        // closed before the month: not active in the month
      if (writtenOff && a.written_off_on < monthStart) continue;
      const days = outstanding > 0n && !writtenOff ? dpd(a.due_date, asOf) : 0;
      const stage = dpdStage(days, a.term_days ?? 120, pol);
      const statusAtMonthEnd = outstanding === 0n ? 'settled' : writtenOff ? 'written_off'
        : (a.npl_at && a.npl_at <= asOf) || stage === 'npl' ? 'non_performing'
        : a.recourse_at && a.recourse_at <= asOf ? 'recourse' : days >= 1 ? 'late' : 'current';
      loans.push({
        advanceId: a.id, fineractLoanId: a.fineract_loan_id, invoiceNumber: a.invoice_number, buyerName: a.buyer_name, buyerKraPin: a.buyer_kra_pin, sector: a.sector ?? '',
        supplierId: a.supplier_id, buyerId: a.buyer_id, supplierName: a.supplier_name, supplierKraPin: a.supplier_kra_pin, supplierRegNo: a.supplier_reg_no,
        disbursementDate: a.disbursement_date, dueDate: a.due_date, termDays: a.term_days, rateBpsPer30d: a.rate_bps_per_30d,
        invoiceAmountCents: s(toCents(a.invoice_amount_cents)), principalCents: s(principal), discountFeeCents: s(toCents(a.discount_fee_cents)), verificationFeeCents: s(toCents(a.verification_fee_cents)),
        principalRepaidCents: s(pRepaid), feesRepaidCents: s(sum('fees_charges_cents')), interestRepaidCents: s(sum('interest_cents')), supplierBalanceCents: s(sum('supplier_balance_cents')),
        outstandingPrincipalCents: s(writtenOff ? 0n : outstanding), writtenOffPrincipalCents: s(writtenOff ? outstanding : 0n),
        repaidInMonth: { principalCents: s(sum('principal_cents', inMonth)), feesCents: s(sum('fees_charges_cents', inMonth)), interestCents: s(sum('interest_cents', inMonth)), supplierBalanceCents: s(sum('supplier_balance_cents', inMonth)) },
        disbursedInMonth: a.disbursement_date >= monthStart, writtenOffInMonth: Boolean(writtenOff && a.written_off_on >= monthStart),
        dpd: days, bucket: ageingBucket(days), statusAtMonthEnd, nplAt: a.npl_at, recourseAt: a.recourse_at,
        inDuplumWaivedInMonthCents: s(waivers.filter((w) => w.advance_id === a.id && w.as_of_date >= monthStart).reduce((t, w) => t + toCents(w.amount_cents), 0n)),
        crbConsentOnFile: a.crb_consent, crbIncluded: requireConsent ? a.crb_consent : true,
      });
    }
    const live = loans.filter((l) => BigInt(l.outstandingPrincipalCents) > 0n);
    const tot = (xs: any[], k: string) => xs.reduce((t, l) => t + BigInt(get2(l, k)), 0n);
    const ageing = Object.fromEntries(AGEING_BUCKETS.map((b) => { const xs = live.filter((l) => l.bucket === b); return [b, { count: xs.length, principalCents: s(tot(xs, 'outstandingPrincipalCents')) }]; }));
    const statusAtMonthEnd = Object.fromEntries(['current', 'late', 'recourse', 'non_performing'].map((st) => { const xs = live.filter((l) => l.statusAtMonthEnd === st); return [st, { count: xs.length, principalCents: s(tot(xs, 'outstandingPrincipalCents')) }]; }));
    const outstanding = tot(live, 'outstandingPrincipalCents');
    const limits = await this.db.query(`SELECT subject, pct_of_float_bps FROM limit_config WHERE active AND subject_org_id IS NULL`);
    const lim = (subj: string) => Number(limits.find((l) => l.subject === subj && l.pct_of_float_bps !== null)?.pct_of_float_bps ?? { buyer: 2500, supplier: 1000, sector: 3500 }[subj]);
    const conc = (key: 'buyerName' | 'supplierName' | 'sector', subj: string) => {
      const m = new Map<string, bigint>();
      for (const l of live) m.set(l[key], (m.get(l[key]) ?? 0n) + BigInt(l.outstandingPrincipalCents));
      const cap = (float * BigInt(lim(subj))) / 10000n;
      return [...m.entries()].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : x[0].localeCompare(y[0])))
        .map(([name, e]) => ({ name, exposureCents: s(e), capCents: s(cap), limitBps: lim(subj), usedBps: bpsOf(e, cap), pctOfFloatBps: bpsOf(e, float), breach: e > cap }));
    };
    const buyers = conc('buyerName', 'buyer'); const suppliers = conc('supplierName', 'supplier'); const sectors = conc('sector', 'sector');
    const compl = await this.db.one(`SELECT
        count(*) FILTER (WHERE created_at::date BETWEEN $1 AND $2)::int AS received,
        count(*) FILTER (WHERE resolved_at::date BETWEEN $1 AND $2)::int AS resolved,
        count(*) FILTER (WHERE created_at::date <= $2 AND (resolved_at IS NULL OR resolved_at::date > $2))::int AS open_at_end FROM complaint`, [monthStart, asOf]);
    const recon = await this.db.one(`SELECT count(*)::int AS runs, count(*) FILTER (WHERE status = 'balanced')::int AS balanced, count(*) FILTER (WHERE status = 'explained')::int AS explained,
        count(*) FILTER (WHERE unexplained_count > 0 OR status = 'breaks')::int AS with_unexplained FROM reconciliation_run WHERE as_of_date BETWEEN $1 AND $2`, [monthStart, asOf]);
    const recourse = await this.db.one(`SELECT count(*) FILTER (WHERE opened_on <= $1 AND (closed_on IS NULL OR closed_on > $1))::int AS open_cases,
        COALESCE(SUM(amount_demanded_cents) FILTER (WHERE demanded_on BETWEEN $2 AND $1),0)::bigint AS demanded FROM recourse_case`, [asOf, monthStart]);
    const collections = await this.db.one(`SELECT COALESCE(SUM(amount_cents),0)::bigint AS c FROM bank_transaction WHERE value_date BETWEEN $1 AND $2`, [monthStart, asOf]);
    const funding = await this.db.one(`SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents ELSE -amount_cents END),0)::bigint AS f FROM funding_movement WHERE value_date <= $1`, [asOf]);
    const sumM = (k: string) => s(loans.reduce((t, l) => t + BigInt(l.repaidInMonth[k]), 0n));
    const disb = loans.filter((l) => l.disbursedInMonth); const wo = loans.filter((l) => l.writtenOffInMonth);
    return {
      schema: 'mapema.month_end.v1', period, monthStart, asOfDate: asOf,
      lender: { name: 'Mapema', licence: lending.cbk_licence_no ? `CBK licence ${lending.cbk_licence_no}` : 'NOT YET LICENSED' },
      pricing: { code: pricing?.code ?? '', cbkApprovalRef: pricing?.cbk_approval_ref ?? '', label: pricing ? `${pricing.code} / ${pricing.cbk_approval_ref}` : '' },
      float: { floatCents: s(float), fundingNetCents: s(toCents(funding.f)) },
      policy: pol, crb: { requireConsent },
      loans: loans.map(({ supplierId, buyerId, ...l }) => l),
      aggregates: {
        loansOutstanding: { count: live.length, principalCents: s(outstanding) },
        borrowersOutstanding: new Set(live.map((l) => l.supplierKraPin)).size,
        buyersOutstanding: new Set(live.map((l) => l.buyerKraPin)).size,
        disbursedInMonth: { count: disb.length, principalCents: s(tot(disb, 'principalCents')) },
        repaidInMonth: { principalCents: sumM('principalCents'), feesCents: sumM('feesCents'), interestCents: sumM('interestCents'), supplierBalanceCents: sumM('supplierBalanceCents') },
        incomeInMonth: { interestCents: sumM('interestCents'), feesCents: sumM('feesCents') },
        collectionsInMonthCents: s(toCents(collections.c)),
        ageing, statusAtMonthEnd,
        nplRatioBps: bpsOf(BigInt(statusAtMonthEnd.non_performing.principalCents), outstanding),
        writtenOffInMonth: { count: wo.length, principalCents: s(tot(wo, 'writtenOffPrincipalCents')) },
        inDuplumWaivedInMonthCents: s(tot(loans, 'inDuplumWaivedInMonthCents')),
        concentration: { buyers, suppliers, sectors, largestBuyerBps: buyers[0]?.pctOfFloatBps ?? 0, largestSupplierBps: suppliers[0]?.pctOfFloatBps ?? 0, largestSectorBps: sectors[0]?.pctOfFloatBps ?? 0 },
        recourse: { openCases: recourse.open_cases, demandedInMonthCents: s(toCents(recourse.demanded)) },
        complaints: { received: compl.received, resolved: compl.resolved, openAtMonthEnd: compl.open_at_end },
        reconciliation: { runs: recon.runs, balanced: recon.balanced, explained: recon.explained, withUnexplained: recon.with_unexplained },
      },
    };
  }

  async snapshot(u: AuthUser | null, period: string, restate = false, reason?: string) {
    if (restate && !reason) throw badRequest('REASON_REQUIRED', 'A restatement needs a reason');
    const latest = await this.db.one(`SELECT id, period, version, as_of_date, sha256, created_at FROM report_snapshot WHERE period = $1 ORDER BY version DESC LIMIT 1`, [period]);
    if (latest && !restate) return latest;
    const data = await this.build(period);
    const hash = sha256(canonical(data));
    return this.db.tx(async (c) => {
      const r = (await c.query(`INSERT INTO report_snapshot (period, version, as_of_date, data, sha256, reason, created_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
        RETURNING id, period, version, as_of_date, sha256, created_at`, [period, (latest?.version ?? 0) + 1, data.asOfDate, JSON.stringify(data), hash, reason ?? null, u?.id ?? null])).rows[0];
      await this.audit.record(c, u?.actor ?? SYSTEM, restate ? 'report.snapshot_restated' : 'report.snapshot_created', 'report_snapshot', r.id, null, { period, version: r.version, sha256: hash, reason });
      return r;
    });
  }

  listSnapshots() {
    return this.db.query(`SELECT s.id, s.period, s.version, s.as_of_date, s.sha256, s.reason, s.created_at,
      (SELECT json_agg(json_build_object('id', a.id, 'kind', a.kind, 'format', a.format, 'filename', a.filename, 'draft', a.draft, 'sha256', a.sha256) ORDER BY a.filename) FROM report_artifact a WHERE a.snapshot_id = s.id) AS artifacts
      FROM report_snapshot s ORDER BY s.period DESC, s.version DESC LIMIT 120`);
  }

  async getSnapshot(id: string) {
    const r = await this.db.one(`SELECT * FROM report_snapshot WHERE id = $1`, [id]);
    if (!r) throw notFound('Snapshot');
    return { ...r, verified: sha256(canonical(r.data)) === r.sha256 };
  }

  // ------------------------------------------------------------------ generation
  async generate(u: AuthUser | null, snapshotId: string, kind: 'cbk_return' | 'crb_file' | 'lender_pack', fundingSource?: string) {
    const snap = await this.getSnapshot(snapshotId);
    if (fundingSource && kind !== 'lender_pack') throw badRequest('FUNDING_SOURCE_NOT_APPLICABLE', 'Only a lender pack can be cut per funding source');
    if (!snap.verified) throw conflict('SNAPSHOT_TAMPERED', 'Snapshot hash does not verify');
    const t = await this.db.one(`SELECT * FROM report_template WHERE kind = $1 AND active`, [kind]);
    if (!t) throw conflict('NO_TEMPLATE', `No active ${kind} template`);
    const m: TemplateMeta = { kind, version: t.version, status: t.status, sourceRef: t.source_ref };
    const sm = { period: snap.period, version: snap.version, sha256: snap.sha256 };
    let data = snap.data;
    if (fundingSource) {
      await this.funding.source(fundingSource); // 404 if unknown
      // Phase 3 FUND-05: the tag as at month end decides which funder's pack a loan sits in (history, not today's tag)
      const tags = await this.funding.tagsAsOf(snap.data.asOfDate);
      data = funderView(snap.data, (l: any) => tags.get(l.advanceId) === fundingSource);
    }
    const draft = t.status !== 'official';
    const base = `mapema-${kind.replace('_', '-')}-${snap.period}-v${snap.version}`;
    const files: { format: 'csv' | 'pdf'; filename: string; content: Buffer }[] = [];
    let extra: Record<string, unknown> = {};
    if (kind === 'cbk_return') {
      const map = t.mapping as ReturnMapping;
      files.push({ format: 'csv', filename: `${base}.csv`, content: Buffer.from(renderReturnCsv(data, map, m, sm)) });
      const lines = renderReturnCsv(data, map, m, sm).trim().split('\n').slice(draft ? 3 : 2).map((l) => l.replace(/^"?([^,]*)"?,/, '$1 | ').replace(/,/g, ' | '));
      files.push({ format: 'pdf', filename: `${base}.pdf`, content: pdfDocument(`${draft ? 'DRAFT ' : ''}CBK monthly return ${snap.period}${draft ? ' - ASSUMED LAYOUT, NOT FOR SUBMISSION' : ''}`, [`Template ${t.version} (${t.status}) - ${t.source_ref}`, `Snapshot v${snap.version} sha256 ${snap.sha256}`, '', ...lines]) });
    } else if (kind === 'crb_file') {
      const map = t.mapping as FileMapping;
      const records = data.loans.filter((l: any) => l.crbIncluded);
      const exc = new Map<string, any>();
      for (const l of data.loans.filter((x: any) => !x.crbIncluded)) {
        const e = exc.get(l.supplierKraPin) ?? { borrower: l.supplierName, kraPin: l.supplierKraPin, facilities: 0, reason: 'no_crb_consent_on_file' };
        e.facilities++; exc.set(l.supplierKraPin, e);
      }
      files.push({ format: 'csv', filename: `${base}.csv`, content: Buffer.from(renderFileCsv(data, records, map, m, sm)) });
      extra = { records: records.length, exceptions: [...exc.values()] };
    } else {
      const map = t.mapping as PackMapping;
      const sumCsv = renderReturnCsv(data, { type: 'return', fields: map.summary }, m, sm);
      const fb = fundingSource ? `mapema-lender-pack-${fundingSource}-${snap.period}-v${snap.version}` : `mapema-lender-pack-${snap.period}-v${snap.version}`;
      files.push({ format: 'csv', filename: `${fb}-loan-tape.csv`, content: Buffer.from(renderTapeCsv(data, map, sm)) });
      files.push({ format: 'csv', filename: `${fb}-summary.csv`, content: Buffer.from(sumCsv) });
      files.push({ format: 'pdf', filename: `${fb}.pdf`, content: pdfDocument(`Mapema - Lender portfolio pack ${snap.period}${fundingSource ? ` - funding source ${fundingSource}` : ''}`, lenderPackLines(data, map, sm)) });
      if (fundingSource) extra = { fundingSource, loans: data.loans.length };
    }
    const artifacts = await this.db.tx(async (c) => {
      const out: any[] = [];
      for (const f of files) {
        const h = sha256(f.content);
        // S-09: encrypted at the application level; the hash stays over the plaintext (reproducibility)
        const sealed = this.artifactCrypto.seal(f.content, ArtifactCrypto.aad(snap.id, t.id, f.filename));
        await c.query(`INSERT INTO report_artifact (snapshot_id, kind, template_id, format, filename, draft, content, sha256, encrypted, plain_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9) ON CONFLICT (snapshot_id, template_id, filename) DO NOTHING`,
          [snap.id, kind, t.id, f.format, f.filename, draft, sealed, h, f.content.length]);
        const row = (await c.query(`SELECT id, kind, format, filename, draft, sha256, COALESCE(plain_bytes, octet_length(content)) AS bytes FROM report_artifact WHERE snapshot_id = $1 AND template_id = $2 AND filename = $3`, [snap.id, t.id, f.filename])).rows[0];
        if (row.sha256 !== h) throw conflict('NOT_REPRODUCIBLE', `${f.filename}: regenerated bytes differ from the stored artefact`);
        out.push(row);
      }
      await this.audit.record(c, u?.actor ?? SYSTEM, 'report.generated', 'report_snapshot', snap.id, null, { kind, template: t.version, draft, files: out.map((o) => ({ filename: o.filename, sha256: o.sha256 })) });
      return out;
    });
    return { snapshotId: snap.id, period: snap.period, kind, draft, template: { version: t.version, status: t.status, sourceRef: t.source_ref }, artifacts, ...extra };
  }

  async download(u: AuthUser, id: string) {
    const row = await this.db.one(`SELECT id, kind, format, filename, content, sha256, encrypted, snapshot_id, template_id FROM report_artifact WHERE id = $1`, [id]);
    if (!row) throw notFound('Artefact');
    let content: Buffer;
    try { content = this.artifactCrypto.open(row.content, ArtifactCrypto.aad(row.snapshot_id, row.template_id, row.filename), row.encrypted); } catch { throw conflict('ARTIFACT_INTEGRITY', 'Stored artefact cannot be decrypted (wrong key or tampered)'); }
    if (sha256(content) !== row.sha256) throw conflict('ARTIFACT_INTEGRITY', 'Stored artefact does not match its recorded hash');
    const a = { id: row.id, kind: row.kind, format: row.format, filename: row.filename, sha256: row.sha256, content };
    await this.db.tx((c) => this.audit.record(c, u.actor, 'report.downloaded', 'report_artifact', id, null, { filename: a.filename, sha256: a.sha256 }));
    return a;
  }

  templates() {
    return this.db.query(`SELECT id, kind, version, status, source_ref, mapping, active, approved_via, created_at FROM report_template ORDER BY kind, created_at`);
  }

  async proposeTemplate(u: AuthUser, b: { kind: string; version: string; status: 'assumed_draft' | 'official'; sourceRef: string; mapping: unknown }) {
    return this.db.tx(async (c) => {
      const t = (await c.query(`INSERT INTO report_template (kind, version, status, source_ref, mapping, active) VALUES ($1,$2,$3,$4,$5::jsonb,false) ON CONFLICT (kind, version) DO NOTHING RETURNING id`,
        [b.kind, b.version, b.status, b.sourceRef, JSON.stringify(b.mapping)])).rows[0];
      if (!t) throw conflict('DUPLICATE_VERSION', 'Template version already exists');
      return this.approvals.propose(c, u, { action: 'report_template_activate', entityType: 'report_template', entityId: t.id, payload: { kind: b.kind, version: b.version, status: b.status, sourceRef: b.sourceRef }, requiredRole: 'ceo', reason: `Activate ${b.kind} template ${b.version}` });
    });
  }

  /** Worker: on the 1st, snapshot the previous month and generate all three reports. */
  async monthEnd(today = this.clock.today()) {
    if (!today.endsWith('-01')) return null;
    const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(0);
    const period = d.toISOString().slice(0, 7);
    const snap = await this.snapshot(null, period);
    const out: Record<string, unknown> = { period, snapshotId: snap.id };
    for (const k of ['cbk_return', 'crb_file', 'lender_pack'] as const) out[k] = (await this.generate(null, snap.id, k)).artifacts.length;
    return out;
  }
}

function get2(o: any, k: string) { return o[k]; }

const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

@Controller('reports')
export class RegulatoryController {
  constructor(private readonly s: RegulatoryService) {}

  @Post('snapshots') @Roles('compliance', 'ceo')
  snapshot(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    const body = z.object({ period: Period, restate: z.boolean().optional(), reason: z.string().min(5).max(500).optional() }).parse(b);
    return this.s.snapshot(u, body.period, body.restate === true, body.reason);
  }

  @Get('snapshots') @Roles(...READERS)
  list() { return this.s.listSnapshots(); }

  @Get('snapshots/:id') @Roles(...READERS)
  get(@Param('id') id: string) { return this.s.getSnapshot(zUuid.parse(id)); }

  @Post('snapshots/:id/generate') @Roles('compliance', 'ceo')
  generate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ kind: z.enum(['cbk_return', 'crb_file', 'lender_pack']), fundingSource: z.string().regex(/^[A-Z0-9-]{2,24}$/).optional() }).parse(b);
    return this.s.generate(u, zUuid.parse(id), body.kind, body.fundingSource);
  }

  @Get('artifacts/:id/download') @Roles(...READERS)
  async download(@CurrentUser() u: AuthUser, @Param('id') id: string, @Res() res: any) {
    const a = await this.s.download(u, zUuid.parse(id));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Content-SHA256', a.sha256);
    res.type(a.format === 'pdf' ? 'application/pdf' : 'text/csv').attachment(a.filename).send(a.content);
  }

  @Get('templates') @Roles(...READERS)
  templates() { return this.s.templates(); }

  @Post('templates') @Roles('compliance')
  propose(@CurrentUser() u: AuthUser, @Body() b: unknown) {
    return this.s.proposeTemplate(u, z.object({ kind: z.enum(['cbk_return', 'crb_file', 'lender_pack']), version: z.string().min(1).max(40), status: z.enum(['assumed_draft', 'official']), sourceRef: zText(300), mapping: z.record(z.string(), z.unknown()) }).parse(b) as any);
  }
}
