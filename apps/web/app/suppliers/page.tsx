import Link from 'next/link';
import { serverT } from '@/lib/lang-server';

export default async function Suppliers() {
  const { t } = await serverT();
  return (
    <div className="space-y-6">
      <h1 className="h1">{t('suppliers.title')}</h1>
      <p className="text-lg">{t('suppliers.lead')}</p>
      <ul className="space-y-3">{['suppliers.p1', 'suppliers.p2', 'suppliers.p3'].map((k) => <li key={k} className="card">{t(k)}</li>)}</ul>
      <Link className="btn" href="/pricing">{t('nav.pricing')}</Link>
    </div>
  );
}
