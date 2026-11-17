import Link from 'next/link';
import { Lang } from '@/lib/i18n';
import { LangSwitch, T } from './lang';
import { Wordmark } from './brand';
import { DesktopNav, MobileMenu } from './nav-client';
import { contactParams } from '@/lib/site-config';

/** Static site: no API call. Lending stays off until a CBK licence number is entered in the platform. */
export async function cbkStatus(): Promise<{ lendingEnabled: boolean; cbkLicenceNo: string | null; statement: string }> {
  return { lendingEnabled: false, cbkLicenceNo: null, statement: 'Mapema is not yet licensed by the Central Bank of Kenya as a non-deposit-taking credit provider. We do not provide credit until we are licensed.' };
}

const tt = (k: string) => <T k={k} p={contactParams()} />;

export function Header({ lang }: { lang: Lang }) {
  void lang;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-cream/95 backdrop-blur">
      <nav className="container-x relative flex min-h-[4.5rem] items-center gap-4" aria-label="Main">
        <Link href="/" className="mr-auto rounded-lg py-1" aria-label="Mapema home"><Wordmark /></Link>
        <DesktopNav />
        <div className="hidden items-center gap-3 md:flex [&_button]:min-h-11 [&_button]:px-2 [&_button]:font-semibold [&_button]:text-green">
          <LangSwitch />
          <span className="rounded-full bg-sand px-3 py-1.5 text-sm font-semibold text-muted" data-testid="portal-soon">{tt('nav.portalSoon')}</span>
        </div>
        <MobileMenu />
      </nav>
    </header>
  );
}

export async function Footer({ lang }: { lang: Lang }) {
  void lang;
  const s = await cbkStatus();
  const link = 'inline-flex min-h-11 items-center text-ink hover:text-green hover:underline';
  return (
    <footer className="border-t border-line bg-sand">
      <div className="container-x grid gap-10 py-14 md:grid-cols-12">
        <div className="space-y-4 md:col-span-5">
          <Wordmark />
          <p className="max-w-sm text-muted">{tt('footer.tag')}</p>
        </div>
        <nav className="md:col-span-3" aria-label="Footer">
          <p className="mb-2 font-bold text-green">{tt('footer.company')}</p>
          <ul>
            <li><Link className={link} href="/suppliers">{tt('nav.suppliers')}</Link></li>
            <li><Link className={link} href="/buyers">{tt('nav.buyers')}</Link></li>
            <li><Link className={link} href="/pricing">{tt('nav.pricing')}</Link></li>
            <li><Link className={link} href="/book-a-call">{tt('nav.book')}</Link></li>
          </ul>
        </nav>
        <nav className="md:col-span-4" aria-label="Legal">
          <p className="mb-2 font-bold text-green">{tt('footer.legal')}</p>
          <ul>
            <li><Link className={link} href="/complaints">{tt('footer.complaints')}</Link></li>
            <li><Link className={link} href="/legal/privacy">{tt('footer.privacy')}</Link></li>
            <li><Link className={link} href="/legal/terms">{tt('footer.terms')}</Link></li>
            <li><Link className={link} href="/data-protection">{tt('footer.dp')}</Link></li>
            <li><Link className={link} href="/cbk-status">{tt('footer.cbk')}</Link></li>
          </ul>
        </nav>
      </div>
      <div className="container-x space-y-4 border-t border-sand-2 py-8 text-[0.95rem] text-muted">
        <p data-testid="cbk-statement" className="rounded-2xl border border-sand-2 bg-cream p-4 font-medium leading-relaxed text-ink">{s.statement}</p>
        <p data-testid="footer-contact" className="leading-relaxed">{tt('footer.contact')}</p>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p>© {new Date().getFullYear()} Mapema Limited, Nairobi, Kenya.</p>
          <span className="md:hidden [&_button]:min-h-11 [&_button]:font-semibold [&_button]:text-green"><LangSwitch /></span>
        </div>
      </div>
    </footer>
  );
}
