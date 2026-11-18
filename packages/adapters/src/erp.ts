/**
 * [Integration Engineer] ERP connectors (Phase 3 ERP-01..04). One interface, five connectors:
 *   odoo      - JSON-RPC (/jsonrpc, common.authenticate + object.execute_kw on account.move). Complete.
 *   csv_sftp  - a drop folder (<ERP_DROP_ROOT>/<connectionId>/incoming) that an SFTP server writes to. Complete.
 *   sap       - S/4HANA OData API_SUPPLIERINVOICE_PROCESS_SRV          } request/response shapes from the public
 *   sage      - Sage Business Cloud Accounting v3.1 purchase_invoices  } API docs, unit-tested with an injected
 *   dynamics  - Dynamics 365 Business Central v2.0 purchaseInvoices     } fetch only. Field names marked ASSUMED.
 * Modes: mock = in-memory fixtures per connection; sandbox = the real protocol against a buyer's test
 * tenant / drop folder; live = production only. Connectors only READ approved supplier invoices; they
 * never write back to the ERP (not in scope). Secrets come from an env var named on the connection.
 *
 * Every connector returns raw records { externalId, version, data }. A per-buyer FIELD MAPPING (pure,
 * maker-checker approved) turns data into a Mapema invoice; the API then runs the same checks as a
 * manual upload (duplicate hash, eTIMS, buyer confirmation + ILU).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { join } from 'node:path';
import { Cents } from '@mapema/pricing';
import { AdapterContext, AdapterError, AdapterMode, HealthCheck } from './common';

export type ErpKind = 'odoo' | 'csv_sftp' | 'sap' | 'sage' | 'dynamics';
export const ERP_KINDS: ErpKind[] = ['odoo', 'csv_sftp', 'sap', 'sage', 'dynamics'];
export interface ErpRawRecord { externalId: string; version: string; data: Record<string, unknown> }
export interface ErpFileResult { name: string; sha256: string; status: 'read' | 'duplicate_file' | 'bad_header' | 'too_many_rows' | 'too_large'; rows?: number }
export interface ErpFetchResult { records: ErpRawRecord[]; nextCursor: string | null; files?: ErpFileResult[] }
export interface ErpConnector {
  readonly kind: ErpKind;
  readonly mode: AdapterMode;
  /** approved supplier invoices changed after the cursor, oldest first */
  fetchApproved(ctx: AdapterContext, cursor: string | null, limit: number): Promise<ErpFetchResult>;
  /** called after the platform has stored the results (CSV: archive the files) */
  ack?(result: ErpFetchResult): Promise<void>;
  health(): Promise<HealthCheck>;
}

const err = (code: 'ERP_AUTH_FAILED' | 'ERP_UNAVAILABLE' | 'ERP_BAD_RESPONSE' | 'ERP_CONFIG', msg: string, status?: number) =>
  new AdapterError('erp', code, msg, code === 'ERP_UNAVAILABLE', status);

async function httpJson(f: typeof fetch, url: string, init: RequestInit, timeoutMs = 20_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try { res = await f(url, { ...init, signal: ctrl.signal }); } catch (e) { throw err('ERP_UNAVAILABLE', `network: ${(e as Error).message}`); } finally { clearTimeout(t); }
  if (res.status === 401 || res.status === 403) throw err('ERP_AUTH_FAILED', `HTTP ${res.status}`, res.status);
  if (res.status === 429 || res.status >= 500) throw err('ERP_UNAVAILABLE', `HTTP ${res.status}`, res.status);
  if (!res.ok) throw err('ERP_BAD_RESPONSE', `HTTP ${res.status}`, res.status);
  try { return await res.json(); } catch { throw err('ERP_BAD_RESPONSE', 'response is not JSON'); }
}

// ===================================================================== field mapping (pure)
export type ErpTransform = 'trim' | 'upper' | 'lower' | 'date' | 'decimal_to_cents' | 'cents';
const TRANSFORMS: ErpTransform[] = ['trim', 'upper', 'lower', 'date', 'decimal_to_cents', 'cents'];
export type ErpFieldRule = { path: string; transform?: ErpTransform[]; default?: string } | { const: string };
export const ERP_TARGETS = ['supplierKraPin', 'invoiceNumber', 'amountCents', 'currency', 'issueDate', 'dueDate', 'etimsCuInvoiceNo', 'poReference'] as const;
export type ErpTarget = typeof ERP_TARGETS[number];
const REQUIRED: ErpTarget[] = ['supplierKraPin', 'invoiceNumber', 'amountCents', 'currency', 'issueDate', 'dueDate'];
export interface ErpMapping {
  fields: Partial<Record<ErpTarget, ErpFieldRule>>;
  /** only records whose value at path (trimmed, case-insensitive) is in equals are imported; others are skipped */
  approval?: { path: string; equals: string[] };
}
export interface MappedInvoice { supplierKraPin: string; invoiceNumber: string; amountCents: Cents; currency: string; issueDate: string; dueDate: string; etimsCuInvoiceNo?: string; poReference?: string }
export type MapResult = { ok: true; invoice: MappedInvoice } | { ok: false; skip?: 'not_approved'; errors: string[] };

const getPath = (o: unknown, path: string): unknown => path.split('.').reduce<any>((v, k) => (v === null || v === undefined ? undefined : v[k]), o);
const empty = (v: unknown) => v === undefined || v === null || v === false || (typeof v === 'string' && v.trim() === '');

/** exact decimal -> cents; thousands separators allowed in strings; more than 2 decimals or float noise is an error */
export function strictDecimalToCents(v: unknown): Cents | null {
  let s: string;
  if (typeof v === 'number') { if (!Number.isFinite(v)) return null; s = String(v); }
  else if (typeof v === 'string') s = v.trim();
  else return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '0').padEnd(2, '0'));
}
export function toIsoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const sap = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(s);
  if (sap) return new Date(Number(sap[1])).toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1] ? null : m[1];
}

export function mapErpRecord(rec: ErpRawRecord, mapping: ErpMapping): MapResult {
  if (mapping.approval) {
    const v = getPath(rec.data, mapping.approval.path);
    const norm = typeof v === 'string' ? v.trim().toLowerCase() : String(v).toLowerCase();
    if (!mapping.approval.equals.map((x) => x.toLowerCase()).includes(norm)) return { ok: false, skip: 'not_approved', errors: [] };
  }
  const errors: string[] = [];
  const out: Record<string, unknown> = {};
  for (const t of ERP_TARGETS) {
    const rule = mapping.fields[t];
    if (!rule) { if (REQUIRED.includes(t)) errors.push(`${t}:missing`); continue; }
    let v: unknown = 'const' in rule ? rule.const : getPath(rec.data, rule.path);
    if (empty(v) && !('const' in rule) && rule.default !== undefined) v = rule.default;
    if (empty(v)) { if (REQUIRED.includes(t)) errors.push(`${t}:missing`); continue; }
    let bad: string | null = null;
    for (const tr of ('const' in rule ? [] : rule.transform ?? [])) {
      if (tr === 'trim') v = String(v).trim();
      else if (tr === 'upper') v = String(v).trim().toUpperCase();
      else if (tr === 'lower') v = String(v).trim().toLowerCase();
      else if (tr === 'date') { const d = toIsoDate(v); if (!d) { bad = 'bad_date'; break; } v = d; }
      else if (tr === 'decimal_to_cents') { const c = strictDecimalToCents(v); if (c === null) { bad = 'bad_decimal'; break; } v = c; }
      else if (tr === 'cents') { const s = String(v).trim(); if (!/^\d+$/.test(s)) { bad = 'bad_cents'; break; } v = BigInt(s); }
    }
    if (bad) { errors.push(`${t}:${bad}`); continue; }
    if (t === 'amountCents' && typeof v !== 'bigint') { const c = strictDecimalToCents(v); if (c === null) { errors.push(`${t}:bad_decimal`); continue; } v = c; }
    if ((t === 'issueDate' || t === 'dueDate') && !toIsoDate(v)) { errors.push(`${t}:bad_date`); continue; }
    out[t] = typeof v === 'bigint' ? v : String(v);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, invoice: out as unknown as MappedInvoice };
}

export function validateErpMapping(m: ErpMapping): string[] {
  const bad: string[] = [];
  if (!m || typeof m !== 'object' || typeof m.fields !== 'object' || m.fields === null) return ['fields: required'];
  for (const k of Object.keys(m)) if (!['fields', 'approval'].includes(k)) bad.push(`unknown key ${k}`);
  for (const [k, rule] of Object.entries(m.fields)) {
    if (!(ERP_TARGETS as readonly string[]).includes(k)) { bad.push(`fields.${k}: unknown target`); continue; }
    if (!rule || typeof rule !== 'object') { bad.push(`fields.${k}: invalid`); continue; }
    if ('const' in rule) { if (typeof rule.const !== 'string' || !rule.const) bad.push(`fields.${k}.const: invalid`); continue; }
    if (typeof rule.path !== 'string' || !/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(rule.path)) bad.push(`fields.${k}.path: invalid`);
    for (const t of rule.transform ?? []) if (!TRANSFORMS.includes(t)) bad.push(`fields.${k}.transform: unknown ${t}`);
    for (const x of Object.keys(rule)) if (!['path', 'transform', 'default'].includes(x)) bad.push(`fields.${k}: unknown key ${x}`);
  }
  for (const r of REQUIRED) if (!m.fields[r]) bad.push(`fields.${r}: required`);
  if (m.approval && (typeof m.approval.path !== 'string' || !Array.isArray(m.approval.equals) || m.approval.equals.length === 0)) bad.push('approval: invalid');
  return bad;
}

export const DEFAULT_ERP_MAPPINGS: Record<ErpKind, ErpMapping> = {
  odoo: {
    approval: { path: 'state', equals: ['posted'] },
    fields: {
      supplierKraPin: { path: 'partner_vat', transform: ['upper'] }, invoiceNumber: { path: 'ref', transform: ['trim'] },
      amountCents: { path: 'amount_total', transform: ['decimal_to_cents'] }, currency: { path: 'currency', transform: ['upper'] },
      issueDate: { path: 'invoice_date', transform: ['date'] }, dueDate: { path: 'invoice_date_due', transform: ['date'] },
      etimsCuInvoiceNo: { path: 'x_etims_cu_invoice_no', transform: ['trim'] }, // ASSUMED custom field (Odoo Kenya eTIMS modules differ)
    },
  },
  csv_sftp: {
    approval: { path: 'status', equals: ['approved'] },
    fields: {
      supplierKraPin: { path: 'supplier_kra_pin', transform: ['upper'] }, invoiceNumber: { path: 'invoice_number', transform: ['trim'] },
      amountCents: { path: 'amount_kes', transform: ['decimal_to_cents'] }, currency: { path: 'currency', transform: ['upper'] },
      issueDate: { path: 'issue_date', transform: ['date'] }, dueDate: { path: 'due_date', transform: ['date'] },
      etimsCuInvoiceNo: { path: 'etims_cu_invoice_no', transform: ['trim'] }, poReference: { path: 'po_reference', transform: ['trim'] },
    },
  },
  sap: {
    fields: {
      supplierKraPin: { path: 'YY1_KRAPIN_SINV', transform: ['upper'] }, // ASSUMED custom field holding the supplier KRA PIN
      invoiceNumber: { path: 'SupplierInvoiceIDByInvcgParty', transform: ['trim'] },
      amountCents: { path: 'InvoiceGrossAmount', transform: ['decimal_to_cents'] }, currency: { path: 'DocumentCurrency', transform: ['upper'] },
      issueDate: { path: 'DocumentDate', transform: ['date'] }, dueDate: { path: 'DueDate', transform: ['date'] }, // DueDate derived by the connector
    },
  },
  sage: {
    approval: { path: 'status.id', equals: ['UNPAID', 'PART_PAID'] },
    fields: {
      supplierKraPin: { path: 'contact.tax_number', transform: ['upper'] }, // ASSUMED: contact expanded with its tax number
      invoiceNumber: { path: 'vendor_reference', transform: ['trim'] },
      amountCents: { path: 'total_amount', transform: ['decimal_to_cents'] }, currency: { path: 'currency.id', transform: ['upper'] },
      issueDate: { path: 'date', transform: ['date'] }, dueDate: { path: 'due_date', transform: ['date'] },
    },
  },
  dynamics: {
    approval: { path: 'status', equals: ['Open'] },
    fields: {
      supplierKraPin: { path: 'vendor.taxRegistrationNumber', transform: ['upper'] }, // ASSUMED: $expand=vendor
      invoiceNumber: { path: 'vendorInvoiceNumber', transform: ['trim'] },
      amountCents: { path: 'totalAmountIncludingTax', transform: ['decimal_to_cents'] }, currency: { path: 'currencyCode', transform: ['upper'], default: 'KES' }, // blank = local currency (ASSUMED KES)
      issueDate: { path: 'invoiceDate', transform: ['date'] }, dueDate: { path: 'dueDate', transform: ['date'] },
    },
  },
};

// ===================================================================== mock
export class MockErp implements ErpConnector {
  readonly kind = 'odoo' as ErpKind;
  readonly mode = 'mock' as const;
  private static data = new Map<string, { records: ErpRawRecord[]; fail: string | null }>();
  static push(connectionId: string, r: ErpRawRecord) {
    const d = MockErp.data.get(connectionId) ?? { records: [], fail: null };
    d.records = d.records.filter((x) => x.externalId !== r.externalId);
    d.records.push(r); MockErp.data.set(connectionId, d);
  }
  static failNext(connectionId: string, code: 'ERP_AUTH_FAILED' | 'ERP_UNAVAILABLE') { const d = MockErp.data.get(connectionId) ?? { records: [], fail: null }; d.fail = code; MockErp.data.set(connectionId, d); }
  static reset(connectionId: string) { MockErp.data.delete(connectionId); }
  constructor(private readonly connectionId: string) {}
  async fetchApproved(_ctx: AdapterContext, cursor: string | null, limit: number): Promise<ErpFetchResult> {
    const d = MockErp.data.get(this.connectionId) ?? { records: [], fail: null };
    if (d.fail) { const c = d.fail as any; d.fail = null; throw err(c, 'mock failure'); }
    // cursor = sequence number in the fixture list (records re-pushed move to the end, like a write_date bump)
    const start = cursor ? Number(cursor) : 0;
    const page = d.records.slice(start, start + limit);
    return { records: page, nextCursor: String(start + page.length) };
  }
  async health(): Promise<HealthCheck> { return { provider: 'erp-mock', mode: 'mock', ok: true }; }
}

// ===================================================================== Odoo (JSON-RPC)
export interface OdooConfig { baseUrl: string; database: string; username: string; companyId?: number }
export class OdooConnector implements ErpConnector {
  readonly kind = 'odoo' as const;
  private uid: number | null = null;
  private seq = 1;
  constructor(readonly mode: AdapterMode, private readonly cfg: OdooConfig, private readonly apiKey: string, private readonly f: typeof fetch = fetch) {}

  private async rpc(service: 'common' | 'object', method: string, args: unknown[]): Promise<any> {
    const body = await httpJson(this.f, `${this.cfg.baseUrl.replace(/\/$/, '')}/jsonrpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: this.seq++ }),
    });
    if (body?.error) {
      const name = String(body.error?.data?.name ?? '');
      if (/AccessDenied|AccessError|SessionExpired/.test(name)) { this.uid = null; throw err('ERP_AUTH_FAILED', name); }
      throw err('ERP_BAD_RESPONSE', `${name || 'rpc error'}: ${String(body.error?.data?.message ?? body.error?.message ?? '').slice(0, 200)}`);
    }
    return body?.result;
  }
  private async login(): Promise<number> {
    if (this.uid) return this.uid;
    const uid = await this.rpc('common', 'authenticate', [this.cfg.database, this.cfg.username, this.apiKey, {}]);
    if (!uid || typeof uid !== 'number') throw err('ERP_AUTH_FAILED', 'Odoo rejected the login / API key');
    this.uid = uid;
    return uid;
  }
  private exec(uid: number, model: string, method: string, args: unknown[], kw: Record<string, unknown>) {
    return this.rpc('object', 'execute_kw', [this.cfg.database, uid, this.apiKey, model, method, args, kw]);
  }

  async fetchApproved(_ctx: AdapterContext, cursor: string | null, limit: number): Promise<ErpFetchResult> {
    const uid = await this.login();
    const [wd, idStr] = (cursor ?? '').split('|');
    const domain: unknown[] = [['move_type', '=', 'in_invoice'], ['state', '=', 'posted']];
    if (this.cfg.companyId) domain.push(['company_id', '=', this.cfg.companyId]);
    if (cursor) domain.push('|', ['write_date', '>', wd], '&', ['write_date', '=', wd], ['id', '>', Number(idStr)]);
    const moves: any[] = await this.exec(uid, 'account.move', 'search_read', [domain], {
      fields: ['id', 'name', 'ref', 'move_type', 'state', 'payment_state', 'partner_id', 'amount_total', 'currency_id', 'invoice_date', 'invoice_date_due', 'invoice_origin', 'x_etims_cu_invoice_no', 'write_date'],
      order: 'write_date asc, id asc', limit,
    });
    if (!Array.isArray(moves)) throw err('ERP_BAD_RESPONSE', 'search_read did not return a list');
    const partnerIds = [...new Set(moves.map((m) => (Array.isArray(m.partner_id) ? m.partner_id[0] : null)).filter(Boolean))];
    const partners: any[] = partnerIds.length ? await this.exec(uid, 'res.partner', 'read', [partnerIds], { fields: ['id', 'vat', 'name'] }) : [];
    const vat = new Map(partners.map((p) => [p.id, p.vat || null]));
    const records = moves.map((m) => ({
      externalId: String(m.id), version: String(m.write_date),
      data: { ...m, partner_name: Array.isArray(m.partner_id) ? m.partner_id[1] : null, partner_vat: Array.isArray(m.partner_id) ? vat.get(m.partner_id[0]) ?? null : null, currency: Array.isArray(m.currency_id) ? m.currency_id[1] : null },
    }));
    const last = moves[moves.length - 1];
    return { records, nextCursor: last ? `${last.write_date}|${last.id}` : cursor };
  }
  async health(): Promise<HealthCheck> {
    try { await this.rpc('common', 'version', []); return { provider: 'odoo', mode: this.mode, ok: true }; } catch (e) { return { provider: 'odoo', mode: this.mode, ok: false, detail: (e as Error).message }; }
  }
}

// ===================================================================== CSV / SFTP drop folder
export const CSV_MAX_ROWS = 500;
export const CSV_MAX_BYTES = 5_000_000;
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
export class CsvDropConnector implements ErpConnector {
  readonly kind = 'csv_sftp' as const;
  private pending: { name: string; sha: string; to: 'processed' | 'rejected' }[] = [];
  constructor(readonly mode: AdapterMode, private readonly cfg: { dropDir: string }) {}
  private dir(sub: 'incoming' | 'processed' | 'rejected') { return join(this.cfg.dropDir, sub); }

  async fetchApproved(_ctx: AdapterContext, _cursor: string | null, _limit: number): Promise<ErpFetchResult> {
    if (this.mode === 'mock') return { records: [], nextCursor: null, files: [] };
    for (const s of ['incoming', 'processed', 'rejected'] as const) mkdirSync(this.dir(s), { recursive: true });
    const processed = readdirSync(this.dir('processed'));
    const names = readdirSync(this.dir('incoming')).filter((n) => /^[\w.-]+\.csv$/i.test(n) && statSync(join(this.dir('incoming'), n)).isFile()).sort();
    const records: ErpRawRecord[] = []; const files: ErpFileResult[] = [];
    this.pending = [];
    for (const name of names) {
      const path = join(this.dir('incoming'), name);
      if (statSync(path).size > CSV_MAX_BYTES) { files.push({ name, sha256: '', status: 'too_large' }); this.pending.push({ name, sha: 'too-large', to: 'rejected' }); continue; }
      const buf = readFileSync(path);
      const sha = createHash('sha256').update(buf).digest('hex');
      if (processed.some((p) => p.startsWith(`${sha}-`))) { files.push({ name, sha256: sha, status: 'duplicate_file' }); this.pending.push({ name, sha, to: 'rejected' }); continue; }
      const rows = parseCsv(buf.toString('utf8').replace(/^\uFEFF/, ''));
      const header = (rows[0] ?? []).map((x) => x.trim().toLowerCase());
      if (!header.includes('invoice_number') || !header.includes('supplier_kra_pin')) { files.push({ name, sha256: sha, status: 'bad_header' }); this.pending.push({ name, sha, to: 'rejected' }); continue; }
      const body = rows.slice(1);
      if (body.length > CSV_MAX_ROWS) { files.push({ name, sha256: sha, status: 'too_many_rows', rows: body.length }); this.pending.push({ name, sha, to: 'rejected' }); continue; }
      for (const r of body) {
        const data: Record<string, unknown> = {};
        header.forEach((h, i) => { data[h] = (r[i] ?? '').trim(); });
        const externalId = String(data.external_id || `${String(data.supplier_kra_pin).toUpperCase()}|${String(data.invoice_number)}`);
        records.push({ externalId, version: createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16), data });
      }
      files.push({ name, sha256: sha, status: 'read', rows: body.length });
      this.pending.push({ name, sha, to: 'processed' });
    }
    return { records, nextCursor: null, files };
  }
  async ack(_r: ErpFetchResult) {
    for (const p of this.pending) {
      const from = join(this.dir('incoming'), p.name);
      if (existsSync(from)) renameSync(from, join(this.dir(p.to), `${p.sha}-${p.name}`));
    }
    this.pending = [];
  }
  async health(): Promise<HealthCheck> {
    if (this.mode === 'mock') return { provider: 'csv-drop', mode: 'mock', ok: true };
    return { provider: 'csv-drop', mode: this.mode, ok: existsSync(this.cfg.dropDir), detail: existsSync(this.cfg.dropDir) ? undefined : 'drop folder not created yet' };
  }
}

// ===================================================================== REST connectors (ASSUMED field names)
abstract class RestConnector implements ErpConnector {
  abstract readonly kind: ErpKind;
  constructor(readonly mode: AdapterMode, protected readonly cfg: { baseUrl: string; companyId?: string }, protected readonly secret: string, protected readonly f: typeof fetch = fetch) {}
  protected abstract auth(): string;
  abstract fetchApproved(ctx: AdapterContext, cursor: string | null, limit: number): Promise<ErpFetchResult>;
  protected get(url: string) { return httpJson(this.f, url, { method: 'GET', headers: { Accept: 'application/json', Authorization: this.auth() } }); }
  async health(): Promise<HealthCheck> { return { provider: this.kind, mode: this.mode, ok: Boolean(this.cfg.baseUrl && this.secret), detail: 'assumed API shape; not exercised against a real tenant' }; }
}
const qs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const sapMs = (v: unknown) => Number(/\/Date\((\d+)/.exec(String(v))?.[1] ?? NaN);
export class SapConnector extends RestConnector {
  readonly kind = 'sap' as const;
  protected auth() { return `Basic ${Buffer.from(this.secret).toString('base64')}`; } // secret = "user:password" of a communication user
  async fetchApproved(_ctx: AdapterContext, cursor: string | null, limit: number): Promise<ErpFetchResult> {
    const filter = [`SupplierInvoiceStatus eq '5'`, cursor ? `LastChangeDateTime gt datetimeoffset'${new Date(sapMs(cursor)).toISOString()}'` : null].filter(Boolean).join(' and ');
    const q = qs({ $filter: filter, $orderby: 'LastChangeDateTime asc', $top: String(limit), $format: 'json' });
    const body = await this.get(`${this.cfg.baseUrl.replace(/\/$/, '')}/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice?${q}`);
    const rows: any[] = body?.d?.results;
    if (!Array.isArray(rows)) throw err('ERP_BAD_RESPONSE', 'missing d.results');
    const records = rows.map((r) => {
      const base = sapMs(r.DueCalculationBaseDate ?? r.DocumentDate);
      const due = Number.isFinite(base) ? new Date(base + Number(r.NetPaymentDays ?? 0) * 86_400_000).toISOString().slice(0, 10) : null;
      return { externalId: `${r.FiscalYear}/${r.SupplierInvoice}`, version: String(r.LastChangeDateTime), data: { ...r, DueDate: due } };
    });
    return { records, nextCursor: rows.length ? String(rows[rows.length - 1].LastChangeDateTime) : cursor };
  }
}
export class SageConnector extends RestConnector {
  readonly kind = 'sage' as const;
  protected auth() { return `Bearer ${this.secret}`; } // OAuth2 access token issued out of band (refresh flow not built)
  async fetchApproved(_ctx: AdapterContext, cursor: string | null, limit: number): Promise<ErpFetchResult> {
    const q = qs({ attributes: 'all', items_per_page: String(limit), ...(cursor ? { updated_or_created_since: cursor } : {}) });
    const body = await this.get(`${this.cfg.baseUrl.replace(/\/$/, '')}/purchase_invoices?${q}`);
    const rows: any[] = body?.$items;
    if (!Array.isArray(rows)) throw err('ERP_BAD_RESPONSE', 'missing $items');
    rows.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
    return { records: rows.map((r) => ({ externalId: String(r.id), version: String(r.updated_at), data: r })), nextCursor: rows.length ? String(rows[rows.length - 1].updated_at) : cursor };
  }
}
export class DynamicsConnector extends RestConnector {
  readonly kind = 'dynamics' as const;
  protected auth() { return `Bearer ${this.secret}`; } // Entra ID client-credentials token issued out of band
  async fetchApproved(_ctx: AdapterContext, cursor: string | null, limit: number): Promise<ErpFetchResult> {
    const filter = [`status eq 'Open'`, cursor ? `lastModifiedDateTime gt ${cursor}` : null].filter(Boolean).join(' and ');
    const q = qs({ $filter: filter, $orderby: 'lastModifiedDateTime asc', $top: String(limit), $expand: 'vendor' });
    const body = await this.get(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/v2.0/companies(${this.cfg.companyId})/purchaseInvoices?${q}`);
    const rows: any[] = body?.value;
    if (!Array.isArray(rows)) throw err('ERP_BAD_RESPONSE', 'missing value');
    return { records: rows.map((r) => ({ externalId: String(r.id), version: String(r.lastModifiedDateTime), data: r })), nextCursor: rows.length ? String(rows[rows.length - 1].lastModifiedDateTime) : cursor };
  }
}

// ===================================================================== registry (the adapter in Adapters)
export interface ErpConnectionDef { id: string; kind: ErpKind; config: Record<string, unknown> }
export class ErpRegistry {
  constructor(readonly mode: AdapterMode, private readonly env: Record<string, string | undefined>, private readonly f: typeof fetch = fetch) {}
  connector(c: ErpConnectionDef, secret: string | undefined): ErpConnector {
    if (this.mode === 'mock') return new MockErp(c.id);
    const cfg = c.config as any;
    if (c.kind === 'csv_sftp') {
      if (!this.env.ERP_DROP_ROOT) throw err('ERP_CONFIG', 'ERP_DROP_ROOT is not set');
      return new CsvDropConnector(this.mode, { dropDir: join(this.env.ERP_DROP_ROOT, c.id) });
    }
    if (!secret) throw err('ERP_CONFIG', 'ERP_SECRET_MISSING: the connection secret env var is not set');
    if (c.kind === 'odoo') return new OdooConnector(this.mode, { baseUrl: cfg.baseUrl, database: cfg.database, username: cfg.username, companyId: cfg.companyId }, secret, this.f);
    if (c.kind === 'sap') return new SapConnector(this.mode, cfg, secret, this.f);
    if (c.kind === 'sage') return new SageConnector(this.mode, cfg, secret, this.f);
    return new DynamicsConnector(this.mode, cfg, secret, this.f);
  }
  async health(): Promise<HealthCheck> { return { provider: 'erp', mode: this.mode, ok: this.mode === 'mock' || Boolean(this.env.ERP_DROP_ROOT), detail: this.mode === 'mock' ? undefined : `drop root ${this.env.ERP_DROP_ROOT ? 'set' : 'missing'}` }; }
}

// ===================================================================== FakeOdoo (local test double of Odoo's JSON-RPC; never a real host)
type Move = Record<string, any>;
export class FakeOdoo {
  readonly calls: { service: string; method: string; args: any[] }[] = [];
  failNext: 'auth' | 'unavailable' | 'fault' | null = null;
  private moves = new Map<number, Move>();
  private partners = new Map<number, { id: number; name: string; vat: string | false }>();
  private server: Server | null = null;
  constructor(private readonly cfg: { db: string; login: string; apiKey: string; uid?: number }) {}
  addPartner(id: number, name: string, vat: string | false) { this.partners.set(id, { id, name, vat }); }
  addMove(m: Move) { this.moves.set(m.id, { ...m }); }
  updateMove(id: number, patch: Move) { this.moves.set(id, { ...this.moves.get(id), ...patch }); }

  private evalDomain(m: Move, d: any[]): boolean {
    const stack: boolean[] = [];
    for (let i = d.length - 1; i >= 0; i--) {
      const t = d[i];
      if (t === '|' || t === '&') { const a = stack.pop()!; const b = stack.pop()!; stack.push(t === '|' ? a || b : a && b); continue; }
      const [f, op, v] = t; const x = m[f];
      stack.push(op === '=' ? x === v : op === '>' ? x > v : op === 'in' ? v.includes(x) : false);
    }
    return stack.every(Boolean);
  }
  handle(body: any): { status: number; json: unknown } {
    const { service, method, args } = body?.params ?? {};
    this.calls.push({ service, method, args });
    let f = this.failNext;
    if (f === 'fault' && !(service === 'object' && method === 'execute_kw')) f = null; // a fault hits the data call, not the login
    if (f) this.failNext = null;
    if (f === 'unavailable') return { status: 503, json: {} };
    const ok = (result: unknown) => ({ status: 200, json: { jsonrpc: '2.0', id: body.id, result } });
    const fault = (name: string, message: string) => ({ status: 200, json: { jsonrpc: '2.0', id: body.id, error: { code: 200, message: 'Odoo Server Error', data: { name, message } } } });
    if (service === 'common' && method === 'version') return ok({ server_version: '17.0' });
    if (service === 'common' && method === 'authenticate') {
      const [db, login, key] = args;
      return ok(f !== 'auth' && db === this.cfg.db && login === this.cfg.login && key === this.cfg.apiKey ? this.cfg.uid ?? 2 : false);
    }
    if (service === 'object' && method === 'execute_kw') {
      const [db, , key, model, m, margs, kw] = args;
      if (f === 'auth' || db !== this.cfg.db || key !== this.cfg.apiKey) return fault('odoo.exceptions.AccessDenied', 'Access Denied');
      if (f === 'fault') return fault('builtins.ValueError', 'Invalid field');
      if (model === 'account.move' && m === 'search_read') {
        const rows = [...this.moves.values()].filter((x) => this.evalDomain(x, margs[0]))
          .sort((a, b) => String(a.write_date).localeCompare(String(b.write_date)) || a.id - b.id).slice(0, kw?.limit ?? 80);
        return ok(rows.map((r) => Object.fromEntries((kw?.fields ?? Object.keys(r)).map((k: string) => [k, r[k] ?? false]))));
      }
      if (model === 'res.partner' && m === 'read') return ok(margs[0].map((id: number) => this.partners.get(id)).filter(Boolean));
      return fault('builtins.NotImplementedError', `${model}.${m}`);
    }
    return fault('builtins.NotImplementedError', `${service}.${method}`);
  }
  readonly fetch = (async (_url: string, init: any) => {
    const r = this.handle(JSON.parse(init.body));
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  listen(): Promise<string> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
          let r: { status: number; json: unknown };
          try { r = req.url === '/jsonrpc' ? this.handle(JSON.parse(data)) : { status: 404, json: {} }; } catch { r = { status: 400, json: {} }; }
          res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(r.json));
        });
      }).listen(0, '127.0.0.1', () => { const a = this.server!.address() as any; resolve(`http://127.0.0.1:${a.port}`); });
    });
  }
  close(): Promise<void> { return new Promise((r) => (this.server ? this.server.close(() => r()) : r())); }
}
