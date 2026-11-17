/**
 * [Security Engineer + Frontend Engineer] Phase 1b: the browser never stores sign-in tokens.
 * The API sets an httpOnly cookie; the page keeps only the CSRF token, in memory.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { csrfToken, devSignIn, loadSession, signOut } from '../lib/session';

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
const SRC = [join(__dirname, '../app'), join(__dirname, '../components'), join(__dirname, '../lib')].flatMap(walk);

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function mockFetch(responder: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  calls = [];
  globalThis.fetch = vi.fn(async (url: any, init: any = {}) => {
    calls.push({ url: String(url), init });
    const r = responder(String(url), init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
}
const hdr = (c: Call, k: string) => new Headers(c.init.headers as any).get(k);

describe('no tokens in browser storage', () => {
  it('no source file writes a token to localStorage/sessionStorage or sends a bearer header', () => {
    for (const f of SRC) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/localStorage/);
      // the only sessionStorage use allowed is the one-time PKCE verifier/state during an OIDC redirect
      for (const m of src.matchAll(/sessionStorage\.setItem\(\s*'([^']+)'/g)) expect(m[1], f).toBe('mapema.pkce');
      expect(src, f).not.toMatch(/Authorization:\s*`Bearer/);
      expect(src, f).not.toMatch(/setSession\(/);
    }
  });
});

describe('cookie session client', () => {
  beforeEach(() => { mockFetch(() => ({ status: 200, body: {} })); });

  it('devSignIn swaps the dev IdP token for a cookie session and keeps only the CSRF token in memory', async () => {
    mockFetch((url) => url.endsWith('/dev-idp/token') ? { status: 201, body: { accessToken: 'eyJ.fake.jwt' } }
      : url.endsWith('/auth/session') ? { status: 201, body: { csrfToken: 'c'.repeat(43), user: { email: 'a@b.c', roles: [] } } } : { status: 404 });
    await devSignIn('a@b.c', 'otp');
    expect(calls.map((c) => c.url.replace(/^.*\/v1/, ''))).toEqual(['/dev-idp/token', '/auth/session']);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ accessToken: 'eyJ.fake.jwt' });
    expect(calls[1].init.credentials).toBe('include');
    expect(csrfToken()).toBe('c'.repeat(43));
  });

  it('every API call sends credentials; writes add X-CSRF-Token; nothing sends Authorization', async () => {
    mockFetch(() => ({ status: 200, body: { ok: true } }));
    await api('/me');
    await api('/complaints', { body: { x: 1 } });
    expect(calls.every((c) => c.init.credentials === 'include')).toBe(true);
    expect(calls.every((c) => hdr(c, 'Authorization') === null)).toBe(true);
    expect(hdr(calls[0], 'X-CSRF-Token')).toBeNull();
    expect(hdr(calls[1], 'X-CSRF-Token')).toBe('c'.repeat(43));
  });

  it('loadSession restores the CSRF token after a reload from GET /auth/session; 401 means signed out', async () => {
    mockFetch(() => ({ status: 200, body: { csrfToken: 'd'.repeat(43), user: { email: 'x@y.z', roles: [{ role: 'ops', orgId: null }] } } }));
    const s = await loadSession();
    expect(s?.user.email).toBe('x@y.z');
    expect(csrfToken()).toBe('d'.repeat(43));
    mockFetch(() => ({ status: 401, body: { title: 'SESSION_EXPIRED' } }));
    expect(await loadSession()).toBeNull();
    expect(csrfToken()).toBeNull();
  });

  it('signOut calls the logout endpoint with the CSRF token and forgets it', async () => {
    mockFetch(() => ({ status: 200, body: { csrfToken: 'e'.repeat(43), user: { email: 'x', roles: [] } } }));
    await loadSession();
    mockFetch(() => ({ status: 204 }));
    await signOut();
    expect(calls[0].url).toMatch(/\/v1\/auth\/logout$/);
    expect(hdr(calls[0], 'X-CSRF-Token')).toBe('e'.repeat(43));
    expect(csrfToken()).toBeNull();
  });
});
