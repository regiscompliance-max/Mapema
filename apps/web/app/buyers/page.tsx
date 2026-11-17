import Link from 'next/link';
import { serverT } from '@/lib/lang-server';

export default async function Buyers() {
  const { t } = await serverT();
  return (
    <div className="space-y-6">
      <h1 className="h1">{t('buyers.title')}</h1>
      <p className="text-lg">{t('buyers.lead')}</p>
      <ul className="space-y-3">{['buyers.p1', 'buyers.p2', 'buyers.p3'].map((k) => <li key={k} className="card">{t(k)}</li>)}</ul>
      <Link className="btn" href="/book-a-call">{t('nav.book')}</Link>
    </div>
  );
}
