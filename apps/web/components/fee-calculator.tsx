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
    <section className="statement overflow-hidden" aria-labelledby="calc-h" data-testid="fee-calculator">
      <div className="flex items-center justify-between border-b border-line-dark px-5 py-3.5 sm:px-6">
        <h2 id="calc-h" className="font-serif text-lg font-medium text-white">{t('calc.title')}</h2>
        <span className="rounded-full border border-brass/40 px-2.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-brass">{t('calc.statement')}</span>
      </div>
      <div className="grid items-end gap-4 px-5 pt-5 sm:grid-cols-[1.4fr_1fr] sm:px-6">
        <label><span className="label">{t('calc.amount')}</span><input className="input text-lg" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label><span className="label">{t('calc.days')}</span><input className="input text-lg" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></label>
      </div>
      <div className="px-5 pb-5 pt-4 sm:px-6">
        {result.error ? <p role="alert" className="rounded-md border border-red-400/40 bg-red-500/10 p-3 text-red-200">{result.error}</p> : (
          <dl className="num text-[0.95rem]" aria-live="polite">
            {rows.map(([k, v], i) => {
              const total = i === 3; const bal = i === 4;
              return (
                <div key={k} className={`flex items-baseline justify-between gap-4 py-2.5 ${total ? 'mt-1 border-t border-brass/40 pt-3' : 'border-b border-dashed border-line-dark'} ${bal ? 'mt-2 rounded-lg border border-brass/30 bg-brass/[0.08] px-3 py-3' : ''}`}>
                  <dt className={bal ? 'font-semibold text-brass-soft' : total ? 'font-semibold text-white' : 'text-mist'}>{k}</dt>
                  <dd className={`text-right font-semibold tabular-nums tracking-tight ${bal ? 'text-lg text-brass-soft' : 'text-white'}`}>{kesFromCents(v as bigint)}</dd>
                </div>
              );
            })}
            <div className="flex justify-between pt-3 text-xs uppercase tracking-[0.14em] text-mist"><dt>{t('calc.apr')}</dt><dd className="tabular-nums">{bps(result.q!.aprBps)}</dd></div>
          </dl>
        )}
        <p className="mt-4 border-t border-line-dark pt-3 text-xs leading-relaxed text-mist">{t('calc.note')}</p>
      </div>
    </section>
  );
}
