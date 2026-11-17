import Link from 'next/link';
import { FeeCalculator } from '@/components/fee-calculator';
import { serverT } from '@/lib/lang-server';

export default async function Home() {
  const { t } = await serverT();
  return (
    <div className="space-y-12">
      <section className="space-y-4">
        <h1 className="h1">{t('home.title')}</h1>
        <p className="text-lg text-slate-700">{t('home.lead')}</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link className="btn" href="/suppliers">{t('home.cta.supplier')}</Link>
          <Link className="btn-secondary" href="/buyers">{t('home.cta.buyer')}</Link>
        </div>
      </section>
      <section className="space-y-4">
        <h2 className="h2">{t('home.how')}</h2>
        <ol className="grid gap-4 sm:grid-cols-2">
          {[1, 2, 3, 4].map((i) => <li key={i} className="card"><span className="mr-2 font-bold text-brand">{i}.</span>{t(`home.step${i}`)}</li>)}
        </ol>
      </section>
      <FeeCalculator />
    </div>
  );
}
