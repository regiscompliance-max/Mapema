'use client';
import { FormEvent, useState } from 'react';
import { api, newIdempotencyKey } from '@/lib/api';
import { kesFromCents, parseKesInput } from '@/lib/money';
import { useT } from '../lang';
import { Msg, StatusPill, Table, Tabs, useAction, useGet } from '../ui';

export function StaffPortal({ roles }: { roles: string[] }) {
  const t = useT();
  const [tab, setTab] = useState('dash');
  const has = (...r: string[]) => roles.some((x) => r.includes(x));
  const tabs = [{ id: 'dash', label: t('staff.dashboard') }, { id: 'approvals', label: t('staff.approvals') }, { id: 'advances', label: t('staff.advances') },
    ...(has('ops', 'ceo') ? [{ id: 'payments', label: t('staff.payments') }, { id: 'recon', label: t('staff.recon') }] : []), { id: 'orgs', label: t('staff.orgs') },
    ...(has('compliance') ? [{ id: 'compliance', label: t('staff.compliance') }] : []), ...(has('admin', 'ceo', 'compliance') ? [{ id: 'settings', label: t('staff.settings') }] : [])];
  return (
    <div>
      <Tabs active={tab} onChange={setTab} tabs={tabs} />
      {tab === 'dash' && <Dashboard />}
      {tab === 'approvals' && <Approvals />}
      {tab === 'advances' && <Advances canCredit={has('credit')} canOps={has('ops')} />}
      {tab === 'payments' && <Payments />}
      {tab === 'recon' && <Recon />}
      {tab === 'orgs' && <Orgs />}
      {tab === 'compliance' && <Compliance />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}

function Dashboard() {
  const { data } = useGet<any>('/dashboard');
  if (!data) return null;
  const cards: [string, string][] = [['Float', kesFromCents(data.floatCents)], ['Exposure', kesFromCents(data.exposureCents)], ['Headroom', kesFromCents(data.headroomCents)],
    ['Lending', data.lending.enabled ? `ON (${data.lending.cbk_licence_no})` : 'OFF'], ...Object.entries(data.queues).map(([k, v]) => [k.replace(/_/g, ' '), String(v)] as [string, string])];
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{cards.map(([k, v]) => <div key={k} className="card"><div className="text-xs uppercase text-slate-500">{k}</div><div className="text-lg font-semibold">{v}</div></div>)}</div>;
}

function Approvals() {
  const { data, reload } = useGet<any[]>('/approvals');
  const { busy, msg, run } = useAction();
  const act = (id: string, a: 'approve' | 'reject') => run(() => api(`/approvals/${id}/${a}`, { body: { reason: a === 'reject' ? prompt('Reason') ?? 'rejected' : 'checked' } }), a).then(reload);
  return (<><Msg msg={msg} /><Table rows={data} cols={[{ key: 'action', label: 'Action' }, { key: 'maker_name', label: 'Proposed by' }, { key: 'maker_reason', label: 'Reason' }, { key: 'required_role', label: 'Needs' },
    { key: 'payload', label: 'Change', render: (r) => <code className="text-xs">{JSON.stringify(r.payload)}</code> },
    { key: 'x', label: '', render: (r) => <span className="flex gap-2"><button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => act(r.id, 'approve')}>Approve</button><button className="btn-secondary !min-h-10 !py-2" onClick={() => act(r.id, 'reject')}>Reject</button></span> }]} /></>);
}

function Advances({ canCredit, canOps }: { canCredit: boolean; canOps: boolean }) {
  const requested = useGet<any[]>('/advances/queue?status=requested');
  const approved = useGet<any[]>('/advances/queue?status=approved');
  const { busy, msg, run } = useAction();
  const checks = (r: any) => <ul className="text-xs">{r.checks?.map((c: any) => <li key={c.code} className={c.ok ? 'text-green-700' : 'text-red-700'}>{c.ok ? '✓' : '✗'} {c.code}: {c.detail}</li>)}</ul>;
  const reload = () => { void requested.reload(); void approved.reload(); };
  return (
    <div className="space-y-6"><Msg msg={msg} />
      <h2 className="h2">Requested (credit decision)</h2>
      <Table rows={requested.data} cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'buyer_name', label: 'Buyer' }, { key: 'principal_cents', label: 'Advance', money: true }, { key: 'c', label: 'Checks', render: checks },
        { key: 'x', label: '', render: (r) => canCredit ? <span className="flex gap-2"><button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => run(() => api(`/advances/${r.id}/decision`, { body: { decision: 'approve', reason: 'Checks green' } }), 'Approved').then(reload)}>Approve</button>
          <button className="btn-secondary !min-h-10 !py-2" onClick={() => run(() => api(`/advances/${r.id}/decision`, { body: { decision: 'decline', reason: prompt('Reason') ?? 'declined' } }), 'Declined').then(reload)}>Decline</button></span> : null }]} />
      <h2 className="h2">Approved (ops release - a different person)</h2>
      <Table rows={approved.data} cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'principal_cents', label: 'Advance', money: true }, { key: 'c', label: 'Checks now', render: checks },
        { key: 'x', label: '', render: (r) => canOps ? <button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => run(() => api(`/advances/${r.id}/release`, { idempotencyKey: newIdempotencyKey(), body: {} }), 'Released').then(reload)}>Release payment</button> : null }]} />
    </div>
  );
}

function Payments() {
  const unmatched = useGet<any[]>('/payments?status=unmatched');
  const payouts = useGet<any[]>('/payouts?status=proposed');
  const { busy, msg, run } = useAction();
  return (
    <div className="space-y-6"><Msg msg={msg} />
      <h2 className="h2">Supplier balances to release today</h2>
      <Table rows={payouts.data} cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'amount_cents', label: 'Balance', money: true },
        { key: 'x', label: '', render: (r) => <button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => run(() => api(`/payouts/${r.id}/release`, { body: {} }), 'Balance sent').then(payouts.reload)}>Release</button> }]} />
      <h2 className="h2">Unmatched receipts</h2>
      <Table rows={unmatched.data} cols={[{ key: 'bank_ref', label: 'Bank ref' }, { key: 'payer_name', label: 'Payer' }, { key: 'narrative', label: 'Narrative' }, { key: 'amount_cents', label: 'Amount', money: true },
        { key: 'x', label: '', render: (r) => <button className="underline" onClick={() => { const adv = prompt('Advance id to match'); if (adv) void run(() => api(`/payments/${r.id}/match`, { body: { advanceId: adv, reason: prompt('Evidence') ?? 'manual' } }), 'Match proposed - a second ops user must approve'); }}>Match…</button> }]} />
    </div>
  );
}

function Recon() {
  const { data, reload } = useGet<any[]>('/reconciliation/runs');
  const { busy, msg, run } = useAction();
  return (<div className="space-y-4"><button className="btn" disabled={busy} onClick={() => run(() => api('/reconciliation/run', { body: {} }), 'Reconciliation run').then(reload)}>Run reconciliation now</button><Msg msg={msg} />
    <Table rows={data} cols={[{ key: 'as_of_date', label: 'Date', render: (r) => String(r.as_of_date).slice(0, 10) }, { key: 'bank_balance_cents', label: 'Bank', money: true }, { key: 'fineract_cash_cents', label: 'Ledger', money: true }, { key: 'platform_cash_cents', label: 'Platform', money: true }, { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> }, { key: 'open_breaks', label: 'Open breaks' }]} /></div>);
}

function Orgs() {
  const { data, reload } = useGet<any[]>('/organisations');
  const { busy, msg, run } = useAction();
  const create = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); void run(() => api('/organisations', { body: { type: 'buyer', ...f } }), 'Buyer prospect created').then(reload); };
  return (
    <div className="space-y-4">
      <form onSubmit={create} className="card grid gap-3 sm:grid-cols-2"><h3 className="h2 sm:col-span-2">New buyer prospect</h3>
        <input name="legalName" required placeholder="Legal name" className="input" /><input name="kraPin" required placeholder="KRA PIN" className="input" />
        <input name="registrationNo" required placeholder="Registration no." className="input" /><input name="sectorCode" required placeholder="Sector code (e.g. FMCG)" className="input" />
        <button className="btn sm:col-span-2" disabled={busy}>Create</button></form>
      <Msg msg={msg} />
      <Table rows={data} cols={[{ key: 'legal_name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'kra_pin', label: 'KRA PIN' }, { key: 'sector_code', label: 'Sector' }, { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> },
        { key: 'x', label: '', render: (r) => r.type === 'buyer'
          ? <button className="underline" onClick={() => run(() => api(`/organisations/${r.id}/crb-pull`, { body: {} }), 'CRB report pulled')}>Pull CRB</button>
          : <button className="underline" onClick={() => run(async () => {
              const org = await api<any>(`/organisations/${r.id}`);
              const kes = prompt(`Supplier limit in KES for ${org.supplierLinks[0]?.buyer_name}`); if (!kes) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
              const cents = parseKesInput(kes); if (cents === null) throw Object.assign(new Error('not a KES amount'), { code: 'BAD_AMOUNT' });
              await api(`/supplier-links/${org.supplierLinks[0].id}/limit`, { body: { limitCents: cents.toString(), reason: prompt('Reason') ?? 'credit review' } });
            }, 'Limit proposed - a second credit officer must approve')}>Set limit…</button> }]} />
    </div>
  );
}

function Compliance() {
  const aml = useGet<any[]>('/aml-flags'); const complaints = useGet<any[]>('/complaints'); const dsr = useGet<any[]>('/dsr');
  return (<div className="space-y-6">
    <h2 className="h2">AML flags (never disclose to the customer)</h2><Table rows={aml.data} cols={[{ key: 'rule_code', label: 'Rule' }, { key: 'legal_name', label: 'Organisation' }, { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Raised', render: (r) => String(r.created_at).slice(0, 10) }]} />
    <h2 className="h2">Complaints</h2><Table rows={complaints.data} cols={[{ key: 'category', label: 'Category' }, { key: 'status', label: 'Status' }, { key: 'resolve_due_at', label: 'Due', render: (r) => String(r.resolve_due_at).slice(0, 10) }, { key: 'overdue', label: 'Overdue', render: (r) => r.overdue ? 'YES' : '' }]} />
    <h2 className="h2">Data subject requests</h2><Table rows={dsr.data} cols={[{ key: 'type', label: 'Type' }, { key: 'requester_email', label: 'Requester' }, { key: 'status', label: 'Status' }, { key: 'due_at', label: 'Due', render: (r) => String(r.due_at).slice(0, 10) }]} />
  </div>);
}

function Settings() {
  const { data, reload } = useGet<any>('/admin/settings');
  const { busy, msg, run } = useAction();
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div className="card space-y-2">
        <p>Lending: <strong>{data.lending.enabled ? `ON - CBK licence ${data.lending.cbk_licence_no}` : 'OFF'}</strong></p>
        {data.lending.enabled
          ? <button className="btn" disabled={busy} onClick={() => run(() => api('/admin/lending/disable', { body: { reason: prompt('Reason') ?? 'manual stop' } }), 'Lending switched off').then(reload)}>Switch lending OFF now</button>
          : <button className="btn" disabled={busy} onClick={() => { const n = prompt('CBK licence number'); if (n) void run(() => api('/admin/lending/enable', { body: { cbkLicenceNo: n } }), 'Proposed - the CEO must approve'); }}>Propose switching lending ON</button>}
      </div>
      <Msg msg={msg} />
      <p>Float: {kesFromCents(data.floatCents)} · Minimum invoice: {kesFromCents(data.invoiceMinimumCents)} · Environment: {data.environment}</p>
      <Table rows={data.pricing} cols={[{ key: 'code', label: 'Pricing' }, { key: 'status', label: 'Status' }, { key: 'cbk_approval_ref', label: 'CBK ref' }, { key: 'discount_rate_bps_per_30d', label: 'bps/30d' }, { key: 'verification_fee_cents', label: 'Fee', money: true }]} />
    </div>
  );
}
