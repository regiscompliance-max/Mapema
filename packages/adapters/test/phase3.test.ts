/**
 * [QA Engineer] Phase 3 adapter contract tests (ERP-01..04, MP-01..04, FUND-03), written first.
 * Sandbox adapters run against an injected fetch or a local fake only: no live provider calls.
 */
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kes } from '@mapema/pricing';
import {
  createAdapters, CsvDropConnector, DarajaMpesa, DEFAULT_ERP_MAPPINGS, DynamicsConnector, ErpRegistry, FakeOdoo, mapErpRecord, MockErp, MockLedger, MockMpesa,
  OdooConnector, parseB2cResult, SageConnector, SapConnector, validateErpMapping,
} from '../src';

const ctx = { requestId: 't' };
type Call = { url: string; init: any };
const jsonFetch = (handler: (url: string, init: any) => { status?: number; body: unknown }) => {
  const calls: Call[] = [];
  const f = async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, f: f as unknown as typeof fetch };
};

const odooBill = (o: Record<string, unknown> = {}) => ({
  id: 7, name: 'BILL/2027/0007', ref: ' inv-1001 ', move_type: 'in_invoice', state: 'posted', partner_id: [42, 'Jua Kali Packaging Ltd'],
  amount_total: 1000000.0, currency_id: [1, 'KES'], invoice_date: '2027-01-02', invoice_date_due: '2027-02-21', x_etims_cu_invoice_no: 'KRACU0001', write_date: '2027-01-03 08:00:00', ...o,
});

describe('TC-P3U-ERP-01 field mapping (pure)', () => {
  const odoo = DEFAULT_ERP_MAPPINGS.odoo;
  it('maps an Odoo vendor bill to a Mapema invoice to the cent, trimming and upper-casing', () => {
    const r = mapErpRecord({ externalId: '7', version: 'v', data: { ...odooBill(), partner_vat: ' p051111111b ', currency: 'KES' } }, odoo);
    expect(r).toEqual({ ok: true, invoice: { supplierKraPin: 'P051111111B', invoiceNumber: 'inv-1001', amountCents: kes(1_000_000), currency: 'KES', issueDate: '2027-01-02', dueDate: '2027-02-21', etimsCuInvoiceNo: 'KRACU0001' } });
  });
  it('decimal amounts are exact: "1234.5" -> 123450; floats never round silently; 3 decimals are rejected', () => {
    const m = { fields: { ...odoo.fields } };
    const base = { ...odooBill(), partner_vat: 'P051111111B', currency: 'KES' };
    expect((mapErpRecord({ externalId: '7', version: 'v', data: { ...base, amount_total: '1234.5' } }, m) as any).invoice.amountCents).toBe(123_450n);
    expect((mapErpRecord({ externalId: '7', version: 'v', data: { ...base, amount_total: 0.1 + 0.2 } }, m) as any).errors).toEqual(['amountCents:bad_decimal']);
    expect((mapErpRecord({ externalId: '7', version: 'v', data: { ...base, amount_total: '10.005' } }, m) as any).errors).toEqual(['amountCents:bad_decimal']);
  });
  it('reports every missing/invalid field; Odoo false means empty; non-approved records are skipped, not errors', () => {
    const r = mapErpRecord({ externalId: '7', version: 'v', data: { ...odooBill({ ref: false, invoice_date_due: 'tomorrow' }), currency: 'KES' } }, odoo);
    expect(r).toEqual({ ok: false, errors: ['supplierKraPin:missing', 'invoiceNumber:missing', 'dueDate:bad_date'] });
    expect(mapErpRecord({ externalId: '7', version: 'v', data: { ...odooBill({ state: 'draft' }), partner_vat: 'P051111111B', currency: 'KES' } }, odoo)).toEqual({ ok: false, skip: 'not_approved', errors: [] });
  });
  it('SAP /Date(ms)/ and datetime strings become ISO dates; const fields work', () => {
    const m = { fields: { supplierKraPin: { const: 'P051111111B' }, invoiceNumber: { path: 'n' }, amountCents: { path: 'a', transform: ['cents' as const] }, currency: { const: 'KES' }, issueDate: { path: 'i', transform: ['date' as const] }, dueDate: { path: 'd', transform: ['date' as const] } } };
    const r = mapErpRecord({ externalId: 'x', version: 'v', data: { n: 'A1', a: '80000000', i: '/Date(1798761600000)/', d: '2027-02-21T00:00:00Z' } }, m);
    expect(r).toEqual({ ok: true, invoice: { supplierKraPin: 'P051111111B', invoiceNumber: 'A1', amountCents: kes(800_000), currency: 'KES', issueDate: '2027-01-01', dueDate: '2027-02-21' } });
  });
  it('validates a mapping: required targets, known transforms, no unknown keys', () => {
    expect(validateErpMapping(odoo)).toEqual([]);
    expect(validateErpMapping({ fields: { invoiceNumber: { path: 'ref', transform: ['shout'] } }, extra: 1 } as any)).toEqual([
      'unknown key extra', 'fields.invoiceNumber.transform: unknown shout', 'fields.supplierKraPin: required', 'fields.amountCents: required', 'fields.currency: required', 'fields.issueDate: required', 'fields.dueDate: required']);
    for (const k of ['odoo', 'csv_sftp', 'sap', 'sage', 'dynamics'] as const) expect(validateErpMapping(DEFAULT_ERP_MAPPINGS[k])).toEqual([]);
  });
});

describe('TC-P3U-ERP-02 Odoo JSON-RPC connector (against the local FakeOdoo)', () => {
  const setup = () => {
    const odoo = new FakeOdoo({ db: 'acme', login: 'api@acme.test', apiKey: 'k-123' });
    odoo.addPartner(42, 'Jua Kali Packaging Ltd', 'P051111111B');
    odoo.addMove(odooBill({ id: 7, write_date: '2027-01-03 08:00:00' }));
    odoo.addMove(odooBill({ id: 8, ref: 'INV-1002', write_date: '2027-01-03 08:00:00' }));
    odoo.addMove(odooBill({ id: 9, ref: 'DRAFT', state: 'draft', write_date: '2027-01-03 09:00:00' }));
    odoo.addMove(odooBill({ id: 10, ref: 'CUST', move_type: 'out_invoice', write_date: '2027-01-03 09:00:00' }));
    const c = new OdooConnector('sandbox', { baseUrl: 'http://odoo.local', database: 'acme', username: 'api@acme.test' }, 'k-123', odoo.fetch);
    return { odoo, c };
  };
  it('authenticates, pulls posted vendor bills only, attaches the partner VAT and currency code, pages by (write_date, id)', async () => {
    const { odoo, c } = setup();
    const p1 = await c.fetchApproved(ctx, null, 1);
    expect(p1.records.map((r) => r.externalId)).toEqual(['7']);
    expect(p1.records[0].data).toMatchObject({ partner_vat: 'P051111111B', currency: 'KES', amount_total: 1000000 });
    expect(p1.records[0].version).toBe('2027-01-03 08:00:00');
    const p2 = await c.fetchApproved(ctx, p1.nextCursor, 10);
    expect(p2.records.map((r) => r.externalId)).toEqual(['8']); // same write_date, higher id: not skipped
    const p3 = await c.fetchApproved(ctx, p2.nextCursor, 10);
    expect(p3.records).toEqual([]);
    expect(p3.nextCursor).toBe(p2.nextCursor); // cursor never moves backwards
    expect(odoo.calls.filter((x) => x.method === 'authenticate')).toHaveLength(1); // uid cached
    expect(odoo.calls.every((x) => x.args?.[2] === 'k-123' || x.method === 'authenticate')).toBe(true);
  });
  it('a bill edited after import comes back with a newer version', async () => {
    const { odoo, c } = setup();
    const p1 = await c.fetchApproved(ctx, null, 10);
    odoo.updateMove(7, { amount_total: 900000, write_date: '2027-01-04 10:00:00' });
    const p2 = await c.fetchApproved(ctx, p1.nextCursor, 10);
    expect(p2.records.map((r) => [r.externalId, r.version])).toEqual([['7', '2027-01-04 10:00:00']]);
  });
  it('maps errors: bad key -> ERP_AUTH_FAILED (not retryable); 503 / network -> ERP_UNAVAILABLE (retryable); RPC fault -> ERP_BAD_RESPONSE', async () => {
    const { odoo, c } = setup();
    odoo.failNext = 'auth';
    await expect(c.fetchApproved(ctx, null, 10)).rejects.toMatchObject({ code: 'ERP_AUTH_FAILED', retryable: false });
    odoo.failNext = 'unavailable';
    await expect(c.fetchApproved(ctx, null, 10)).rejects.toMatchObject({ code: 'ERP_UNAVAILABLE', retryable: true });
    odoo.failNext = 'fault';
    await expect(c.fetchApproved(ctx, null, 10)).rejects.toMatchObject({ code: 'ERP_BAD_RESPONSE' });
    const down = new OdooConnector('sandbox', { baseUrl: 'http://odoo.local', database: 'acme', username: 'api@acme.test' }, 'k-123', (async () => { throw new TypeError('fetch failed'); }) as any);
    await expect(down.fetchApproved(ctx, null, 10)).rejects.toMatchObject({ code: 'ERP_UNAVAILABLE' });
    const wrong = new OdooConnector('sandbox', { baseUrl: 'http://odoo.local', database: 'acme', username: 'api@acme.test' }, 'nope', odoo.fetch);
    await expect(wrong.fetchApproved(ctx, null, 10)).rejects.toMatchObject({ code: 'ERP_AUTH_FAILED' });
    expect((await c.health()).ok).toBe(true);
  });
  it('FakeOdoo also serves real HTTP for the API end-to-end tests', async () => {
    const { odoo } = setup();
    const url = await odoo.listen();
    try {
      const c = new OdooConnector('sandbox', { baseUrl: url, database: 'acme', username: 'api@acme.test' }, 'k-123');
      expect((await c.fetchApproved(ctx, null, 10)).records).toHaveLength(2);
    } finally { await odoo.close(); }
  });
});

describe('TC-P3U-ERP-03 CSV / SFTP drop folder', () => {
  const header = 'external_id,supplier_kra_pin,invoice_number,amount_kes,currency,issue_date,due_date,etims_cu_invoice_no,status';
  it('reads incoming CSV files (quoted fields too), acks into processed/, and rejects an identical file dropped again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-'));
    const c = new CsvDropConnector('sandbox', { dropDir: join(root, 'conn1') });
    mkdirSync(join(root, 'conn1', 'incoming'), { recursive: true });
    const body = `${header}\nA-1,P051111111B,INV-9,"1,000,000.00",KES,2027-01-02,2027-02-21,KRACU9,approved\nA-2,P051111111B,"INV, 10",500000,KES,2027-01-02,2027-02-21,,pending\n`;
    writeFileSync(join(root, 'conn1', 'incoming', 'acme-2027-01-03.csv'), body);
    const r = await c.fetchApproved(ctx, null, 500);
    expect(r.records.map((x) => [x.externalId, x.data.invoice_number, x.data.amount_kes])).toEqual([['A-1', 'INV-9', '1,000,000.00'], ['A-2', 'INV, 10', '500000']]);
    expect(r.files).toEqual([{ name: 'acme-2027-01-03.csv', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), status: 'read', rows: 2 }]);
    const mapped = mapErpRecord(r.records[0], DEFAULT_ERP_MAPPINGS.csv_sftp);
    expect(mapped).toMatchObject({ ok: true, invoice: { amountCents: kes(1_000_000), etimsCuInvoiceNo: 'KRACU9' } });
    expect(mapErpRecord(r.records[1], DEFAULT_ERP_MAPPINGS.csv_sftp)).toEqual({ ok: false, skip: 'not_approved', errors: [] });
    await c.ack!(r);
    expect(readdirSync(join(root, 'conn1', 'incoming'))).toEqual([]);
    expect(readdirSync(join(root, 'conn1', 'processed'))).toEqual([`${r.files![0].sha256}-acme-2027-01-03.csv`]);
    writeFileSync(join(root, 'conn1', 'incoming', 'again.csv'), body);
    const r2 = await c.fetchApproved(ctx, null, 500);
    expect(r2.records).toEqual([]);
    expect(r2.files![0]).toMatchObject({ name: 'again.csv', status: 'duplicate_file' });
    await c.ack!(r2);
    expect(readdirSync(join(root, 'conn1', 'rejected'))).toEqual([`${r.files![0].sha256}-again.csv`]);
  });
  it('rejects unsafe or oversized input: missing header, too many rows, path tricks in names are ignored', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drop-'));
    const c = new CsvDropConnector('sandbox', { dropDir: join(root, 'c') });
    mkdirSync(join(root, 'c', 'incoming'), { recursive: true });
    writeFileSync(join(root, 'c', 'incoming', 'noheader.csv'), 'P051111111B,INV-1,100,KES\n');
    writeFileSync(join(root, 'c', 'incoming', 'big.csv'), `${header}\n` + Array.from({ length: 501 }, (_, i) => `B-${i},P051111111B,I-${i},100,KES,2027-01-02,2027-02-21,,approved`).join('\n'));
    writeFileSync(join(root, 'c', 'incoming', 'notes.txt'), 'ignored');
    const r = await c.fetchApproved(ctx, null, 500);
    expect(r.records).toEqual([]);
    expect(r.files!.map((f) => [f.name, f.status])).toEqual([['big.csv', 'too_many_rows'], ['noheader.csv', 'bad_header']]);
  });
  it('mock mode needs no folder', async () => {
    expect((await new CsvDropConnector('mock', { dropDir: '' }).health()).ok).toBe(true);
  });
});

describe('TC-P3U-ERP-04 SAP, Sage and Dynamics connectors (assumed field names, injected fetch)', () => {
  it('SAP S/4HANA OData API_SUPPLIERINVOICE_PROCESS_SRV: filters on LastChangeDateTime, basic auth, d.results', async () => {
    const { calls, f } = jsonFetch(() => ({ body: { d: { results: [{ SupplierInvoice: '5105600001', FiscalYear: '2027', SupplierInvoiceIDByInvcgParty: 'INV-7', InvoiceGrossAmount: '1000000.00', DocumentCurrency: 'KES',
      DocumentDate: '/Date(1798848000000)/', DueCalculationBaseDate: '/Date(1798848000000)/', NetPaymentDays: 50, YY1_KRAPIN_SINV: 'P051111111B', SupplierInvoiceStatus: '5', LastChangeDateTime: '/Date(1798934400000+0000)/' }] } } }));
    const c = new SapConnector('sandbox', { baseUrl: 'https://sap.local' }, 'user:pass', f);
    const r = await c.fetchApproved(ctx, null, 50);
    expect(calls[0].url).toContain('/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice?');
    expect(decodeURIComponent(calls[0].url)).toContain('$top=50');
    expect(calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
    expect(r.records[0].externalId).toBe('2027/5105600001');
    expect(mapErpRecord(r.records[0], DEFAULT_ERP_MAPPINGS.sap)).toEqual({ ok: true, invoice: { supplierKraPin: 'P051111111B', invoiceNumber: 'INV-7', amountCents: kes(1_000_000), currency: 'KES', issueDate: '2027-01-02', dueDate: '2027-02-21' } });
    expect(r.nextCursor).toBe('/Date(1798934400000+0000)/');
  });
  it('Sage Business Cloud Accounting v3.1 purchase_invoices: bearer token, updated_or_created_since, $items', async () => {
    const { calls, f } = jsonFetch(() => ({ body: { $items: [{ id: 'abc', vendor_reference: 'INV-8', contact: { id: 'c1', displayed_as: 'Jua Kali', tax_number: 'P051111111B' }, total_amount: '500000.00', currency: { id: 'KES' }, date: '2027-01-02', due_date: '2027-02-21', status: { id: 'UNPAID' }, updated_at: '2027-01-03T08:00:00Z' }], $next: null } }));
    const c = new SageConnector('sandbox', { baseUrl: 'https://api.accounting.sage.com/v3.1' }, 'tok', f);
    const r = await c.fetchApproved(ctx, '2027-01-01T00:00:00Z', 20);
    expect(calls[0].url).toContain('/purchase_invoices?');
    expect(calls[0].url).toContain('updated_or_created_since=2027-01-01T00%3A00%3A00Z');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(mapErpRecord(r.records[0], DEFAULT_ERP_MAPPINGS.sage)).toMatchObject({ ok: true, invoice: { invoiceNumber: 'INV-8', amountCents: kes(500_000) } });
    expect(r.nextCursor).toBe('2027-01-03T08:00:00Z');
  });
  it('Dynamics 365 Business Central purchaseInvoices: status Open only, lastModifiedDateTime cursor, value[]', async () => {
    const { calls, f } = jsonFetch(() => ({ body: { value: [{ id: 'g1', number: 'PI-1', vendorInvoiceNumber: 'INV-9', vendorNumber: 'V1', vendor: { taxRegistrationNumber: 'P051111111B' }, invoiceDate: '2027-01-02', dueDate: '2027-02-21', currencyCode: '', totalAmountIncludingTax: 250000, status: 'Open', lastModifiedDateTime: '2027-01-03T08:00:00Z' }] } }));
    const c = new DynamicsConnector('sandbox', { baseUrl: 'https://api.businesscentral.dynamics.com/v2.0/t/production', companyId: 'co-1' }, 'tok', f);
    const r = await c.fetchApproved(ctx, null, 20);
    expect(calls[0].url).toContain('/api/v2.0/companies(co-1)/purchaseInvoices?');
    expect(decodeURIComponent(calls[0].url)).toContain("status eq 'Open'");
    // blank currencyCode = local currency (assumed KES for a Kenyan company)
    expect(mapErpRecord(r.records[0], DEFAULT_ERP_MAPPINGS.dynamics)).toMatchObject({ ok: true, invoice: { invoiceNumber: 'INV-9', amountCents: kes(250_000), currency: 'KES' } });
  });
  it('401 -> ERP_AUTH_FAILED, 500 -> ERP_UNAVAILABLE for the REST connectors', async () => {
    const a = jsonFetch(() => ({ status: 401, body: {} }));
    await expect(new SageConnector('sandbox', { baseUrl: 'https://x' }, 't', a.f).fetchApproved(ctx, null, 1)).rejects.toMatchObject({ code: 'ERP_AUTH_FAILED' });
    const b = jsonFetch(() => ({ status: 500, body: {} }));
    await expect(new SapConnector('sandbox', { baseUrl: 'https://x' }, 'u:p', b.f).fetchApproved(ctx, null, 1)).rejects.toMatchObject({ code: 'ERP_UNAVAILABLE', retryable: true });
  });
});

describe('TC-P3U-ERP-05 mock ERP and registry', () => {
  it('MockErp serves fixtures per connection with a cursor and test failure hooks', async () => {
    const m = new MockErp('conn-1');
    MockErp.push('conn-1', { externalId: 'm1', version: '1', data: { a: 1 } });
    MockErp.push('conn-1', { externalId: 'm2', version: '1', data: { a: 2 } });
    const r = await m.fetchApproved(ctx, null, 1);
    expect(r.records.map((x) => x.externalId)).toEqual(['m1']);
    expect((await m.fetchApproved(ctx, r.nextCursor, 10)).records.map((x) => x.externalId)).toEqual(['m2']);
    MockErp.failNext('conn-1', 'ERP_UNAVAILABLE');
    await expect(m.fetchApproved(ctx, null, 1)).rejects.toMatchObject({ code: 'ERP_UNAVAILABLE' });
    MockErp.reset('conn-1');
  });
  it('registry: mock mode returns MockErp for every kind; sandbox builds the real connector; live outside production is refused', () => {
    const mock = new ErpRegistry('mock', {});
    expect(mock.connector({ id: 'c', kind: 'sap', config: {} }, undefined)).toBeInstanceOf(MockErp);
    const sb = new ErpRegistry('sandbox', { ERP_DROP_ROOT: '/tmp/drop' });
    expect(sb.connector({ id: 'c', kind: 'odoo', config: { baseUrl: 'http://o', database: 'd', username: 'u' } }, 'k')).toBeInstanceOf(OdooConnector);
    expect(sb.connector({ id: 'c', kind: 'csv_sftp', config: {} }, undefined)).toBeInstanceOf(CsvDropConnector);
    expect(() => sb.connector({ id: 'c', kind: 'odoo', config: { baseUrl: 'http://o', database: 'd', username: 'u' } }, undefined)).toThrow(/ERP_SECRET_MISSING/);
    expect(() => createAdapters({ ADAPTER_MODE_ERP: 'live' })).toThrow(/only allowed in production/);
    const a = createAdapters({});
    expect(a.erp.mode).toBe('mock');
    expect(a.mpesa).toBeInstanceOf(MockMpesa);
  });
});

describe('TC-P3U-MP-01 MockMpesa B2C', () => {
  it('accepts a whole-shilling payout, is idempotent on OriginatorConversationID, and completes with a receipt and a statement line', async () => {
    const m = new MockMpesa();
    m.fund(kes(1_000_000), 'FLOAT-1', '2027-01-04');
    const a = await m.b2cPayment(ctx, { idempotencyKey: 'pay-1', amountCents: kes(120_000), msisdn: '254712345678', remarks: 'Mapema advance' });
    expect(a).toEqual({ originatorConversationId: 'pay-1', conversationId: expect.stringMatching(/^AG_/), accepted: true });
    expect(await m.b2cPayment(ctx, { idempotencyKey: 'pay-1', amountCents: kes(120_000), msisdn: '254712345678', remarks: 'x' })).toEqual(a);
    expect(m.requests).toHaveLength(1);
    m.chargeCents = kes(15);
    const body = m.complete('pay-1', { receiverName: 'PETER KAMAU', date: '2027-01-04' });
    const res = parseB2cResult(body);
    expect(res).toMatchObject({ originatorConversationId: 'pay-1', resultCode: 0, transactionId: expect.stringMatching(/^[A-Z0-9]{10}$/), amountCents: kes(120_000), receiverName: '254712***678 - PETER KAMAU' });
    expect(await m.getBalance()).toBe(kes(1_000_000) - kes(120_000) - kes(15));
    expect((await m.getStatement('2027-01-04', '2027-01-04')).map((l) => [l.amountCents, l.type])).toEqual([[kes(1_000_000), 'credit'], [-kes(120_000), 'debit'], [-kes(15), 'charge']]);
    expect(await m.queryStatus(ctx, 'pay-1')).toMatchObject({ state: 'completed', result: { transactionId: res.transactionId } });
  });
  it('rejects cents, bad numbers and amounts outside KES 10 - 250,000 before calling the provider', async () => {
    const m = new MockMpesa();
    await expect(m.b2cPayment(ctx, { idempotencyKey: 'a', amountCents: 12_000_050n, msisdn: '254712345678', remarks: 'x' })).rejects.toMatchObject({ code: 'MPESA_WHOLE_SHILLINGS' });
    await expect(m.b2cPayment(ctx, { idempotencyKey: 'b', amountCents: kes(100), msisdn: '0712345678', remarks: 'x' })).rejects.toMatchObject({ code: 'MPESA_BAD_MSISDN' });
    await expect(m.b2cPayment(ctx, { idempotencyKey: 'c', amountCents: kes(250_001), msisdn: '254712345678', remarks: 'x' })).rejects.toMatchObject({ code: 'MPESA_AMOUNT_RANGE' });
  });
  it('failure and timeout callbacks; status query reports pending, failed or unknown; nothing moves money on failure', async () => {
    const m = new MockMpesa();
    m.fund(kes(500_000), 'F', '2027-01-04');
    await m.b2cPayment(ctx, { idempotencyKey: 'f1', amountCents: kes(100_000), msisdn: '254712345678', remarks: 'x' });
    expect((await m.queryStatus(ctx, 'f1')).state).toBe('pending');
    const fail = parseB2cResult(m.fail('f1', 2001, 'The initiator information is invalid.'));
    expect(fail).toMatchObject({ resultCode: 2001, resultDesc: 'The initiator information is invalid.' });
    expect(fail.transactionId).toBeUndefined();
    expect((await m.queryStatus(ctx, 'f1')).state).toBe('failed');
    expect(await m.getBalance()).toBe(kes(500_000));
    await m.b2cPayment(ctx, { idempotencyKey: 't1', amountCents: kes(100_000), msisdn: '254712345678', remarks: 'x' });
    expect(parseB2cResult(m.timeoutBody('t1'))).toMatchObject({ originatorConversationId: 't1', timeout: true });
    m.statusOverride.set('t1', 'unknown');
    expect((await m.queryStatus(ctx, 't1')).state).toBe('unknown');
    expect(() => parseB2cResult({ nope: 1 })).toThrow(/MPESA_BAD_CALLBACK/);
  });
});

describe('TC-P3U-MP-02 Daraja sandbox adapter (injected fetch, never the real host in tests)', () => {
  const cfg = { baseUrl: 'https://sandbox.safaricom.co.ke', consumerKey: 'ck', consumerSecret: 'cs', shortcode: '600999', initiatorName: 'testapi', securityCredential: 'ENC', resultUrl: 'https://cb.example/r', timeoutUrl: 'https://cb.example/t' };
  it('OAuth then B2C v3 payment request with whole-shilling Amount and the callback URLs', async () => {
    const { calls, f } = jsonFetch((url) => url.includes('/oauth/')
      ? { body: { access_token: 'AT1', expires_in: '3599' } }
      : { body: { ConversationID: 'AG_1', OriginatorConversationID: 'pay-9', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } });
    const d = new DarajaMpesa('sandbox', cfg, f);
    const a = await d.b2cPayment(ctx, { idempotencyKey: 'pay-9', amountCents: kes(120_000), msisdn: '254712345678', remarks: 'Mapema advance' });
    expect(a).toEqual({ originatorConversationId: 'pay-9', conversationId: 'AG_1', accepted: true });
    expect(calls[0].url).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect(calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('ck:cs').toString('base64')}`);
    expect(calls[1].url).toBe('https://sandbox.safaricom.co.ke/mpesa/b2c/v3/paymentrequest');
    expect(JSON.parse(calls[1].init.body)).toEqual({ OriginatorConversationID: 'pay-9', InitiatorName: 'testapi', SecurityCredential: 'ENC', CommandID: 'BusinessPayment', Amount: 120000,
      PartyA: '600999', PartyB: '254712345678', Remarks: 'Mapema advance', QueueTimeOutURL: 'https://cb.example/t', ResultURL: 'https://cb.example/r', Occassion: 'pay-9' });
    await d.b2cPayment(ctx, { idempotencyKey: 'pay-10', amountCents: kes(1_000), msisdn: '254712345678', remarks: 'x' });
    expect(calls.filter((c) => c.url.includes('/oauth/'))).toHaveLength(1); // token cached
  });
  it('maps errors: 401 -> MPESA_AUTH_FAILED; ResponseCode != 0 -> MPESA_REJECTED; 5xx -> MPESA_UNAVAILABLE (caller must query, never resend)', async () => {
    await expect(new DarajaMpesa('sandbox', cfg, jsonFetch(() => ({ status: 401, body: {} })).f).b2cPayment(ctx, { idempotencyKey: 'x', amountCents: kes(100), msisdn: '254712345678', remarks: 'x' })).rejects.toMatchObject({ code: 'MPESA_AUTH_FAILED' });
    const rej = jsonFetch((url) => url.includes('/oauth/') ? { body: { access_token: 'A', expires_in: '3599' } } : { status: 400, body: { requestId: 'r', errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PartyB' } });
    await expect(new DarajaMpesa('sandbox', cfg, rej.f).b2cPayment(ctx, { idempotencyKey: 'x', amountCents: kes(100), msisdn: '254712345678', remarks: 'x' })).rejects.toMatchObject({ code: 'MPESA_REJECTED', retryable: false });
    const down = jsonFetch((url) => url.includes('/oauth/') ? { body: { access_token: 'A', expires_in: '3599' } } : { status: 503, body: {} });
    await expect(new DarajaMpesa('sandbox', cfg, down.f).b2cPayment(ctx, { idempotencyKey: 'x', amountCents: kes(100), msisdn: '254712345678', remarks: 'x' })).rejects.toMatchObject({ code: 'MPESA_UNAVAILABLE', retryable: true });
  });
  it('status query is asynchronous on Daraja: the request is sent and the state is pending until the result callback', async () => {
    const { calls, f } = jsonFetch((url) => url.includes('/oauth/') ? { body: { access_token: 'A', expires_in: '3599' } } : { body: { ResponseCode: '0', ConversationID: 'AG_2', OriginatorConversationID: 'q' } });
    const d = new DarajaMpesa('sandbox', cfg, f);
    expect(await d.queryStatus(ctx, 'pay-9')).toEqual({ state: 'pending' });
    expect(calls[1].url).toBe('https://sandbox.safaricom.co.ke/mpesa/transactionstatus/v1/query');
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ CommandID: 'TransactionStatusQuery', OriginatorConversationID: 'pay-9', PartyA: '600999', IdentifierType: '4' });
  });
});

describe('TC-P3U-FUND-04 MockLedger funds and funding tags', () => {
  it('ensureFund is idempotent; bookAdvance records the fund; the tag can move, the fund cannot', async () => {
    const l = new MockLedger();
    const fa = await l.ensureFund('FAC-A', 'Facility A');
    expect(await l.ensureFund('FAC-A', 'Facility A')).toBe(fa);
    const c = await l.createClient(ctx, { externalId: 's', legalName: 'S', activationDate: '2027-01-01' });
    const { loanId } = await l.bookAdvance(ctx, { externalId: 'a', clientId: c, principalCents: kes(800_000), rateBpsPer30d: 350, days: 48, disbursementDate: '2027-01-04', dueDate: '2027-02-21', verificationFeeCents: kes(2_500), fundId: fa });
    expect(await l.getFundingTag(loanId)).toEqual({ fundId: fa, tagCode: null });
    await l.setFundingTag(loanId, 'FAC-A', '2027-01-04');
    await l.setFundingTag(loanId, 'EQUITY', '2027-01-10');
    expect(await l.getFundingTag(loanId)).toEqual({ fundId: fa, tagCode: 'EQUITY' });
    await expect(l.setFundingTag(999, 'X', '2027-01-10')).rejects.toThrow(/LOAN_NOT_FOUND/);
  });
});
