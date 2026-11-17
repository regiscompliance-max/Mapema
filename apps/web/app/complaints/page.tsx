import { Body, PageHero } from '@/components/page';
import { serverT } from '@/lib/lang-server';
export default async function Page() {
  const { t } = await serverT();
  return <><PageHero eyebrow={t('footer.legal')} title={t('complaints.title')} /><Body narrow><p className="text-lg leading-relaxed">{t('complaints.lead')}</p></Body></>;
}
