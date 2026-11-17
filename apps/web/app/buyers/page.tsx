import Link from 'next/link';
import { Body, PageHero, Points } from '@/components/page';
import { serverT } from '@/lib/lang-server';

export default async function Buyers() {
  const { t } = await serverT();
  return (
    <>
      <PageHero eyebrow={t('nav.buyers')} title={t('buyers.title')} lead={t('buyers.lead')} />
      <Body narrow>
        <Points items={['buyers.p1', 'buyers.p2', 'buyers.p3'].map((k) => t(k))} />
        <div className="mt-10"><Link className="btn" href="/book-a-call">{t('nav.book')}</Link></div>
      </Body>
    </>
  );
}
