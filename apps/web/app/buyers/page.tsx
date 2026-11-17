import Link from 'next/link';
import { Safeguards, Section } from '@/components/marketing';
import { PageHero, Points } from '@/components/page';
import { serverT } from '@/lib/lang-server';

export default async function Buyers() {
  const { t } = await serverT();
  return (
    <>
      <PageHero eyebrow={t('nav.buyers')} title={t('buyers.title')} lead={t('buyers.lead')}>
        <Link className="btn-green w-full sm:w-auto" href="/book-a-call">{t('nav.book')}</Link>
      </PageHero>
      <Section>
        <div className="grid gap-12 lg:grid-cols-2">
          <Points items={['buyers.p1', 'buyers.p2', 'buyers.p3'].map((k) => t(k))} />
          <div><h2 className="h2">{t('safe.h')}</h2><div className="mt-8"><Safeguards /></div></div>
        </div>
      </Section>
      <Section tone="sand">
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div><h2 className="h2">{t('band.h')}</h2><p className="lead mt-3 max-w-xl">{t('buyers.cta.d')}</p></div>
          <Link className="btn-green w-full shrink-0 sm:w-auto" href="/book-a-call">{t('nav.book')}</Link>
        </div>
      </Section>
    </>
  );
}
