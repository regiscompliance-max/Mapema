import { cbkStatus } from '@/components/site';
import { serverT } from '@/lib/lang-server';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const { t } = await serverT(); const s = await cbkStatus();
  return <div className="space-y-4"><h1 className="h1">{t('cbk.title')}</h1><p className="card text-lg">{s.statement}</p>
    <p className="text-sm text-slate-600">Central Bank of Kenya, Haile Selassie Avenue, Nairobi. You can check licensed non-deposit-taking credit providers on the CBK website.</p></div>;
}
