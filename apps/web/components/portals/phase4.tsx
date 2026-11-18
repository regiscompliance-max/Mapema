'use client';
/**
 * [Frontend Engineer] Phase 4 security screens: registry search/filing evidence (P4-1),
 * eTIMS override (P4-6), and the government-payer flag on the credit file (P4-8).
 */
import { FormEvent } from 'react';
import { api } from '@/lib/api';
import { useT } from '../lang';
import { Field } from '../shared';
import { Msg, StatusPill, Table, useAction, useGet } from '../ui';

async function fileBody(input: HTMLInputElement | null) {
  const f = input?.files?.[0];
  if (!f) throw Object.assign(new Error('Attach a PDF of the registry portal certificate'), { code: 'FILE_REQUIRED' });
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { fileName: f.name, mimeType: f.type || 'application/pdf', contentBase64: btoa(s) };
}
function fileInput(form: HTMLFormElement) {
  return form.elements.namedItem('file') as HTMLInputElement;
}

/** Registry search evidence + eTIMS override on a requested advance. */
export function RegistrySearchForm({ invoiceId, checks, onDone }: { invoiceId: string; checks: any[]; onDone: () => void }) {
  const t = useT();
  const { busy, msg, run } = useAction();
  const searchNeeded = checks?.some((c) => c.code === 'REGISTRY_SEARCH' && !c.ok);
  const etimsBlocked = checks?.some((c) => c.code === 'ETIMS_VALID' && !c.ok);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const v = Object.fromEntries(new FormData(form)) as Record<string, string>;
    void run(async () => {
      const ev = await fileBody(fileInput(form));
      await api(`/invoices/${invoiceId}/registry-search`, { body: { result: v.result, notes: v.notes || undefined, searchedOn: v.searchedOn, ...ev } });
    }, t('p4.search.proposed')).then(onDone);
  };
  const override = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    void run(() => api(`/invoices/${invoiceId}/etims-override`, { body: { reason: v.reason } }), t('p4.etims.proposed')).then(onDone);
  };
  return (
    <div className="space-y-3" data-story="P4-1">
      {searchNeeded && (
        <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
          <h3 className="h2 sm:col-span-2">{t('p4.search.title')}</h3>
          <p className="sm:col-span-2 text-sm text-slate-600">{t('p4.search.lead')}</p>
          <Field label={t('p4.search.result')}><select name="result" required className="input"><option value="clear">{t('p4.search.clear')}</option><option value="conflict">{t('p4.search.conflict')}</option><option value="conflict_waived">{t('p4.search.waived')}</option></select></Field>
          <Field label={t('p4.search.date')}><input name="searchedOn" type="date" required className="input" /></Field>
          <Field label={t('p4.search.notes')} className="sm:col-span-2"><textarea name="notes" rows={2} className="input" /></Field>
          <Field label={t('p4.search.file')} className="sm:col-span-2"><input name="file" type="file" accept="application/pdf" required className="input" /></Field>
          <button className="btn sm:col-span-2" disabled={busy}>{t('p4.search.submit')}</button>
        </form>
      )}
      {etimsBlocked && (
        <form onSubmit={override} className="card grid gap-3" data-story="P4-6">
          <h3 className="h2">{t('p4.etims.title')}</h3>
          <p className="text-sm text-slate-600">{t('p4.etims.lead')}</p>
          <Field label={t('p4.etims.reason')}><textarea name="reason" required rows={3} className="input" /></Field>
          <button className="btn" disabled={busy}>{t('p4.etims.submit')}</button>
        </form>
      )}
      <Msg msg={msg} />
    </div>
  );
}

export function RegistryFilingQueue({ canOps }: { canOps: boolean }) {
  const t = useT();
  const { data, reload } = useGet<any[]>('/ops/tasks?kind=registry_filing_due&status=open');
  const { busy, msg, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>, advanceId: string) => {
    e.preventDefault();
    const form = e.currentTarget;
    const v = Object.fromEntries(new FormData(form)) as Record<string, string>;
    void run(async () => {
      const ev = await fileBody(fileInput(form));
      await api(`/advances/${advanceId}/registry-filing`, { body: { registrationNo: v.registrationNo, notes: v.notes || undefined, filedOn: v.filedOn, ...ev } });
    }, t('p4.filing.proposed')).then(reload);
  };
  return (
    <section data-story="P4-1-file" className="space-y-3" aria-labelledby="rf-h">
      <h2 id="rf-h" className="h2">{t('p4.filing.title')}</h2>
      <p className="text-sm text-slate-600">{t('p4.filing.lead')}</p>
      <Msg msg={msg} />
      <Table rows={data} empty={t('p4.filing.empty')} cols={[
        { key: 'invoice_number', label: t('p4.invoice') },
        { key: 'supplier_name', label: t('p4.supplier') },
        { key: 'advance_status', label: t('p4.status'), render: (r) => <StatusPill s={r.advance_status} /> },
        ...(canOps ? [{ key: 'x', label: '', render: (r: any) => (
          <form onSubmit={(e) => submit(e, r.advance_id)} className="grid gap-2 sm:grid-cols-2">
            <Field label={t('p4.filing.number')}><input name="registrationNo" required minLength={3} className="input" /></Field>
            <Field label={t('p4.filing.date')}><input name="filedOn" type="date" required className="input" /></Field>
            <Field label={t('p4.filing.notes')} className="sm:col-span-2"><input name="notes" className="input" /></Field>
            <Field label={t('p4.filing.file')} className="sm:col-span-2"><input name="file" type="file" accept="application/pdf" required className="input" /></Field>
            <button className="btn sm:col-span-2" disabled={busy}>{t('p4.filing.submit')}</button>
          </form>
        ) }] : []),
      ]} />
    </section>
  );
}

export function GovernmentPayerFields() {
  const t = useT();
  return (
    <>
      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" name="govdep" /> {t('p4.gov.flag')}</label>
      <Field label={t('p4.gov.note')} className="sm:col-span-2"><textarea name="govnote" rows={2} className="input" /></Field>
      <p className="sm:col-span-2 text-sm text-slate-600">{t('p4.gov.lead')}</p>
    </>
  );
}
