import { formatKes, STANDARD_PRICING } from '@mapema/pricing';
import { FeeCalculator } from '@/components/fee-calculator';
import { Body, PageHero } from '@/components/page';
import { serverT } from '@/lib/lang-server';

export default async function Pricing() {
  const { t } = await serverT();
  const items = [
    { n: `${(STANDARD_PRICING.discountRateBpsPer30d / 100).toFixed(1)}%`, sub: t('fees.per30'), text: t('fees.discount', { rate: (STANDARD_PRICING.discountRateBpsPer30d / 100).toFixed(1) }) },
    { n: formatKes(STANDARD_PRICING.verificationFeeCents), sub: t('fees.perInvoice'), text: t('fees.verification', { fee: formatKes(STANDARD_PRICING.verificationFeeCents) }) },
  ];
  return (
    <>
      <PageHero eyebrow={t('nav.pricing')} title={t('fees.title')} lead={t('fees.lead')} />
      <Body>
        <div className="grid items-start gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <ul className="divide-y divide-line border-y border-line">
            {items.map((it, i) => (
              <li key={i} className="py-7">
                <p className="num font-serif text-4xl font-medium text-navy">{it.n} <span className="font-sans text-sm font-medium uppercase tracking-[0.14em] text-muted">{it.sub}</span></p>
                <p className="mt-3 leading-relaxed text-body">{it.text}</p>
              </li>
            ))}
          </ul>
          <FeeCalculator />
        </div>
      </Body>
    </>
  );
}
