import { formatKes, STANDARD_PRICING } from '@mapema/pricing';
import { FeeCalculator } from '@/components/fee-calculator';
import { serverT } from '@/lib/lang-server';

export default async function Pricing() {
  const { t } = await serverT();
  return (
    <div className="space-y-6">
      <h1 className="h1">{t('fees.title')}</h1>
      <p className="text-lg">{t('fees.lead')}</p>
      <ul className="list-disc space-y-2 pl-6">
        <li>{t('fees.discount', { rate: (STANDARD_PRICING.discountRateBpsPer30d / 100).toFixed(1) })}</li>
        <li>{t('fees.verification', { fee: formatKes(STANDARD_PRICING.verificationFeeCents) })}</li>
      </ul>
      <FeeCalculator />
    </div>
  );
}
