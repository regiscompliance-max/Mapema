/**
 * [Security Engineer + Integration Engineer] Outbound host allow-list / SSRF guard (go-live, S-13).
 *
 * ERP connectors call a base URL that ops types in. Before go-live that is an SSRF surface, so:
 *  1. ERP_ALLOWED_HOSTS lists the hosts the platform may call: exact names ("erp.acme.co.ke") or a
 *     suffix ("*.odoo.com" = any sub-domain, not the apex). Empty / unset = NOTHING is allowed (fail closed).
 *  2. https only, except in development/test when ERP_ALLOW_HTTP=true (the local FakeOdoo).
 *  3. No credentials in the URL, only ports 443 (or 80/any when http is allowed for local tests).
 *  4. The host's addresses are resolved before every call; loopback, private (RFC 1918), CGNAT,
 *     link-local (incl. the 169.254.169.254 cloud metadata service), multicast, reserved and IPv6
 *     ULA/link-local addresses are refused - unless the EXACT host (not a wildcard) is allow-listed,
 *     which is how a buyer reached over a private link / VPN is enabled deliberately.
 *  5. Redirects are not followed (redirect: 'error'), so an allowed host cannot bounce us elsewhere.
 * The same list is meant to be enforced again at the egress proxy (defence in depth; docs/go-live).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AdapterError } from './common';

export type EgressDenyReason = 'ERP_HOST_NOT_ALLOWED' | 'ERP_HTTPS_REQUIRED' | 'ERP_PRIVATE_ADDRESS' | 'ERP_BAD_URL';
export interface EgressPolicy { allow: string[]; allowHttp: boolean }

export function egressPolicyFromEnv(env: Record<string, string | undefined>): EgressPolicy {
  const allow = (env.ERP_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const nonProd = ['development', 'test'].includes(env.APP_ENV ?? 'development');
  return { allow, allowHttp: nonProd && env.ERP_ALLOW_HTTP === 'true' };
}

function hostMatches(host: string, pattern: string) {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

/** true for addresses an outbound integration must never reach unless explicitly allow-listed */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd)/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true; // not an IP: callers resolve first
}

/** Static check of a URL against the policy (no DNS). Returns the reason it is refused, or null. */
export function checkEgressUrl(raw: string, p: EgressPolicy): EgressDenyReason | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'ERP_BAD_URL'; }
  if (u.username || u.password) return 'ERP_BAD_URL';
  if (u.protocol !== 'https:' && !(p.allowHttp && u.protocol === 'http:')) return 'ERP_HTTPS_REQUIRED';
  if (u.protocol === 'https:' && u.port && u.port !== '443' && !p.allowHttp) return 'ERP_HOST_NOT_ALLOWED';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const exact = p.allow.includes(host);
  if (!exact && !p.allow.some((a) => hostMatches(host, a))) return 'ERP_HOST_NOT_ALLOWED';
  if (isIP(host) && isPrivateAddress(host) && !exact) return 'ERP_PRIVATE_ADDRESS';
  return null;
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * fetch wrapper enforcing the policy on every call (also re-checks DNS each time, which limits
 * DNS-rebinding to the gap between our lookup and the socket's own; the egress proxy closes that).
 */
export function guardedFetch(f: typeof fetch, p: EgressPolicy, resolve: Resolver = defaultResolver): typeof fetch {
  return (async (input: any, init: RequestInit = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const deny = checkEgressUrl(raw, p);
    if (deny) throw new AdapterError('erp', deny, `outbound call refused: ${deny}`, false);
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!isIP(host) && !p.allow.includes(host)) {
      let addrs: string[];
      try { addrs = await resolve(host); } catch { throw new AdapterError('erp', 'ERP_UNAVAILABLE', 'network: DNS lookup failed', true); }
      if (!addrs.length || addrs.some(isPrivateAddress)) throw new AdapterError('erp', 'ERP_PRIVATE_ADDRESS', 'outbound call refused: ERP_PRIVATE_ADDRESS', false);
    }
    return f(raw, { ...init, redirect: 'error' });
  }) as typeof fetch;
}
