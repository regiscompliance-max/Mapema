'use client';
import { FormEvent, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useT } from './lang';

export function BookCallForm() {
  const t = useT();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [err, setErr] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(''); setState('busy');
    const f = new FormData(e.currentTarget);
    try {
      await api('/public/leads', { body: { contactName: f.get('name'), company: f.get('company'), email: f.get('email'), phone: f.get('phone') || undefined, role: f.get('role'), privacyNoticeAccepted: f.get('privacy') === 'on' } });
      setState('done');
    } catch (x) { setErr((x as ApiError).message); setState('idle'); }
  }
  if (state === 'done') return <p role="status" className="card">{t('book.done')}</p>;
  return (
    <form onSubmit={submit} className="card space-y-4">
      <label className="block"><span className="label">{t('book.name')}</span><input name="name" required className="input" autoComplete="name" /></label>
      <label className="block"><span className="label">{t('book.company')}</span><input name="company" required className="input" autoComplete="organization" /></label>
      <label className="block"><span className="label">{t('book.email')}</span><input name="email" type="email" required className="input" autoComplete="email" /></label>
      <label className="block"><span className="label">{t('book.phone')}</span><input name="phone" type="tel" pattern="\+254[17][0-9]{8}" placeholder="+2547XXXXXXXX" className="input" autoComplete="tel" /></label>
      <fieldset><legend className="label">{t('book.role')}</legend>
        <label className="mr-6"><input type="radio" name="role" value="buyer" defaultChecked /> {t('book.role.buyer')}</label>
        <label><input type="radio" name="role" value="supplier" /> {t('book.role.supplier')}</label>
      </fieldset>
      <label className="flex gap-2"><input type="checkbox" name="privacy" required /> <span>{t('book.privacy')} <a className="underline" href="/legal/privacy">{t('footer.privacy')}</a></span></label>
      {err && <p role="alert" className="text-red-700">{err}</p>}
      <button className="btn w-full sm:w-auto" disabled={state === 'busy'}>{t('book.submit')}</button>
    </form>
  );
}

export function DsrForm() {
  const t = useT();
  const [ref, setRef] = useState(''); const [err, setErr] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr('');
    const f = new FormData(e.currentTarget);
    try { const r = await api<{ id: string }>('/public/data-requests', { body: { email: f.get('email'), type: f.get('type') } }); setRef(r.id.slice(0, 8)); } catch (x) { setErr((x as Error).message); }
  }
  if (ref) return <p role="status" className="card">{t('dp.done', { ref })}</p>;
  return (
    <form onSubmit={submit} className="card space-y-4">
      <label className="block"><span className="label">{t('dp.email')}</span><input name="email" type="email" required className="input" /></label>
      <label className="block"><span className="label">{t('dp.type')}</span>
        <select name="type" className="input">{['access', 'correction', 'deletion', 'objection', 'portability', 'restriction'].map((k) => <option key={k} value={k}>{t(`dp.type.${k}`)}</option>)}</select>
      </label>
      {err && <p role="alert" className="text-red-700">{err}</p>}
      <button className="btn">{t('dp.submit')}</button>
    </form>
  );
}
