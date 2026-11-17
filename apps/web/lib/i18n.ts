/** [Product Designer + Frontend Engineer] Tiny i18n: English source, Swahili draft (flagged for native review). */
import en from './messages/en.json';
import sw from './messages/sw.json';

export type Lang = 'en' | 'sw';
export const DICTS: Record<Lang, Record<string, string>> = { en, sw };
export type Key = keyof typeof en;

export function translate(lang: Lang, key: Key | string, params: Record<string, string | number> = {}): string {
  const tpl = DICTS[lang]?.[key] ?? DICTS.en[key] ?? key;
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => String(params[k] ?? `{${k}}`));
}
export const isLang = (v: unknown): v is Lang => v === 'en' || v === 'sw';
