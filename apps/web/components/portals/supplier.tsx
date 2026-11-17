'use client';
import { FormEvent, useState } from 'react';
import { api, newIdempotencyKey } from '@/lib/api';
import { kesFromCents, bps } from '@/lib/money';
import { useT } from '../lang';
import { Msg, StatusPill, Table, Tabs, useAction, useGet } from '../ui';

export function SupplierPortal({ orgId }: { orgId: string }) {
  const t = useT();
  const [tab, setTab] = useState('invoices');
  return (
    <div>
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'invoices', label: t('supplier.title') }, { id: 'advances', label: t('supplier.advances') }, { id: 'account', label: 'Account' }, { id: 'help', label: t('footer.complaints') }]} />
      {tab === 'invoices' && <Invoices />}
      {tab === 'advances' && <Advances />}
      {tab === 'account' && <Account orgId={orgId} />}
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
        <input name="fullName" required placeholder="Full name" className="input" /><input name="nationalId" required placeholder="ID number" className="input" />
        <input name="email" type="email" placeholder="Email" className="input" /><input name="phone" placeholder="+2547…" className="input" />
        <button className="btn sm:col-span-2" disabled={busy}>Add</button>
      </form>
      <form onSubmit={bank} className="card grid gap-3 sm:grid-cols-2">
        <h3 className="h2 sm:col-span-2">Payout bank account</h3>
        <input name="bankCode" required placeholder="Bank code (e.g. 11)" className="input" /><input name="accountName" required placeholder="Account name" className="input" />
        <input name="accountNumber" required inputMode="numeric" placeholder="Account number" className="input sm:col-span-2" />
        <button className="btn sm:col-span-2" disabled={busy}>Save</button>
      </form>
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
        <select name="category" className="input">{['pricing', 'service', 'payout', 'data', 'conduct', 'other'].map((c) => <option key={c}>{c}</option>)}</select>
        <textarea name="description" required className="input" rows={4} placeholder="Tell us what happened" />
        <button className="btn" disabled={busy}>Send</button>
      </form>
      <Msg msg={msg} />
      <Table rows={data} cols={[{ key: 'category', label: 'Category' }, { key: 'status', label: 'Status' }, { key: 'resolve_due_at', label: 'Resolve by', render: (r) => String(r.resolve_due_at).slice(0, 10) }]} />
    </div>
  );
}
