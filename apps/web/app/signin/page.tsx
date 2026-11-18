'use client';
import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/components/lang';
import { devSignIn, OIDC_ENABLED, oidcSignIn } from '@/lib/session';

const DEV = process.env.NEXT_PUBLIC_DEV_SIGNIN === 'true';

export default function SignIn() {
  const t = useT(); const router = useRouter();
  const [err, setErr] = useState('');
  useEffect(() => { const e = signInError(new URLSearchParams(location.search).get('error')); if (e) setErr(e); }, []);
  async function dev(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr('');
    const f = new FormData(e.currentTarget);
    try { await devSignIn(String(f.get('email')), f.get('factor') === 'sms' ? 'sms' : 'otp'); router.push('/app'); } catch (x) { setErr((x as Error).message); }
  }
  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="h1">{t('signin.title')}</h1>
      {OIDC_ENABLED && <button className="btn w-full" onClick={() => oidcSignIn().catch((x) => setErr((x as Error).message))}>{t('signin.oidc')}</button>}
      {err && !DEV && <p role="alert" className="text-red-700">{err}</p>}
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

/** Error codes the API's sign-in callback sends back (never any detail). */
function signInError(code: string | null): string {
  if (!code) return '';
  const known: Record<string, string> = {
    MFA_REQUIRED: 'Sign-in needs a second factor. Set up your authenticator app and try again.',
    STRONG_MFA_REQUIRED: 'Staff, buyer and auditor users must use an authenticator app or security key.',
    NO_ACCOUNT: 'There is no active Mapema account for this sign-in. Ask your administrator for an invitation.',
    ACCESS_EXPIRED: 'Your time-boxed access has expired.',
    STEP_UP_REQUIRED: 'Please sign in again to confirm it is you.',
    ACCESS_DENIED: 'Sign-in was cancelled.',
  };
  return known[code] ?? 'Sign-in did not complete. Please try again.';
}
