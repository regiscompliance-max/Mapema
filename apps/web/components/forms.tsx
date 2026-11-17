'use client';
import { useT } from './lang';

/** Static public site: no backend yet, so these do not collect or submit any personal data. */
export function BookCallForm() {
  const t = useT();
  return <p role="status" className="card" data-testid="book-soon">{t('book.soon')}</p>;
}

export function DsrForm() {
  const t = useT();
  return <p role="status" className="card" data-testid="dp-soon">{t('dp.soon')}</p>;
}
