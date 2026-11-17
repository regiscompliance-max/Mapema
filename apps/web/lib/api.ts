/**
 * [Frontend Engineer + Security Engineer] API client. Errors are RFC 9457 problem+json from the API.
 * Phase 1b: authentication is the API's httpOnly session cookie (credentials: 'include'); the page
 * never sees or stores a token. State-changing calls add the in-memory CSRF token.
 */
import { getCsrf, onUnauthenticated } from './csrf';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: any) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const csrf = getCsrf();
  if (!['GET', 'HEAD'].includes(method) && csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${API_URL}/v1${path}`, { method, headers, credentials: 'include', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    if (res.status === 401) onUnauthenticated();
    throw new ApiError(res.status, json?.title ?? `HTTP_${res.status}`, json?.detail ?? res.statusText, json);
  }
  return json as T;
}

/** Authenticated file download (e.g. PDFs, CSV) via the cookie; returns a Blob. */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(`${API_URL}/v1${path}`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) { const j = safeJson(await res.text()); throw new ApiError(res.status, j?.title ?? `HTTP_${res.status}`, j?.detail ?? res.statusText, j); }
  return res.blob();
}

export async function download(path: string, filename: string) {
  const blob = await apiBlob(path);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function safeJson(t: string) { try { return JSON.parse(t); } catch { return { detail: t }; } }

export const newIdempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
