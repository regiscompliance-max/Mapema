import { ReactNode } from 'react';

/** Navy title band used by every inner page, followed by the page body on paper. */
export function PageHero({ eyebrow, title, lead, children }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <section className="hero-bg on-dark relative overflow-hidden text-white">
      <div className="grain pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="container-x relative py-14 sm:py-20">
        {eyebrow && <p className="eyebrow mb-4">{eyebrow}</p>}
        <h1 className="h1 max-w-3xl">{title}</h1>
        {lead && <p className="lead mt-5 max-w-2xl">{lead}</p>}
        {children && <div className="mt-8">{children}</div>}
      </div>
      <div className="rule-brass" />
    </section>
  );
}

export function Body({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return <div className={`container-x py-12 sm:py-16 ${narrow ? 'max-w-3xl' : ''}`}>{children}</div>;
}

/** Numbered list styled as a ledger of points. */
export function Points({ items }: { items: ReactNode[] }) {
  return (
    <ol className="divide-y divide-line border-y border-line">
      {items.map((it, i) => (
        <li key={i} className="grid grid-cols-[3rem_1fr] gap-4 py-6 sm:grid-cols-[5rem_1fr]">
          <span className="num font-serif text-2xl text-brass-ink">{String(i + 1).padStart(2, '0')}</span>
          <span className="text-lg leading-relaxed">{it}</span>
        </li>
      ))}
    </ol>
  );
}
