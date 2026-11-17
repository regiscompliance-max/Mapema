/** Mapema mark: the sun rising over the horizon ("mapema" = early) on a green tile. Same art as /favicon.svg. */
export function Mark({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="9" fill="#14532d" />
      <circle cx="16" cy="20" r="7" fill="#f97316" />
      <path d="M16 7.5v3M8 11l2 2M24 11l-2 2" stroke="#fdba74" strokeWidth="2" strokeLinecap="round" />
      <rect x="5" y="20" width="22" height="7" fill="#14532d" />
      <path d="M5 20.5h22" stroke="#fbf7f0" strokeWidth="2" strokeLinecap="round" />
      <path d="M10 24.5h12" stroke="#b7e4c7" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark />
      <span className="font-display text-[1.6rem] font-bold tracking-[-0.03em] text-green">mapema</span>
    </span>
  );
}
