'use client';
import { SupplierDashboard } from './phase2';
import { FormEvent, useState } from 'react';
import { api, newIdempotencyKey } from '@/lib/api';
import { kesFromCents, bps, parseKesInput } from '@/lib/money';
import { Consents, Documents, Field, MyData, Shortfalls, TermsExplained } from '../shared';
import { useT } from '../lang';
import { Msg, StatusPill, Table, Tabs, useAction, useGet } from '../ui';

export function SupplierPortal({ orgId, roles = [] }: { orgId: string; roles?: string[] }) {
  const t = useT();
  const [tab, setTab] = useState('overview');
  return (
    <div>
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'invoices', label: t('supplier.title') }, { id: 'submit', label: 'Add invoice' }, { id: 'advances', label: t('supplier.advances') }, { id: 'account', label: 'Account' },
        { id: 'privacy', label: 'Privacy' }, { id: 'help', label: t('footer.complaints') }]} />
      {tab === 'overview' && <SupplierDashboard orgId={orgId} />}
      {tab === 'invoices' && <Invoices />}
      {tab === 'submit' && <SubmitInvoice orgId={orgId} />}
      {tab === 'advances' && <><Advances /><div className="mt-6"><Shortfalls canClose={roles.includes('supplier_admin')} /></div></>}
      {tab === 'account' && <Account orgId={orgId} />}
      {tab === 'privacy' && <div className="space-y-8"><Consents orgId={orgId} /><MyData /></div>}
      {tab === 'help' && <Complaints />}
    </div>
  );
}

function Invoices() {
  const t = useT();
  const { data, reload } = useGet<any[]>('/invoices');
  const [offer, setOffer] = useState<any>(null);
  const [agree, setAgree] = useState(false);
  const { busy, msg, run } = useAction();
  if (offer) return (
    <section className="card space-y-3" aria-labelledby="offer-h">
      <h2 id="offer-h" className="h2">{t('supplier.offer')}</h2>
      <dl className="divide-y">
        {[['Invoice', offer.invoiceAmountCents], [t('calc.advance'), offer.advanceCents], [t('calc.discountFee'), offer.discountFeeCents], [t('calc.verificationFee'), offer.verificationFeeCents], [t('calc.totalCost'), offer.totalCostCents], [t('calc.balance'), offer.supplierBalanceCents]]
          .map(([k, v]) => <div key={k} className="flex justify-between py-2"><dt>{k}</dt><dd className="font-semibold tabular-nums">{kesFromCents(v)}</dd></div>)}
        <div className="flex justify-between py-2 text-sm"><dt>{t('calc.apr')}</dt><dd>{bps(offer.aprBps)}</dd></div>
      </dl>
      <ul className="list-disc space-y-1 pl-5 text-sm">{offer.explanation.map((x: string) => <li key={x}>{x}</li>)}</ul>
      <details className="text-sm"><summary className="cursor-pointer underline">How early repayment and recourse work</summary><TermsExplained example={{ advanceCents: offer.advanceCents, discountFeeCents: offer.discountFeeCents, days: offer.days ?? 0 }} /></details>
      <p className="text-xs text-slate-500">Terms {offer.termsVersion} · Key information {offer.kidVersion} · Offer valid until {new Date(offer.expiresAt).toLocaleTimeString()}</p>
      <label className="flex gap-2"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> {t('supplier.accept')}</label>
      <div className="flex gap-3">
        <button className="btn" disabled={!agree || busy} onClick={async () => { if (await run(() => api('/advances', { idempotencyKey: newIdempotencyKey(), body: { disclosureIds: [offer.disclosureId], acceptTerms: true } }), 'Requested. We will notify you when the money is sent.')) { setOffer(null); void reload(); } }}>{t('supplier.confirm')}</button>
        <button className="btn-secondary" onClick={() => setOffer(null)}>Back</button>
      </div>
      <Msg msg={msg} />
    </section>
  );
  return (
    <>
      <Msg msg={msg} />
      <Table rows={data} cols={[
        { key: 'invoice_number', label: 'Invoice' }, { key: 'buyer_name', label: 'Buyer' }, { key: 'amount_cents', label: 'Amount', money: true }, { key: 'due_date', label: 'Due' },
        { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> },
        { key: 'act', label: '', render: (r) => r.status === 'eligible' ? <button className="btn !min-h-10 !py-2" onClick={() => run(async () => setOffer(await api(`/invoices/${r.id}/quote`, { body: {} })), '')}>{t('supplier.getPaid')}</button> : null },
      ]} />
    </>
  );
}

function Advances() {
  const { data } = useGet<any[]>('/advances');
  return <Table rows={data} cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'principal_cents', label: 'Advance', money: true }, { key: 'discount_fee_cents', label: 'Max discount fee', money: true }, { key: 'due_date', label: 'Due' }, { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> }]} />;
}

function Account({ orgId }: { orgId: string }) {
  const { data: org, reload } = useGet<any>(`/organisations/${orgId}`);
  const { busy, msg, run } = useAction();
  const person = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); void run(() => api(`/organisations/${orgId}/persons`, { body: { fullName: f.fullName, nationalId: f.nationalId, email: f.email || undefined, phone: f.phone || undefined, isDirector: true, isAuthorisedSignatory: true } }), 'Director added').then(reload); };
  const bank = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); void run(() => api(`/organisations/${orgId}/bank-accounts`, { body: f }), 'Bank account saved. Our team will call to verify it.').then(reload); };
  return (
    <div className="space-y-6">
      <p>Status: <StatusPill s={org?.status ?? '…'} /></p>
      <form onSubmit={person} className="card grid gap-3 sm:grid-cols-2">
        <h3 className="h2 sm:col-span-2">Director / signatory</h3>
        <Field label="Full name"><input name="fullName" required className="input" autoComplete="name" /></Field><Field label="ID number"><input name="nationalId" required className="input" /></Field>
        <Field label="Email"><input name="email" type="email" className="input" autoComplete="email" /></Field><Field label="Mobile (+2547…)"><input name="phone" type="tel" className="input" autoComplete="tel" /></Field>
        <button className="btn sm:col-span-2" disabled={busy}>Add</button>
      </form>
      <form onSubmit={bank} className="card grid gap-3 sm:grid-cols-2">
        <h3 className="h2 sm:col-span-2">Payout bank account</h3>
        <Field label="Bank code (e.g. 11)"><input name="bankCode" required inputMode="numeric" className="input" /></Field><Field label="Account name"><input name="accountName" required className="input" /></Field>
        <Field label="Account number" className="sm:col-span-2"><input name="accountNumber" required inputMode="numeric" className="input" /></Field>
        <button className="btn sm:col-span-2" disabled={busy}>Save</button>
      </form>
      <Documents orgId={orgId} story="SUP-02" />
      <TermsExplained />
      <div className="flex flex-col gap-3 sm:flex-row">
        <button className="btn" disabled={busy} onClick={() => run(() => api(`/organisations/${orgId}/submit`, { body: {} }), 'Submitted for verification').then(reload)}>Submit for verification</button>
        <button className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/organisations/${orgId}/agreements`, { body: {} }), 'Agreement sent for e-signature')}>Sign master agreement</button>
      </div>
      <Msg msg={msg} />
    </div>
  );
}

export function Complaints() {
  const { data, reload } = useGet<any[]>('/complaints');
  const { busy, msg, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); void run(() => api('/complaints', { body: f }), 'Complaint received').then(reload); };
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="card space-y-3">
        <Field label="What is it about?"><select name="category" className="input">{['pricing', 'service', 'payout', 'data', 'conduct', 'other'].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Tell us what happened"><textarea name="description" required className="input" rows={4} /></Field>
        <button className="btn" disabled={busy}>Send</button>
      </form>
      <Msg msg={msg} />
      <Table rows={data} cols={[{ key: 'category', label: 'Category' }, { key: 'status', label: 'Status' }, { key: 'resolve_due_at', label: 'Resolve by', render: (r) => String(r.resolve_due_at).slice(0, 10) }]} />
    </div>
  );
}

/** SUP-06 the supplier adds an invoice for its buyer to confirm. */
function SubmitInvoice({ orgId }: { orgId: string }) {
  const { data: org } = useGet<any>(`/organisations/${orgId}`);
  const { busy, msg, run } = useAction();
  const buyers = (org?.supplierLinks ?? []).filter((l: any) => l.supplier_id === orgId);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const form = e.currentTarget; const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const cents = parseKesInput(f.amount);
    void run(async () => {
      if (cents === null) throw Object.assign(new Error('Enter the amount in KES, e.g. 125000.50'), { code: 'BAD_AMOUNT' });
      await api('/invoices', { body: { buyerId: f.buyer, supplierKraPin: org.kra_pin, invoiceNumber: f.number, amountCents: cents.toString(), currency: 'KES', issueDate: f.issue, dueDate: f.due, etimsCuInvoiceNo: f.cu || undefined, poReference: f.po || undefined } });
      form.reset();
    }, 'Invoice sent to your buyer to confirm. You can ask for early payment once they confirm it.');
  };
  return (
    <form data-story="SUP-06" onSubmit={submit} className="card grid gap-3 sm:grid-cols-2" aria-labelledby="si-h">
      <h2 id="si-h" className="h2 sm:col-span-2">Add an invoice</h2>
      <Field label="Buyer" className="sm:col-span-2"><select name="buyer" required className="input">{buyers.map((b: any) => <option key={b.buyer_id} value={b.buyer_id}>{b.buyer_name}</option>)}</select></Field>
      <Field label="Invoice number"><input name="number" required className="input" /></Field>
      <Field label="Amount (KES)"><input name="amount" required inputMode="decimal" className="input" /></Field>
      <Field label="Issue date"><input name="issue" type="date" required className="input" /></Field>
      <Field label="Due date"><input name="due" type="date" required className="input" /></Field>
      <Field label="eTIMS CU invoice number"><input name="cu" className="input" /></Field>
      <Field label="PO reference (optional)"><input name="po" className="input" /></Field>
      <button className="btn sm:col-span-2" disabled={busy || !buyers.length}>Send to buyer</button>
      {!buyers.length && <p className="text-sm sm:col-span-2">You can add invoices once a buyer has invited you.</p>}
      <div className="sm:col-span-2"><Msg msg={msg} /></div>
    </form>
  );
}
