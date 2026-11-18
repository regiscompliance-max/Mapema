/**
 * [Backend Engineer + Integration Engineer] ERP invoice import (Phase 3 ERP-01..08).
 *  - ops creates a connection for a buyer (kind, non-secret config, the NAME of an ERP_SECRET_* env var);
 *    the default field mapping for the kind is proposed at once and must be approved by an ops user who
 *    did not propose it (maker-checker on mapping changes; buyer admins may propose, never approve)
 *  - each connection has an integration user (no roles, cannot sign in) that is the invoice uploader of
 *    record, so the buyer's human checker always provides the second pair of eyes
 *  - a run pulls APPROVED supplier invoices changed since the cursor and pushes each through
 *    InvoicesService.insertOne: the same minimum, tenor, supplier link, duplicate hash and eTIMS checks
 *    as a manual upload. Invoices land as awaiting_confirmation; confirmation + ILU stay with the buyer.
 *  - idempotent: one erp_import_item per (connection, external id), ever. Same version -> nothing;
 *    error/skipped + newer version -> retried; created + newer version -> changed_after_import (flagged,
 *    never applied). The cursor only moves when a run completes.
 *  - errors: ERP_AUTH_FAILED (3 in a row pauses the connection), ERP_UNAVAILABLE (retry next run),
 *    ERP_BAD_RESPONSE, MAPPING_ERROR, CURRENCY_NOT_KES, plus the domain codes of the invoice checks.
 */
import { Body, Controller, Get, Inject, Injectable, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AdapterError, DEFAULT_ERP_MAPPINGS, ERP_KINDS, ErpKind, ErpMapping, ErpRawRecord, mapErpRecord, MockErp, validateErpMapping } from '@mapema/adapters';
import type { Adapters } from '@mapema/adapters';
import { Audit, SYSTEM } from '../common/audit';
import { ADAPTERS, AppConfig, CONFIG } from '../common/config';
import { Clock } from '../common/clock';
import { Db } from '../common/db';
import { badRequest, conflict, DomainError, forbidden, notFound } from '../common/errors';
import { zText, zUuid } from '../common/http';
import { Notifier } from '../common/notify';
import { AuthUser, CurrentUser, hasRole, isStaff, orgIds, Roles, STAFF_ROLES } from '../auth/auth';
import { ApprovalsService } from './approvals';
import { invoiceSchema, InvoicesService } from './invoices';

const PAGE = 100; const MAX_PAGES = 10; const PAUSE_AFTER_AUTH_FAILURES = 3;
const BUYER_ROLES = ['buyer_admin', 'buyer_maker', 'buyer_checker'] as const;
const zConfig = z.object({
  baseUrl: z.string().url().max(300).optional(), database: z.string().max(100).optional(), username: z.string().max(200).optional(),
  companyId: z.union([z.string().max(100), z.number().int()]).optional(),
}).strict();
export const zCreateConnection = z.object({
  buyerId: zUuid, kind: z.enum(ERP_KINDS as [ErpKind, ...ErpKind[]]), name: zText(120), config: zConfig.default({}),
  secretEnv: z.string().regex(/^ERP_SECRET_[A-Z0-9_]{1,60}$/, 'secretEnv must name an ERP_SECRET_* environment variable').optional(),
});
type ItemOut = { externalId: string; status: string; errorCode?: string; errorDetail?: string; invoiceId?: string };

@Injectable()
export class ErpService implements OnModuleInit {
  constructor(
    private readonly db: Db, private readonly audit: Audit, private readonly clock: Clock, private readonly notifier: Notifier,
    private readonly approvals: ApprovalsService, private readonly invoices: InvoicesService,
    @Inject(ADAPTERS) private readonly adapters: Adapters, @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit() {
    this.approvals.register('erp_mapping_change', async (c, a) => {
      const m = (await c.query(`SELECT * FROM erp_field_mapping WHERE id = $1 FOR UPDATE`, [a.entity_id])).rows[0];
      if (!m || m.status !== 'pending') throw conflict('BAD_STATE', 'Mapping is not pending');
      await c.query(`UPDATE erp_field_mapping SET status = 'superseded' WHERE connection_id = $1 AND status = 'active'`, [m.connection_id]);
      await c.query(`UPDATE erp_field_mapping SET status = 'active', approved_via = $2 WHERE id = $1`, [m.id, a.id]);
      await c.query(`UPDATE erp_connection SET status = CASE WHEN status = 'pending_mapping' THEN 'active' ELSE status END, updated_at = now() WHERE id = $1`, [m.connection_id]);
      await this.audit.record(c, SYSTEM, 'erp.mapping_activated', 'erp_connection', m.connection_id, null, { version: m.version, approvalId: a.id });
    });
  }

  private assertAccess(u: AuthUser, buyerId: string, write = false) {
    if (isStaff(u) || hasRole(u, 'auditor')) { if (write && !hasRole(u, 'ops')) throw forbidden('ROLE_REQUIRED', 'Only operations can do this'); return; }
    if (!orgIds(u, write ? ['buyer_admin'] : [...BUYER_ROLES]).includes(buyerId)) throw notFound('ERP connection');
  }
  private async conn(id: string) {
    const c = await this.db.one(`SELECT * FROM erp_connection WHERE id = $1`, [id]);
    if (!c) throw notFound('ERP connection');
    return c;
  }

  async create(u: AuthUser, b: z.infer<typeof zCreateConnection>) {
    if (b.kind !== 'csv_sftp' && this.adapters.erp.mode !== 'mock') {
      if (!b.secretEnv) throw badRequest('SECRET_ENV_REQUIRED', 'Name the ERP_SECRET_* variable that holds the API key');
      if (!b.config.baseUrl) throw badRequest('BASE_URL_REQUIRED', 'baseUrl is required');
    }
    return this.db.tx(async (c) => {
      const buyer = (await c.query(`SELECT id, type FROM organisation WHERE id = $1`, [b.buyerId])).rows[0];
      if (!buyer || buyer.type !== 'buyer') throw notFound('Buyer');
      const id = (await c.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
      const iu = (await c.query(`INSERT INTO user_account (idp_subject, email, display_name, mfa_enabled, active) VALUES ($1,$2,$3,false,false) RETURNING id`,
        [`erp-integration:${id}`, `erp-${id}@integration.mapema.invalid`, `ERP import (${b.name})`])).rows[0];
      await c.query(`INSERT INTO erp_connection (id, buyer_id, kind, name, config, secret_env, integration_user_id, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
        [id, b.buyerId, b.kind, b.name, JSON.stringify(b.config), b.secretEnv ?? null, iu.id, u.id]);
      await this.audit.record(c, u.actor, 'erp.connection_create', 'erp_connection', id, null, { buyerId: b.buyerId, kind: b.kind, name: b.name, config: b.config, secretEnv: b.secretEnv ?? null });
      const ap = await this.proposeMappingTx(c, u, id, DEFAULT_ERP_MAPPINGS[b.kind], `Default ${b.kind} field mapping`);
      return { id, status: 'pending_mapping', kind: b.kind, name: b.name, mapping: { version: ap.version, status: 'pending', approvalId: ap.id } };
    });
  }

  private async proposeMappingTx(c: any, u: AuthUser, connectionId: string, mapping: ErpMapping, reason: string) {
    const bad = validateErpMapping(mapping);
    if (bad.length) throw badRequest('INVALID_MAPPING', `Invalid mapping: ${bad.join('; ')}`, { problems: bad });
    const v = (await c.query(`SELECT COALESCE(MAX(version),0)+1 AS v FROM erp_field_mapping WHERE connection_id = $1`, [connectionId])).rows[0].v;
    const m = (await c.query(`INSERT INTO erp_field_mapping (connection_id, version, definition, proposed_by) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`, [connectionId, v, JSON.stringify(mapping), u.id])).rows[0];
    const ap = await this.approvals.propose(c, u, { action: 'erp_mapping_change', entityType: 'erp_field_mapping', entityId: m.id, payload: { connectionId, version: v, mapping }, requiredRole: 'ops', reason });
    return { ...ap, version: v };
  }

  async proposeMapping(u: AuthUser, id: string, mapping: ErpMapping, reason: string) {
    const conn = await this.conn(id);
    if (!hasRole(u, 'ops') && !orgIds(u, ['buyer_admin']).includes(conn.buyer_id)) throw notFound('ERP connection');
    const bad = validateErpMapping(mapping);
    if (bad.length) throw badRequest('INVALID_MAPPING', `Invalid mapping: ${bad.join('; ')}`, { problems: bad });
    return this.db.tx(async (c) => {
      const pending = (await c.query(`SELECT id FROM erp_field_mapping WHERE connection_id = $1 AND status = 'pending'`, [id])).rows[0];
      if (pending) throw conflict('APPROVAL_PENDING', 'A mapping change is already waiting for approval');
      const ap = await this.proposeMappingTx(c, u, id, mapping, reason);
      return { id: ap.id, status: ap.status, version: ap.version };
    });
  }

  async list(u: AuthUser) {
    const all = isStaff(u) || hasRole(u, 'auditor');
    const ids = orgIds(u, [...BUYER_ROLES]);
    return this.db.query(`SELECT c.id, c.buyer_id, o.legal_name AS buyer_name, c.kind, c.name, c.status, c.secret_env, c.last_run_at, c.last_error, c.auth_failures,
        (SELECT version FROM erp_field_mapping m WHERE m.connection_id = c.id AND m.status = 'active') AS mapping_version,
        (SELECT json_build_object('status', r.status, 'created', r.created, 'errors', r.errors, 'finished_at', r.finished_at, 'error_code', r.error_code) FROM erp_import_run r WHERE r.connection_id = c.id ORDER BY r.started_at DESC LIMIT 1) AS last_run,
        (SELECT count(*)::int FROM erp_import_item i WHERE i.connection_id = c.id AND i.status IN ('error','changed_after_import')) AS open_items
      FROM erp_connection c JOIN organisation o ON o.id = c.buyer_id WHERE $1 OR c.buyer_id = ANY($2) ORDER BY c.created_at`, [all, ids]);
  }

  async get(u: AuthUser, id: string) {
    const c = await this.conn(id);
    this.assertAccess(u, c.buyer_id);
    const m = await this.db.one(`SELECT version, status, definition, approved_via, created_at FROM erp_field_mapping WHERE connection_id = $1 AND status = 'active'`, [id])
      ?? await this.db.one(`SELECT version, status, definition, approved_via, created_at FROM erp_field_mapping WHERE connection_id = $1 ORDER BY version DESC LIMIT 1`, [id]);
    const runs = await this.db.query(`SELECT id, trigger, status, error_code, fetched, created, duplicates, errors, skipped, changed, files, started_at, finished_at FROM erp_import_run WHERE connection_id = $1 ORDER BY started_at DESC LIMIT 20`, [id]);
    const pending = await this.db.one(`SELECT version, definition, created_at FROM erp_field_mapping WHERE connection_id = $1 AND status = 'pending'`, [id]);
    return { id: c.id, buyerId: c.buyer_id, kind: c.kind, name: c.name, status: c.status, config: c.config, secretEnv: c.secret_env, authFailures: c.auth_failures, lastRunAt: c.last_run_at,
      lastError: c.last_error, cursor: c.cursor, mapping: m, pendingMapping: pending, runs };
  }

  items(u: AuthUser, id: string, status?: string) {
    return this.conn(id).then((c) => {
      this.assertAccess(u, c.buyer_id);
      return this.db.query(`SELECT e.external_id, e.external_version, e.status, e.error_code, e.error_detail, e.invoice_id, e.mapping_version, e.updated_at, i.invoice_number, i.status AS invoice_status
        FROM erp_import_item e LEFT JOIN invoice i ON i.id = e.invoice_id WHERE e.connection_id = $1 AND ($2::text IS NULL OR e.status = $2) ORDER BY e.updated_at DESC LIMIT 500`, [id, status ?? null]);
    });
  }

  async resume(u: AuthUser, id: string, reason: string) {
    return this.db.tx(async (c) => {
      const r = (await c.query(`UPDATE erp_connection SET status = 'active', auth_failures = 0, last_error = NULL, updated_at = now() WHERE id = $1 AND status = 'paused' RETURNING id`, [id])).rows[0];
      if (!r) throw conflict('BAD_STATE', 'Only a paused connection can be resumed');
      await this.audit.record(c, u.actor, 'erp.connection_resumed', 'erp_connection', id, { status: 'paused' }, { status: 'active', reason });
      return { id, status: 'active' };
    });
  }

  // ------------------------------------------------------------------ the import run
  async runNow(u: AuthUser, id: string) {
    const c = await this.conn(id);
    if (!hasRole(u, 'ops')) { if (!orgIds(u, ['buyer_admin']).includes(c.buyer_id)) throw notFound('ERP connection'); }
    return this.run(id, 'manual', u);
  }

  async runDue() {
    const due = await this.db.query(`SELECT id FROM erp_connection WHERE status = 'active' AND (last_run_at IS NULL OR last_run_at < $1) ORDER BY last_run_at NULLS FIRST LIMIT 50`, [new Date(this.clock.now().getTime() - 14 * 60_000)]);
    const out = [];
    for (const d of due) { try { out.push(await this.run(d.id, 'schedule')); } catch (e) { out.push({ id: d.id, error: (e as Error).message }); } }
    return out;
  }

  async run(id: string, trigger: 'schedule' | 'manual', u?: AuthUser) {
    const conn = (await this.db.tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('mapema.erp.' || $1))`, [id]);
      return (await c.query(`SELECT * FROM erp_connection WHERE id = $1`, [id])).rows[0];
    }));
    if (!conn) throw notFound('ERP connection');
    if (conn.status !== 'active') throw conflict('CONNECTION_NOT_ACTIVE', `Connection is ${conn.status}`);
    const mapping = await this.db.one(`SELECT version, definition FROM erp_field_mapping WHERE connection_id = $1 AND status = 'active'`, [id]);
    if (!mapping) throw conflict('NO_ACTIVE_MAPPING', 'The field mapping is not approved yet');
    const actorUser: AuthUser = { id: conn.integration_user_id, email: '', displayName: 'ERP import', roles: [], amr: [], authTime: 0,
      actor: { userId: conn.integration_user_id, role: 'erp_integration', requestId: `erp-${id}-${Date.now()}` } };
    const counts = { fetched: 0, created: 0, duplicates: 0, errors: 0, skipped: 0, changed: 0 };
    const items: ItemOut[] = [];
    let cursor: string | null = conn.cursor; let files: unknown[] | undefined; let errorCode: string | null = null; let errorMsg: string | null = null;
    const runRow = await this.db.one(`INSERT INTO erp_import_run (connection_id, trigger, status, cursor_before) VALUES ($1,$2,'running',$3) RETURNING id`, [id, trigger, conn.cursor]);
    try {
      const secret = conn.secret_env ? this.cfg.raw[conn.secret_env] : undefined;
      const connector = this.adapters.erp.connector({ id, kind: conn.kind, config: conn.config }, secret);
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await connector.fetchApproved({ requestId: actorUser.actor.requestId! }, cursor, PAGE);
        if (res.files) files = [...(files ?? []), ...res.files];
        counts.fetched += res.records.length;
        for (const rec of res.records) {
          const it = await this.processRecord(conn, mapping, actorUser, rec, runRow.id);
          if (!it) { counts.duplicates++; continue; }
          items.push(it);
          if (it.status === 'created') counts.created++;
          else if (it.status === 'error') counts.errors++;
          else if (it.status === 'skipped') counts.skipped++;
          else if (it.status === 'changed_after_import') counts.changed++;
        }
        if (connector.ack) await connector.ack(res);
        const moved = res.nextCursor !== cursor;
        cursor = res.nextCursor;
        if (res.records.length < PAGE || !moved) break;
      }
    } catch (e) {
      errorCode = e instanceof AdapterError ? (e.message.includes('ERP_SECRET_MISSING') ? 'ERP_SECRET_MISSING' : e.code) : 'ERP_INTERNAL';
      errorMsg = (e as Error).message.slice(0, 300);
    }
    const status = errorCode ? 'failed' : 'completed';
    const run = await this.db.tx(async (c) => {
      const r = (await c.query(`UPDATE erp_import_run SET status = $2, error_code = $3, fetched = $4, created = $5, duplicates = $6, errors = $7, skipped = $8, changed = $9, cursor_after = $10, files = $11::jsonb, finished_at = now()
        WHERE id = $1 RETURNING id`, [runRow.id, status, errorCode, counts.fetched, counts.created, counts.duplicates, counts.errors, counts.skipped, counts.changed, errorCode ? conn.cursor : cursor, files ? JSON.stringify(files) : null])).rows[0];
      if (errorCode) {
        const authFail = errorCode === 'ERP_AUTH_FAILED';
        const upd = (await c.query(`UPDATE erp_connection SET last_run_at = $2, last_error = $3, auth_failures = CASE WHEN $4 THEN auth_failures + 1 ELSE auth_failures END,
          status = CASE WHEN $4 AND auth_failures + 1 >= $5 THEN 'paused' ELSE status END, updated_at = now() WHERE id = $1 RETURNING status`,
          [id, this.clock.now(), `${errorCode}: ${errorMsg}`, authFail, PAUSE_AFTER_AUTH_FAILURES])).rows[0];
        if (upd.status === 'paused' && conn.status !== 'paused') {
          await this.audit.record(c, SYSTEM, 'erp.connection_paused', 'erp_connection', id, { status: conn.status }, { status: 'paused', reason: errorCode });
          await this.notifier.toRole(c, 'ops', 'erp.paused', { name: conn.name }, { type: 'erp_connection', id });
        }
      } else {
        await c.query(`UPDATE erp_connection SET cursor = $2, last_run_at = $3, last_error = NULL, auth_failures = 0, updated_at = now() WHERE id = $1`, [id, cursor, this.clock.now()]);
      }
      await this.audit.record(c, u?.actor ?? SYSTEM, 'erp.import_run', 'erp_connection', id, null, { runId: r.id, trigger, status, errorCode, ...counts });
      return r;
    });
    return { runId: run.id, connectionId: id, status, errorCode, ...counts, items, files };
  }

  /** One ERP record -> one item row. Returns null when nothing changed since the last run. */
  private async processRecord(conn: any, mapping: { version: number; definition: ErpMapping }, u: AuthUser, rec: ErpRawRecord, runId: string): Promise<ItemOut | null> {
    const prior = await this.db.one(`SELECT * FROM erp_import_item WHERE connection_id = $1 AND external_id = $2`, [conn.id, rec.externalId]);
    if (prior && prior.external_version === rec.version) return null;
    const save = async (c: any, status: string, o: { errorCode?: string; errorDetail?: string; invoiceId?: string | null } = {}) => {
      await c.query(`INSERT INTO erp_import_item (connection_id, external_id, external_version, status, error_code, error_detail, invoice_id, mapping_version, last_run_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (connection_id, external_id) DO UPDATE SET external_version = EXCLUDED.external_version, status = EXCLUDED.status, error_code = EXCLUDED.error_code,
          error_detail = EXCLUDED.error_detail, invoice_id = COALESCE(EXCLUDED.invoice_id, erp_import_item.invoice_id), mapping_version = EXCLUDED.mapping_version, last_run_id = EXCLUDED.last_run_id, updated_at = now()`,
        [conn.id, rec.externalId, rec.version, status, o.errorCode ?? null, o.errorDetail ?? null, o.invoiceId ?? null, mapping.version, runId]);
      return { externalId: rec.externalId, status, errorCode: o.errorCode, errorDetail: o.errorDetail, invoiceId: o.invoiceId ?? prior?.invoice_id ?? undefined } as ItemOut;
    };
    if (prior && ['created', 'changed_after_import'].includes(prior.status)) {
      return this.db.tx(async (c) => {
        const inv = (await c.query(`SELECT invoice_number FROM invoice WHERE id = $1`, [prior.invoice_id])).rows[0];
        await this.audit.record(c, u.actor, 'erp.record_changed_after_import', 'invoice', prior.invoice_id, { version: prior.external_version }, { version: rec.version, externalId: rec.externalId });
        await this.notifier.toRole(c, 'ops', 'erp.record_changed', { invoice: inv?.invoice_number ?? rec.externalId, name: conn.name }, { type: 'invoice', id: prior.invoice_id });
        await this.notifier.toOrg(c, conn.buyer_id, 'erp.record_changed', { invoice: inv?.invoice_number ?? rec.externalId, name: conn.name }, { type: 'invoice', id: prior.invoice_id });
        return save(c, 'changed_after_import', { invoiceId: prior.invoice_id });
      });
    }
    const m = mapErpRecord(rec, mapping.definition);
    if (!m.ok) return this.db.tx((c) => (m.skip ? save(c, 'skipped', { errorDetail: m.skip }) : save(c, 'error', { errorCode: 'MAPPING_ERROR', errorDetail: m.errors.join('; ') })));
    if (m.invoice.currency !== 'KES') return this.db.tx((c) => save(c, 'error', { errorCode: 'CURRENCY_NOT_KES', errorDetail: `currency ${m.invoice.currency}` }));
    const parsed = invoiceSchema.safeParse({ ...m.invoice, amountCents: m.invoice.amountCents.toString() });
    if (!parsed.success) return this.db.tx((c) => save(c, 'error', { errorCode: 'VALIDATION', errorDetail: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ').slice(0, 500) }));
    try {
      return await this.db.tx(async (c) => {
        const inv = await this.invoices.insertOne(c, u, conn.buyer_id, null, parsed.data, 'erp');
        await this.audit.record(c, u.actor, 'erp.invoice_imported', 'invoice', inv.id, null, { connectionId: conn.id, externalId: rec.externalId, version: rec.version, mappingVersion: mapping.version });
        return save(c, 'created', { invoiceId: inv.id });
      });
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      return this.db.tx((c) => save(c, 'error', { errorCode: e.code, errorDetail: e.message.slice(0, 500) }));
    }
  }

  /** dev/mock: push fixture records for a mock-mode connection (seed demo) */
  devPush(id: string, records: ErpRawRecord[]) {
    if (this.adapters.erp.mode !== 'mock') throw badRequest('NOT_MOCK', 'ERP adapter is not in mock mode');
    for (const r of records) MockErp.push(id, r);
    return { pushed: records.length };
  }
}

@Controller('erp')
export class ErpController {
  constructor(private readonly s: ErpService) {}

  @Get('connections') @Roles(...STAFF_ROLES, 'auditor', 'buyer_admin', 'buyer_maker', 'buyer_checker')
  list(@CurrentUser() u: AuthUser) { return this.s.list(u); }

  @Post('connections') @Roles('ops')
  create(@CurrentUser() u: AuthUser, @Body() b: unknown) { return this.s.create(u, zCreateConnection.parse(b)); }

  @Get('connections/:id') @Roles(...STAFF_ROLES, 'auditor', 'buyer_admin', 'buyer_maker', 'buyer_checker')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.s.get(u, zUuid.parse(id)); }

  @Get('connections/:id/items') @Roles(...STAFF_ROLES, 'auditor', 'buyer_admin', 'buyer_maker', 'buyer_checker')
  items(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('status') status?: string) {
    return this.s.items(u, zUuid.parse(id), z.enum(['created', 'error', 'skipped', 'changed_after_import']).optional().parse(status));
  }

  @Post('connections/:id/mapping') @Roles('ops', 'buyer_admin')
  mapping(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    const body = z.object({ mapping: z.record(z.string(), z.unknown()), reason: zText(500) }).parse(b);
    return this.s.proposeMapping(u, zUuid.parse(id), body.mapping as unknown as ErpMapping, body.reason);
  }

  @Post('connections/:id/run') @Roles('ops', 'buyer_admin')
  run(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.s.runNow(u, zUuid.parse(id)); }

  @Post('connections/:id/resume') @Roles('ops')
  resume(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: unknown) {
    return this.s.resume(u, zUuid.parse(id), z.object({ reason: zText(500) }).parse(b ?? {}).reason);
  }
}
