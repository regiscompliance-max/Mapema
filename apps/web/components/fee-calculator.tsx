'use client';
import { useMemo, useState } from 'react';
import { BANK_FUNDED_A_PRICING, PricingError, quote, STANDARD_PRICING } from '@mapema/pricing';
import { useT } from './lang';
import { bps, kesFromCents, parseKesInput } from '@/lib/money';

export function FeeCalculator() {
  const t = useT();
  const [amount, setAmount] = useState('1,000,000');
  const [days, setDays] = useState('48');
  const [profile, setProfile] = useState<'bank-funded-A' | 'direct-legacy'>('bank-funded-A');
  const [buyerPays, setBuyerPays] = useState(false);
  const result = useMemo(() => {
    const cents = parseKesInput(amount);
    const d = Number(days);
    if (cents === null || !Number.isInteger(d)) return { error: t('calc.error.min') };
    const params = profile === 'bank-funded-A'
      ? { ...BANK_FUNDED_A_PRICING, processingFeePayer: buyerPays ? 'buyer' as const : 'supplier' as const }
      : STANDARD_PRICING;
    try { return { q: quote(cents, d, params) }; } catch (e) {
      const code = (e as PricingError).code;
      return { error: code === 'TENOR_OUT_OF_RANGE' ? t('calc.error.days') : t('calc.error.min') };
    }
  }, [amount, days, profile, buyerPays, t]);
  const feeLabel = result.q?.profileCode === 'bank-funded-A' ? t('calc.processingFee') : t('calc.verificationFee');
  const feeAmount = result.q?.profileCode === 'bank-funded-A' ? result.q.processingFeeCents : result.q?.verificationFeeCents;
  const rows: [string, bigint | string][] = result.q ? [
    [t('calc.advance'), result.q.advanceCents], [t('calc.discountFee'), result.q.discountFeeCents], [feeLabel, feeAmount!],
    [t('calc.totalCost'), result.q.totalCostCents], [t('calc.balance'), result.q.supplierBalanceCents],
  ] : [];
  return (
    <section className="card space-y-4" aria-labelledby="calc-h">
      <h2 id="calc-h" className="h2">{t('calc.title')}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label><span className="label">{t('calc.amount')}</span><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label><span className="label">{t('calc.days')}</span><input className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></label>
      </div>
      <fieldset className="space-y-2">
        <legend className="label">{t('calc.profile')}</legend>
        <label className="flex gap-2 text-sm"><input type="radio" name="profile" checked={profile === 'bank-funded-A'} onChange={() => setProfile('bank-funded-A')} /> {t('fees.profileA')}</label>
        <label className="flex gap-2 text-sm"><input type="radio" name="profile" checked={profile === 'direct-legacy'} onChange={() => setProfile('direct-legacy')} /> {t('fees.profileLegacy')}</label>
      </fieldset>
      {profile === 'bank-funded-A' && (
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={buyerPays} onChange={(e) => setBuyerPays(e.target.checked)} /> {t('calc.buyerPays')}</label>
      )}
      {result.error ? <p role="alert" className="text-red-700">{result.error}</p> : (
        <dl className="divide-y divide-slate-100" aria-live="polite">
          {rows.map(([k, v]) => <div key={k} className="flex justify-between py-2"><dt>{k}</dt><dd className="font-semibold tabular-nums">{kesFromCents(v as bigint)}</dd></div>)}
          <div className="flex justify-between py-2 text-sm text-slate-600"><dt>{t('calc.apr')}</dt><dd>{bps(result.q!.aprBps)}</dd></div>
        </dl>
      )}
      {profile === 'bank-funded-A' && <p className="text-sm text-slate-600">{t('fees.bankLender')}</p>}
      <p className="text-sm text-slate-600">{profile === 'bank-funded-A' ? t('calc.noteA') : t('calc.note')}</p>
    </section>
  );
}
