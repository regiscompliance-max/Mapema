/**
 * [Security Engineer] S-12 (go-live): secrets that must travel in a URL path (Daraja does not sign
 * callbacks, so the M-Pesa ResultURL / QueueTimeOutURL carry a secret path token) are masked before a
 * URL is logged or echoed. The reverse proxy masks the same paths in its access log
 * (infra/proxy/nginx.conf), so the token never lands in a log file.
 */
import { BlockList, isIP } from 'node:net';

const SECRET_PATHS: RegExp[] = [/(\/webhooks\/mpesa\/b2c\/(?:result|timeout)\/)[^/?#]+/g];

export function redactUrl(url: string | undefined | null): string | undefined {
  if (url == null) return undefined;
  return SECRET_PATHS.reduce((u, re) => u.replace(re, '$1[redacted]'), String(url));
}

/** CIDR / single-IP allow-list ("196.201.214.0/24, 196.201.213.114"). Empty list = allow all. */
export function ipAllowList(spec: string | undefined) {
  const entries = (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return null;
  const bl = new BlockList();
  for (const e of entries) {
    const [ip, bits] = e.split('/');
    const fam = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (!isIP(ip)) throw new Error(`invalid IP allow-list entry: ${e}`);
    if (bits) bl.addSubnet(ip, Number(bits), fam); else bl.addAddress(ip, fam);
  }
  return (addr: string | undefined) => {
    if (!addr) return false;
    const a = addr.replace(/^::ffff:/, '');
    const fam = isIP(a) === 6 ? 'ipv6' : isIP(a) === 4 ? 'ipv4' : null;
    return fam ? bl.check(a, fam) : false;
  };
}
