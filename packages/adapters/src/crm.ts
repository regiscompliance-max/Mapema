/**
 * [Integration Engineer + Compliance] CRM adapter (Phase 2 CRM-01). HubSpot first.
 *  - mock    : in-memory contacts and deals
 *  - sandbox : HubSpot CRM v3 with a private-app token for a HubSpot developer test portal.
 *              NOT exercised in this phase (no portal, no live calls).
 * Lawful basis: the site form asked the person to be contacted about their request; we record that as
 * the basis and never subscribe the contact to marketing (DPA 2019 s.30/s.37; consent for marketing is
 * separate and not collected on the form).
 */
import { AdapterContext, AdapterError, AdapterMode, HealthCheck, notConfigured } from './common';

export interface CrmLead { sourceId: string; name: string; company: string; email: string; phone?: string | null; basis: 'request_to_be_contacted'; lang?: string }
export interface CrmResult { contactId: string; dealId: string; duplicate: boolean }

export interface CrmAdapter {
  readonly mode: AdapterMode;
  readonly provider: string;
  upsertLead(ctx: AdapterContext, lead: CrmLead): Promise<CrmResult>;
  health(): Promise<HealthCheck>;
}

export class MockCrm implements CrmAdapter {
  readonly mode = 'mock' as const;
  readonly provider = 'crm-mock';
  readonly contacts = new Map<string, { id: string; email: string; name: string; company: string; marketingOptIn: false; basis: string }>();
  readonly deals = new Map<string, { id: string; contactId: string; sourceId: string; stage: string }>();

  async upsertLead(_ctx: AdapterContext, lead: CrmLead): Promise<CrmResult> {
    const email = lead.email.trim().toLowerCase();
    let c = this.contacts.get(email);
    if (!c) { c = { id: `c${this.contacts.size + 1}`, email, name: lead.name, company: lead.company, marketingOptIn: false, basis: lead.basis }; this.contacts.set(email, c); }
    const d = this.deals.get(lead.sourceId);
    if (d) return { contactId: c.id, dealId: d.id, duplicate: true };
    const deal = { id: `d${this.deals.size + 1}`, contactId: c.id, sourceId: lead.sourceId, stage: 'appointmentscheduled' };
    this.deals.set(lead.sourceId, deal);
    return { contactId: c.id, dealId: deal.id, duplicate: false };
  }

  async health(): Promise<HealthCheck> { return { provider: this.provider, mode: 'mock', ok: true }; }
}

export class HubSpotCrm implements CrmAdapter {
  readonly provider = 'hubspot';
  constructor(readonly mode: AdapterMode, private readonly cfg: { token: string; pipelineId?: string; dealStageId?: string; baseUrl?: string }, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call(method: string, path: string, body: unknown): Promise<any> {
    if (!this.cfg.token) return notConfigured('hubspot', this.mode);
    const res = await this.fetchImpl(`${this.cfg.baseUrl ?? 'https://api.hubapi.com'}${path}`, {
      method, headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } as any);
    if (!res.ok) throw new AdapterError('hubspot', `HTTP_${res.status}`, await res.text(), res.status >= 500 || res.status === 429, res.status);
    return res.json();
  }

  async upsertLead(_ctx: AdapterContext, lead: CrmLead): Promise<CrmResult> {
    if (!this.cfg.token) return notConfigured('hubspot', this.mode);
    const email = lead.email.trim().toLowerCase();
    const found = await this.call('POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], limit: 1 });
    const [first, ...rest] = lead.name.trim().split(/\s+/);
    const contactId = found.results?.[0]?.id ?? (await this.call('POST', '/crm/v3/objects/contacts', {
      properties: { email, firstname: first, lastname: rest.join(' '), company: lead.company, phone: lead.phone ?? undefined, hs_language: lead.lang === 'sw' ? 'sw' : 'en', mapema_lawful_basis: lead.basis },
    })).id;
    const deal = await this.call('POST', '/crm/v3/objects/deals/search', { filterGroups: [{ filters: [{ propertyName: 'mapema_source_id', operator: 'EQ', value: lead.sourceId }] }], limit: 1 });
    if (deal.results?.[0]?.id) return { contactId: String(contactId), dealId: String(deal.results[0].id), duplicate: true };
    const created = await this.call('POST', '/crm/v3/objects/deals', {
      properties: { dealname: `${lead.company} - buyer programme`, pipeline: this.cfg.pipelineId ?? 'default', dealstage: this.cfg.dealStageId ?? 'appointmentscheduled', mapema_source_id: lead.sourceId },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }],
    });
    return { contactId: String(contactId), dealId: String(created.id), duplicate: false };
  }

  async health(): Promise<HealthCheck> { return { provider: 'hubspot', mode: this.mode, ok: Boolean(this.cfg.token), detail: this.cfg.token ? undefined : 'HUBSPOT_PRIVATE_APP_TOKEN not set' }; }
}
