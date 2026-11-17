'use client';
/**
 * [Security Engineer + Frontend Engineer] Browser session.
 * Production: OIDC authorization-code + PKCE against Keycloak (NEXT_PUBLIC_OIDC_ISSUER); MFA and
 * step-up are enforced by Keycloak and checked again by the API (amr / auth_time).
 * Development: the API's dev IdP (only when NEXT_PUBLIC_DEV_SIGNIN=true and the API allows it).
 * The access token is kept in sessionStorage (cleared when the tab closes). A backend-for-frontend
 * with httpOnly cookies is the recommended hardening before go-live (see security checklist).
 */
import { api } from './api';

const KEY = 'mapema.session';
export interface Session { accessToken: string; email: string; expiresAt: number }

export function getSession(): Session | null {
  if (typeof window === 'undefined') return null;
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Session | null;
    return s && s.expiresAt > Date.now() ? s : null;
  } catch { return null; }
}
export function setSession(s: Session) { sessionStorage.setItem(KEY, JSON.stringify(s)); }
export function clearSession() { sessionStorage.removeItem(KEY); }

export async function devSignIn(email: string, factor: 'otp' | 'sms') {
  const r = await api<{ accessToken: string }>('/dev-idp/token', { body: { email, factor } });
  setSession({ accessToken: r.accessToken, email, expiresAt: Date.now() + 14 * 60_000 });
}

function b64url(buf: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Start OIDC code + PKCE. NOT exercised in Phase 1 (Keycloak was not run on the build box). */
export async function oidcSignIn(opts: { stepUp?: boolean } = {}) {
  const issuer = process.env.NEXT_PUBLIC_OIDC_ISSUER!;
  const clientId = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? 'mapema-web';
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
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
  const claims = JSON.parse(atob(t.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  setSession({ accessToken: t.access_token, email: claims.email, expiresAt: Date.now() + (t.expires_in - 30) * 1000 });
}
