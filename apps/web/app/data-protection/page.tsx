import { DsrForm } from '@/components/forms';
import { serverT } from '@/lib/lang-server';
export default async function Page() { const { t } = await serverT(); return <div className="space-y-6"><h1 className="h1">{t('dp.title')}</h1><p className="text-lg">{t('dp.lead')}</p><DsrForm /></div>; }
