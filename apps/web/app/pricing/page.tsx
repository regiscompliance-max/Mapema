import { BANK_FUNDED_A_PRICING } from '@mapema/pricing';
import { FeeCalculator } from '@/components/fee-calculator';
import { T } from '@/components/lang';
import { Faq, Section } from '@/components/marketing';
import { PageHero } from '@/components/page';

export default function Pricing() {
  const rate = (BANK_FUNDED_A_PRICING.discountRateBpsPer30d / 100).toFixed(1);
  const processing = ((BANK_FUNDED_A_PRICING.processingFeeBps ?? 50) / 100).toFixed(1);
  return (
    <>
      <PageHero eyebrow={<T k="nav.pricing" />} title={<T k="fees.title" />} lead={<T k="fees.lead" />} />
      <section className="bg-green"><div className="container-x py-12 sm:py-16"><div className="mx-auto max-w-4xl"><FeeCalculator /></div></div></section>
      <Section>
        <h2 className="h2"><T k="fees.how" /></h2>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="rounded-3xl bg-white p-6 ring-1 ring-line">
            <p className="num font-display text-5xl font-bold text-green">{rate}%</p>
            <p className="font-semibold text-sun-ink"><T k="fees.per30" /></p>
            <p className="mt-3 text-ink"><T k="fees.discount" p={{ rate }} /></p>
          </div>
          <div className="rounded-3xl bg-white p-6 ring-1 ring-line">
            <p className="num font-display text-5xl font-bold text-green">{processing}%</p>
            <p className="font-semibold text-sun-ink"><T k="fees.atFunding" /></p>
            <p className="mt-3 text-ink"><T k="fees.processing" /></p>
          </div>
        </div>
        <p className="mt-8 max-w-3xl text-ink"><T k="fees.bankLender" /></p>
      </Section>
      <Section tone="sand">
        <div className="mx-auto max-w-3xl"><h2 className="h2"><T k="faq.h" /></h2><div className="mt-6"><Faq ids={[1, 2, 3, 4, 6, 7]} /></div></div>
      </Section>
    </>
  );
}
