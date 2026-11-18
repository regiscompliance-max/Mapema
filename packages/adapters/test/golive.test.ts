/**
 * [QA Engineer + Security Engineer] Go-live hardening: S-13 outbound allow-list / SSRF guard and
 * S-16 CSV drop-folder trust (file type checks + malware scanning, fail closed).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkEgressUrl, ClamdScanner, createScanner, CsvDropConnector, eicarTestString, egressPolicyFromEnv, ErpRegistry, FakeOdoo, guardedFetch, isPrivateAddress, MockScanner,
} from '../src';

const ctx = { requestId: 'gl-test' };
const P = { allow: ['erp.acme.co.ke', '*.odoo.com', '10.20.0.5'], allowHttp: false };

describe('TC-GL-S13-01 outbound URL policy (static)', () => {
  it('allows only listed hosts over https; wildcard means sub-domains only', () => {
    expect(checkEgressUrl('https://erp.acme.co.ke/jsonrpc', P)).toBeNull();
    expect(checkEgressUrl('https://acme.odoo.com/jsonrpc', P)).toBeNull();
    expect(checkEgressUrl('https://odoo.com/jsonrpc', P)).toBe('ERP_HOST_NOT_ALLOWED');
    expect(checkEgressUrl('https://evil.example/jsonrpc', P)).toBe('ERP_HOST_NOT_ALLOWED');
    expect(checkEgressUrl('https://erp.acme.co.ke.evil.example/', P)).toBe('ERP_HOST_NOT_ALLOWED');
    expect(checkEgressUrl('http://erp.acme.co.ke/jsonrpc', P)).toBe('ERP_HTTPS_REQUIRED');
    expect(checkEgressUrl('https://user:pw@erp.acme.co.ke/', P)).toBe('ERP_BAD_URL');
    expect(checkEgressUrl('https://erp.acme.co.ke:8443/', P)).toBe('ERP_HOST_NOT_ALLOWED');
    expect(checkEgressUrl('file:///etc/passwd', P)).toBe('ERP_HTTPS_REQUIRED');
    expect(checkEgressUrl('not a url', P)).toBe('ERP_BAD_URL');
  });
  it('private / loopback / metadata IP literals are refused unless that exact IP is listed', () => {
    for (const u of ['https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/', 'https://192.168.1.10/', 'https://172.16.0.1/'])
      expect(checkEgressUrl(u, { ...P, allow: [...P.allow, '*.0.1'] }), u).not.toBeNull();
    expect(checkEgressUrl('https://10.20.0.5/', P)).toBeNull(); // explicitly listed private link
  });
  it('isPrivateAddress covers RFC 1918, CGNAT, link-local, ULA, mapped IPv4', () => {
    for (const ip of ['10.0.0.1', '172.31.255.255', '192.168.0.1', '100.64.0.1', '169.254.169.254', '127.0.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['41.90.64.1', '197.248.0.1', '8.8.8.8', '2001:4860::8888']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('unset ERP_ALLOWED_HOSTS = nothing allowed (fail closed); http only in development/test with ERP_ALLOW_HTTP', () => {
    expect(egressPolicyFromEnv({})).toEqual({ allow: [], allowHttp: false });
    expect(checkEgressUrl('https://erp.acme.co.ke/', egressPolicyFromEnv({}))).toBe('ERP_HOST_NOT_ALLOWED');
    expect(egressPolicyFromEnv({ APP_ENV: 'production', ERP_ALLOW_HTTP: 'true' }).allowHttp).toBe(false);
    expect(egressPolicyFromEnv({ APP_ENV: 'test', ERP_ALLOW_HTTP: 'true', ERP_ALLOWED_HOSTS: ' A.example , b.example' })).toEqual({ allow: ['a.example', 'b.example'], allowHttp: true });
  });
});

describe('TC-GL-S13-02 guarded fetch (DNS + redirects)', () => {
  const seen: any[] = [];
  const f = (async (url: string, init: any) => { seen.push({ url, init }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  it('a listed name that resolves to a private address is refused (DNS rebinding / internal name)', async () => {
    const g = guardedFetch(f, P, async () => ['10.0.0.7']);
    await expect(g('https://acme.odoo.com/jsonrpc', {})).rejects.toMatchObject({ code: 'ERP_PRIVATE_ADDRESS', retryable: false });
    expect(seen).toHaveLength(0);
  });
  it('a public resolution is allowed and redirects are never followed', async () => {
    const g = guardedFetch(f, P, async () => ['41.90.64.10']);
    await g('https://acme.odoo.com/jsonrpc', { method: 'POST' });
    expect(seen[0]).toMatchObject({ url: 'https://acme.odoo.com/jsonrpc', init: { method: 'POST', redirect: 'error' } });
  });
  it('the registry wires the guard into every HTTP connector (Odoo to an unlisted host never leaves the box)', async () => {
    const odoo = new FakeOdoo({ db: 'acme', login: 'api@acme.test', apiKey: 'k' });
    const url = await odoo.listen();
    try {
      const deny = new ErpRegistry('sandbox', { APP_ENV: 'test', ERP_ALLOW_HTTP: 'true' }).connector({ id: 'c1', kind: 'odoo', config: { baseUrl: url, database: 'acme', username: 'api@acme.test' } }, 'k');
      await expect(deny.fetchApproved(ctx, null, 5)).rejects.toMatchObject({ code: 'ERP_HOST_NOT_ALLOWED' });
      expect(odoo.calls).toHaveLength(0);
      const ok = new ErpRegistry('sandbox', { APP_ENV: 'test', ERP_ALLOW_HTTP: 'true', ERP_ALLOWED_HOSTS: '127.0.0.1' }).connector({ id: 'c1', kind: 'odoo', config: { baseUrl: url, database: 'acme', username: 'api@acme.test' } }, 'k');
      await expect(ok.fetchApproved(ctx, null, 5)).resolves.toMatchObject({ records: [] });
      expect(odoo.calls.length).toBeGreaterThan(0);
    } finally { await odoo.close(); }
  });
});

const csv = 'invoice_number,supplier_kra_pin,amount,currency,issue_date,due_date,status\nINV-1,P051111111B,1000.00,KES,2027-01-02,2027-02-21,approved\n';
function drop() {
  const root = mkdtempSync(join(tmpdir(), 'gl-drop-'));
  const inc = join(root, 'incoming'); mkdirSync(inc, { recursive: true });
  return { root, inc };
}

describe('TC-GL-S16-01 CSV drop folder trust', () => {
  it('symlinks, non-regular entries and world-writable files are rejected without being read; a clean file is read', async () => {
    const { root, inc } = drop();
    const secret = join(root, '..', `gl-secret-${Date.now()}.csv`); writeFileSync(secret, csv);
    symlinkSync(secret, join(inc, 'a-link.csv'));
    mkdirSync(join(inc, 'b-dir.csv'));
    writeFileSync(join(inc, 'c-open.csv'), csv); chmodSync(join(inc, 'c-open.csv'), 0o666);
    writeFileSync(join(inc, 'd-good.csv'), csv); chmodSync(join(inc, 'd-good.csv'), 0o640);
    const c = new CsvDropConnector('sandbox', { dropDir: root });
    const r = await c.fetchApproved(ctx, null, 100);
    expect(r.files!.map((f) => `${f.name}:${f.status}:${f.detail ?? ''}`)).toEqual([
      'a-link.csv:unsafe_file:symlink', 'b-dir.csv:unsafe_file:not a regular file', 'c-open.csv:unsafe_file:world-writable', 'd-good.csv:read:',
    ]);
    expect(r.records).toHaveLength(1);
    await c.ack(r);
    expect(readdirSync(join(root, 'rejected')).length).toBe(3);
    expect(existsSync(secret)).toBe(true); // the link target was never moved or read
  });
  it('an infected file is quarantined and never parsed; a scanner outage leaves the file in incoming (fail closed)', async () => {
    const { root, inc } = drop();
    writeFileSync(join(inc, 'eicar.csv'), `${csv}${eicarTestString()}\n`);
    const c = new CsvDropConnector('sandbox', { dropDir: root }, new MockScanner());
    const r = await c.fetchApproved(ctx, null, 100);
    expect(r.files).toEqual([expect.objectContaining({ name: 'eicar.csv', status: 'infected', detail: 'Eicar-Test-Signature' })]);
    expect(r.records).toEqual([]);
    await c.ack(r);
    expect(readdirSync(join(root, 'quarantine'))).toHaveLength(1);

    writeFileSync(join(inc, 'later.csv'), csv);
    const down = new CsvDropConnector('sandbox', { dropDir: root }, new ClamdScanner('sandbox', '127.0.0.1', 1, 500));
    const r2 = await down.fetchApproved(ctx, null, 100);
    expect(r2.files).toEqual([expect.objectContaining({ name: 'later.csv', status: 'scan_failed' })]);
    await down.ack(r2);
    expect(readdirSync(inc)).toEqual(['later.csv']);
  });
});

describe('TC-GL-S16-02 clamd INSTREAM client (against a local fake clamd)', () => {
  it('speaks the INSTREAM framing and maps OK / FOUND', async () => {
    const got: Buffer[] = [];
    const srv = createServer((s) => {
      const parts: Buffer[] = [];
      s.on('data', (d) => parts.push(d));
      s.on('end', () => {
        const all = Buffer.concat(parts); got.push(all);
        const cmd = all.subarray(0, 10).toString();
        let off = 10; const body: Buffer[] = [];
        for (;;) { const n = all.readUInt32BE(off); off += 4; if (n === 0) break; body.push(all.subarray(off, off + n)); off += n; }
        const data = Buffer.concat(body);
        s.end(cmd === 'zINSTREAM\0' && data.includes(eicarTestString()) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    try {
      const sc = new ClamdScanner('sandbox', '127.0.0.1', port);
      expect(await sc.scan(Buffer.alloc(200_000, 'a'))).toEqual({ clean: true });
      expect(await sc.scan(Buffer.from(`x${eicarTestString()}y`))).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
      expect((await sc.health()).ok).toBe(true);
      expect(got[0].subarray(0, 10).toString()).toBe('zINSTREAM\0');
    } finally { srv.close(); }
  });
  it('mock scanning is refused in production', () => {
    expect(() => createScanner({ APP_ENV: 'production', ADAPTER_MODE_AV: 'mock' })).toThrow(/not allowed in production/);
    expect(createScanner({ ADAPTER_MODE_AV: 'sandbox', CLAMD_HOST: 'clamav', CLAMD_PORT: '3310' })).toBeInstanceOf(ClamdScanner);
  });
});
