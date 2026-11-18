/**
 * [Integration Engineer] Site lead source (Phase 2 CRM-01): the marketing site's Cloudflare D1
 * database `mapema-site` (tables call_requests, data_requests - infra/cloudflare-site/schema.sql).
 *  - mock    : fixture rows
 *  - sandbox : Cloudflare D1 HTTP API (POST /accounts/{acc}/d1/database/{db}/query) with a D1-read
 *              API token. Read-only parameterised SELECTs. NOT called in this phase (no live calls).
 */
import { AdapterError, AdapterMode, HealthCheck, notConfigured } from './common';

export interface SiteCallRequest { id: string; created_at: string; contact_name: string; company: string; email: string; phone: string | null; role: 'buyer' | 'supplier'; privacy_notice_version: string; lang: string }
export interface SiteDataRequest { email: string; type: string; created_at: string }
export type LeadCursor = { createdAt: string; id: string } | null;

export interface LeadSourceAdapter {
  readonly mode: AdapterMode;
  listSince(cursor: LeadCursor): Promise<SiteCallRequest[]>;
  /** emails with a deletion/objection request on the site (erasure respected before CRM sync) */
  erasureRequests(): Promise<string[]>;
  health(): Promise<HealthCheck>;
}

const after = (r: SiteCallRequest, c: LeadCursor) => !c || r.created_at > c.createdAt || (r.created_at === c.createdAt && r.id > c.id);

export class MockSiteLeadSource implements LeadSourceAdapter {
  readonly mode = 'mock' as const;
  constructor(public rows: SiteCallRequest[] = [], public erasures: SiteDataRequest[] = []) {}
  async listSince(c: LeadCursor) {
    return this.rows.filter((r) => after(r, c)).sort((a, b) => (a.created_at + a.id).localeCompare(b.created_at + b.id)).slice(0, 200);
  }
  async erasureRequests() { return this.erasures.filter((e) => ['deletion', 'objection'].includes(e.type)).map((e) => e.email.toLowerCase()); }
  async health(): Promise<HealthCheck> { return { provider: 'site-leads-mock', mode: 'mock', ok: true }; }
}

export class D1SiteLeadSource implements LeadSourceAdapter {
  constructor(readonly mode: AdapterMode, private readonly cfg: { accountId: string; databaseId: string; token: string }, private readonly fetchImpl: typeof fetch = fetch) {}

  private async query(sql: string, params: unknown[]): Promise<any[]> {
    if (!this.cfg.token || !this.cfg.accountId || !this.cfg.databaseId) return notConfigured('cloudflare-d1', this.mode);
    const res = await this.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${this.cfg.accountId}/d1/database/${this.cfg.databaseId}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }),
    } as any);
    if (!res.ok) throw new AdapterError('cloudflare-d1', `HTTP_${res.status}`, await res.text(), res.status >= 500, res.status);
    const j: any = await res.json();
    return j.result?.[0]?.results ?? [];
  }

  async listSince(c: LeadCursor) {
    return (await this.query('SELECT id, created_at, contact_name, company, email, phone, role, privacy_notice_version, lang FROM call_requests WHERE created_at > ?1 OR (created_at = ?1 AND id > ?2) ORDER BY created_at, id LIMIT 200',
      [c?.createdAt ?? '', c?.id ?? ''])) as SiteCallRequest[];
  }

  async erasureRequests() {
    return (await this.query(`SELECT email FROM data_requests WHERE type IN ('deletion','objection')`, [])).map((r: any) => String(r.email).toLowerCase());
  }

  async health(): Promise<HealthCheck> { return { provider: 'cloudflare-d1', mode: this.mode, ok: Boolean(this.cfg.token), detail: this.cfg.token ? undefined : 'SITE_D1_API_TOKEN not set' }; }
}
