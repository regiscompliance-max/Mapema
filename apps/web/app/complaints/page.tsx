import { serverT } from '@/lib/lang-server';
export default async function Page() { const { t } = await serverT(); return <div className="space-y-4"><h1 className="h1">{t('complaints.title')}</h1><p className="text-lg">{t('complaints.lead')}</p></div>; }
