'use client';
/** [Frontend Engineer] Phase 1b staff screens: credit files + programme proposal, review tasks, DSR handling, staff admin, limits/float, write-offs. */
import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { kesFromCents, parseKesInput } from '@/lib/money';
import { Documents, Field, Shortfalls } from '../shared';
import { GovernmentPayerFields } from './phase4';
import { Msg, StatusPill, Table, useAction, useGet } from '../ui';

const day = (v: unknown) => (v ? String(v).slice(0, 10) : '-');
const cancelled = () => Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });

/** CRD-01 buyer credit file / CRD-04 supplier credit file, with CRD-03 programme proposal (buyers) and CRD-05 limit (suppliers). */
export function CreditFile({ orgId, onClose, canCredit }: { orgId: string; onClose: () => void; canCredit: boolean }) {
  const org = useGet<any>(`/organisations/${orgId}`);
  const file = useGet<any>(`/organisations/${orgId}/credit-file`);
  const { busy, msg, run } = useAction();
  const o = org.data; const f = file.data;
  const buyer = o?.type === 'buyer';
  const propose = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const cents = parseKesInput(v.limit); const rate = Math.round(Number(v.rate) * 100);
    void run(async () => {
      if (cents === null) throw Object.assign(new Error('Enter the limit in KES'), { code: 'BAD_AMOUNT' });
      await api(`/organisations/${orgId}/programme`, { body: { limitCents: cents.toString(), advanceRateBps: rate, startDate: v.start, reviewDate: v.review, decisionReason: v.reason, governmentPayerDependent: Boolean(v.govdep), governmentPayerNote: v.govnote || undefined, pricingProfileCode: v.profile || 'bank-funded-A', processingFeePayer: v.buyerPays ? 'buyer' : 'supplier', lenderDisplayName: v.lender || undefined } });
    }, 'Programme proposed - the CEO must approve').then(org.reload);
  };
  const setLimit = (linkId: string, buyerName: string) => run(async () => {
    const kes = prompt(`Supplier limit in KES with ${buyerName}`); if (!kes) throw cancelled();
    const cents = parseKesInput(kes); if (cents === null) throw Object.assign(new Error('Not a KES amount'), { code: 'BAD_AMOUNT' });
    const reason = prompt('Reason for the limit'); if (!reason) throw cancelled();
    await api(`/supplier-links/${linkId}/limit`, { body: { limitCents: cents.toString(), reason } });
  }, 'Limit proposed - a second credit officer must approve');
  return (
    <section data-story={buyer ? 'CRD-01' : 'CRD-04'} className="space-y-4" aria-labelledby="cf-h">
      <div className="flex items-center justify-between gap-3"><h2 id="cf-h" className="h2">Credit file: {o?.legal_name ?? '…'}</h2><button className="underline" onClick={onClose}>Back to list</button></div>
      {o && <div className="card grid gap-1 text-sm sm:grid-cols-2">
        <p>Type: <strong>{o.type}</strong></p><p>Status: <StatusPill s={o.status} /></p><p>KRA PIN: {o.kra_pin}</p><p>Registration: {o.registration_no}</p>
        {f && <p>Exposure: {kesFromCents(buyer ? f.exposure.buyerCents : f.exposure.supplierCents)}</p>}
        {buyer && o.programme && <p>Programme: {kesFromCents(o.programme.limit_cents)} · {o.programme.status} · {o.programme.pricing_profile_code ?? 'direct-legacy'} · review {day(o.programme.review_date)}</p>}
        {buyer && <p data-story="P4-8">Government-payer dependent: <strong>{f?.governmentPayerDependent === true ? 'yes' : f?.governmentPayerDependent === false ? 'no' : 'not recorded'}</strong>{f?.governmentPayerNote ? ` — ${f.governmentPayerNote}` : ''}{f?.sectorCode === 'CONS' ? ' (construction)' : ''}</p>}
      </div>}
      <Msg msg={msg} />
      {canCredit && <button className="btn" disabled={busy} onClick={() => run(() => api(`/organisations/${orgId}/crb-pull`, { body: {} }), 'CRB report pulled').then(file.reload)}>Pull CRB report</button>}
      <h3 className="font-semibold">Credit bureau</h3>
      <Table rows={f?.creditChecks ?? null} empty="No CRB report yet" cols={[{ key: 'bureau', label: 'Bureau' }, { key: 'score', label: 'Score' }, { key: 'bureau_ref', label: 'Ref' }, { key: 'pulled_at', label: 'Pulled', render: (r) => day(r.pulled_at) }]} />
      <h3 className="font-semibold">KYC / KYB checks</h3>
      <Table rows={f?.kycChecks ?? null} empty="No checks yet" cols={[{ key: 'check_type', label: 'Check' }, { key: 'result', label: 'Result', render: (r) => <StatusPill s={r.result} /> }, { key: 'provider', label: 'Provider' }, { key: 'checked_at', label: 'Date', render: (r) => day(r.checked_at) }]} />
      <h3 className="font-semibold">Consents</h3>
      <Table rows={f?.consents ?? null} cols={[{ key: 'purpose', label: 'Purpose' }, { key: 'granted_at', label: 'Given', render: (r) => day(r.granted_at) }, { key: 'withdrawn_at', label: 'Withdrawn', render: (r) => day(r.withdrawn_at) }]} />
      {(f?.amlFlags?.length ?? 0) > 0 && <p role="alert" className="rounded bg-amber-50 p-2 text-sm">{f.amlFlags.length} AML flag(s) - see Compliance. Never disclose to the customer.</p>}
      {buyer && canCredit && (
        <form onSubmit={propose} data-story="CRD-03" className="card grid gap-3 sm:grid-cols-2">
          <h3 className="h2 sm:col-span-2">Propose buyer programme (CEO approves)</h3>
          <Field label="Programme limit (KES)"><input name="limit" required inputMode="decimal" className="input" /></Field>
          <Field label="Advance rate (% of invoice)"><input name="rate" required type="number" min="1" max="100" step="0.01" defaultValue="80" className="input" /></Field>
          <Field label="Start date"><input name="start" required type="date" className="input" /></Field>
          <Field label="Review date"><input name="review" required type="date" className="input" /></Field>
          <Field label="Decision reason" className="sm:col-span-2"><textarea name="reason" required rows={3} className="input" /></Field>
          <Field label="Pricing profile"><select name="profile" className="input" defaultValue="bank-funded-A"><option value="bank-funded-A">Bank-funded (model A)</option><option value="direct-legacy">Direct (legacy)</option></select></Field>
          <Field label="Funding bank name (shown to suppliers)"><input name="lender" className="input" /></Field>
          <label className="flex gap-2 text-sm sm:col-span-2"><input type="checkbox" name="buyerPays" /> Buyer pays the processing fee</label>
          <GovernmentPayerFields />
          <button className="btn sm:col-span-2" disabled={busy}>Propose programme</button>
        </form>
      )}
      {buyer && canCredit && o?.programme && ['approved','live'].includes(o.programme.status) && (
        <form onSubmit={(e) => {
          e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          void run(() => api(`/organisations/${orgId}/programme/pricing-profile`, { body: { pricingProfileCode: v.profile, processingFeePayer: v.buyerPays ? 'buyer' : 'supplier', lenderDisplayName: v.lender || undefined } }), 'Proposed - the CEO must approve').then(org.reload);
        }} className="card grid gap-3 sm:grid-cols-2">
          <h3 className="h2 sm:col-span-2">Change programme pricing (CEO approves)</h3>
          <Field label="Pricing profile"><select name="profile" className="input" defaultValue={o.programme.pricing_profile_code ?? 'direct-legacy'}><option value="bank-funded-A">Bank-funded (model A)</option><option value="direct-legacy">Direct (legacy)</option></select></Field>
          <Field label="Funding bank name (shown to suppliers)"><input name="lender" className="input" defaultValue={o.programme.lender_display_name ?? ''} /></Field>
          <label className="flex gap-2 text-sm sm:col-span-2"><input type="checkbox" name="buyerPays" defaultChecked={o.programme.processing_fee_payer === 'buyer'} /> Buyer pays the processing fee</label>
          <button className="btn sm:col-span-2" disabled={busy}>Propose pricing change</button>
        </form>
      )}
      {!buyer && canCredit && o?.supplierLinks?.length > 0 && (
        <div className="card space-y-2"><h3 className="font-semibold">Limits per buyer</h3>
          <Table rows={o.supplierLinks} cols={[{ key: 'buyer_name', label: 'Buyer' }, { key: 'supplier_limit_cents', label: 'Limit', money: true }, { key: 'status', label: 'Link' },
            { key: 'x', label: '', render: (r) => <button className="underline" disabled={busy} onClick={() => setLimit(r.id, r.buyer_name)}>Set limit…</button> }]} /></div>
      )}
      <Documents orgId={orgId} story={buyer ? 'CRD-01-docs' : 'CRD-04-docs'} upload={false} />
    </section>
  );
}

/** CRD-07 review-date and KYC-expiry tasks. */
export function ReviewTasks({ canCredit }: { canCredit: boolean }) {
  const { data, reload } = useGet<any[]>('/credit/tasks?status=open');
  const { busy, msg, run } = useAction();
  const label: Record<string, string> = { programme_review: 'Programme review', limit_review: 'Limit review', kyc_expiry: 'KYC refresh' };
  return (
    <section data-story="CRD-07" className="space-y-3" aria-labelledby="rt-h">
      <h2 id="rt-h" className="h2">Review tasks</h2>
      <p className="text-sm text-slate-600">Created automatically 30 and 7 days before a review date or KYC expiry, and on the day. On the day the party is blocked from new advances until reviewed.</p>
      <Msg msg={msg} />
      {canCredit && <button className="btn-secondary" disabled={busy} onClick={() => run(() => api('/credit/review-reminders/run', { body: {} }), 'Checked for new review dates').then(reload)}>Check now</button>}
      <Table rows={data} empty="No open review tasks" cols={[{ key: 'kind', label: 'Task', render: (r) => label[r.kind] ?? r.kind }, { key: 'org_name', label: 'Party' }, { key: 'due_date', label: 'Due', render: (r) => day(r.due_date) },
        { key: 'threshold_days', label: 'When', render: (r) => (r.threshold_days === 0 ? <strong className="text-red-700">due now - blocked</strong> : `${r.threshold_days}-day notice`) },
        ...(canCredit ? [{ key: 'x', label: '', render: (r: any) => <button className="underline" disabled={busy} onClick={() => { const note = prompt('What was reviewed / decided?'); if (note) void run(() => api(`/credit/tasks/${r.id}/done`, { body: { note } }), 'Task closed').then(reload); }}>Mark done…</button> }] : [])]} />
    </section>
  );
}

/** OPS-12 data subject requests: verify identity, progress and close. */
export function DsrPanel() {
  const { data, reload } = useGet<any[]>('/dsr');
  const { busy, msg, run } = useAction();
  const [sel, setSel] = useState<any>(null);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const v = new FormData(e.currentTarget);
    void run(() => api(`/dsr/${sel.id}`, { body: { status: v.get('status'), note: (v.get('note') as string) || undefined, identityVerified: v.get('idv') === 'on' || undefined } }), 'Request updated').then(() => { setSel(null); void reload(); });
  };
  return (
    <section data-story="OPS-12" className="space-y-3" aria-labelledby="dsr-h">
      <h2 id="dsr-h" className="h2">Data subject requests</h2>
      <Msg msg={msg} />
      <Table rows={data} empty="No requests" cols={[{ key: 'type', label: 'Type' }, { key: 'requester_email', label: 'Requester' }, { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> },
        { key: 'due_at', label: 'Due', render: (r) => <span className={r.overdue ? 'font-semibold text-red-700' : ''}>{day(r.due_at)}{r.overdue ? ' (overdue)' : ''}</span> },
        { key: 'identity_verified_at', label: 'ID checked', render: (r) => (r.identity_verified_at ? 'yes' : 'no') },
        { key: 'x', label: '', render: (r) => !['completed', 'refused'].includes(r.status) ? <button className="underline" onClick={() => setSel(r)}>Update…</button> : null }]} />
      {sel && (
        <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2" aria-label="Update request">
          <p className="sm:col-span-2 text-sm">{sel.type} request from {sel.requester_email}</p>
          <Field label="New status"><select name="status" className="input" defaultValue="in_progress">{['verifying', 'in_progress', 'partially_completed', 'completed', 'refused'].map((s) => <option key={s}>{s}</option>)}</select></Field>
          <label className="flex items-center gap-2 self-end"><input type="checkbox" name="idv" /> Identity verified</label>
          <Field label="Note (what was done; reason if refused)" className="sm:col-span-2"><textarea name="note" rows={3} className="input" /></Field>
          <div className="flex gap-3 sm:col-span-2"><button className="btn" disabled={busy}>Save</button><button type="button" className="btn-secondary" onClick={() => setSel(null)}>Cancel</button></div>
        </form>
      )}
    </section>
  );
}

/** ADM-01 staff users and role invitations (a second person approves before the invite is sent). */
export function StaffAdmin() {
  const { data, reload } = useGet<any[]>('/admin/users');
  const { busy, msg, run } = useAction();
  const [kind, setKind] = useState('staff');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    void run(() => api('/invitations', { body: kind === 'staff' ? { kind, email: v.email, role: v.role } : { kind, email: v.email, accessExpiresAt: new Date(`${v.expires}T23:59:59+03:00`).toISOString() } }),
      'Invitation proposed - a second admin must approve it before it is sent').then(reload);
  };
  return (
    <section data-story="ADM-01" className="space-y-3" aria-labelledby="sa-h">
      <h2 id="sa-h" className="h2">Staff and auditors</h2>
      <Table rows={data} cols={[{ key: 'display_name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'roles', label: 'Roles', render: (r) => r.roles.join(', ') },
        { key: 'mfa_methods', label: 'MFA', render: (r) => r.mfa_methods?.join(', ') || '-' }, { key: 'access_expires_at', label: 'Access until', render: (r) => day(r.access_expires_at) }, { key: 'active', label: 'Active', render: (r) => (r.active ? 'yes' : 'no') }]} />
      <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
        <h3 className="h2 sm:col-span-2">Invite</h3>
        <Field label="Type"><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="staff">Mapema staff</option><option value="auditor">External auditor (time-boxed, read-only)</option></select></Field>
        <Field label="Work email"><input name="email" type="email" required className="input" /></Field>
        {kind === 'staff'
          ? <Field label="Role"><select name="role" className="input">{['credit', 'ops', 'compliance', 'admin', 'ceo'].map((r) => <option key={r}>{r}</option>)}</select></Field>
          : <Field label="Access ends on"><input name="expires" type="date" required className="input" /></Field>}
        <button className="btn sm:col-span-2" disabled={busy}>Propose invitation</button>
      </form>
      <Msg msg={msg} />
    </section>
  );
}

/** ADM-03 float and concentration limits (each change goes to the approvals queue). */
export function LimitsFloat() {
  const settings = useGet<any>('/admin/settings');
  const orgs = useGet<any[]>('/organisations');
  const { busy, msg, run } = useAction();
  const [subject, setSubject] = useState('buyer');
  const float = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; const cents = parseKesInput(v.amount);
    void run(async () => { if (cents === null) throw Object.assign(new Error('Enter KES'), { code: 'BAD_AMOUNT' }); await api('/admin/float', { body: { amountCents: cents.toString(), basisNote: v.basis } }); }, 'Float change proposed - needs approval');
  };
  const limit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const cap = v.cap ? parseKesInput(v.cap) : null; const pct = v.pct ? Math.round(Number(v.pct) * 100) : undefined;
    void run(async () => {
      if (cap === null && pct === undefined) throw Object.assign(new Error('Give a % of float or a KES cap'), { code: 'LIMIT_REQUIRED' });
      await api('/admin/limits', { body: { subject, subjectOrgId: subject !== 'sector' && v.org ? v.org : undefined, subjectSectorId: subject === 'sector' ? Number(v.sector) : undefined, pctOfFloatBps: pct, absoluteCapCents: cap !== null ? cap.toString() : undefined } });
    }, 'Limit change proposed - needs approval');
  };
  return (
    <section data-story="ADM-03" className="space-y-4" aria-labelledby="lf-h">
      <h2 id="lf-h" className="h2">Float and limits</h2>
      {settings.data && <p>Current float: <strong>{kesFromCents(settings.data.floatCents)}</strong></p>}
      <form onSubmit={float} className="card grid gap-3 sm:grid-cols-2">
        <h3 className="font-semibold sm:col-span-2">Change the lending float</h3>
        <Field label="New float (KES)"><input name="amount" required inputMode="decimal" className="input" /></Field>
        <Field label="Basis (e.g. equity + facility A)"><input name="basis" required className="input" /></Field>
        <button className="btn sm:col-span-2" disabled={busy}>Propose float</button>
      </form>
      <form onSubmit={limit} className="card grid gap-3 sm:grid-cols-2">
        <h3 className="font-semibold sm:col-span-2">Set a concentration limit</h3>
        <Field label="Applies to"><select className="input" value={subject} onChange={(e) => setSubject(e.target.value)}><option value="buyer">Buyer</option><option value="supplier">Supplier</option><option value="sector">Sector</option></select></Field>
        {subject === 'sector'
          ? <Field label="Sector id"><input name="sector" required type="number" min="1" className="input" /></Field>
          : <Field label="Organisation (blank = default for all)"><select name="org" className="input"><option value="">Default for all {subject}s</option>{orgs.data?.filter((o) => o.type === subject).map((o) => <option key={o.id} value={o.id}>{o.legal_name}</option>)}</select></Field>}
        <Field label="% of float"><input name="pct" type="number" min="0" max="100" step="0.01" className="input" /></Field>
        <Field label="or absolute cap (KES)"><input name="cap" inputMode="decimal" className="input" /></Field>
        <button className="btn sm:col-span-2" disabled={busy}>Propose limit</button>
      </form>
      <Msg msg={msg} />
    </section>
  );
}

/** ADM-07 propose a write-off (CEO approves; the ledger write-off posts on approval). */
export function WriteOffs() {
  const npl = useGet<any[]>('/advances/queue?status=non_performing');
  const rec = useGet<any[]>('/advances/queue?status=recourse');
  const { busy, msg, run } = useAction();
  const rows = npl.data && rec.data ? [...npl.data, ...rec.data] : null;
  return (
    <section data-story="ADM-07" className="space-y-3" aria-labelledby="wo-h">
      <h2 id="wo-h" className="h2">Write-offs</h2>
      <p className="text-sm text-slate-600">Only recourse and non-performing advances are listed. A write-off needs the CEO&apos;s approval.</p>
      <Msg msg={msg} />
      <Table rows={rows} empty="Nothing to write off" cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'buyer_name', label: 'Buyer' }, { key: 'principal_cents', label: 'Advance', money: true },
        { key: 'status', label: 'Status', render: (r) => <StatusPill s={r.status} /> }, { key: 'due_date', label: 'Due', render: (r) => day(r.due_date) },
        { key: 'x', label: '', render: (r) => <button className="underline" disabled={busy} onClick={() => { const reason = prompt('Reason for write-off (recovery steps taken)'); if (reason) void run(() => api(`/advances/${r.id}/write-off`, { body: { reason } }), 'Write-off proposed - the CEO must approve'); }}>Propose write-off…</button> }]} />
    </section>
  );
}

export { Shortfalls };
