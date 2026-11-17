'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/components/lang';
import { devSignIn, oidcSignIn } from '@/lib/session';

const DEV = process.env.NEXT_PUBLIC_DEV_SIGNIN === 'true';

export default function SignIn() {
  const t = useT(); const router = useRouter();
  const [err, setErr] = useState('');
  async function dev(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr('');
    const f = new FormData(e.currentTarget);
    try { await devSignIn(String(f.get('email')), f.get('factor') === 'sms' ? 'sms' : 'otp'); router.push('/app'); } catch (x) { setErr((x as Error).message); }
  }
  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="h1">{t('signin.title')}</h1>
      {process.env.NEXT_PUBLIC_OIDC_ISSUER && <button className="btn w-full" onClick={() => oidcSignIn()}>{t('signin.oidc')}</button>}
      {DEV && (
        <form onSubmit={dev} className="card space-y-4">
          <p className="rounded bg-amber-50 p-2 text-sm">{t('signin.dev')} - not available in production.</p>
          <label className="block"><span className="label">{t('signin.email')}</span><input name="email" type="email" required className="input" defaultValue="ops@mapema.test" /></label>
          <label className="block"><span className="label">{t('signin.factor')}</span>
            <select name="factor" className="input"><option value="otp">Authenticator app</option><option value="sms">SMS code (suppliers only)</option></select></label>
          {err && <p role="alert" className="text-red-700">{err}</p>}
          <button className="btn w-full">{t('signin.go')}</button>
        </form>
      )}
    </div>
  );
}
