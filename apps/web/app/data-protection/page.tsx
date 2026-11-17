import { DsrForm } from '@/components/forms';
import { Body, PageHero } from '@/components/page';
import { serverT } from '@/lib/lang-server';
export default async function Page() {
  const { t } = await serverT();
  return <><PageHero eyebrow={t('footer.legal')} title={t('dp.title')} lead={t('dp.lead')} /><Body narrow><DsrForm /></Body></>;
}
