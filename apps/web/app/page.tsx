import Link from 'next/link';
import { FeeCalculator } from '@/components/fee-calculator';
import { Faq, HeroVisual, ProductMock, Safeguards, Section, Steps } from '@/components/marketing';
import { serverT } from '@/lib/lang-server';

export default async function Home() {
  const { t } = await serverT();
  return (
    <>
      {/* 1. Split hero with the signature invoice visual */}
      <section className="relative overflow-hidden bg-cream">
        <div className="container-x grid items-center gap-10 pb-14 pt-10 sm:pb-20 sm:pt-16 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          <div>
            <p className="kicker"><span className="h-2 w-2 rounded-full bg-sun" aria-hidden="true" />{t('home.kicker')}</p>
            <h1 className="display mt-5">{t('home.h1')}</h1>
            <p className="lead mt-5 max-w-xl !text-ink/80">{t('home.sub')}</p>
            <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <Link className="btn w-full sm:w-auto" href="#calculator">{t('nav.check')} <span aria-hidden="true">↓</span></Link>
              <Link className="link inline-flex min-h-12 items-center" href="/buyers">{t('home.buyerLink')}</Link>
            </div>
            <p className="mt-5 text-muted">{t('home.reassure')}</p>
          </div>
          <HeroVisual />
        </div>
      </section>

      {/* 2. Calculator front and centre on a green band */}
      <section className="bg-green">
        <div className="container-x py-14 sm:py-20">
          <div className="mx-auto max-w-4xl"><FeeCalculator /></div>
        </div>
      </section>

      {/* 3. Three steps */}
      <Section>
        <h2 className="h2 max-w-xl">{t('home.how')}</h2>
        <div className="mt-10"><Steps /></div>
      </Section>

      {/* 4. Product mock, text left / mock right */}
      <Section tone="sand">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <h2 className="h2">{t('mock.h')}</h2>
            <p className="lead mt-4">{t('mock.sub')}</p>
            <ul className="mt-6 space-y-3 text-lg">
              {['mock.p1', 'mock.p2', 'mock.p3'].map((k) => (
                <li key={k} className="flex gap-3"><span className="mt-2.5 h-2.5 w-2.5 shrink-0 rounded-full bg-sun" aria-hidden="true" />{t(k)}</li>
              ))}
            </ul>
          </div>
          <ProductMock />
        </div>
      </Section>

      {/* 5. Buyer band: one action */}
      <section className="relative overflow-hidden bg-sun-soft text-ink">
        <svg className="pointer-events-none absolute -bottom-24 -left-16 w-[28rem] opacity-60" viewBox="0 0 200 100" aria-hidden="true"><circle cx="100" cy="100" r="90" fill="#fed7aa" /></svg>
        <div className="container-x relative grid items-center gap-8 py-16 sm:py-20 md:grid-cols-[1.4fr_1fr]">
          <div>
            <p className="font-bold text-sun-ink">{t('band.kicker')}</p>
            <h2 className="mt-2 font-display text-[1.85rem] font-bold leading-tight tracking-tight text-green sm:text-[2.6rem]">{t('band.h')}</h2>
            <p className="mt-4 max-w-xl text-lg text-ink/80">{t('band.d')}</p>
          </div>
          <div className="md:text-right"><Link className="btn-green" href="/book-a-call">{t('nav.book')}</Link></div>
        </div>
      </section>

      {/* 6. Safeguards + short FAQ side by side */}
      <Section>
        <div className="grid gap-14 lg:grid-cols-2">
          <div>
            <h2 className="h2">{t('safe.h')}</h2>
            <div className="mt-8"><Safeguards /></div>
          </div>
          <div>
            <h2 className="h2">{t('faq.h')}</h2>
            <div className="mt-6"><Faq ids={[1, 2, 4, 7]} /></div>
            <Link className="link mt-6 inline-flex min-h-12 items-center" href="/suppliers#faq">{t('nav.faq')} →</Link>
          </div>
        </div>
      </Section>
    </>
  );
}
