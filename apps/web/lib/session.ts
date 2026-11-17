'use client';
/**
 * [Security Engineer + Frontend Engineer] Browser session (Phase 1b).
 * The API holds the session server-side and sets an httpOnly, Secure, SameSite=Strict cookie; this
 * module never stores a token. Sign-in obtains an IdP access token, immediately exchanges it at
 * POST /v1/auth/session (it stays in a local variable only), and keeps the returned CSRF token in memory.
 * After a page reload, loadSession() asks GET /v1/auth/session for the CSRF token again.
 * Production: OIDC authorization-code + PKCE against Keycloak (NEXT_PUBLIC_OIDC_ISSUER); MFA and
 * step-up are enforced by Keycloak and checked again by the API (amr / auth_time).
 * Development: the API's dev IdP (only when NEXT_PUBLIC_DEV_SIGNIN=true and the API allows it).
 */
import { api, ApiError } from './api';
import { getCsrf, setCsrf } from './csrf';

export interface SessionUser { id?: string; email: string; displayName?: string; roles: { role: string; orgId: string | null }[] }
export interface SessionInfo { csrfToken: string | null; user: SessionUser }

export const csrfToken = getCsrf;

async function exchange(accessToken: string): Promise<SessionInfo> {
  const s = await api<SessionInfo>('/auth/session', { body: { accessToken } });
  setCsrf(s.csrfToken);
  return s;
}

/** Returns the current session (and restores the in-memory CSRF token), or null when signed out. */
export async function loadSession(): Promise<SessionInfo | null> {
  try {
    const s = await api<SessionInfo>('/auth/session');
    setCsrf(s.csrfToken);
    return s;
  } catch (e) {
    setCsrf(null);
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export async function signOut() {
  try { await api('/auth/logout', { body: {} }); } finally { setCsrf(null); }
}

export async function devSignIn(email: string, factor: 'otp' | 'sms') {
  const r = await api<{ accessToken: string }>('/dev-idp/token', { body: { email, factor } });
  return exchange(r.accessToken);
}

function b64url(buf: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Start OIDC code + PKCE. NOT exercised yet (Keycloak was not run on the build box). */
export async function oidcSignIn(opts: { stepUp?: boolean } = {}) {
  const issuer = process.env.NEXT_PUBLIC_OIDC_ISSUER!;
  const clientId = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? 'mapema-web';
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  // one-time PKCE values for the redirect round-trip (not a credential; removed on return)
  sessionStorage.setItem('mapema.pkce', JSON.stringify({ verifier, state }));
  const p = new URLSearchParams({ client_id: clientId, response_type: 'code', scope: 'openid email', redirect_uri: `${location.origin}/signin/callback`, state, code_challenge: challenge, code_challenge_method: 'S256' });
  if (opts.stepUp) { p.set('max_age', '0'); p.set('acr_values', 'mfa'); }
  location.assign(`${issuer}/protocol/openid-connect/auth?${p}`);
}

export async function oidcCallback(params: URLSearchParams) {
  const saved = JSON.parse(sessionStorage.getItem('mapema.pkce') ?? 'null');
  sessionStorage.removeItem('mapema.pkce');
  if (!saved || saved.state !== params.get('state')) throw new Error('Sign-in state mismatch');
  const issuer = process.env.NEXT_PUBLIC_OIDC_ISSUER!;
  const res = await fetch(`${issuer}/protocol/openid-connect/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code') ?? '', redirect_uri: `${location.origin}/signin/callback`, client_id: process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? 'mapema-web', code_verifier: saved.verifier }) });
  if (!res.ok) throw new Error('Sign-in failed');
  const t = await res.json();
  return exchange(t.access_token); // token goes straight to the API and is then dropped
}
