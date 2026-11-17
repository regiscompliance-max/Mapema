import { BookCallForm } from '@/components/forms';
import { Body, PageHero } from '@/components/page';
import { serverT } from '@/lib/lang-server';
export default async function Page() {
  const { t } = await serverT();
  return <><PageHero eyebrow={t('nav.buyers')} title={t('book.title')} /><Body narrow><BookCallForm /></Body></>;
}
