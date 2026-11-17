import Link from 'next/link';
import { FeeCalculator } from '@/components/fee-calculator';
import { serverT } from '@/lib/lang-server';

const TRUST = [
  { k: 'trust.kes', icon: 'M4 7h16M4 12h16M4 17h10' },
  { k: 'trust.bank', icon: 'M3 10l9-6 9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18' },
  { k: 'trust.maker', icon: 'M9 12l2 2 4-4M7 4h10l3 3v13H4V4h3' },
  { k: 'trust.data', icon: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z' },
];

export default async function Home() {
  const { t } = await serverT();
  return (
    <>
      <section className="hero-bg on-dark relative overflow-hidden text-white">
        <div className="grain pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="container-x relative grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <div>
            <p className="eyebrow mb-5">{t('home.eyebrow')}</p>
            <h1 className="display">{t('home.title')}</h1>
            <p className="lead mt-6 max-w-xl">{t('home.lead')}</p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link className="btn" href="/suppliers">{t('home.cta.supplier')}</Link>
              <Link className="btn-secondary" href="/buyers">{t('home.cta.buyer')}</Link>
            </div>
          </div>
          <FeeCalculator />
        </div>
        <div className="rule-brass" />
      </section>

      <section aria-label="Safeguards" className="border-b border-line bg-ivory">
        <ul className="container-x grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
          {TRUST.map(({ k, icon }) => (
            <li key={k} className="flex gap-4 py-6 lg:px-6 lg:first:pl-0">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className="mt-0.5 shrink-0 text-brass-ink"><path d={icon} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <div>
                <p className="font-semibold text-navy">{t(`${k}`)}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{t(`${k}.d`)}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="container-x py-16 sm:py-24" aria-labelledby="how-h">
        <div className="grid gap-10 lg:grid-cols-[1fr_2fr] lg:gap-16">
          <div>
            <p className="eyebrow mb-4">{t('home.process')}</p>
            <h2 id="how-h" className="h2 text-navy">{t('home.how')}</h2>
          </div>
          <ol className="relative space-y-0">
            {[1, 2, 3, 4].map((i) => (
              <li key={i} className="relative grid grid-cols-[3rem_1fr] gap-5 pb-10 last:pb-0">
                {i < 4 && <span aria-hidden="true" className="absolute left-6 top-12 h-[calc(100%-3rem)] w-px bg-gradient-to-b from-brass/70 to-line" />}
                <span className="num relative flex h-12 w-12 items-center justify-center rounded-full border border-brass/60 bg-white font-serif text-lg text-brass-ink">{String(i).padStart(2, '0')}</span>
                <p className="pt-2.5 text-lg leading-relaxed text-body">{t(`home.step${i}`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t border-line bg-ivory">
        <div className="container-x grid gap-6 py-16 sm:py-20 md:grid-cols-2">
          {[
            { href: '/suppliers', eb: 'nav.suppliers', title: 'suppliers.title', lead: 'suppliers.lead' },
            { href: '/buyers', eb: 'nav.buyers', title: 'buyers.title', lead: 'buyers.lead' },
          ].map((c) => (
            <Link key={c.href} href={c.href} className="group card flex flex-col justify-between gap-8 transition hover:border-brass/60 hover:shadow-[0_20px_50px_-30px_rgba(10,19,36,.35)] sm:p-8">
              <div>
                <p className="eyebrow mb-3">{t(c.eb)}</p>
                <h3 className="font-serif text-2xl font-medium leading-snug text-navy">{t(c.title)}</h3>
                <p className="mt-3 leading-relaxed text-muted">{t(c.lead)}</p>
              </div>
              <span className="text-sm font-semibold text-navy">{t('home.more')} <span aria-hidden="true" className="inline-block transition group-hover:translate-x-1">→</span></span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
