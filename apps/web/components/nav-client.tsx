'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LangSwitch, useT } from './lang';

const LINKS = [['/suppliers', 'nav.suppliers'], ['/buyers', 'nav.buyers'], ['/pricing', 'nav.pricing']] as const;

export function DesktopNav() {
  const t = useT(); const path = usePathname();
  return (
    <div className="hidden items-center gap-1 md:flex">
      {LINKS.map(([href, k]) => (
        <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}
          className={`rounded-full px-4 py-2.5 font-semibold transition hover:bg-sand ${path === href ? 'bg-sand text-green' : 'text-ink'}`}>{t(k)}</Link>
      ))}
    </div>
  );
}

export function MobileMenu() {
  const t = useT(); const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="md:hidden">
      <button type="button" aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen(!open)}
        className="flex min-h-12 items-center gap-2 rounded-full border-2 border-line bg-white px-4 font-semibold text-green">
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d={open ? 'M5 5l10 10M15 5L5 15' : 'M3 6h14M3 10h14M3 14h14'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        {open ? t('nav.close') : t('nav.menu')}
      </button>
      {open && (
        <div id="mobile-menu" className="absolute inset-x-0 top-full border-b border-line bg-cream px-5 pb-6 pt-2 shadow-lg">
          <ul className="divide-y divide-line">
            {[['/', 'nav.home'] as const, ...LINKS, ['/book-a-call', 'nav.book'] as const].map(([href, k]) => (
              <li key={href}><Link href={href} className="flex min-h-14 items-center justify-between text-lg font-semibold text-ink">{t(k)}<span aria-hidden="true" className="text-sun-ink">→</span></Link></li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between gap-3 [&_button]:min-h-12 [&_button]:font-semibold [&_button]:text-green">
            <LangSwitch />
            <span className="rounded-full bg-sand px-3 py-1.5 text-sm font-semibold text-muted" data-testid="portal-soon-mobile">{t('nav.portalSoon')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Phone-only bottom bar with the one main action for the page. Hidden on form and legal pages. */
export function StickyCta() {
  const t = useT(); const path = usePathname();
  if (/^\/(book-a-call|data-protection|legal|complaints|cbk-status)/.test(path)) return null;
  const buyer = path === '/buyers';
  const href = buyer ? '/book-a-call' : path === '/' ? '#calculator' : '/pricing#calculator';
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-cream/95 p-3 backdrop-blur md:hidden" data-testid="sticky-cta">
      <Link href={href} className={`${buyer ? 'btn-green' : 'btn'} w-full`}>{buyer ? t('nav.book') : t('nav.check')}</Link>
    </div>
  );
}
