'use client';
/**
 * [Security Engineer + Frontend Engineer] Browser session (Phase 1b).
 * The API holds the session server-side and sets an httpOnly, Secure, SameSite=Strict cookie; this
 * module never stores a token. Sign-in obtains an IdP access token, immediately exchanges it at
 * POST /v1/auth/session (it stays in a local variable only), and keeps the returned CSRF token in memory.
 * After a page reload, loadSession() asks GET /v1/auth/session for the CSRF token again.
 * Production: OIDC authorization-code + PKCE against Keycloak, run SERVER-SIDE by the API (BFF, D-32;
 * NEXT_PUBLIC_OIDC_ENABLED=true); MFA and step-up are enforced by Keycloak and checked again by the API.
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

async function devIdpToken(email: string, factor: 'otp' | 'sms') {
  return (await api<{ accessToken: string }>('/dev-idp/token', { body: { email, factor } })).accessToken;
}

export async function devSignIn(email: string, factor: 'otp' | 'sms') {
  return exchange(await devIdpToken(email, factor));
}

export interface JoinDetails { token: string; displayName: string; phone?: string }
async function acceptAndSignIn(accessToken: string, join: JoinDetails) {
  await api('/invitations/accept', { body: { ...join, accessToken } });
  return exchange(accessToken);
}
/** Invitation (development): sign in with the dev IdP, accept, then start the cookie session. */
export async function devJoin(email: string, factor: 'otp' | 'sms', join: JoinDetails) {
  return acceptAndSignIn(await devIdpToken(email, factor), join);
}

/**
 * OIDC sign-in through the API's backend-for-frontend (D-32, go-live): the API creates the PKCE
 * verifier, state and nonce, keeps them server-side, does the code exchange itself and sets the
 * session cookie on the IdP's redirect back. The page only navigates; it never handles a code or token.
 */
export async function oidcSignIn(opts: { stepUp?: boolean; join?: JoinDetails; returnTo?: string } = {}) {
  const { authorizeUrl } = await api<{ authorizeUrl: string }>('/auth/oidc/start', { body: { returnTo: opts.returnTo ?? '/app', stepUp: opts.stepUp ?? false, join: opts.join } });
  location.assign(authorizeUrl);
}

export const OIDC_ENABLED = process.env.NEXT_PUBLIC_OIDC_ENABLED === 'true';
