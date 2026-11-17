'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/components/lang';
import { api, ApiError } from '@/lib/api';
import { getSession } from '@/lib/session';

/** Invitation landing: the user first signs in (creating their IdP account with MFA), then accepts. */
export default function Join() {
  const t = useT(); const router = useRouter(); const [err, setErr] = useState('');
  const token = typeof window !== 'undefined' ? new URLSearchParams(location.search).get('token') ?? '' : '';
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr('');
    const f = new FormData(e.currentTarget);
    const s = getSession();
    if (!s) { setErr('Sign in first, then come back to this link.'); return; }
    try { await api('/invitations/accept', { token: s.accessToken, body: { token, displayName: f.get('name'), phone: f.get('phone') || undefined } }); router.push('/app'); } catch (x) { setErr(`${(x as ApiError).code}: ${(x as ApiError).message}`); }
  }
  return (
    <form onSubmit={submit} className="card mx-auto max-w-md space-y-4">
      <h1 className="h1">{t('join.title')}</h1>
      <label className="block"><span className="label">{t('join.name')}</span><input name="name" required className="input" /></label>
      <label className="block"><span className="label">{t('join.phone')}</span><input name="phone" type="tel" pattern="\+254[17][0-9]{8}" className="input" /></label>
      {err && <p role="alert" className="text-red-700">{err}</p>}
      <button className="btn w-full">{t('join.submit')}</button>
    </form>
  );
}
