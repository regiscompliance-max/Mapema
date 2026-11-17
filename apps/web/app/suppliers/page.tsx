import Link from 'next/link';
import { Faq, ProductMock, Section, Steps } from '@/components/marketing';
import { PageHero, Points } from '@/components/page';
import { serverT } from '@/lib/lang-server';

export default async function Suppliers() {
  const { t } = await serverT();
  return (
    <>
      <PageHero eyebrow={t('nav.suppliers')} title={t('suppliers.title')} lead={t('suppliers.lead')}>
        <Link className="btn w-full sm:w-auto" href="/pricing#calculator">{t('suppliers.cta')}</Link>
      </PageHero>
      <Section>
        <h2 className="h2">{t('home.how')}</h2>
        <div className="mt-10"><Steps /></div>
      </Section>
      <Section tone="sand">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <Points items={['suppliers.p1', 'suppliers.p2', 'suppliers.p3'].map((k) => t(k))} />
          <ProductMock />
        </div>
      </Section>
      <Section id="faq" className="scroll-mt-20">
        <div className="mx-auto max-w-3xl">
          <h2 className="h2">{t('faq.h')}</h2>
          <div className="mt-6"><Faq /></div>
          <div className="mt-10"><Link className="btn w-full sm:w-auto" href="/pricing#calculator">{t('suppliers.cta')}</Link></div>
        </div>
      </Section>
    </>
  );
}
