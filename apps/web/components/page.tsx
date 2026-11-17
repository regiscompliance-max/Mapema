import { ReactNode } from 'react';

/** Light title band for inner pages: a soft sunrise glow behind a bold, friendly heading. */
export function PageHero({ eyebrow, title, lead, children }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <section className="relative overflow-hidden border-b border-line bg-cream">
      <svg className="pointer-events-none absolute -right-24 -top-10 w-[34rem] max-w-none opacity-80 sm:right-0" viewBox="0 0 400 220" aria-hidden="true">
        <circle cx="300" cy="200" r="150" fill="#ffe8d6" /><circle cx="300" cy="200" r="90" fill="#fed7aa" opacity=".7" /><circle cx="300" cy="200" r="46" fill="#fdba74" opacity=".8" />
      </svg>
      <div className="container-x relative py-12 sm:py-20">
        {eyebrow && <p className="kicker mb-5">{eyebrow}</p>}
        <h1 className="h1 max-w-3xl">{title}</h1>
        {lead && <p className="lead mt-5 max-w-2xl">{lead}</p>}
        {children && <div className="mt-8">{children}</div>}
      </div>
    </section>
  );
}

export function Body({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return <div className={`container-x py-12 sm:py-16 ${narrow ? 'max-w-3xl' : ''}`}>{children}</div>;
}

/** Simple checklist rows. */
export function Points({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-4">
      {items.map((it, i) => (
        <li key={i} className="flex gap-4 rounded-3xl bg-white p-5 ring-1 ring-line">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green text-white" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <span className="pt-1 text-lg">{it}</span>
        </li>
      ))}
    </ul>
  );
}
