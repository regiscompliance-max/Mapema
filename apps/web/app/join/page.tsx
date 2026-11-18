'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/components/lang';
import { ApiError } from '@/lib/api';
import { devJoin, oidcSignIn } from '@/lib/session';

const DEV = process.env.NEXT_PUBLIC_DEV_SIGNIN === 'true';

/** Invitation landing: the user signs in (creating their IdP account with MFA), the invitation is accepted, then a cookie session starts. */
export default function Join() {
  const t = useT(); const router = useRouter(); const [err, setErr] = useState('');
  const token = typeof window !== 'undefined' ? new URLSearchParams(location.search).get('token') ?? '' : '';
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr('');
    const f = new FormData(e.currentTarget);
    const join = { token, displayName: String(f.get('name')), phone: (f.get('phone') as string) || undefined };
    try {
      if (DEV) { await devJoin(String(f.get('email')), f.get('factor') === 'sms' ? 'sms' : 'otp', join); router.push('/app'); }
      else await oidcSignIn({ join, returnTo: '/app' });
    } catch (x) { setErr(`${(x as ApiError).code ?? 'ERROR'}: ${(x as Error).message}`); }
  }
  return (
    <form onSubmit={submit} className="card mx-auto max-w-md space-y-4">
      <h1 className="h1">{t('join.title')}</h1>
      <label className="block"><span className="label">{t('join.name')}</span><input name="name" required className="input" autoComplete="name" /></label>
      <label className="block"><span className="label">{t('join.phone')}</span><input name="phone" type="tel" pattern="\+254[17][0-9]{8}" className="input" autoComplete="tel" /></label>
      {DEV && <>
        <p className="rounded bg-amber-50 p-2 text-sm">{t('signin.dev')} - not available in production.</p>
        <label className="block"><span className="label">{t('signin.email')}</span><input name="email" type="email" required className="input" autoComplete="email" /></label>
        <label className="block"><span className="label">{t('signin.factor')}</span>
          <select name="factor" className="input"><option value="otp">Authenticator app</option><option value="sms">SMS code (suppliers only)</option></select></label>
      </>}
      {err && <p role="alert" className="text-red-700">{err}</p>}
      <button className="btn w-full">{t('join.submit')}</button>
    </form>
  );
}
