'use client';
import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { parseKesInput } from '@/lib/money';
import { useT } from '../lang';
import { Msg, StatusPill, Table, Tabs, useAction, useGet } from '../ui';
import { Complaints } from './supplier';

export function BuyerPortal({ roles }: { roles: string[] }) {
  const t = useT();
  const [tab, setTab] = useState('invoices');
  const checker = roles.some((r) => r === 'buyer_checker' || r === 'buyer_admin');
  return (
    <div>
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'invoices', label: t('buyer.title') }, { id: 'new', label: t('buyer.new') }, ...(checker ? [{ id: 'confirm', label: 'Confirm & sign ILU' }] : []),
        { id: 'calendar', label: t('buyer.calendar') }, { id: 'suppliers', label: t('buyer.invite') }, { id: 'help', label: t('footer.complaints') }]} />
      {tab === 'invoices' && <AllInvoices />}
      {tab === 'new' && <NewInvoice />}
      {tab === 'confirm' && <Confirm />}
      {tab === 'calendar' && <Calendar />}
      {tab === 'suppliers' && <Invite />}
      {tab === 'help' && <Complaints />}
    </div>
  );
}

function AllInvoices() {
  const { data, reload } = useGet<any[]>('/invoices');
  const { msg, run } = useAction();
  const dispute = (id: string) => run((tok) => api('/disputes', { token: tok, body: { invoiceId: id, reasonCode: 'other', description: prompt('Describe the problem') ?? '' } }), 'Dispute raised').then(reload);
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
    void run((tok) => api('/invoices', { token: tok, body: { supplierKraPin: f.pin, invoiceNumber: f.number, amountCents: cents.toString(), currency: 'KES', issueDate: f.issue, dueDate: f.due, etimsCuInvoiceNo: f.cu || undefined } }), 'Invoice added. A second person must now confirm it.');
  };
  const csv = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const file = (e.currentTarget.elements.namedItem('file') as HTMLInputElement).files?.[0]; if (file) void file.text().then((text) => run((tok) => api('/invoices/csv', { token: tok, body: { csv: text } }), 'CSV processed')); };
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
  const decide = (id: string, decision: string) => run((tok) => api(`/invoices/${id}/decision`, { token: tok, body: decision === 'reject' ? { decision, reasonCode: 'not_recognised', reasonText: prompt('Why are you rejecting this invoice?') ?? undefined } : { decision } }), decision).then(() => { void pending.reload(); void confirmed.reload(); });
  return (
    <div className="space-y-6">
      <Msg msg={msg} />
      <h2 className="h2">Waiting for your confirmation</h2>
      <Table rows={pending.data} cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'amount_cents', label: 'Amount', money: true }, { key: 'due_date', label: 'Due' }, { key: 'etims_status', label: 'eTIMS' },
        { key: 'a', label: '', render: (r) => <span className="flex gap-2"><button className="btn !min-h-10 !py-2" disabled={busy} onClick={() => decide(r.id, 'approve')}>{t('buyer.approve')}</button><button className="btn-secondary !min-h-10 !py-2" onClick={() => decide(r.id, 'reject')}>{t('buyer.reject')}</button></span> }]} />
      <h2 className="h2">Confirmed - sign the undertaking to pay (ILU)</h2>
      <Table rows={confirmed.data} cols={[{ key: 's', label: '', render: (r) => <input type="checkbox" aria-label={`select ${r.invoice_number}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /> },
        { key: 'invoice_number', label: 'Invoice' }, { key: 'amount_cents', label: 'Amount', money: true }, { key: 'due_date', label: 'Due' }]} />
      <button className="btn" disabled={!sel.length || busy} onClick={() => run((tok) => api('/confirmations', { token: tok, body: { invoiceIds: sel } }), 'Undertaking sent for e-signature').then(() => setSel([]))}>{t('buyer.sign')}</button>
    </div>
  );
}

function Calendar() {
  const { data } = useGet<any[]>('/buyer/payment-calendar');
  return <Table rows={data} cols={[{ key: 'due_date', label: 'Due' }, { key: 'invoice_number', label: 'Invoice' }, { key: 'amount_cents', label: 'Pay', money: true }, { key: 'pay_to', label: 'Pay to account' }]} />;
}

function Invite() {
  const { busy, msg, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    void run((tok) => api('/invitations', { token: tok, body: { kind: 'supplier', email: f.email, phone: f.phone || undefined, supplier: { legalName: f.name, kraPin: f.pin, registrationNo: f.reg } } }), 'Invitation sent'); };
  return (
    <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
      <input name="name" required placeholder="Supplier legal name" className="input" /><input name="pin" required placeholder="KRA PIN" className="input" />
      <input name="reg" required placeholder="Registration number" className="input" /><input name="email" type="email" required placeholder="Finance contact email" className="input" />
      <input name="phone" placeholder="+2547…" className="input" /><button className="btn" disabled={busy}>Send invitation</button>
      <div className="sm:col-span-2"><Msg msg={msg} /></div>
    </form>
  );
}
