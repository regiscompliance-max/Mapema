import { cbkStatus } from '@/components/site';
import { Body, PageHero } from '@/components/page';
import { serverT } from '@/lib/lang-server';
export default async function Page() {
  const { t } = await serverT(); const s = await cbkStatus();
  return (
    <>
      <PageHero eyebrow={t('footer.legal')} title={t('cbk.title')} />
      <Body narrow>
        <p className="card border-l-4 border-l-brass text-lg leading-relaxed">{s.statement}</p>
        <p className="mt-6 text-sm leading-relaxed text-muted">Central Bank of Kenya, Haile Selassie Avenue, Nairobi. You can check licensed non-deposit-taking credit providers on the CBK website.</p>
      </Body>
    </>
  );
}
