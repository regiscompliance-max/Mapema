'use client';
import { useMemo, useState } from 'react';
import { PricingError, quote, STANDARD_PRICING } from '@mapema/pricing';
import { useT } from './lang';
import { bps, kesFromCents, parseKesInput } from '@/lib/money';

export function FeeCalculator() {
  const t = useT();
  const [amount, setAmount] = useState('1,000,000');
  const [days, setDays] = useState('48');
  const result = useMemo(() => {
    const cents = parseKesInput(amount);
    const d = Number(days);
    if (cents === null || !Number.isInteger(d)) return { error: t('calc.error.min') };
    try { return { q: quote(cents, d, STANDARD_PRICING) }; } catch (e) {
      const code = (e as PricingError).code;
      return { error: code === 'TENOR_OUT_OF_RANGE' ? t('calc.error.days') : t('calc.error.min') };
    }
  }, [amount, days, t]);
  const rows: [string, bigint | string][] = result.q ? [
    [t('calc.advance'), result.q.advanceCents], [t('calc.discountFee'), result.q.discountFeeCents], [t('calc.verificationFee'), result.q.verificationFeeCents],
    [t('calc.totalCost'), result.q.totalCostCents], [t('calc.balance'), result.q.supplierBalanceCents],
  ] : [];
  return (
    <section className="card space-y-4" aria-labelledby="calc-h">
      <h2 id="calc-h" className="h2">{t('calc.title')}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label><span className="label">{t('calc.amount')}</span><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label><span className="label">{t('calc.days')}</span><input className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></label>
      </div>
      {result.error ? <p role="alert" className="text-red-700">{result.error}</p> : (
        <dl className="divide-y divide-slate-100" aria-live="polite">
          {rows.map(([k, v]) => <div key={k} className="flex justify-between py-2"><dt>{k}</dt><dd className="font-semibold tabular-nums">{kesFromCents(v as bigint)}</dd></div>)}
          <div className="flex justify-between py-2 text-sm text-slate-600"><dt>{t('calc.apr')}</dt><dd>{bps(result.q!.aprBps)}</dd></div>
        </dl>
      )}
      <p className="text-sm text-slate-600">{t('calc.note')}</p>
    </section>
  );
}
