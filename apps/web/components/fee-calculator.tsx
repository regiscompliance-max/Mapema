'use client';
import { useMemo, useState } from 'react';
import { PricingError, quote, STANDARD_PRICING } from '@mapema/pricing';
import { useT } from './lang';
import { bps, kesFromCents, parseKesInput } from '@/lib/money';

const QUICK = [['250,000', '250K'], ['500,000', '500K'], ['1,000,000', '1M'], ['5,000,000', '5M']] as const;
const clampDays = (n: number) => Math.min(STANDARD_PRICING.maxDays, Math.max(STANDARD_PRICING.minDays, n));

export function FeeCalculator({ id = 'calculator' }: { id?: string }) {
  const t = useT();
  const [amount, setAmount] = useState('1,000,000');
  const [days, setDays] = useState('48');
  // Pricing logic unchanged: same parse, same quote(), same error mapping.
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
  const dNum = Number.isInteger(Number(days)) ? clampDays(Number(days)) : 48;
  const step = (n: number) => setDays(String(clampDays(dNum + n)));
  const b = (s: string) => <strong className="num whitespace-nowrap text-green">{s}</strong>;

  return (
    <section id={id} className="scroll-mt-24 rounded-[2rem] border border-line bg-white p-5 shadow-[0_30px_60px_-40px_rgba(20,83,45,.45)] sm:p-8" aria-labelledby={`${id}-h`} data-testid="fee-calculator">
      <h2 id={`${id}-h`} className="h3 !text-2xl">{t('calc.h')}</h2>
      <p className="mt-1 text-muted">{t('calc.sub')}</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <label className="label" htmlFor={`${id}-amount`}>{t('calc.amount')}</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-semibold text-muted" aria-hidden="true">KES</span>
            <input id={`${id}-amount`} className="input num !min-h-16 !pl-16 !text-2xl font-bold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2" role="group" aria-label={t('calc.quick')}>
            {QUICK.map(([q, short]) => (
              <button key={q} type="button" onClick={() => setAmount(q)} aria-pressed={amount === q} aria-label={`KES ${q}`}
                className={`num min-h-12 rounded-full border-2 text-[0.95rem] font-bold transition ${amount === q ? 'border-green bg-green text-white' : 'border-line bg-cream text-ink hover:border-green'}`}>{short}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-days`}>{t('calc.days')}</label>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => step(-1)} aria-label={t('calc.less')} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border-2 border-line bg-cream text-2xl font-bold text-green hover:border-green">−</button>
            <div className="relative flex-1">
              <input id={`${id}-days`} className="input num !min-h-16 text-center !text-2xl font-bold" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted" aria-hidden="true">{t('calc.daysUnit')}</span>
            </div>
            <button type="button" onClick={() => step(1)} aria-label={t('calc.more')} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border-2 border-line bg-cream text-2xl font-bold text-green hover:border-green">+</button>
          </div>
          <input type="range" className="range mt-5" min={STANDARD_PRICING.minDays} max={STANDARD_PRICING.maxDays} value={dNum}
            onChange={(e) => setDays(e.target.value)} aria-label={t('calc.days')} />
          <div className="mt-1 flex justify-between text-sm text-muted num" aria-hidden="true"><span>1</span><span>30</span><span>60</span><span>90</span><span>120</span></div>
        </div>
      </div>

      <div className="mt-7" aria-live="polite">
        {result.error ? <p role="alert" className="rounded-2xl bg-sun-soft p-4 font-semibold text-ink">{result.error}</p> : (
          <>
            <p className="rounded-2xl bg-green-soft p-5 text-xl leading-relaxed text-ink sm:text-2xl" data-testid="calc-sentence">
              {(() => {
                const q = result.q!;
                const parts = [
                  [t('calc.s1', { advance: '§' }), kesFromCents(q.advanceCents)],
                  [t('calc.s2', { balance: '§' }), kesFromCents(q.supplierBalanceCents)],
                  [t('calc.s3', { total: '§' }), kesFromCents(q.totalCostCents)],
                ] as const;
                return parts.map(([tpl, v], i) => { const [a, z] = tpl.split('§'); return <span key={i}>{a}{b(v)}{z}{i < 2 ? ' ' : ''}</span>; });
              })()}
            </p>
            <h3 className="mt-6 text-sm font-bold uppercase tracking-wider text-muted">{t('calc.breakdown')}</h3>
            <dl className="num mt-2 divide-y divide-line">
              {rows.map(([k, v], i) => (
                <div key={k} className={`flex items-baseline justify-between gap-4 py-3 ${i === 3 ? 'font-semibold' : ''} ${i === 4 ? 'font-bold text-green' : ''}`}>
                  <dt>{k}</dt><dd className="text-right tabular-nums">{kesFromCents(v as bigint)}</dd>
                </div>
              ))}
              <div className="flex justify-between py-3 text-sm text-muted"><dt>{t('calc.apr')}</dt><dd className="tabular-nums">{bps(result.q!.aprBps)}</dd></div>
            </dl>
          </>
        )}
        <p className="mt-3 text-sm text-muted">{t('calc.note')}</p>
      </div>
    </section>
  );
}
