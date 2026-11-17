'use client';
import { FormEvent, useState } from 'react';
import { useLang, useT } from './lang';
import { contactParams, PRIVACY_NOTICE_VERSION } from '@/lib/site-config';

type State = 'idle' | 'busy' | 'done';
async function post(path: string, body: Record<string, unknown>): Promise<{ ok: true; ref: string } | { ok: false; code: string }> {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { ref?: string; error?: string };
    return r.ok && j.ref ? { ok: true, ref: j.ref } : { ok: false, code: j.error ?? 'network' };
  } catch { return { ok: false, code: 'network' }; }
}

/** Hidden from people; bots that fill every field get silently dropped by the Worker. */
function Honeypot() {
  return (
    <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
      <label>Leave this field empty<input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" /></label>
    </div>
  );
}

function Notice({ k }: { k: string }) {
  const t = useT();
  return (
    <p className="rounded bg-slate-50 p-3 text-sm text-slate-700" data-testid="dp-notice">
      {t(k, contactParams())} <a className="underline" href="/legal/privacy">{t('footer.privacy')}</a> ({PRIVACY_NOTICE_VERSION})
    </p>
  );
}

export function BookCallForm() {
  const t = useT(); const lang = useLang();
  const [state, setState] = useState<State>('idle');
  const [err, setErr] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(''); setState('busy');
    const f = new FormData(e.currentTarget);
    const r = await post('/api/book-a-call', {
      contactName: f.get('name'), company: f.get('company'), email: f.get('email'), phone: f.get('phone') || undefined,
      role: f.get('role'), privacyNoticeAccepted: f.get('privacy') === 'on', website: f.get('website'), lang,
    });
    if (r.ok) setState('done'); else { setErr(t(r.code === 'network' ? 'form.error.network' : 'form.error.invalid')); setState('idle'); }
  }
  if (state === 'done') return <p role="status" className="card" data-testid="book-done">{t('book.done')}</p>;
  return (
    <form onSubmit={submit} className="card relative space-y-4" data-testid="book-form">
      <Notice k="book.notice" />
      <label className="block"><span className="label">{t('book.name')}</span><input name="name" required maxLength={120} className="input" autoComplete="name" /></label>
      <label className="block"><span className="label">{t('book.company')}</span><input name="company" required maxLength={200} className="input" autoComplete="organization" /></label>
      <label className="block"><span className="label">{t('book.email')}</span><input name="email" type="email" required maxLength={254} className="input" autoComplete="email" /></label>
      <label className="block"><span className="label">{t('book.phone')}</span><input name="phone" type="tel" pattern="\+254[17][0-9]{8}" placeholder="+2547XXXXXXXX" className="input" autoComplete="tel" /></label>
      <fieldset><legend className="label">{t('book.role')}</legend>
        <label className="mr-6"><input type="radio" name="role" value="buyer" defaultChecked /> {t('book.role.buyer')}</label>
        <label><input type="radio" name="role" value="supplier" /> {t('book.role.supplier')}</label>
      </fieldset>
      <label className="flex gap-2"><input type="checkbox" name="privacy" required /> <span>{t('book.privacy')} <a className="underline" href="/legal/privacy">{t('footer.privacy')}</a></span></label>
      <Honeypot />
      {err && <p role="alert" className="text-red-700">{err}</p>}
      <button className="btn w-full sm:w-auto" disabled={state === 'busy'}>{state === 'busy' ? t('form.sending') : t('book.submit')}</button>
    </form>
  );
}

export function DsrForm() {
  const t = useT(); const lang = useLang();
  const [ref, setRef] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(''); setBusy(true);
    const f = new FormData(e.currentTarget);
    const r = await post('/api/data-request', { email: f.get('email'), type: f.get('type'), details: f.get('details') || undefined, website: f.get('website'), lang });
    setBusy(false);
    if (r.ok) setRef(r.ref); else setErr(t(r.code === 'network' ? 'form.error.network' : 'form.error.invalid'));
  }
  if (ref) return <p role="status" className="card" data-testid="dp-done">{t('dp.done', { ref })}</p>;
  return (
    <form onSubmit={submit} className="card relative space-y-4" data-testid="dp-form">
      <Notice k="dp.notice" />
      <label className="block"><span className="label">{t('dp.email')}</span><input name="email" type="email" required maxLength={254} className="input" autoComplete="email" /></label>
      <label className="block"><span className="label">{t('dp.type')}</span>
        <select name="type" className="input">{['access', 'correction', 'deletion', 'objection', 'portability', 'restriction'].map((k) => <option key={k} value={k}>{t(`dp.type.${k}`)}</option>)}</select>
      </label>
      <label className="block"><span className="label">{t('dp.details')}</span><textarea name="details" maxLength={1000} rows={3} className="input" /></label>
      <Honeypot />
      {err && <p role="alert" className="text-red-700">{err}</p>}
      <button className="btn" disabled={busy}>{busy ? t('form.sending') : t('dp.submit')}</button>
    </form>
  );
}
