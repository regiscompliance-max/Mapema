/**
 * [Integration Engineer + Backend Engineer] Phase 2 integrations (ACC-01/02, CRM-01/02).
 *  - accounting: one balanced DRAFT manual journal per business day = Fineract trial-balance movement
 *    since the last push, GL keys mapped to accounting codes (ACCOUNTING_GL_MAP, default = Mapema's
 *    Fineract GL codes - accountant to confirm, Q-E). Idempotency key mapema-je-YYYY-MM-DD.
 *    The first run captures the opening TB only (opening balances are keyed by the accountant).
 *  - fee invoices: hook fires at settlement (fee_invoice_hook) but stays DISABLED (D-24).
 *  - CRM: buyer "book a call" requests from the site's D1 database -> CRM contact + deal, once per
 *    request; suppliers skipped (not the buyer pipeline); erasure/objection requests respected.
 */
import { Controller, Get, Inject, Injectable, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { GL_ACCOUNTS, type Adapters, type JournalLine, type LedgerGl } from '@mapema/adapters';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS, AppConfig, CONFIG } from '../common/config';
import { Clock } from '../common/clock';
import { Db } from '../common/db';
import { Notifier } from '../common/notify';
import { Roles } from '../auth/auth';

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly clock: Clock,
    private readonly notifier: Notifier,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private glMap(): Record<string, string> {
    const def = Object.fromEntries(Object.entries(GL_ACCOUNTS).map(([k, v]) => [k, v.glCode]));
    try { return { ...def, ...(this.cfg.raw.ACCOUNTING_GL_MAP ? JSON.parse(this.cfg.raw.ACCOUNTING_GL_MAP) : {}) }; } catch { return def; }
  }

  // ------------------------------------------------------------------ accounting
  async pushDailyJournal(date = this.clock.today()) {
    const key = `mapema-je-${date}`;
    const done = await this.db.one(`SELECT status, provider_ref FROM accounting_push WHERE business_date = $1`, [date]);
    if (done) return { date, status: done.status, duplicate: true, providerRef: done.provider_ref };
    const tb = await this.adapters.ledger.trialBalance();
    const prev = await this.db.one(`SELECT trial_balance FROM accounting_push WHERE business_date < $1 AND status IN ('opening_captured','pushed','nothing_to_push') ORDER BY business_date DESC LIMIT 1`, [date]);
    const provider = this.adapters.accounting.provider;
    if (!prev) {
      await this.db.tx(async (c) => {
        await c.query(`INSERT INTO accounting_push (business_date, idempotency_key, status, trial_balance, provider) VALUES ($1,$2,'opening_captured',$3::jsonb,$4)`, [date, key, ser(tb), provider]);
        await this.audit.record(c, SYSTEM, 'accounting.opening_captured', 'accounting_push', null, null, { date, tb });
      });
      return { date, status: 'opening_captured', duplicate: false };
    }
    const map = this.glMap();
    const lines: JournalLine[] = [];
    for (const [gl, bal] of Object.entries(tb) as [LedgerGl, bigint][]) {
      const delta = bal - BigInt(prev.trial_balance[gl] ?? 0);
      if (delta === 0n) continue;
      const code = map[gl];
      lines.push({ accountCode: code, debitCents: delta > 0n ? delta : 0n, creditCents: delta < 0n ? -delta : 0n, description: `${gl} - ${(GL_ACCOUNTS as any)[gl]?.name ?? gl}` });
    }
    const journal = { date, idempotencyKey: key, narration: `Mapema daily journal ${date} (Fineract trial balance movement)`, lines };
    if (lines.length === 0) {
      await this.db.query(`INSERT INTO accounting_push (business_date, idempotency_key, status, trial_balance, provider) VALUES ($1,$2,'nothing_to_push',$3::jsonb,$4)`, [date, key, ser(tb), provider]);
      return { date, status: 'nothing_to_push', duplicate: false };
    }
    try {
      const r = await this.adapters.accounting.pushJournal({ requestId: key, idempotencyKey: key }, journal);
      await this.db.tx(async (c) => {
        await c.query(`INSERT INTO accounting_push (business_date, idempotency_key, status, trial_balance, journal, provider, provider_ref) VALUES ($1,$2,'pushed',$3::jsonb,$4::jsonb,$5,$6)`, [date, key, ser(tb), ser(journal), provider, r.providerRef]);
        await this.audit.record(c, SYSTEM, 'accounting.journal_pushed', 'accounting_push', null, null, { date, providerRef: r.providerRef, lines: lines.length });
      });
      return { date, status: 'pushed', duplicate: r.duplicate, providerRef: r.providerRef, lines: lines.length };
    } catch (e) {
      const reason = (e as Error).message.slice(0, 300);
      await this.db.tx(async (c) => {
        await this.audit.record(c, SYSTEM, 'accounting.push_failed', 'accounting_push', null, null, { date, reason });
        await this.notifier.toRole(c, 'ops', 'accounting.push_failed', { date, reason });
      });
      return { date, status: 'error', error: reason };
    }
  }

  // ------------------------------------------------------------------ CRM
  async importLeads() {
    const cur = await this.db.one(`SELECT source_created_at, source_id FROM crm_sync WHERE source = 'site_d1' ORDER BY source_created_at DESC, source_id DESC LIMIT 1`);
    const rows = await this.adapters.leads.listSince(cur ? { createdAt: cur.source_created_at, id: cur.source_id } : null);
    const erased = new Set(await this.adapters.leads.erasureRequests());
    let imported = 0; let skipped = 0; let errors = 0;
    for (const r of rows) {
      const email = r.email.trim().toLowerCase();
      let status = 'synced'; let reason: string | null = null; let res: { contactId: string; dealId: string } | null = null;
      if (r.role !== 'buyer') { status = 'skipped'; reason = 'not_buyer'; }
      else if (!r.privacy_notice_version) { status = 'skipped'; reason = 'no_privacy_acceptance'; }
      else if (erased.has(email)) { status = 'skipped'; reason = 'erasure_requested'; }
      else {
        try {
          res = await this.adapters.crm.upsertLead({ requestId: `crm-${r.id}` }, { sourceId: r.id, name: r.contact_name, company: r.company, email, phone: r.phone, basis: 'request_to_be_contacted', lang: r.lang });
        } catch (e) { status = 'error'; reason = (e as Error).message.slice(0, 200); }
      }
      await this.db.tx(async (c) => {
        await c.query(`INSERT INTO crm_sync (source_id, source_created_at, status, reason, crm_contact_id, crm_deal_id, lawful_basis) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source, source_id) DO NOTHING`,
          [r.id, r.created_at, status, reason, res?.contactId ?? null, res?.dealId ?? null, status === 'synced' ? 'request_to_be_contacted' : null]);
        await this.audit.record(c, SYSTEM, `crm.lead_${status}`, 'crm_sync', null, null, { sourceId: r.id, reason }); // no PII in the audit log
      });
      if (status === 'synced') imported++; else if (status === 'skipped') skipped++; else errors++;
    }
    // CRM-02: a lead synced earlier whose person later asked for erasure is flagged for manual deletion in the CRM
    const flagged = await this.db.query(`SELECT id, source_id FROM crm_sync WHERE status = 'synced'`);
    let erasurePending = 0;
    if (erased.size && flagged.length) {
      const all = await this.adapters.leads.listSince(null);
      for (const f of flagged) {
        const src = all.find((x) => x.id === f.source_id);
        if (src && erased.has(src.email.toLowerCase())) { await this.db.query(`UPDATE crm_sync SET status = 'erasure_pending', reason = 'erasure_requested_after_sync' WHERE id = $1`, [f.id]); erasurePending++; }
      }
    }
    return { fetched: rows.length, imported, skipped, errors, erasurePending };
  }

  async status() {
    const fee = (await this.db.one(`SELECT value FROM platform_setting WHERE key = 'fee_invoices_enabled'`))?.value === true;
    const last = await this.db.one(`SELECT business_date, status, provider_ref FROM accounting_push ORDER BY business_date DESC LIMIT 1`);
    const crm = await this.db.one(`SELECT count(*) FILTER (WHERE status = 'synced')::int AS synced, count(*) FILTER (WHERE status = 'skipped')::int AS skipped, count(*) FILTER (WHERE status = 'erasure_pending')::int AS erasure_pending FROM crm_sync`);
    return {
      accounting: { provider: this.adapters.accounting.provider, mode: this.adapters.accounting.mode, lastPush: last ?? null,
        feeInvoices: fee ? 'enabled' : 'disabled - blocked on tax advice (D-24); hook records each settlement in fee_invoice_hook' },
      crm: { provider: this.adapters.crm.provider, mode: this.adapters.crm.mode, ...crm },
      siteLeads: { mode: this.adapters.leads.mode },
    };
  }
}

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly s: IntegrationsService) {}

  @Post('accounting/push') @Roles('ops')
  push(@Query('date') date?: string) { return this.s.pushDailyJournal(date ? ISO.parse(date) : undefined); }

  @Post('crm/import') @Roles('ops', 'admin')
  crm() { return this.s.importLeads(); }

  @Get('status') @Roles('admin', 'ceo', 'ops', 'compliance')
  status() { return this.s.status(); }
}
