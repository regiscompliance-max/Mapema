'use client';
/**
 * [Frontend Engineer] Phase 1b screens shared by the buyer, supplier and staff portals.
 * Every screen root carries data-story="<story id>" so tests and the phone-width smoke can find it.
 */
import { FormEvent, ReactNode, useState } from 'react';
import { api, download } from '@/lib/api';
import { kesFromCents } from '@/lib/money';
import { Msg, StatusPill, Table, useAction, useGet } from './ui';

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`block ${className}`}><span className="label">{label}</span>{children}</label>;
}

export const UPLOAD_TYPES: Record<string, string> = {
  certificate_of_incorporation: 'Certificate of incorporation', cr12: 'CR12 (directors and shareholders)', kra_pin_certificate: 'KRA PIN certificate',
  board_resolution: 'Board resolution', national_id: 'Director ID', passport: 'Director passport', bank_proof: 'Bank letter or statement', audited_accounts: 'Audited accounts', other: 'Other',
};
export const DOC_LABELS: Record<string, string> = { ...UPLOAD_TYPES, programme_agreement: 'Programme agreement', master_agreement: 'Master agreement', deed_of_assignment: 'Deed of assignment',
  ilu: 'Undertaking to pay (ILU)', notice_of_assignment: 'Notice of assignment', receipt: 'Payment receipt', invoice_pdf: 'Invoice PDF', selfie: 'Selfie' };

const MAX_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];

/** Validates a picked file before upload (same limits as the API) - exported for unit tests. */
export function checkFile(f: { size: number; type: string }): string | null {
  if (!ACCEPTED_MIME.includes(f.type)) return 'Only PDF, JPEG or PNG files are accepted';
  if (f.size === 0 || f.size > MAX_BYTES) return 'Files must be between 1 byte and 10 MB';
  return null;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** BUY-02 / SUP-02 KYB-KYC document upload + the organisation's documents (BUY-09 notices, BUY-12 receipts) with download. */
export function Documents({ orgId, story, upload = true, types }: { orgId: string; story: string; upload?: boolean; types?: string[] }) {
  const list = useGet<any[]>(`/documents?orgId=${orgId}`);
  const { busy, msg, run } = useAction();
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setErr('');
    const form = e.currentTarget;
    const file = (form.elements.namedItem('file') as HTMLInputElement).files?.[0];
    const type = (form.elements.namedItem('type') as HTMLSelectElement).value;
    if (!file) { setErr('Choose a file'); return; }
    const bad = checkFile(file); if (bad) { setErr(bad); return; }
    const contentBase64 = await toBase64(file);
    if (await run(() => api(`/organisations/${orgId}/documents`, { body: { type, fileName: file.name, mimeType: file.type, contentBase64 } }), 'Uploaded. Our team will review it.')) { form.reset(); void list.reload(); }
  };
  const rows = (list.data ?? null) && (types ? list.data!.filter((d) => types.includes(d.type)) : list.data);
  return (
    <section data-story={story} className="space-y-4" aria-labelledby={`docs-${story}`}>
      <h2 id={`docs-${story}`} className="h2">Documents</h2>
      {upload && (
        <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
          <Field label="Document type"><select name="type" className="input">{Object.entries(UPLOAD_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="File (PDF, JPEG or PNG, up to 10 MB)"><input name="file" type="file" accept={ACCEPTED_MIME.join(',')} className="input" /></Field>
          <button className="btn sm:col-span-2" disabled={busy}>Upload</button>
          {err && <p role="alert" className="text-red-700 sm:col-span-2">{err}</p>}
        </form>
      )}
      <Msg msg={msg} />
      <Table rows={rows} empty="No documents yet" cols={[
        { key: 'type', label: 'Document', render: (r) => DOC_LABELS[r.type] ?? r.type }, { key: 'file_name', label: 'File' },
        { key: 'created_at', label: 'Date', render: (r) => String(r.created_at).slice(0, 10) },
        { key: 'x', label: '', render: (r) => <button className="underline" aria-label={`Download ${r.file_name}`} onClick={() => run(() => download(`/documents/${r.id}/content`, r.file_name), 'Downloaded')}>Download</button> },
      ]} />
    </section>
  );
}

export const CONSENT_TEXT: Record<string, { version: string; title: string; text: string; required?: boolean }> = {
  crb_enquiry_and_reporting: { version: 'CRB-2026-11', required: true, title: 'Credit reference bureau checks', text: 'Mapema may check your business (and its directors) with licensed credit reference bureaus and report how advances are repaid. Needed to give you advances.' },
  data_sharing_with_buyer: { version: 'SHARE-2026-11', title: 'Sharing status with your buyer', text: 'Mapema may tell your buyer which of their invoices are financed and paid, so they pay the right account.' },
  marketing: { version: 'MKT-2026-11', title: 'News and offers', text: 'Occasional emails or SMS about Mapema products. You can stop any time.' },
  cross_border_transfer: { version: 'XB-2026-11', title: 'Processing outside Kenya', text: 'Some service providers may process your data outside Kenya with safeguards described in the privacy notice.' },
};

/** SUP-03 give / withdraw consent. */
export function Consents({ orgId }: { orgId: string }) {
  const list = useGet<any[]>(`/consents?orgId=${orgId}`);
  const { busy, msg, run } = useAction();
  const active = (purpose: string) => list.data?.find((c) => c.purpose === purpose && !c.withdrawn_at);
  return (
    <section data-story="SUP-03" className="space-y-3" aria-labelledby="consent-h">
      <h2 id="consent-h" className="h2">Your consents</h2>
      <p className="text-sm text-slate-600">You can withdraw a consent at any time. Withdrawing the credit bureau consent stops new advances but does not cancel advances you already have.</p>
      <Msg msg={msg} />
      <ul className="space-y-3">
        {Object.entries(CONSENT_TEXT).map(([purpose, c]) => {
          const a = active(purpose);
          return (
            <li key={purpose} className="card space-y-2">
              <div className="flex items-start justify-between gap-3"><h3 className="font-semibold">{c.title}</h3><StatusPill s={a ? 'given' : 'not given'} /></div>
              <p className="text-sm">{c.text}</p>
              <p className="text-xs text-slate-500">Text version {c.version}{a ? ` · given ${String(a.granted_at).slice(0, 10)}` : ''}</p>
              {a ? <button className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/consents/${a.id}/withdraw`, { body: {} }), 'Consent withdrawn').then(list.reload)}>Withdraw</button>
                : <button className="btn" disabled={busy} onClick={() => run(() => api('/consents', { body: { orgId, purpose, textVersion: c.version } }), 'Consent recorded').then(list.reload)}>I agree</button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** SUP-13 self-service view of the personal and business data Mapema holds. */
export function MyData() {
  const { data, error } = useGet<any>('/me/data');
  const save = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'mapema-my-data.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  return (
    <section data-story="SUP-13" className="space-y-4" aria-labelledby="mydata-h">
      <h2 id="mydata-h" className="h2">Your data</h2>
      {error && <p role="alert" className="text-red-700">{error.code}: {error.message}</p>}
      {data && <>
        <div className="card space-y-1"><p><strong>{data.profile.display_name}</strong> · {data.profile.email}</p><p className="text-sm">Sign-in factors: {data.profile.mfa_methods?.join(', ') || '-'} · Roles: {data.roles.map((r: any) => r.role).join(', ')}</p></div>
        {data.organisations.map((o: any) => (
          <div key={o.id} className="card space-y-2">
            <h3 className="font-semibold">{o.legal_name}</h3>
            <p className="text-sm">KRA PIN {o.kra_pin} · Reg. {o.registration_no} · Status {o.status}</p>
            <p className="text-sm">Invoices {o.activity.invoices} · Advances {o.activity.advances} · Documents {o.activity.documents}</p>
            <Table rows={o.people} cols={[{ key: 'fullName', label: 'Person' }, { key: 'nationalIdMasked', label: 'ID' }, { key: 'phoneMasked', label: 'Phone' }, { key: 'email', label: 'Email' }]} />
            <Table rows={o.bankAccounts} cols={[{ key: 'bank_code', label: 'Bank' }, { key: 'account_name', label: 'Name' }, { key: 'account_number_last4', label: 'Account', render: (r) => `••••${r.account_number_last4}` }, { key: 'verified_at', label: 'Verified', render: (r) => (r.verified_at ? 'yes' : 'no') }]} />
          </div>
        ))}
        <Table rows={data.consents} cols={[{ key: 'purpose', label: 'Consent' }, { key: 'granted_at', label: 'Given', render: (r) => String(r.granted_at).slice(0, 10) }, { key: 'withdrawn_at', label: 'Withdrawn', render: (r) => (r.withdrawn_at ? String(r.withdrawn_at).slice(0, 10) : '-') }]} />
        <p className="text-sm">{data.rights}</p>
        <div className="flex flex-col gap-3 sm:flex-row"><button className="btn" onClick={save}>Download a copy (JSON)</button><a className="btn-secondary text-center" href="/data-protection">Ask for a correction or deletion</a></div>
      </>}
    </section>
  );
}

/** D-22: what the buyer still owes the supplier after Mapema was repaid. Supplier admin can close one it recovered or forgave. */
export function Shortfalls({ canClose = false }: { canClose?: boolean }) {
  const { data, reload } = useGet<any[]>('/shortfalls');
  const { busy, msg, run } = useAction();
  const close = (id: string) => {
    const outcome = confirm('Did the buyer pay you directly? OK = recovered directly, Cancel = forgive the amount') ? 'recovered_directly' : 'forgiven';
    const note = prompt('Add a short note (e.g. how and when it was paid)');
    if (note) void run(() => api(`/shortfalls/${id}/close`, { body: { outcome, note } }), 'Updated').then(reload);
  };
  return (
    <section data-story="SHORTFALL" className="space-y-3" aria-labelledby="sf-h">
      <h2 id="sf-h" className="h2">Unpaid balances from the buyer</h2>
      <p className="text-sm text-slate-600">When a buyer pays less than the invoice, Mapema is repaid first. The rest is still owed by the buyer to the supplier; any further payment the buyer makes to the collection account is passed to the supplier.</p>
      <Msg msg={msg} />
      <Table rows={data} empty="Nothing outstanding" cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'buyer_name', label: 'Buyer' }, { key: 'supplier_name', label: 'Supplier' },
        { key: 'invoice_amount_cents', label: 'Invoice', money: true }, { key: 'amount_cents', label: 'Still owed', money: true }, { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> },
        ...(canClose ? [{ key: 'x', label: '', render: (r: any) => r.status === 'open' ? <button className="underline" disabled={busy} onClick={() => close(r.id)}>Close…</button> : null }] : [])]} />
    </section>
  );
}

/** SUP-14 early repayment and recourse explained in plain words (draft for counsel; numbers come from the live quote). */
export function TermsExplained({ example }: { example?: { advanceCents: string; discountFeeCents: string; days: number } }) {
  return (
    <section data-story="SUP-14" className="card space-y-2" aria-labelledby="terms-h">
      <h2 id="terms-h" className="h2">How early repayment and recourse work</h2>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li><strong>You get most of the invoice now.</strong> Mapema pays you the advance; your buyer then pays the full invoice to Mapema&apos;s collection account on the due date.</li>
        <li><strong>If your buyer pays early, you pay less.</strong> The discount fee is charged only for the days the money is actually out{example ? ` - at most ${kesFromCents(example.discountFeeCents)} for ${example.days} days on an advance of ${kesFromCents(example.advanceCents)}` : ''}.</li>
        <li><strong>Order of repayment.</strong> Money from your buyer repays the advance first, then fees, then the discount fee (interest). Everything above that goes to you.</li>
        <li><strong>If your buyer pays short,</strong> Mapema is repaid first and you are told what the buyer still owes you; you follow up with your buyer.</li>
        <li><strong>Recourse.</strong> If the buyer has not paid 30 days after the due date, Mapema may ask you to repay what is outstanding on the advance. Charges can never be more than the advance itself (in duplum rule).</li>
      </ol>
      <p className="text-xs text-slate-500">Plain-language summary; the master agreement and key information document are the binding terms (drafts pending counsel review).</p>
    </section>
  );
}
