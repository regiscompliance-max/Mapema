'use client';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { kesFromCents } from '@/lib/money';
import { useT } from './lang';

/** GET with the session cookie; returns data, error, reload. */
export function useGet<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try { setError(null); setData(await api<T>(path)); } catch (e) { setError(e as ApiError); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, reload: load };
}

/** POST helper that surfaces problem+json details (including failed checks). */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, okText = 'Done') => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: okText }); return true; } catch (e) {
      const x = e as ApiError;
      const checks = x.body?.failedChecks?.map((c: any) => `${c.code}: ${c.detail}`).join('; ');
      setMsg({ ok: false, text: `${x.code}: ${x.message}${checks ? ` (${checks})` : ''}${x.code === 'STEP_UP_REQUIRED' ? ' - sign in again to confirm.' : ''}` });
      return false;
    } finally { setBusy(false); }
  };
  return { busy, msg, run };
}

export function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-green-700' : 'text-red-700'}>{msg.text}</p>;
}

export function ErrorBox({ error }: { error: ApiError | null }) {
  const t = useT();
  if (!error) return null;
  return <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{t('portal.error')}: {error.code} - {error.message}</p>;
}

export interface Col<R> { key: string; label: string; render?: (r: R) => ReactNode; money?: boolean }
export function Table<R extends Record<string, any>>({ rows, cols, empty, label }: { rows: R[] | null; cols: Col<R>[]; empty?: string; label?: string }) {
  const t = useT();
  if (!rows) return <p>{t('portal.loading')}</p>;
  if (!rows.length) return <p className="text-slate-600">{empty ?? t('portal.empty')}</p>;
  return (
    // focusable scroll region so keyboard users can scroll wide tables at phone width (WCAG 2.1.1, axe scrollable-region-focusable)
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={label ?? cols.map((c) => c.label).filter(Boolean).slice(0, 3).join(', ')}>
      <table className="min-w-full text-sm">
        <thead><tr className="border-b text-left">{cols.map((c) => <th key={c.key} className="px-2 py-2 font-semibold">{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={r.id ?? i} className="border-b border-slate-100 align-top">
            {cols.map((c) => <td key={c.key} className={`px-2 py-2 ${c.money ? 'text-right tabular-nums' : ''}`}>{c.render ? c.render(r) : c.money ? kesFromCents(r[c.key]) : String(r[c.key] ?? '-')}</td>)}
          </tr>))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-2 overflow-x-auto border-b">
      {tabs.map((t) => <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => onChange(t.id)}
        className={`whitespace-nowrap px-3 py-3 ${active === t.id ? 'border-b-2 border-brand font-semibold text-brand' : 'text-slate-600'}`}>{t.label}</button>)}
    </div>
  );
}

export const StatusPill = ({ s }: { s: string }) => <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium">{s}</span>;
