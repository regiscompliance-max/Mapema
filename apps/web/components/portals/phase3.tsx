'use client';
/**
 * [Frontend Engineer] Phase 3 "Growth" screens (docs/phase-3/stories.md): ERP connections and import runs
 * (ERP-01..06), funding sources, utilisation, covenants and re-tagging (FUND-01..05), the M-Pesa B2C cap and
 * pending payouts (MP-01..05), buyer bulk confirmation, supplier bulk quotes and ops payout batches
 * (BULK-01..04). Mobile-first (cards stack at 390 px; wide tables scroll in a focusable region).
 * Money arrives from the API as integer cents (KES) and is shown through kesFromCents.
 */
import { useState } from 'react';
import { api, newIdempotencyKey } from '@/lib/api';
import { kesFromCents, parseKesInput } from '@/lib/money';
import { useT } from '../lang';
import { Msg, StatusPill, Table, useAction, useGet } from '../ui';
import { Field } from '../shared';

const d16 = (v: unknown) => (v ? String(v).slice(0, 16).replace('T', ' ') : '-');
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="card"><div className="text-xs uppercase tracking-wide text-slate-500">{label}</div><div className="text-lg font-semibold tabular-nums">{value}</div>{sub && <div className="text-xs text-slate-500">{sub}</div>}</div>;
}

// ------------------------------------------------------------------ ERP (staff + buyer)
export function ErpConnections({ canOps, canPropose, buyerId }: { canOps: boolean; canPropose: boolean; buyerId?: string }) {
  const t = useT();
  const { data, reload } = useGet<any[]>('/erp/connections');
  const [open, setOpen] = useState<string | null>(null);
  const { busy, msg, run } = useAction();
  const runNow = (id: string) => run(() => api(`/erp/connections/${id}/run`, { body: {} }), t('p3.erp.run_done')).then(reload);
  return (
    <section data-story="ERP-01" className="space-y-4">
      <h2 className="h2">{t('p3.erp.title')}</h2>
      <p className="text-sm text-slate-600">{t('p3.erp.lead')}</p>
      <Msg msg={msg} />
      {data && !data.length && <p className="text-slate-600">{t('p3.erp.none')}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {data?.map((c) => (
          <div key={c.id} className="card min-w-0 space-y-2">
            <div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{c.name}</div><div className="text-xs text-slate-500">{c.buyer_name} · {c.kind.toUpperCase()}</div></div><StatusPill s={c.status} /></div>
            <dl className="grid grid-cols-2 gap-1 text-sm">
              <dt className="text-slate-500">{t('p3.erp.mapping')}</dt><dd>{c.mapping_version ? `v${c.mapping_version}` : t('p3.erp.mapping_pending')}</dd>
              <dt className="text-slate-500">{t('p3.erp.last_run')}</dt><dd>{c.last_run ? `${d16(c.last_run.finished_at)} · ${c.last_run.status}${c.last_run.error_code ? ` (${c.last_run.error_code})` : ''}` : '-'}</dd>
              <dt className="text-slate-500">{t('p3.erp.created')}</dt><dd>{c.last_run?.created ?? 0} / {t('p3.erp.errors')} {c.last_run?.errors ?? 0}</dd>
              <dt className="text-slate-500">{t('p3.erp.open_items')}</dt><dd>{c.open_items}</dd>
              {c.secret_env && <><dt className="text-slate-500">{t('p3.erp.secret')}</dt><dd><code className="text-xs">{c.secret_env}</code></dd></>}
            </dl>
            <div className="flex flex-wrap gap-2">
              {c.status === 'active' && <button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => runNow(c.id)}>{t('p3.erp.run')}</button>}
              {c.status === 'paused' && canOps && <button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => run(() => api(`/erp/connections/${c.id}/resume`, { body: { reason: prompt(t('p3.reason')) ?? 'resumed after check' } }), 'Resumed').then(reload)}>{t('p3.erp.resume')}</button>}
              <button className="btn-secondary !min-h-10 !py-2" onClick={() => setOpen(open === c.id ? null : c.id)}>{t('p3.erp.items')}</button>
            </div>
            {open === c.id && <ErpItems id={c.id} canPropose={canPropose} />}
          </div>))}
      </div>
      {canOps && <NewErpConnection onDone={reload} buyerId={buyerId} />}
    </section>
  );
}

function ErpItems({ id, canPropose }: { id: string; canPropose: boolean }) {
  const t = useT();
  const items = useGet<any[]>(`/erp/connections/${id}/items`);
  const conn = useGet<any>(`/erp/connections/${id}`);
  const [def, setDef] = useState('');
  const { busy, msg, run } = useAction();
  return (
    <div className="space-y-3" data-story="ERP-05">
      <Table label={t('p3.erp.items')} rows={items.data} cols={[{ key: 'external_id', label: 'ERP id' }, { key: 'status', label: t('p3.status'), render: (r) => <StatusPill s={r.status} /> },
        { key: 'error_code', label: t('p3.erp.error') }, { key: 'mapping_version', label: t('p3.erp.mapping') }, { key: 'updated_at', label: t('p3.when'), render: (r) => d16(r.updated_at) }]} />
      {conn.data?.mapping && <details><summary className="cursor-pointer text-sm underline">{t('p3.erp.mapping')} v{conn.data.mapping.version} ({conn.data.mapping.status})</summary>
        <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(conn.data.mapping.definition, null, 2)}</pre>
        {canPropose && <div className="space-y-2">
          <Field label={t('p3.erp.new_mapping')}><textarea className="input font-mono text-xs" rows={6} value={def} onChange={(e) => setDef(e.target.value)} /></Field>
          <p className="text-xs text-slate-500">{t('p3.erp.mapping_mc')} (a second ops user must approve the mapping)</p>
          <button className="btn-secondary !min-h-10 !py-2" disabled={busy || !def} onClick={() => run(() => api(`/erp/connections/${id}/mapping`, { body: { mapping: JSON.parse(def), reason: prompt(t('p3.reason')) ?? 'mapping change' } }), t('p3.proposed'))}>{t('p3.propose')}</button>
          <Msg msg={msg} />
        </div>}
      </details>}
    </div>
  );
}

function NewErpConnection({ onDone, buyerId }: { onDone: () => void; buyerId?: string }) {
  const t = useT();
  const buyers = useGet<any[]>(buyerId ? null : '/organisations?type=buyer');
  const [f, setF] = useState({ buyerId: buyerId ?? '', kind: 'odoo', name: '', baseUrl: '', database: '', username: '', secretEnv: 'ERP_SECRET_' });
  const { busy, msg, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = () => run(() => api('/erp/connections', { body: { buyerId: f.buyerId, kind: f.kind, name: f.name,
    config: f.kind === 'odoo' ? { baseUrl: f.baseUrl, database: f.database, username: f.username } : f.kind === 'csv_sftp' ? {} : { baseUrl: f.baseUrl },
    ...(f.kind === 'csv_sftp' ? {} : { secretEnv: f.secretEnv }) } }), t('p3.erp.created_ok')).then(onDone);
  return (
    <details className="card"><summary className="cursor-pointer font-semibold">{t('p3.erp.add')}</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {!buyerId && <Field label={t('p3.buyer')}><select className="input" value={f.buyerId} onChange={set('buyerId')}><option value="">-</option>{buyers.data?.map((b) => <option key={b.id} value={b.id}>{b.legal_name}</option>)}</select></Field>}
        <Field label={t('p3.erp.kind')}><select className="input" value={f.kind} onChange={set('kind')}>{['odoo', 'csv_sftp', 'sap', 'sage', 'dynamics'].map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
        <Field label={t('p3.erp.name')}><input className="input" value={f.name} onChange={set('name')} /></Field>
        {f.kind !== 'csv_sftp' && <Field label={t('p3.erp.base_url')}><input className="input" value={f.baseUrl} onChange={set('baseUrl')} /></Field>}
        {f.kind === 'odoo' && <><Field label={t('p3.erp.database')}><input className="input" value={f.database} onChange={set('database')} /></Field><Field label={t('p3.erp.username')}><input className="input" value={f.username} onChange={set('username')} /></Field></>}
        {f.kind !== 'csv_sftp' && <Field label={t('p3.erp.secret_env')}><input className="input font-mono" value={f.secretEnv} onChange={set('secretEnv')} /></Field>}
      </div>
      <p className="mt-2 text-xs text-slate-500">{t('p3.erp.secret_note')} The secret_env field names an ERP_SECRET_* environment variable; the key itself is never typed here or stored in the database.</p>
      <button className="btn mt-3" disabled={busy || !f.name || !f.buyerId} onClick={submit}>{t('p3.erp.add')}</button><Msg msg={msg} />
    </details>
  );
}

// ------------------------------------------------------------------ funding sources (staff)
export function FundingSources({ canPropose, canRetag }: { canPropose: boolean; canRetag: boolean }) {
  const t = useT();
  const { data, reload } = useGet<any[]>('/funding-sources');
  const cons = useGet<any>('/funding/consistency');
  return (
    <section data-story="FUND-01" className="space-y-4">
      <h2 className="h2">{t('p3.fund.title')}</h2>
      <p className="text-sm text-slate-600">{t('p3.fund.lead')} The CEO approves every new source or rule change.</p>
      {data && !data.length && <p className="text-slate-600">{t('p3.fund.none')}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {data?.map((s) => {
          const u = s.utilisation;
          return (
            <div key={s.code} className="card min-w-0 space-y-2">
              <div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{s.code} · {s.name}</div><div className="text-xs text-slate-500">{s.type} · {t('p3.fund.priority')} {s.priority} · Fineract fund {s.fineractFundId ?? '-'}</div></div><StatusPill s={s.active ? 'active' : 'inactive'} /></div>
              <div className="grid grid-cols-2 gap-2">
                <Card label={t('p3.fund.outstanding')} value={kesFromCents(u.outstandingCents)} sub={`${u.count} ${t('p3.fund.loans')}`} />
                <Card label={t('p3.fund.headroom')} value={u.limitCents ? kesFromCents(u.headroomCents) : t('p3.fund.no_limit')} sub={u.limitCents ? `${pct(u.usedBps)} of ${kesFromCents(u.limitCents)}` : undefined} />
              </div>
              {s.covenantStatus?.length > 0 && <ul className="text-sm">{s.covenantStatus.map((c: any) => <li key={c.code} className={c.ok ? 'text-green-700' : 'text-red-700'}>{c.ok ? '✓' : '✗'} {c.code.replace(/_/g, ' ').toLowerCase()}: {pct(c.actualBps)} (max {pct(c.limitBps)})</li>)}</ul>}
              <details><summary className="cursor-pointer text-sm underline">{t('p3.fund.eligibility')}</summary><pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(s.eligibility, null, 2)}</pre></details>
            </div>);
        })}
      </div>
      {cons.data && <p className={cons.data.mismatches?.length ? 'text-red-700' : 'text-green-700'} role="status">{t('p3.fund.consistency')}: {cons.data.checked} {t('p3.fund.checked')}, {cons.data.mismatches?.length ?? 0} {t('p3.fund.mismatches')}</p>}
      {canPropose && <NewFundingSource onDone={reload} />}
      {canRetag && <Retag onDone={reload} />}
    </section>
  );
}

function NewFundingSource({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [f, setF] = useState({ code: '', name: '', type: 'debt_facility', limit: '', priority: '10', maxTenor: '', sectors: '', concentration: '' });
  const { busy, msg, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = () => {
    const limit = f.limit ? parseKesInput(f.limit) : null;
    return run(() => api('/funding-sources', { body: { code: f.code, name: f.name, type: f.type, limitCents: limit === null ? null : String(limit), priority: Number(f.priority),
      eligibility: { ...(f.maxTenor ? { maxTenorDays: Number(f.maxTenor) } : {}), ...(f.sectors ? { sectorCodes: f.sectors.split(',').map((x) => x.trim()) } : {}) },
      covenants: f.concentration ? { maxBuyerConcentrationBps: Math.round(Number(f.concentration) * 100) } : {}, reason: prompt(t('p3.reason')) ?? 'new funding source' } }), t('p3.proposed')).then(onDone);
  };
  return (
    <details className="card"><summary className="cursor-pointer font-semibold">{t('p3.fund.add')}</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label={t('p3.fund.code')}><input className="input font-mono" value={f.code} onChange={set('code')} /></Field>
        <Field label={t('p3.erp.name')}><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label={t('p3.fund.type')}><select className="input" value={f.type} onChange={set('type')}>{['equity', 'debt_facility', 'other'].map((k) => <option key={k}>{k}</option>)}</select></Field>
        <Field label={t('p3.fund.limit')}><input className="input" inputMode="decimal" value={f.limit} onChange={set('limit')} /></Field>
        <Field label={t('p3.fund.priority')}><input className="input" inputMode="numeric" value={f.priority} onChange={set('priority')} /></Field>
        <Field label={t('p3.fund.max_tenor')}><input className="input" inputMode="numeric" value={f.maxTenor} onChange={set('maxTenor')} /></Field>
        <Field label={t('p3.fund.sectors')}><input className="input" value={f.sectors} onChange={set('sectors')} /></Field>
        <Field label={t('p3.fund.concentration')}><input className="input" inputMode="decimal" value={f.concentration} onChange={set('concentration')} /></Field>
      </div>
      <p className="mt-2 text-xs text-slate-500">CEO approves before the source can fund anything.</p>
      <button className="btn mt-3" disabled={busy || !f.code || !f.name} onClick={submit}>{t('p3.propose')}</button><Msg msg={msg} />
    </details>
  );
}

function Retag({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [f, setF] = useState({ advanceId: '', sourceCode: '', reason: '' });
  const { busy, msg, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="card space-y-3" data-story="FUND-03"><h3 className="font-semibold">{t('p3.fund.retag')}</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('p3.advance_id')}><input className="input font-mono text-xs" value={f.advanceId} onChange={set('advanceId')} /></Field>
        <Field label={t('p3.fund.code')}><input className="input font-mono" value={f.sourceCode} onChange={set('sourceCode')} /></Field>
        <Field label={t('p3.reason')}><input className="input" value={f.reason} onChange={set('reason')} /></Field>
      </div>
      <p className="text-xs text-slate-500">{t('p3.fund.retag_mc')} (credit proposes, CEO approves; Fineract is updated after approval)</p>
      <button className="btn-secondary" disabled={busy || !f.advanceId || !f.sourceCode || !f.reason} onClick={() => run(() => api(`/advances/${f.advanceId}/funding-tag`, { body: { sourceCode: f.sourceCode, reason: f.reason } }), t('p3.proposed')).then(onDone)}>{t('p3.propose')}</button><Msg msg={msg} />
    </div>
  );
}

// ------------------------------------------------------------------ M-Pesa (staff)
export function MpesaPanel({ canOps, canPropose }: { canOps: boolean; canPropose: boolean }) {
  const t = useT();
  const s = useGet<any>('/mpesa/settings');
  const p = useGet<any[]>('/mpesa/payouts');
  const [cap, setCap] = useState('');
  const { busy, msg, run } = useAction();
  return (
    <section data-story="MP-02" className="space-y-4">
      <h2 className="h2">{t('p3.mp.title')}</h2>
      {s.data && <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card label={t('p3.mp.cap')} value={kesFromCents(s.data.capCents)} sub="Daraja B2C maximum KES 250,000" />
        <Card label={t('p3.mp.mode')} value={s.data.mode} sub={t('p3.mp.no_live')} />
        <Card label={t('p3.mp.timeout')} value={`${s.data.resultTimeoutMinutes} min`} />
      </div>}
      <p className="text-sm text-slate-600">{t('p3.mp.lead')} A payout with no result is queried, flagged to ops and never resent automatically.</p>
      {canPropose && <div className="card flex flex-wrap items-end gap-3">
        <Field label={t('p3.mp.new_cap')}><input className="input" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
        <button className="btn-secondary" disabled={busy || parseKesInput(cap) === null} onClick={() => run(() => api('/mpesa/cap', { body: { capCents: String(parseKesInput(cap)), reason: prompt(t('p3.reason')) ?? 'cap change' } }), t('p3.proposed'))}>{t('p3.propose')}</button>
        <span className="text-xs text-slate-500">CEO approves the change.</span>
      </div>}
      <div data-story="MP-04" className="space-y-2">
        <div className="flex items-center justify-between"><h3 className="font-semibold">{t('p3.mp.payouts')}</h3>
          {canOps && <button className="btn-secondary !min-h-10 !py-2" disabled={busy} onClick={() => run(() => api('/mpesa/payouts/check', { body: {} }), t('p3.mp.checked')).then(p.reload)}>{t('p3.mp.check')}</button>}</div>
        <Msg msg={msg} />
        <Table label={t('p3.mp.payouts')} rows={p.data} cols={[{ key: 'invoice_number', label: t('p3.invoice') }, { key: 'amount_cents', label: t('p3.amount'), money: true },
          { key: 'account_number_last4', label: t('p3.mp.wallet'), render: (r) => `•••${r.account_number_last4}` }, { key: 'mpesa_state', label: 'M-Pesa', render: (r) => <StatusPill s={r.mpesa_state ?? '-'} /> },
          { key: 'status', label: t('p3.status') }, { key: 'bank_ref', label: t('p3.mp.receipt') }, { key: 'mpesa_requested_at', label: t('p3.when'), render: (r) => d16(r.mpesa_requested_at) }]} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ payout batches (ops)
export function PayoutBatches({ canOps }: { canOps: boolean }) {
  const t = useT();
  const approved = useGet<any[]>('/advances/queue?status=approved');
  const list = useGet<any[]>('/payout-batches');
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, msg, run } = useAction();
  const total = (approved.data ?? []).filter((a) => sel.includes(a.id)).reduce((s, a) => s + BigInt(a.principal_cents), 0n); // the payout is the advance; fees come out of the buyer's payment
  return (
    <section data-story="BULK-03" className="space-y-4">
      <h2 className="h2">{t('p3.batch.title')}</h2>
      <p className="text-sm text-slate-600">{t('p3.batch.lead')} You build the batch; a different ops user approves the batch with a fresh sign-in, and may drop single items. Every item is released one by one with all limit checks.</p>
      {canOps && <div className="card space-y-2">
        <h3 className="font-semibold">{t('p3.batch.new')}</h3>
        {approved.data && !approved.data.length && <p className="text-slate-600">{t('p3.batch.none_approved')}</p>}
        <ul className="divide-y">{approved.data?.map((a) => (
          <li key={a.id} className="flex items-center gap-3 py-2"><input id={`b-${a.id}`} type="checkbox" className="h-5 w-5" checked={sel.includes(a.id)} onChange={(e) => setSel(e.target.checked ? [...sel, a.id] : sel.filter((x) => x !== a.id))} />
            <label htmlFor={`b-${a.id}`} className="flex-1 text-sm"><span className="font-medium">{a.invoice_number}</span> · {a.supplier_name}</label><span className="tabular-nums text-sm">{kesFromCents(a.principal_cents)}</span></li>))}</ul>
        <div className="flex flex-wrap items-center gap-3"><span className="text-sm">{sel.length} {t('p3.batch.items')} · {t('p3.batch.total')} {kesFromCents(total)}</span>
          <button className="btn" disabled={busy || !sel.length} onClick={() => run(() => api('/payout-batches', { body: { advanceIds: sel, note: prompt(t('p3.batch.note')) ?? 'Payout batch' } }), t('p3.batch.created')).then(() => { setSel([]); void list.reload(); void approved.reload(); })}>{t('p3.batch.create')}</button></div>
      </div>}
      <Msg msg={msg} />
      <Table label={t('p3.batch.title')} rows={list.data} cols={[{ key: 'created_at', label: t('p3.when'), render: (r) => d16(r.created_at) }, { key: 'note', label: t('p3.batch.note') }, { key: 'item_count', label: t('p3.batch.items') },
        { key: 'total_cents', label: t('p3.amount'), money: true }, { key: 'released_cents', label: t('p3.batch.released'), money: true }, { key: 'status', label: t('p3.status'), render: (r) => <StatusPill s={r.status} /> },
        { key: 'created_by_name', label: t('p3.batch.maker') }, { key: 'x', label: '', render: (r) => <button className="btn-secondary !min-h-10 !py-2" onClick={() => setOpen(open === r.id ? null : r.id)}>{t('p3.open')}</button> }]} />
      {open && <BatchDetail id={open} canOps={canOps} onDone={() => { void list.reload(); void approved.reload(); }} />}
    </section>
  );
}

function BatchDetail({ id, canOps, onDone }: { id: string; canOps: boolean; onDone: () => void }) {
  const t = useT();
  const b = useGet<any>(`/payout-batches/${id}`);
  const [drop, setDrop] = useState<string[]>([]);
  const { busy, msg, run } = useAction();
  if (!b.data) return null;
  const approve = () => run(() => api(`/payout-batches/${id}/approve`, { body: { rejectItems: drop.map((itemId) => ({ itemId, reason: 'Removed by checker' })) }, idempotencyKey: newIdempotencyKey() }), t('p3.batch.approved')).then(() => { void b.reload(); onDone(); });
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between"><h3 className="font-semibold">{b.data.note}</h3><StatusPill s={b.data.status} /></div>
      <Table label={t('p3.batch.items')} rows={b.data.items} cols={[{ key: 'seq', label: '#' }, { key: 'invoiceNumber', label: t('p3.invoice') }, { key: 'supplierName', label: t('p3.supplier') },
        { key: 'amountCents', label: t('p3.amount'), money: true }, { key: 'rail', label: t('p3.batch.rail') }, { key: 'status', label: t('p3.status'), render: (r) => <StatusPill s={r.status} /> },
        { key: 'errorCode', label: t('p3.erp.error'), render: (r) => r.errorCode ? `${r.errorCode}${r.failedChecks ? ` (${r.failedChecks.join(', ')})` : ''}` : r.rejectReason ?? '-' },
        ...(b.data.status === 'pending_approval' && canOps ? [{ key: 'd', label: t('p3.batch.drop'), render: (r: any) => <input aria-label={`${t('p3.batch.drop')} ${r.invoiceNumber}`} type="checkbox" className="h-5 w-5" checked={drop.includes(r.id)} onChange={(e) => setDrop(e.target.checked ? [...drop, r.id] : drop.filter((x) => x !== r.id))} /> }] : [])]} />
      {b.data.status === 'pending_approval' && canOps && <button className="btn" disabled={busy} onClick={approve}>{t('p3.batch.approve')}</button>}
      <Msg msg={msg} />
    </div>
  );
}

// ------------------------------------------------------------------ buyer bulk confirmation
export function BulkConfirm() {
  const t = useT();
  const { data, reload } = useGet<any[]>('/invoices?status=awaiting_confirmation');
  const [sel, setSel] = useState<string[]>([]);
  const [res, setRes] = useState<any>(null);
  const { busy, msg, run } = useAction();
  const go = (decision: 'approve' | 'reject') => run(async () => {
    const r = await api('/invoices/bulk-decision', { body: { invoiceIds: sel, decision, ...(decision === 'reject' ? { reasonCode: 'NOT_RECEIVED', reasonText: prompt(t('p3.reason')) ?? '' } : {}) } });
    setRes(r); setSel([]);
  }, t('p3.done')).then(reload);
  return (
    <section data-story="BULK-01" className="space-y-3">
      <h2 className="h2">{t('p3.bulk.confirm_title')}</h2>
      <p className="text-sm text-slate-600">{t('p3.bulk.confirm_lead')}</p>
      {data && !data.length && <p className="text-slate-600">{t('p3.bulk.nothing')}</p>}
      <ul className="divide-y">{data?.map((i) => (
        <li key={i.id} className="flex items-center gap-3 py-2"><input id={`c-${i.id}`} type="checkbox" className="h-5 w-5" checked={sel.includes(i.id)} onChange={(e) => setSel(e.target.checked ? [...sel, i.id] : sel.filter((x) => x !== i.id))} />
          <label htmlFor={`c-${i.id}`} className="flex-1 text-sm"><span className="font-medium">{i.invoice_number}</span> · {i.supplier_name} · {i.source === 'erp' ? 'ERP' : t('p3.bulk.manual')} · {t('p3.due')} {String(i.due_date).slice(0, 10)}</label>
          <span className="tabular-nums text-sm">{kesFromCents(i.amount_cents)}</span></li>))}</ul>
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => setSel(data?.map((i) => i.id) ?? [])}>{t('p3.select_all')}</button>
        <button className="btn" disabled={busy || !sel.length} onClick={() => go('approve')}>{t('p3.bulk.approve')} ({sel.length})</button>
        <button className="btn-secondary" disabled={busy || !sel.length} onClick={() => go('reject')}>{t('p3.bulk.reject')}</button>
      </div>
      <Msg msg={msg} />
      {res && <p role="status" className="text-sm">{res.ok} {t('p3.bulk.ok')}, {res.failed} {t('p3.bulk.failed')}. {t('p3.bulk.sign_next')}</p>}
    </section>
  );
}

// ------------------------------------------------------------------ supplier bulk quote + wallet
export function BulkQuote() {
  const t = useT();
  const { data, reload } = useGet<any[]>('/invoices?status=eligible');
  const [sel, setSel] = useState<string[]>([]);
  const [q, setQ] = useState<any>(null);
  const { busy, msg, run } = useAction();
  const quote = () => run(async () => setQ(await api('/invoices/bulk-quote', { body: { invoiceIds: sel } })), t('p3.done'));
  const accept = () => run(() => api('/advances', { body: { disclosureIds: q.results.filter((r: any) => r.status === 'ok').map((r: any) => r.quote.disclosureId), acceptTerms: true }, idempotencyKey: newIdempotencyKey() }), t('p3.bulk.requested')).then(() => { setQ(null); setSel([]); void reload(); });
  return (
    <section data-story="BULK-02" className="space-y-3">
      <h2 className="h2">{t('p3.bulk.quote_title')}</h2>
      <p className="text-sm text-slate-600">{t('p3.bulk.quote_lead')}</p>
      {data && !data.length && <p className="text-slate-600">{t('p3.bulk.nothing')}</p>}
      <ul className="divide-y">{data?.map((i) => (
        <li key={i.id} className="flex items-center gap-3 py-2"><input id={`q-${i.id}`} type="checkbox" className="h-5 w-5" checked={sel.includes(i.id)} onChange={(e) => setSel(e.target.checked ? [...sel, i.id] : sel.filter((x) => x !== i.id))} />
          <label htmlFor={`q-${i.id}`} className="flex-1 text-sm"><span className="font-medium">{i.invoice_number}</span> · {i.buyer_name} · {t('p3.due')} {String(i.due_date).slice(0, 10)}</label><span className="tabular-nums text-sm">{kesFromCents(i.amount_cents)}</span></li>))}</ul>
      <button className="btn" disabled={busy || !sel.length || sel.length > 50} onClick={quote}>{t('p3.bulk.get_quotes')} ({sel.length})</button>
      <Msg msg={msg} />
      {q && <div className="card space-y-2">
        <Table label={t('p3.bulk.quote_title')} rows={q.results} cols={[{ key: 'invoiceId', label: t('p3.invoice'), render: (r) => data?.find((i) => i.id === r.invoiceId)?.invoice_number ?? r.invoiceId.slice(0, 8) },
          { key: 'adv', label: t('p3.bulk.you_get'), render: (r) => r.status === 'ok' ? kesFromCents(r.quote.advanceCents) : r.error },
          { key: 'cost', label: t('p3.bulk.cost'), render: (r) => r.status === 'ok' ? kesFromCents(r.quote.totalCostCents) : '-' }]} />
        <div className="grid grid-cols-2 gap-2"><Card label={t('p3.bulk.total_advance')} value={kesFromCents(q.totals.advanceCents)} sub={`${q.totals.invoices} ${t('p3.batch.items')}`} /><Card label={t('p3.bulk.total_cost')} value={kesFromCents(q.totals.totalCostCents)} /></div>
        <p className="text-xs text-slate-500">{t('p3.bulk.disclosure')}</p>
        <button className="btn" disabled={busy || !q.totals.invoices} onClick={accept}>{t('p3.bulk.accept_all')}</button>
      </div>}
    </section>
  );
}

export function MpesaWallet({ orgId, canEdit }: { orgId?: string; canEdit: boolean }) {
  const t = useT();
  const [f, setF] = useState({ msisdn: '2547', accountName: '' });
  const { busy, msg, run } = useAction();
  return (
    <section data-story="MP-01" className="card space-y-3">
      <h2 className="h2">{t('p3.mp.wallet_title')}</h2>
      <p className="text-sm text-slate-600">{t('p3.mp.wallet_lead')}</p>
      {canEdit && <><div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('p3.mp.msisdn')}><input className="input" inputMode="tel" value={f.msisdn} onChange={(e) => setF({ ...f, msisdn: e.target.value })} /></Field>
        <Field label={t('p3.mp.name')}><input className="input" value={f.accountName} onChange={(e) => setF({ ...f, accountName: e.target.value })} /></Field>
      </div>
      <button className="btn" disabled={busy || !orgId || !/^2547\d{8}$/.test(f.msisdn) || !f.accountName} onClick={() => run(() => api(`/organisations/${orgId}/mpesa-wallet`, { body: f }), t('p3.mp.wallet_added'))}>{t('p3.mp.add_wallet')}</button></>}
      <Msg msg={msg} />
    </section>
  );
}
