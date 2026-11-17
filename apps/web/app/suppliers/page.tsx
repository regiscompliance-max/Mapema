import Link from 'next/link';
import { Body, PageHero, Points } from '@/components/page';
import { serverT } from '@/lib/lang-server';

export default async function Suppliers() {
  const { t } = await serverT();
  return (
    <>
      <PageHero eyebrow={t('nav.suppliers')} title={t('suppliers.title')} lead={t('suppliers.lead')} />
      <Body narrow>
        <Points items={['suppliers.p1', 'suppliers.p2', 'suppliers.p3'].map((k) => t(k))} />
        <div className="mt-10"><Link className="btn" href="/pricing">{t('nav.pricing')}</Link></div>
      </Body>
    </>
  );
}
