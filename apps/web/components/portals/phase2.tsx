'use client';
/**
 * [Frontend Engineer] Phase 2 screens (docs/phase-2/stories.md): staff overview dashboard (DSH-01), reconciliation
 * breaks with maker-checker resolution (REC-03), reports - snapshots, CBK/CRB DRAFTs and the lender pack (RPT-01..05),
 * collections book and recourse (COL-01..05), buyer and supplier dashboards (DSH-02/03). Mobile-first: cards stack at
 * 390 px, wide tables scroll inside a focusable region. Money comes from the API as integer cents (KES).
 */
import { useState } from 'react';
import { api, download } from '@/lib/api';
import { kesFromCents } from '@/lib/money';
import { Msg, StatusPill, Table, useAction, useGet } from '../ui';
import { Field } from '../shared';

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const d10 = (v: unknown) => (v ? String(v).slice(0, 10) : '-');
const n = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
const BUCKET: Record<string, string> = { current: 'Current', dpd_1_30: '1-30 days', dpd_31_60: '31-60 days', dpd_61_90: '61-90 days', dpd_91_plus: 'Over 90 days' };

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'bad' | 'ok' }) {
  const c = tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : tone === 'ok' ? 'text-green-700' : '';
  return <div className="card"><div className="text-xs uppercase tracking-wide text-slate-500">{label}</div><div className={`text-lg font-semibold tabular-nums ${c}`}>{value}</div>{sub && <div className="text-xs text-slate-500">{sub}</div>}</div>;
}

/** Utilisation bar against the policy limit (buyer 25% / supplier 10% / sector 35% of float by default). */
function Bar({ usedBps, breach }: { usedBps: number; breach: boolean }) {
  const w = Math.min(usedBps, 10000) / 100;
  const tone = breach ? 'bg-red-600' : usedBps >= 8000 ? 'bg-amber-500' : 'bg-emerald-600';
  return <div className="h-2 w-full rounded bg-slate-100" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)} aria-label="Share of limit used"><div className={`h-2 rounded ${tone}`} style={{ width: `${w}%` }} /></div>;
}

function Utilisation({ title, rows }: { title: string; rows: any[] }) {
  return (
    <section className="card space-y-3">
      <h3 className="font-semibold">{title}</h3>
      {!rows.length && <p className="text-sm text-slate-600">No live exposure.</p>}
      {rows.map((r) => (
        <div key={(r.orgId ?? r.code ?? r.name) as string} className="space-y-1">
          <div className="flex justify-between gap-2 text-sm"><span className="truncate">{r.name}</span><span className="tabular-nums">{kesFromCents(r.exposureCents)} / {kesFromCents(r.capCents)}</span></div>
          <Bar usedBps={r.usedBps} breach={r.breach} />
          <div className="text-xs text-slate-500">{pct(r.usedBps)} of limit (limit {pct(r.limitBps)} of float){r.breach ? ' - OVER LIMIT' : ''}</div>
        </div>
      ))}
    </section>
  );
}

export function StaffOverview() {
  const { data, error } = useGet<any>('/dashboards/staff');
  if (error) return <p role="alert">{error.code}: {error.message}</p>;
  if (!data) return <p>Loading…</p>;
  const rec = data.reconciliation;
  return (
    <div className="space-y-4" data-story="DSH-01">
      <p className="text-sm text-slate-600">As of {data.asOf} · all amounts KES</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Outstanding principal" value={kesFromCents(data.portfolio.outstandingPrincipalCents)} sub={n(data.portfolio.count, 'live advance')} />
        <Stat label="Lending float" value={kesFromCents(data.floatCents)} sub={`Headroom ${kesFromCents(data.headroomCents)}`} />
        <Stat label="Collections (month to date)" value={kesFromCents(data.collections.monthToDateCents)} sub={n(data.collections.receipts, 'receipt')} />
        <Stat label="Reconciliation" value={rec.status === 'never_run' ? 'Not run' : rec.status} sub={rec.asOfDate ? `${d10(rec.asOfDate)} · ${rec.unexplained} unexplained` : undefined} tone={rec.unexplained > 0 ? 'bad' : rec.status === 'balanced' || rec.status === 'explained' ? 'ok' : undefined} />
        <Stat label="Late" value={kesFromCents(data.late.principalCents)} sub={n(data.late.count, 'advance')} tone={data.late.count ? 'warn' : undefined} />
        <Stat label="Recourse" value={kesFromCents(data.recourse.principalCents)} sub={`${n(data.recourse.count, 'advance')} · cases: ${data.recourseCases.due} due, ${data.recourseCases.demanded} demanded`} tone={data.recourse.count ? 'warn' : undefined} />
        <Stat label="Non-performing" value={kesFromCents(data.npl.principalCents)} sub={n(data.npl.count, 'advance')} tone={data.npl.count ? 'bad' : undefined} />
        <Stat label="NPL ratio" value={pct(data.nplRatioBps)} sub="of outstanding principal" tone={data.nplRatioBps > 0 ? 'bad' : 'ok'} />
      </div>
      <section className="card">
        <h3 className="mb-2 font-semibold">Ageing (days past due)</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {Object.entries(data.ageing as Record<string, { count: number; principalCents: string }>).map(([b, v]) => (
            <div key={b} className="rounded border border-slate-100 p-2"><div className="text-xs text-slate-500">{BUCKET[b] ?? b}</div><div className="text-sm font-semibold tabular-nums">{kesFromCents(v.principalCents)}</div><div className="text-xs text-slate-500">{n(v.count, 'advance')}</div></div>
          ))}
        </div>
      </section>
      <div className="grid gap-3 lg:grid-cols-3">
        <Utilisation title="Buyers (limit 25% of float)" rows={data.utilisation.buyers} />
        <Utilisation title="Suppliers (limit 10% of float)" rows={data.utilisation.suppliers} />
        <Utilisation title="Sectors (limit 35% of float)" rows={data.utilisation.sectors} />
      </div>
    </div>
  );
}

export function ReconBreaks({ canOps }: { canOps: boolean }) {
  const runs = useGet<any[]>('/reconciliation/runs');
  const baseline = useGet<any>('/reconciliation/baseline');
  const [runId, setRunId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const current = runId ?? runs.data?.[0]?.id ?? null;
  const breaks = useGet<any[]>(current ? `/reconciliation/runs/${current}/breaks` : null);
  const { busy, msg, run } = useAction();
  const reload = () => { void runs.reload(); void breaks.reload(); };
  const resolve = (id: string, resolution: 'explained' | 'closed') => {
    const note = prompt(resolution === 'explained' ? 'Explanation and evidence (a second ops user must approve)' : 'Why can this break be closed?');
    if (!note) return;
    const carryForward = resolution === 'explained' && confirm('Carry this item forward as explained on later runs until it clears?');
    void run(() => api(`/reconciliation/breaks/${id}/resolve`, { body: { resolution, note, carryForward } }), 'Proposed - a second ops user must approve').then(reload);
  };
  return (
    <div className="space-y-4" data-story="REC-03">
      <div className="card space-y-2 text-sm">
        <p>Bank = Fineract cash = platform, checked daily at 06:30 EAT for the previous business day. Movements are compared from the approved opening baseline.</p>
        <p>Baseline: <strong>{baseline.data ? `${d10(baseline.data.as_of_date)} (approved)` : 'none approved yet'}</strong></p>
        {canOps && <div className="flex flex-wrap gap-2">
          <button className="btn" disabled={busy} onClick={() => run(() => api('/reconciliation/run', { body: {} }), 'Reconciliation run').then(reload)}>Run now</button>
          <button className="btn-secondary" disabled={busy} onClick={() => { const note = prompt('Why set the opening baseline now?'); if (note) void run(() => api('/reconciliation/baseline', { body: { note } }), 'Baseline proposed - a second ops user must approve'); }}>Propose baseline</button>
        </div>}
      </div>
      <Msg msg={msg} />
      <Table label="Reconciliation runs" rows={runs.data ? (all ? runs.data : runs.data.slice(0, 14)) : null} cols={[{ key: 'as_of_date', label: 'Date', render: (r) => <button className="underline" onClick={() => setRunId(r.id)}>{d10(r.as_of_date)}</button> },
        { key: 'bank_balance_cents', label: 'Bank', money: true }, { key: 'fineract_cash_cents', label: 'Ledger', money: true }, { key: 'platform_cash_cents', label: 'Platform', money: true },
        { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> }, { key: 'unexplained_count', label: 'Unexplained' }, { key: 'open_breaks', label: 'Open' }]} />
      {!all && (runs.data?.length ?? 0) > 14 && <button className="underline" onClick={() => setAll(true)}>Show all {runs.data!.length} runs</button>}
      <h2 className="h2">Breaks {current && runs.data ? `for ${d10(runs.data.find((r) => r.id === current)?.as_of_date)}` : ''}</h2>
      <Table label="Reconciliation breaks" rows={breaks.data} empty="No breaks - balanced." cols={[{ key: 'item_key', label: 'Item' },
        { key: 'classification', label: 'Class', render: (r) => <span className={r.classification === 'unexplained' ? 'font-semibold text-red-700' : r.classification === 'timing' ? 'text-amber-700' : 'text-slate-700'}>{r.classification ?? 'unexplained'}</span> },
        { key: 'category', label: 'Why' }, { key: 'difference_cents', label: 'Difference', money: true }, { key: 'expected_clear_by', label: 'Clears by', render: (r) => d10(r.expected_clear_by) },
        { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.approval_status === 'pending' ? 'awaiting approval' : r.status} /> },
        { key: 'x', label: '', render: (r) => canOps && r.status === 'open' && r.approval_status !== 'pending' ? <span className="flex gap-2"><button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => resolve(r.id, 'explained')}>Explain…</button><button className="btn-secondary !min-h-10 !py-2" disabled={busy} onClick={() => resolve(r.id, 'closed')}>Close…</button></span> : null }]} />
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { cbk_return: 'CBK monthly return (DRAFT)', crb_file: 'CRB data submission (DRAFT)', lender_pack: 'Lender pack' };

export function Reports({ canGenerate }: { canGenerate: boolean }) {
  const snaps = useGet<any[]>('/reports/snapshots');
  const templates = useGet<any[]>('/reports/templates');
  const [open, setOpen] = useState<string | null>(null);
  const { busy, msg, run } = useAction();
  const [period, setPeriod] = useState(() => { const d = new Date(); d.setUTCDate(0); return d.toISOString().slice(0, 7); });
  const [last, setLast] = useState<any>(null);
  const snap = snaps.data?.find((x) => x.id === open) ?? null;
  return (
    <div className="space-y-4" data-story="RPT-01">
      <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">CBK and CRB outputs use an <strong>assumed layout</strong> and are watermarked DRAFT until the official CBK return and CRB submission specifications are loaded as templates (maker-checker). Do not submit them.</p>
      {canGenerate && <form className="card flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void run(() => api('/reports/snapshots', { body: { period } }), 'Month-end snapshot ready').then(snaps.reload); }}>
        <Field label="Month-end (YYYY-MM)"><input className="input" value={period} onChange={(e) => setPeriod(e.target.value)} pattern="\d{4}-\d{2}" required /></Field>
        <button className="btn" disabled={busy}>Take snapshot</button>
      </form>}
      <Msg msg={msg} />
      <Table label="Month-end snapshots" rows={snaps.data} cols={[{ key: 'period', label: 'Month' }, { key: 'version', label: 'Version' }, { key: 'sha256', label: 'SHA-256', render: (r) => <code className="text-xs">{String(r.sha256).slice(0, 12)}…</code> },
        { key: 'created_at', label: 'Taken', render: (r) => d10(r.created_at) }, { key: 'x', label: '', render: (r) => <button className="underline" onClick={() => setOpen(r.id)}>Open</button> }]} />
      {open && snap && <section className="card space-y-3" data-story="RPT-04">
        <h3 className="font-semibold">{snap.period} v{snap.version}{snap.reason ? ` - restated: ${snap.reason}` : ''}</h3>
        {canGenerate && <div className="flex flex-wrap gap-2">{(['lender_pack', 'cbk_return', 'crb_file'] as const).map((k) => (
          <button key={k} className="btn-secondary" disabled={busy} onClick={() => run(async () => { setLast(await api(`/reports/snapshots/${open}/generate`, { body: { kind: k } })); await snaps.reload(); }, `${KIND_LABEL[k]} generated`)}>Generate {KIND_LABEL[k]}</button>))}</div>}
        {last?.exceptions?.length ? <p className="text-sm text-amber-800">CRB exceptions (no consent on file, excluded): {last.exceptions.map((x: any) => `${x.borrower} (${x.facilities})`).join(', ')}</p> : null}
        <Table label="Report files" rows={snap.artifacts ?? []} empty="No files generated yet." cols={[{ key: 'filename', label: 'File' }, { key: 'draft', label: 'Draft', render: (r) => r.draft ? 'DRAFT' : '' },
          { key: 'sha256', label: 'SHA-256', render: (r) => <code className="text-xs">{String(r.sha256).slice(0, 12)}…</code> },
          { key: 'x', label: '', render: (r) => <button className="underline" onClick={() => void download(`/reports/artifacts/${r.id}/download`, r.filename)}>Download</button> }]} />
      </section>}
      <h2 className="h2">Templates (mapping layer)</h2>
      <Table label="Report templates" rows={templates.data} cols={[{ key: 'kind', label: 'Report' }, { key: 'version', label: 'Version' }, { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status === 'assumed_draft' ? 'assumed (DRAFT)' : r.kind === 'lender_pack' ? 'Mapema format' : r.status} /> }, { key: 'active', label: 'Active', render: (r) => r.active ? 'yes' : '' }, { key: 'source_ref', label: 'Source' }]} />
    </div>
  );
}

export function CollectionsBook({ canCredit, canOps }: { canCredit: boolean; canOps: boolean }) {
  const book = useGet<any[]>('/collections/book');
  const cases = useGet<any[]>('/recourse-cases');
  const policy = useGet<any>('/collections/policy');
  const { busy, msg, run } = useAction();
  const reload = () => { void book.reload(); void cases.reload(); };
  const p = policy.data;
  return (
    <div className="space-y-4" data-story="COL-05">
      {p && <div className="card text-sm" data-story="COL-06">
        <p>Reminders: {p.preDueDays?.map((d: number) => `${d}d before`).join(', ')}, on the due date, then {p.overdueDays?.map((d: number) => `${d}d after`).join(', ')} (SMS + email, 08:00 EAT).</p>
        <p>Recourse to the supplier at {p.recourseAfterDays} DPD. NPL at {p.nplDaysShortTerm} DPD (terms up to {p.shortTermMaxDays} days) or {p.nplDaysLongTerm} DPD. In duplum cap on charges after NPL.</p>
        {!p.counselConfirmed && <p className="text-amber-800">Periods are defaults pending Kenyan counsel confirmation. Changes are maker-checker (credit proposes, CEO approves).</p>}
      </div>}
      {canOps && <button className="btn" disabled={busy} onClick={() => run(() => api('/collections/run', { body: {} }), 'Collections run complete').then(reload)}>Run collections now</button>}
      <Msg msg={msg} />
      <Table label="Collections book" rows={book.data} empty="Nothing outstanding." cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'buyer', label: 'Buyer' }, { key: 'supplier', label: 'Supplier' }, { key: 'due_date', label: 'Due', render: (r) => d10(r.due_date) },
        { key: 'dpd', label: 'DPD' }, { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> }, { key: 'principal_cents', label: 'Advance', money: true }, { key: 'last_reminder', label: 'Last reminder' },
        { key: 'x', label: '', render: (r) => canCredit && ['late', 'non_performing'].includes(r.status) && (!r.recourse_status || r.recourse_status === 'due') ? <button className="btn-secondary !min-h-10 !py-2" disabled={busy} onClick={() => { const reason = prompt('Reason for recourse to the supplier (a second credit user must approve)'); if (reason) void run(() => api(`/advances/${r.id}/recourse`, { body: { reason } }), 'Recourse proposed - a second credit user must approve').then(reload); }}>Propose recourse…</button> : null }]} />
      <h2 className="h2">Recourse cases</h2>
      <Table label="Recourse cases" rows={cases.data} empty="No recourse cases." cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'supplier', label: 'Supplier' }, { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> }, { key: 'opened_on', label: 'Opened', render: (r) => d10(r.opened_on) }, { key: 'amount_demanded_cents', label: 'Demanded', money: true }]} />
    </div>
  );
}

export function BuyerDashboard({ orgId }: { orgId: string }) {
  const { data } = useGet<any>(`/dashboards/buyer?orgId=${orgId}`);
  if (!data) return <p>Loading…</p>;
  const pr = data.programme;
  return (
    <div className="space-y-4" data-story="DSH-02">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Due in 30 days" value={kesFromCents(data.dueNext30TotalCents)} sub={`${data.dueNext30.length} invoices`} />
        <Stat label="Overdue" value={kesFromCents(data.overdueTotalCents)} sub={`${data.overdue.length} invoices`} tone={data.overdue.length ? 'bad' : 'ok'} />
        {pr && <Stat label="Programme used" value={pct(pr.usedBps)} sub={`${kesFromCents(pr.usedCents)} of ${kesFromCents(pr.limitCents)}`} />}
        <Stat label="Pay into" value={data.collectionAccount ?? '-'} sub="your collection account" />
      </div>
      {data.overdue.length > 0 && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">Please pay overdue invoices into your collection account to avoid further reminders.</p>}
      <Table label="Due and overdue" rows={[...data.overdue, ...data.dueNext30]} empty="Nothing due in the next 30 days." cols={[{ key: 'invoiceNumber', label: 'Invoice' }, { key: 'supplier', label: 'Supplier' }, { key: 'dueDate', label: 'Due', render: (r) => d10(r.dueDate) }, { key: 'amountCents', label: 'To pay', money: true }, { key: 'daysPastDue', label: 'Days late', render: (r) => r.daysPastDue > 0 ? String(r.daysPastDue) : '' }]} />
    </div>
  );
}

export function SupplierDashboard({ orgId }: { orgId: string }) {
  const { data } = useGet<any>(`/dashboards/supplier?orgId=${orgId}`);
  if (!data) return <p>Loading…</p>;
  return (
    <div className="space-y-4" data-story="DSH-03">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Advanced, not yet repaid" value={kesFromCents(data.fundedOutstandingCents)} sub={`${data.fundedCount} advances`} />
        <Stat label="Balances still to come" value={kesFromCents(data.balancesToComeCents)} sub="when your buyers pay" />
        <Stat label="Ready to finance" value={kesFromCents(data.financeableCents)} sub={`${data.financeableCount} invoices`} />
        <Stat label="Recourse demands" value={String(data.recourseDemands.length)} tone={data.recourseDemands.length ? 'bad' : 'ok'} />
      </div>
      {data.recourseDemands.length > 0 && <Table label="Recourse demands" rows={data.recourseDemands} cols={[{ key: 'invoiceNumber', label: 'Invoice' }, { key: 'amountCents', label: 'Amount to repay', money: true }, { key: 'demandedOn', label: 'Demanded', render: (r) => d10(r.demandedOn) }]} />}
      <h2 className="h2">Recent payments to you</h2>
      <Table label="Recent payouts" rows={data.recentPayouts} empty="No payments yet." cols={[{ key: 'invoiceNumber', label: 'Invoice' }, { key: 'type', label: 'Type' }, { key: 'amountCents', label: 'Amount', money: true }, { key: 'valueDate', label: 'Date', render: (r) => d10(r.valueDate) }]} />
    </div>
  );
}
