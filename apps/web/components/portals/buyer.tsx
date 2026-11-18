'use client';
import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { parseKesInput } from '@/lib/money';
import { useT } from '../lang';
import { Msg, StatusPill, Table, Tabs, useAction, useGet } from '../ui';
import { Complaints } from './supplier';
import { kesFromCents } from '@/lib/money';
import { Documents, Shortfalls } from '../shared';
import { BuyerDashboard } from './phase2';

export function BuyerPortal({ roles, orgId }: { roles: string[]; orgId: string }) {
  const t = useT();
  const [tab, setTab] = useState('overview');
  const checker = roles.some((r) => r === 'buyer_checker' || r === 'buyer_admin');
  return (
    <div>
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'invoices', label: t('buyer.title') }, { id: 'new', label: t('buyer.new') }, ...(checker ? [{ id: 'confirm', label: 'Confirm & sign ILU' }] : []),
        { id: 'calendar', label: t('buyer.calendar') }, { id: 'programme', label: 'Programme' }, { id: 'documents', label: 'Documents' }, { id: 'suppliers', label: t('buyer.invite') }, ...(roles.includes('buyer_admin') ? [{ id: 'users', label: 'Users' }] : []), { id: 'help', label: t('footer.complaints') }]} />
      {tab === 'overview' && <BuyerDashboard orgId={orgId} />}
      {tab === 'invoices' && <AllInvoices />}
      {tab === 'new' && <NewInvoice />}
      {tab === 'confirm' && <Confirm />}
      {tab === 'calendar' && <><Calendar /><div className="mt-6"><Shortfalls /></div></>}
      {tab === 'programme' && <Programme />}
      {tab === 'documents' && <div className="space-y-8">
        <Documents orgId={orgId} story="BUY-09" upload={false} types={['notice_of_assignment']} />
        <Documents orgId={orgId} story="BUY-12" upload={false} types={['receipt']} />
        <Documents orgId={orgId} story="BUY-02" upload={roles.includes('buyer_admin')} />
      </div>}
      {tab === 'suppliers' && <Invite />}
      {tab === 'users' && <Users orgId={orgId} />}
      {tab === 'help' && <Complaints />}
    </div>
  );
}

function AllInvoices() {
  const { data, reload } = useGet<any[]>('/invoices');
  const { msg, run } = useAction();
  const dispute = (id: string) => run(() => api('/disputes', { body: { invoiceId: id, reasonCode: 'other', description: prompt('Describe the problem') ?? '' } }), 'Dispute raised').then(reload);
  return (<><Msg msg={msg} />
    <Table rows={data} cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'amount_cents', label: 'Amount', money: true }, { key: 'due_date', label: 'Due' },
      { key: 'etims_status', label: 'eTIMS' }, { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> },
      { key: 'd', label: '', render: (r) => !['settled', 'cancelled', 'rejected', 'disputed'].includes(r.status) ? <button className="underline" onClick={() => dispute(r.id)}>Dispute</button> : null }]} /></>);
}

function NewInvoice() {
  const { busy, msg, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const cents = parseKesInput(f.amount);
    if (cents === null) return;
    void run(() => api('/invoices', { body: { supplierKraPin: f.pin, invoiceNumber: f.number, amountCents: cents.toString(), currency: 'KES', issueDate: f.issue, dueDate: f.due, etimsCuInvoiceNo: f.cu || undefined } }), 'Invoice added. A second person must now confirm it.');
  };
  const csv = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const file = (e.currentTarget.elements.namedItem('file') as HTMLInputElement).files?.[0]; if (file) void file.text().then((text) => run(() => api('/invoices/csv', { body: { csv: text } }), 'CSV processed')); };
  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
        <input name="pin" required placeholder="Supplier KRA PIN" className="input" /><input name="number" required placeholder="Invoice number" className="input" />
        <input name="amount" required inputMode="decimal" placeholder="Amount (KES)" className="input" /><input name="cu" placeholder="eTIMS CU invoice no." className="input" />
        <label><span className="label">Issue date</span><input name="issue" type="date" required className="input" /></label>
        <label><span className="label">Due date</span><input name="due" type="date" required className="input" /></label>
        <button className="btn sm:col-span-2" disabled={busy}>Add invoice</button>
      </form>
      <form onSubmit={csv} className="card space-y-3"><p className="text-sm">CSV columns: supplier_kra_pin, invoice_number, amount_cents, currency, issue_date, due_date (max 500 rows)</p>
        <input name="file" type="file" accept=".csv,text/csv" className="input" /><button className="btn" disabled={busy}>Upload CSV</button></form>
      <Msg msg={msg} />
    </div>
  );
}

function Confirm() {
  const t = useT();
  const pending = useGet<any[]>('/invoices?status=awaiting_confirmation');
  const confirmed = useGet<any[]>('/invoices?status=confirmed');
  const [sel, setSel] = useState<string[]>([]);
  const { busy, msg, run } = useAction();
  const onHold = useGet<any[]>('/invoices?status=on_hold');
  const decide = (id: string, decision: string) => {
    const body = decision === 'reject' ? { decision, reasonCode: 'not_recognised', reasonText: prompt('Why are you rejecting this invoice?') ?? undefined }
      : decision === 'hold' ? { decision, reasonText: prompt('Why are you holding this invoice? (e.g. goods being checked)') ?? undefined } : { decision };
    const done: Record<string, string> = { approve: 'Approved', reject: 'Rejected', hold: 'On hold - the supplier cannot be paid early until you release it', release_hold: 'Hold released' };
    return run(() => api(`/invoices/${id}/decision`, { body }), done[decision]).then(() => { void pending.reload(); void confirmed.reload(); void onHold.reload(); });
  };
  return (
    <div className="space-y-6">
      <Msg msg={msg} />
      <h2 className="h2">Waiting for your confirmation</h2>
      <Table rows={pending.data} cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'amount_cents', label: 'Amount', money: true }, { key: 'due_date', label: 'Due' }, { key: 'etims_status', label: 'eTIMS' },
        { key: 'a', label: '', render: (r) => <span className="flex flex-wrap gap-2"><button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => decide(r.id, 'approve')}>{t('buyer.approve')}</button><button className="btn-secondary !min-h-10 !py-2" onClick={() => decide(r.id, 'hold')}>Hold</button><button className="btn-secondary !min-h-10 !py-2" onClick={() => decide(r.id, 'reject')}>{t('buyer.reject')}</button></span> }]} />
      <section data-story="BUY-07" className="space-y-2"><h2 className="h2">On hold</h2>
        <Table rows={onHold.data} empty="No invoices on hold" cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'amount_cents', label: 'Amount', money: true }, { key: 'due_date', label: 'Due' },
          { key: 'a', label: '', render: (r) => <span className="flex flex-wrap gap-2"><button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => decide(r.id, 'release_hold')}>Release hold</button><button className="btn-secondary !min-h-10 !py-2" onClick={() => decide(r.id, 'approve')}>{t('buyer.approve')}</button><button className="btn-secondary !min-h-10 !py-2" onClick={() => decide(r.id, 'reject')}>{t('buyer.reject')}</button></span> }]} /></section>
      <h2 className="h2">Confirmed - sign the undertaking to pay (ILU)</h2>
      <Table rows={confirmed.data} cols={[{ key: 's', label: '', render: (r) => <input type="checkbox" aria-label={`select ${r.invoice_number}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /> },
        { key: 'invoice_number', label: 'Invoice' }, { key: 'amount_cents', label: 'Amount', money: true }, { key: 'due_date', label: 'Due' }]} />
      <button className="btn" disabled={!sel.length || busy} onClick={() => run(() => api('/confirmations', { body: { invoiceIds: sel } }), 'Undertaking sent for e-signature').then(() => setSel([]))}>{t('buyer.sign')}</button>
    </div>
  );
}

function Calendar() {
  const { data } = useGet<{ payTo: { bankCode: string; accountNumber: string; reference: string } | null; due: any[] }>('/buyer/payment-calendar');
  return (
    <div className="space-y-4">
      {data?.payTo && <div className="card"><p className="font-semibold">Pay financed invoices to</p><p>Bank {data.payTo.bankCode} · Account <span className="font-mono">{data.payTo.accountNumber}</span></p><p className="text-sm text-slate-600">{data.payTo.reference}</p></div>}
      <Table rows={data?.due ?? null} cols={[{ key: 'due_date', label: 'Due', render: (r) => String(r.due_date).slice(0, 10) }, { key: 'invoices', label: 'Invoices' }, { key: 'invoice_numbers', label: 'Numbers', render: (r) => r.invoice_numbers.join(', ') }, { key: 'amount_cents', label: 'Pay', money: true }]} />
    </div>
  );
}

function Invite() {
  const { busy, msg, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    void run(() => api('/invitations', { body: { kind: 'supplier', email: f.email, phone: f.phone || undefined, supplier: { legalName: f.name, kraPin: f.pin, registrationNo: f.reg } } }), 'Invitation sent'); };
  return (
    <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
      <input name="name" required placeholder="Supplier legal name" className="input" /><input name="pin" required placeholder="KRA PIN" className="input" />
      <input name="reg" required placeholder="Registration number" className="input" /><input name="email" type="email" required placeholder="Finance contact email" className="input" />
      <input name="phone" placeholder="+2547…" className="input" /><button className="btn" disabled={busy}>Send invitation</button>
      <div className="sm:col-span-2"><Msg msg={msg} /></div>
    </form>
  );
}

/** BUY-04: buyer admin adds makers (upload invoices) and checkers (approve, sign ILUs). */
function Users({ orgId }: { orgId: string }) {
  const { busy, msg, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    void run(() => api('/invitations', { body: { kind: 'buyer_user', orgId, email: f.email, role: f.role } }), 'Invitation sent'); };
  return (
    <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
      <input name="email" type="email" required placeholder="Colleague's work email" className="input" />
      <select name="role" className="input"><option value="buyer_maker">Maker - adds invoices</option><option value="buyer_checker">Checker - approves invoices and signs ILUs</option></select>
      <button className="btn sm:col-span-2" disabled={busy}>Invite user</button>
      <div className="sm:col-span-2"><Msg msg={msg} /></div>
    </form>
  );
}

/** BUY-13 programme limit and how much of it is in use. */
function Programme() {
  const { data } = useGet<any>('/buyer/programme');
  if (!data) return null;
  if (data.status === 'none') return <p data-story="BUY-13">No programme yet. Mapema will propose one after the credit review.</p>;
  const pct = Number(data.limit_cents) > 0 ? Math.min(100, Math.round((Number(data.used_cents) / Number(data.limit_cents)) * 100)) : 0;
  return (
    <section data-story="BUY-13" className="space-y-4" aria-labelledby="prog-h">
      <h2 id="prog-h" className="h2">Your supplier finance programme</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['Limit', kesFromCents(data.limit_cents)], ['In use', kesFromCents(data.used_cents)], ['Available', kesFromCents(data.available_cents)], ['Review date', String(data.review_date).slice(0, 10)]].map(([k, v]) => (
          <div key={k} className="card"><div className="text-xs uppercase text-slate-500">{k}</div><div className="text-lg font-semibold tabular-nums">{v}</div></div>))}
      </div>
      <div role="meter" aria-label="Programme utilisation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-3 w-full rounded bg-slate-100"><div className="h-3 rounded bg-brand" style={{ width: `${pct}%` }} /></div>
      <p className="text-sm text-slate-600">{pct}% in use · advance rate {(data.advance_rate_bps / 100).toFixed(0)}% · status {data.status}</p>
      <Table rows={data.suppliers} empty="No suppliers yet" cols={[{ key: 'supplier_name', label: 'Supplier' }, { key: 'exposure_cents', label: 'In use', money: true }, { key: 'supplier_limit_cents', label: 'Supplier limit', money: true }, { key: 'open_advances', label: 'Open advances' }]} />
    </section>
  );
}
