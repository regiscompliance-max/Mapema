import { formatKes, STANDARD_PRICING } from '@mapema/pricing';
import { FeeCalculator } from '@/components/fee-calculator';
import { Faq, Section } from '@/components/marketing';
import { PageHero } from '@/components/page';
import { serverT } from '@/lib/lang-server';

export default async function Pricing() {
  const { t } = await serverT();
  const rate = (STANDARD_PRICING.discountRateBpsPer30d / 100).toFixed(1);
  const fee = formatKes(STANDARD_PRICING.verificationFeeCents);
  return (
    <>
      <PageHero eyebrow={t('nav.pricing')} title={t('fees.title')} lead={t('fees.lead')} />
      <section className="bg-green"><div className="container-x py-12 sm:py-16"><div className="mx-auto max-w-4xl"><FeeCalculator /></div></div></section>
      <Section>
        <h2 className="h2">{t('fees.how')}</h2>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="rounded-3xl bg-white p-6 ring-1 ring-line">
            <p className="num font-display text-5xl font-bold text-green">{rate}%</p>
            <p className="font-semibold text-sun-ink">{t('fees.per30')}</p>
            <p className="mt-3 text-ink">{t('fees.discount', { rate })}</p>
          </div>
          <div className="rounded-3xl bg-white p-6 ring-1 ring-line">
            <p className="num font-display text-5xl font-bold text-green">{fee}</p>
            <p className="font-semibold text-sun-ink">{t('fees.perInvoice')}</p>
            <p className="mt-3 text-ink">{t('fees.verification', { fee })}</p>
          </div>
        </div>
      </Section>
      <Section tone="sand">
        <div className="mx-auto max-w-3xl"><h2 className="h2">{t('faq.h')}</h2><div className="mt-6"><Faq ids={[1, 2, 3, 4, 6, 7]} /></div></div>
      </Section>
    </>
  );
}
