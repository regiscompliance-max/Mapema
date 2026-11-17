/** [Frontend Engineer] API client. Errors are RFC 9457 problem+json from the API. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: any) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; token?: string | null; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch(`${API_URL}/v1${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.title ?? `HTTP_${res.status}`, json?.detail ?? res.statusText, json);
  return json as T;
}

function safeJson(t: string) { try { return JSON.parse(t); } catch { return { detail: t }; } }

export const newIdempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
