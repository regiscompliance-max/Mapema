import Link from 'next/link';
import { Lang } from '@/lib/i18n';
import { LangSwitch, T } from './lang';
import { Wordmark } from './brand';
import { contactParams } from '@/lib/site-config';

/** Static site: no API call. Lending stays off until a CBK licence number is entered in the platform. */
export async function cbkStatus(): Promise<{ lendingEnabled: boolean; cbkLicenceNo: string | null; statement: string }> {
  return { lendingEnabled: false, cbkLicenceNo: null, statement: 'Mapema is not yet licensed by the Central Bank of Kenya as a non-deposit-taking credit provider. We do not provide credit until we are licensed.' };
}

const tt = (k: string) => <T k={k} p={contactParams()} />;

export function Header({ lang }: { lang: Lang }) {
  void lang;
  const nav = 'text-[0.92rem] text-mist transition hover:text-white';
  return (
    <header className="sticky top-0 z-30 border-b border-line-dark bg-ink/95 text-white backdrop-blur">
      <nav className="container-x flex flex-wrap items-center gap-x-7 gap-y-1 py-3" aria-label="Main">
        <Link href="/" className="mr-auto py-1" aria-label="Mapema home"><Wordmark /></Link>
        <div className="order-3 flex w-full gap-6 overflow-x-auto pb-1 sm:order-none sm:w-auto sm:pb-0">
          <Link href="/buyers" className={nav}>{tt('nav.buyers')}</Link>
          <Link href="/suppliers" className={nav}>{tt('nav.suppliers')}</Link>
          <Link href="/pricing" className={nav}>{tt('nav.pricing')}</Link>
        </div>
        <div className="flex items-center gap-4 [&_button]:text-mist [&_button]:decoration-brass/60 [&_button]:underline-offset-4 [&_button:hover]:text-white">
          <LangSwitch />
          <span className="rounded-full border border-brass/40 px-3.5 py-1.5 text-xs font-medium tracking-wide text-brass-soft" data-testid="portal-soon">{tt('nav.portalSoon')}</span>
        </div>
      </nav>
    </header>
  );
}

export async function Footer({ lang }: { lang: Lang }) {
  void lang;
  const s = await cbkStatus();
  const link = 'text-mist transition hover:text-white';
  return (
    <footer className="on-dark bg-ink text-white">
      <div className="rule-brass" />
      <div className="container-x grid gap-10 py-14 sm:grid-cols-12">
        <div className="space-y-4 sm:col-span-5">
          <Wordmark />
          <p className="max-w-sm text-sm leading-relaxed text-mist">{tt('home.lead')}</p>
        </div>
        <nav className="sm:col-span-3" aria-label="Footer">
          <p className="eyebrow mb-4">{tt('footer.company')}</p>
          <ul className="space-y-2.5 text-sm">
            <li><Link className={link} href="/buyers">{tt('nav.buyers')}</Link></li>
            <li><Link className={link} href="/suppliers">{tt('nav.suppliers')}</Link></li>
            <li><Link className={link} href="/pricing">{tt('nav.pricing')}</Link></li>
            <li><Link className={link} href="/book-a-call">{tt('nav.book')}</Link></li>
          </ul>
        </nav>
        <nav className="sm:col-span-4" aria-label="Legal">
          <p className="eyebrow mb-4">{tt('footer.legal')}</p>
          <ul className="space-y-2.5 text-sm">
            <li><Link className={link} href="/complaints">{tt('footer.complaints')}</Link></li>
            <li><Link className={link} href="/legal/privacy">{tt('footer.privacy')}</Link></li>
            <li><Link className={link} href="/legal/terms">{tt('footer.terms')}</Link></li>
            <li><Link className={link} href="/data-protection">{tt('footer.dp')}</Link></li>
            <li><Link className={link} href="/cbk-status">{tt('footer.cbk')}</Link></li>
          </ul>
        </nav>
      </div>
      <div className="container-x space-y-4 border-t border-line-dark py-8 text-sm text-mist">
        <p data-testid="cbk-statement" className="rounded-lg border border-line-dark bg-navy/60 p-4 leading-relaxed text-white/90">{s.statement}</p>
        <p data-testid="footer-contact" className="leading-relaxed">{tt('footer.contact')}</p>
        <p className="text-xs text-mist/90">© {new Date().getFullYear()} Mapema Limited, Nairobi, Kenya.</p>
      </div>
    </footer>
  );
}
