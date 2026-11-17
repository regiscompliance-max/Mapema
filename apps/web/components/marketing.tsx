import { ReactNode } from 'react';
import { formatKes, quote, STANDARD_PRICING } from '@mapema/pricing';
import { serverT } from '@/lib/lang-server';

/** Worked example used by the hero and mocks, computed with the real pricing engine at build time. */
export const EXAMPLE = (() => {
  const q = quote(100000000n, 48, STANDARD_PRICING);
  return { invoice: formatKes(q.invoiceCents), advance: formatKes(q.advanceCents), balance: formatKes(q.supplierBalanceCents), total: formatKes(q.totalCostCents), days: 48 };
})();

/** Signature visual: an approved invoice that splits into "80% today" and "the rest later", under a sunrise arc of days. */
export async function HeroVisual() {
  const { t } = await serverT();
  const e = EXAMPLE;
  return (
    <figure className="relative mx-auto w-full max-w-[30rem]">
      <div className="relative" aria-hidden="true">
      <svg viewBox="0 0 480 250" className="w-full">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffe8d6" /><stop offset="1" stopColor="#fbf7f0" stopOpacity="0" /></linearGradient>
          <radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#fdba74" /><stop offset="1" stopColor="#f97316" /></radialGradient>
        </defs>
        <path d="M20 230 A220 220 0 0 1 460 230 Z" fill="url(#sky)" />
        <path d="M40 230 A200 200 0 0 1 440 230" fill="none" stroke="#e5d9c5" strokeWidth="3" strokeDasharray="2 10" strokeLinecap="round" />
        <path d="M40 230 A200 200 0 0 1 122 69" fill="none" stroke="#f97316" strokeWidth="5" strokeLinecap="round" />
        <circle cx="122" cy="69" r="16" fill="url(#sun)" />
        <g stroke="#fdba74" strokeWidth="3" strokeLinecap="round"><path d="M122 40v-8M98 52l-6-6M146 52l6-6" /></g>
        <circle cx="440" cy="230" r="8" fill="#14532d" />
        <path d="M0 230h480" stroke="#e5d9c5" strokeWidth="2" />
      </svg>
      <div className="absolute bottom-[10%] left-[9%] rounded-full bg-white px-2.5 py-0.5 text-sm font-bold text-sun-ink shadow-sm">{t('hero.day0')}</div>
      <div className="absolute bottom-[10%] right-[4%] rounded-full bg-white px-2.5 py-0.5 text-sm font-bold text-green shadow-sm">{t('hero.dayN', { days: e.days })}</div>
      </div>

      <div className="rise relative mt-3 rounded-3xl border border-line bg-white p-5 shadow-[0_30px_60px_-35px_rgba(20,83,45,.5)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-muted">{t('hero.invoice')} · INV-0142</p>
            <p className="num font-display text-3xl font-bold text-ink">{e.invoice}</p>
          </div>
          <span className="rounded-full bg-sand px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-muted">{t('hero.example')}</span>
        </div>
        <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-green">
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#dcefe3" /><path d="M6 10.5l2.5 2.5L14 7.5" fill="none" stroke="#14532d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {t('hero.approved')} · {t('hero.due', { days: e.days })}
        </p>
        <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-sand" aria-hidden="true">
          <span className="split-a block h-full w-[80%] rounded-l-full bg-green" />
          <span className="split-b ml-1 block h-full flex-1 rounded-r-full bg-sun" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="split-a rounded-2xl bg-green p-3.5 text-white">
            <p className="text-sm font-semibold text-mint">{t('hero.today')}</p>
            <p className="num font-display text-xl font-bold sm:text-2xl">{e.advance}</p>
          </div>
          <div className="split-b rounded-2xl bg-sun-soft p-3.5 text-ink">
            <p className="text-sm font-semibold text-sun-ink">{t('hero.later')}</p>
            <p className="num font-display text-xl font-bold sm:text-2xl">{e.balance}</p>
          </div>
        </div>
        <p className="num mt-3 text-sm text-muted">{t('hero.fees', { total: e.total })}</p>
      </div>
    </figure>
  );
}

const ICONS = {
  check: 'M4 12l5 5L20 6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
  cash: 'M3 7h18v10H3zM7 12h.01M17 12h.01M12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
};

export async function Steps() {
  const { t } = await serverT();
  const steps = [['check', 'how.1t', 'how.1d'], ['eye', 'how.2t', 'how.2d'], ['cash', 'how.3t', 'how.3d']] as const;
  return (
    <ol className="grid gap-8 md:grid-cols-3 md:gap-6">
      {steps.map(([icon, tk, dk], i) => (
        <li key={tk} className="relative">
          <div className="flex items-center gap-3">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-green text-white">
              <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[icon]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <span className="num font-display text-5xl font-bold text-sand-2" aria-hidden="true">{i + 1}</span>
          </div>
          <h3 className="h3 mt-4">{t(tk)}</h3>
          <p className="mt-2 text-muted">{t(dk)}</p>
        </li>
      ))}
    </ol>
  );
}

/** HTML/CSS mock of the supplier portal. Decorative, labelled as an example; buttons are not interactive. */
export async function ProductMock() {
  const { t } = await serverT();
  const rows = [
    { inv: 'INV-0142', amt: EXAMPLE.invoice, days: 48, state: 'cta' },
    { inv: 'INV-0139', amt: formatKes(42000000n), days: 61, state: 'approved' },
    { inv: 'INV-0131', amt: formatKes(18500000n), days: 0, state: 'paid' },
  ];
  return (
    <figure className="relative">
      <figcaption className="sr-only">{t('mock.label')}</figcaption>
      <div aria-hidden="true" className="rounded-[1.75rem] border border-line bg-white p-4 shadow-[0_40px_80px_-50px_rgba(31,35,40,.5)] sm:p-6">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <p className="font-bold text-ink">{t('mock.invoices')}</p>
          <span className="rounded-full bg-sand px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-muted">{t('hero.example')}</span>
        </div>
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.inv} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm text-muted">{r.inv} · {t('mock.buyer')}</p>
                <p className="num text-lg font-bold">{r.amt}</p>
                <p className="text-sm font-semibold text-green">{r.state === 'paid' ? t('mock.paid') : <>{t('mock.approved')} · {t('mock.due', { days: r.days })}</>}</p>
              </div>
              {r.state === 'cta' && <span className="inline-flex min-h-11 items-center rounded-full bg-sun px-5 font-bold text-ink">{t('mock.getPaid')}</span>}
              {r.state === 'approved' && <span className="inline-flex min-h-11 items-center rounded-full border-2 border-line px-5 font-bold text-green">{t('mock.getPaid')}</span>}
              {r.state === 'paid' && <span className="inline-flex min-h-11 items-center rounded-full bg-green-soft px-4 text-sm font-bold text-green">✓ {t('mock.paid')}</span>}
            </li>
          ))}
        </ul>
      </div>
      <div aria-hidden="true" className="relative -mt-6 ml-auto w-[88%] rounded-2xl border border-line bg-ink p-4 text-white shadow-xl sm:-mt-10 sm:w-[70%]">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sun text-ink" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 12l5 5L20 6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <div>
            <p className="flex items-center gap-2 font-bold">{t('mock.notifTitle')} <span className="text-xs font-medium text-white/75">{t('mock.just')}</span></p>
            <p className="num text-white/90">{t('mock.notifBody', { amount: EXAMPLE.advance })}</p>
          </div>
        </div>
      </div>
    </figure>
  );
}

export async function Safeguards() {
  const { t } = await serverT();
  const items = [
    ['trust.kes', 'M4 7h16M4 12h16M4 17h10'],
    ['trust.bank', 'M3 10l9-6 9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18'],
    ['trust.maker', 'M16 11a3 3 0 10-6 0 3 3 0 006 0zM8 9a2.5 2.5 0 10-5 0 2.5 2.5 0 005 0zM2 19c0-2.5 2-4 4.5-4M9 20c0-3 2.5-5 4-5s4 2 4 5'],
    ['trust.data', 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z'],
  ] as const;
  return (
    <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
      {items.map(([k, d]) => (
        <li key={k} className="flex gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-soft text-green">
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <div><p className="text-lg font-bold">{t(k)}</p><p className="text-muted">{t(`${k}.d`)}</p></div>
        </li>
      ))}
    </ul>
  );
}

export async function Faq({ ids = [1, 2, 3, 4, 5, 6, 7] }: { ids?: number[] }) {
  const { t } = await serverT();
  const p = { rate: (STANDARD_PRICING.discountRateBpsPer30d / 100).toFixed(1), fee: formatKes(STANDARD_PRICING.verificationFeeCents) };
  return (
    <div className="faq border-t border-line" data-testid="faq">
      {ids.map((i) => (
        <details key={i}>
          <summary>{t(`faq.q${i}`)}</summary>
          <div>{t(`faq.a${i}`, p)}</div>
        </details>
      ))}
    </div>
  );
}

export function Section({ children, tone = 'cream', className = '', id }: { children: ReactNode; tone?: 'cream' | 'sand' | 'white' | 'green'; className?: string; id?: string }) {
  const bg = { cream: 'bg-cream', sand: 'bg-sand', white: 'bg-white', green: 'bg-green text-white' }[tone];
  return <section id={id} className={`${bg} ${className}`}><div className="container-x py-16 sm:py-24">{children}</div></section>;
}
