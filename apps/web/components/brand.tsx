/** Mapema mark: a rising sun ("mapema" = early) over a horizon, inside a fine brass frame. */
export function Mark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="7" fill="#0a1324" stroke="#c9a45c" strokeWidth="1.5" />
      <path d="M8 21a8 8 0 0 1 16 0" fill="none" stroke="#c9a45c" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 9.2v2.6M9.6 11.8l1.6 1.9M22.4 11.8l-1.6 1.9" stroke="#e3cf9f" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6 21h20M9.5 24.5h13" stroke="#c9a45c" strokeWidth="1.5" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

export function Wordmark({ dark = true }: { dark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark />
      <span className={`font-serif text-[1.45rem] font-medium tracking-[-0.01em] ${dark ? 'text-white' : 'text-navy'}`}>Mapema</span>
    </span>
  );
}
