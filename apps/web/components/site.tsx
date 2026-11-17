import Link from 'next/link';
import { Lang, translate } from '@/lib/i18n';
import { API_URL } from '@/lib/api';

export async function cbkStatus(): Promise<{ lendingEnabled: boolean; cbkLicenceNo: string | null; statement: string }> {
  try {
    const r = await fetch(`${API_URL}/v1/public/cbk-status`, { next: { revalidate: 300 } });
    if (r.ok) return r.json();
  } catch { /* API unreachable at build time */ }
  return { lendingEnabled: false, cbkLicenceNo: null, statement: 'Mapema is not yet licensed by the Central Bank of Kenya as a non-deposit-taking credit provider. We do not provide credit until we are licensed.' };
}

export function Header({ lang }: { lang: Lang }) {
  const t = (k: string) => translate(lang, k);
  return (
    <header className="border-b border-slate-200">
      <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" aria-label="Main">
        <Link href="/" className="mr-auto text-xl font-bold text-brand">Mapema</Link>
        <Link href="/buyers" className="py-2">{t('nav.buyers')}</Link>
        <Link href="/suppliers" className="py-2">{t('nav.suppliers')}</Link>
        <Link href="/pricing" className="py-2">{t('nav.pricing')}</Link>
        <Link href={`/lang?to=${lang === 'en' ? 'sw' : 'en'}`} className="py-2 text-sm underline" prefetch={false}>{t('nav.lang')}</Link>
        <Link href="/signin" className="btn-secondary !min-h-10 !py-2">{t('nav.signin')}</Link>
      </nav>
    </header>
  );
}

export async function Footer({ lang }: { lang: Lang }) {
  const t = (k: string) => translate(lang, k);
  const s = await cbkStatus();
  return (
    <footer className="mt-16 border-t border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-5xl space-y-3 px-4 py-8 text-sm text-slate-600">
        <p data-testid="cbk-statement">{s.statement}</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          <li><Link href="/complaints">{t('footer.complaints')}</Link></li>
          <li><Link href="/legal/privacy">{t('footer.privacy')}</Link></li>
          <li><Link href="/legal/terms">{t('footer.terms')}</Link></li>
          <li><Link href="/data-protection">{t('footer.dp')}</Link></li>
          <li><Link href="/cbk-status">{t('footer.cbk')}</Link></li>
        </ul>
        <p>© {new Date().getFullYear()} Mapema Limited, Nairobi, Kenya.</p>
      </div>
    </footer>
  );
}
