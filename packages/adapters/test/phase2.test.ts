/**
 * [QA Engineer] Phase 2 adapter contract tests (stories REC-07, COL-03, ACC-01, CRM-01), written first.
 * Sandbox adapters are exercised with an injected fetch only: no live provider calls in this phase.
 */
import { describe, expect, it } from 'vitest';
import { kes } from '@mapema/pricing';
import {
  createAdapters, D1SiteLeadSource, HubSpotCrm, MockAccounting, MockBank, MockCrm, MockLedger, MockSiteLeadSource, UnconfiguredBank, XeroAccounting,
} from '../src';

const ctx = { requestId: 't' };
const recordingFetch = () => {
  const calls: { url: string; init: any }[] = [];
  const f = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: '901', results: [], ManualJournals: [{ ManualJournalID: 'xj-1' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  return { calls, f: f as unknown as typeof fetch };
};

describe('TC-P2U-ADP-01 bank statement feed', () => {
  it('MockBank keeps a statement of credits, payouts, returns and charges with signed amounts', async () => {
    const b = new MockBank();
    b.creditReceived(kes(1_000), { bankRef: 'FT1', valueDate: '2027-03-01' });
    const p = await b.sendPayout(ctx, { idempotencyKey: 'k1', amountCents: kes(400), currency: 'KES', beneficiary: { bankCode: '11', accountNumber: '0123456789', accountName: 'X' }, rail: 'pesalink', narrative: 'n' }, '2027-03-02');
    b.bankCharge(2_500n, 'CHG1', '2027-03-02', 'PesaLink fee');
    const st = await b.getStatement('2027-03-01', '2027-03-31');
    expect(st.map((l) => [l.bankRef, l.amountCents, l.type])).toEqual([['FT1', kes(1_000), 'credit'], [p.bankRef, -kes(400), 'debit'], ['CHG1', -2_500n, 'charge']]);
    expect(await b.getBalance()).toBe(kes(600) - 2_500n);
    expect(await b.getStatement('2027-03-02', '2027-03-02')).toHaveLength(2);
  });
  it('sandbox bank fails fast: partner bank not contracted', async () => {
    await expect(new UnconfiguredBank('sandbox').getStatement('2027-03-01', '2027-03-01')).rejects.toThrow(/PROVIDER_NOT_CONFIGURED/);
  });
});

describe('TC-P2U-ADP-04 ledger interest waiver (in duplum) and post-maturity accrual hook', () => {
  it('MockLedger accrues after maturity only when the test hook is on; waiver reduces interest outstanding, never principal', async () => {
    const l = new MockLedger();
    l.postMaturityInterest = true;
    const { loanId } = await l.bookAdvance(ctx, { externalId: 'a', clientId: 1, principalCents: kes(800_000), rateBpsPer30d: 350, days: 48, disbursementDate: '2027-01-04', dueDate: '2027-02-21', verificationFeeCents: kes(2_500) });
    const s = await l.getLoan(loanId, '2027-05-22'); // 90 days past due: 138 days of interest
    expect(s.interestChargedCents).toBe(kes(128_800));
    await l.waiveInterest(ctx, loanId, kes(10_000), '2027-05-22', 'in duplum');
    const s2 = await l.getLoan(loanId, '2027-05-22');
    expect(s2.interestWaivedCents).toBe(kes(10_000));
    expect(s2.interestOutstandingCents).toBe(kes(118_800));
    expect(s2.principalOutstandingCents).toBe(kes(800_000));
    await expect(l.waiveInterest(ctx, loanId, kes(200_000), '2027-05-22', 'too much')).rejects.toThrow(/exceeds/);
  });
});

describe('TC-P2U-ADP-02 accounting (Xero) adapter', () => {
  const j = { date: '2027-03-01', idempotencyKey: 'mapema-je-2027-03-01', narration: 'Mapema daily journal 2027-03-01', lines: [{ accountCode: '090', debitCents: kes(100), creditCents: 0n, description: 'Bank' }, { accountCode: '200', debitCents: 0n, creditCents: kes(100), description: 'Interest' }] };
  it('mock: idempotent by key, rejects unbalanced journals', async () => {
    const a = new MockAccounting();
    const r1 = await a.pushJournal(ctx, j);
    const r2 = await a.pushJournal(ctx, j);
    expect(r2).toEqual({ providerRef: r1.providerRef, duplicate: true });
    expect(a.journals).toHaveLength(1);
    await expect(a.pushJournal(ctx, { ...j, idempotencyKey: 'x', lines: [j.lines[0]] })).rejects.toThrow(/UNBALANCED/);
  });
  it('fee invoices are disabled behind the hook (D-24 tax advice)', async () => {
    const a = new MockAccounting();
    await expect(a.createFeeInvoice(ctx, { idempotencyKey: 'f', contactName: 'X', date: '2027-03-01', lines: [] })).rejects.toThrow(/FEE_INVOICES_DISABLED/);
  });
  it('sandbox: needs credentials; builds a Xero ManualJournal with an Idempotency-Key and 2dp amounts (injected fetch, no network)', async () => {
    await expect(new XeroAccounting('sandbox', { accessToken: '', tenantId: '' }).pushJournal(ctx, j)).rejects.toThrow(/PROVIDER_NOT_CONFIGURED/);
    const rec = recordingFetch();
    const x = new XeroAccounting('sandbox', { accessToken: 'tok', tenantId: 'ten' }, rec.f);
    const r = await x.pushJournal(ctx, j);
    expect(r.providerRef).toBe('xj-1');
    expect(rec.calls[0].url).toBe('https://api.xero.com/api.xro/2.0/ManualJournals');
    expect(rec.calls[0].init.headers['Idempotency-Key']).toBe('mapema-je-2027-03-01');
    expect(rec.calls[0].init.headers['xero-tenant-id']).toBe('ten');
    const body = JSON.parse(rec.calls[0].init.body);
    expect(body.ManualJournals[0].JournalLines).toEqual([{ AccountCode: '090', LineAmount: '100.00', Description: 'Bank' }, { AccountCode: '200', LineAmount: '-100.00', Description: 'Interest' }]);
    expect(body.ManualJournals[0].Status).toBe('DRAFT');
  });
});

describe('TC-P2U-ADP-03 CRM (HubSpot) and site lead source (Cloudflare D1)', () => {
  const lead = { sourceId: 'site-17', name: 'Amina Otieno', company: 'Duka Bora Ltd', email: 'amina@dukabora.test', phone: '+254700000001', basis: 'request_to_be_contacted' as const };
  it('mock CRM: upsert contact by email, one deal per source id', async () => {
    const c = new MockCrm();
    const a = await c.upsertLead(ctx, lead);
    const b = await c.upsertLead(ctx, lead);
    expect(b).toEqual({ ...a, duplicate: true });
    expect(c.contacts.size).toBe(1);
    expect(c.deals.size).toBe(1);
    expect([...c.contacts.values()][0].marketingOptIn).toBe(false);
  });
  it('sandbox HubSpot: needs a token; search-then-create with the source id as idempotency (injected fetch)', async () => {
    await expect(new HubSpotCrm('sandbox', { token: '' }).upsertLead(ctx, lead)).rejects.toThrow(/PROVIDER_NOT_CONFIGURED/);
    const rec = recordingFetch();
    const h = new HubSpotCrm('sandbox', { token: 'pat', pipelineId: 'buyers', dealStageId: 'appointmentscheduled' }, rec.f);
    await h.upsertLead(ctx, lead);
    expect(rec.calls.map((c) => `${c.init.method} ${c.url.replace('https://api.hubapi.com', '')}`)).toEqual([
      'POST /crm/v3/objects/contacts/search', 'POST /crm/v3/objects/contacts', 'POST /crm/v3/objects/deals/search', 'POST /crm/v3/objects/deals',
    ]);
    expect(rec.calls[0].init.headers.Authorization).toBe('Bearer pat');
    const deal = JSON.parse(rec.calls[3].init.body);
    expect(deal.properties).toMatchObject({ pipeline: 'buyers', dealstage: 'appointmentscheduled', mapema_source_id: 'site-17' });
  });
  it('lead source: mock fixture with a (created_at, id) cursor; sandbox D1 reader needs a token and only issues parameterised SELECTs', async () => {
    const row = { id: 'c1', created_at: '2026-11-18T06:00:00.000Z', contact_name: 'A', company: 'B', email: 'a@b.test', phone: '+254700000002', role: 'buyer' as const, privacy_notice_version: 'PN-2026-11', lang: 'en' };
    const m = new MockSiteLeadSource([row], [{ email: 'gone@b.test', type: 'deletion', created_at: '2026-11-18T07:00:00.000Z' }]);
    expect(await m.listSince(null)).toEqual([row]);
    expect(await m.listSince({ createdAt: row.created_at, id: 'c1' })).toEqual([]);
    expect(await m.erasureRequests()).toEqual(['gone@b.test']);
    await expect(new D1SiteLeadSource('sandbox', { accountId: 'acc', databaseId: 'db', token: '' }).listSince(null)).rejects.toThrow(/PROVIDER_NOT_CONFIGURED/);
    const rec = recordingFetch();
    await new D1SiteLeadSource('sandbox', { accountId: 'acc', databaseId: 'db', token: 'cf' }, rec.f).listSince({ createdAt: '2026-11-18T06:00:00.000Z', id: 'c1' });
    expect(rec.calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db/query');
    expect(rec.calls[0].init.headers.Authorization).toBe('Bearer cf');
    const body = JSON.parse(rec.calls[0].init.body);
    expect(body.sql).toMatch(/^SELECT .* FROM call_requests WHERE created_at > \?1 OR \(created_at = \?1 AND id > \?2\) ORDER BY created_at, id LIMIT 200$/);
    expect(body.params).toEqual(['2026-11-18T06:00:00.000Z', 'c1']);
  });
  it('factory: new adapters default to mock; live refused outside production', () => {
    const a = createAdapters({ APP_ENV: 'test' });
    expect([a.accounting.mode, a.crm.mode, a.leads.mode]).toEqual(['mock', 'mock', 'mock']);
    expect(() => createAdapters({ APP_ENV: 'test', ADAPTER_MODE_CRM: 'live' })).toThrow(/only allowed in production/);
  });
});
