/**
 * [Security Engineer + Integration Engineer] Malware scanning for files that arrive from outside
 * (go-live, S-16: CSV drop folder). Same adapter pattern as every provider:
 *   mock    - in-process; flags the industry-standard EICAR test string only (tests, demos)
 *   sandbox - ClamAV daemon (clamd) INSTREAM over TCP at CLAMD_HOST:CLAMD_PORT (a self-hosted
 *   live      container next to the SFTP host; no third-party service, no data leaves the platform)
 * A scanner that cannot answer is treated as NOT clean (fail closed): the file stays in incoming/ and
 * the run reports ERP_AV_UNAVAILABLE so ops can see it.
 */
import { Socket } from 'node:net';
import { AdapterError, AdapterMode, HealthCheck } from './common';

export interface ScanResult { clean: boolean; signature?: string }
export interface FileScanner {
  readonly mode: AdapterMode;
  scan(data: Buffer): Promise<ScanResult>;
  health(): Promise<HealthCheck>;
}

// assembled at runtime so this source file itself is not flagged by scanners
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');
export const eicarTestString = () => EICAR;

export class MockScanner implements FileScanner {
  readonly mode = 'mock' as const;
  async scan(data: Buffer): Promise<ScanResult> {
    return data.includes(EICAR) ? { clean: false, signature: 'Eicar-Test-Signature' } : { clean: true };
  }
  async health(): Promise<HealthCheck> { return { provider: 'av-mock', mode: 'mock', ok: true }; }
}

/** clamd INSTREAM protocol: "zINSTREAM\0", then <uint32 BE length><chunk>..., then a zero length. */
export class ClamdScanner implements FileScanner {
  constructor(readonly mode: AdapterMode, private readonly host: string, private readonly port: number, private readonly timeoutMs = 30_000) {}
  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const s = new Socket(); let out = '';
      const fail = (m: string) => { s.destroy(); reject(new AdapterError('av', 'ERP_AV_UNAVAILABLE', m, true)); };
      s.setTimeout(this.timeoutMs, () => fail('clamd timeout'));
      s.on('error', (e) => fail(`clamd: ${e.message}`));
      s.on('data', (d) => { out += d.toString('utf8'); });
      s.on('end', () => {
        const r = out.replace(/\0/g, '').trim(); // "stream: OK" | "stream: Eicar-Test-Signature FOUND"
        if (/: OK$/.test(r)) resolve({ clean: true });
        else if (/ FOUND$/.test(r)) resolve({ clean: false, signature: r.replace(/^stream: /, '').replace(/ FOUND$/, '') });
        else reject(new AdapterError('av', 'ERP_AV_UNAVAILABLE', `clamd answered: ${r.slice(0, 80)}`, true));
      });
      s.connect(this.port, this.host, () => {
        s.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024); const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length); s.write(len); s.write(chunk);
        }
        s.end(Buffer.alloc(4));
      });
    });
  }
  async health(): Promise<HealthCheck> {
    try { await this.scan(Buffer.from('health')); return { provider: 'clamd', mode: this.mode, ok: true }; } catch (e) { return { provider: 'clamd', mode: this.mode, ok: false, detail: (e as Error).message }; }
  }
}

export function createScanner(env: Record<string, string | undefined>): FileScanner {
  const m = (env.ADAPTER_MODE_AV ?? env.ADAPTER_MODE ?? 'mock') as AdapterMode;
  if (m === 'mock') {
    if (env.APP_ENV === 'production') throw new Error('ADAPTER_MODE_AV=mock is not allowed in production');
    return new MockScanner();
  }
  return new ClamdScanner(m, env.CLAMD_HOST ?? '127.0.0.1', Number(env.CLAMD_PORT ?? 3310));
}
