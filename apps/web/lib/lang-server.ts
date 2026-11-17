import { Lang, translate } from './i18n';

/** Static public site: English only (no cookies at build time). Swahili toggle returns with a server-rendered site. */
export async function serverLang(): Promise<Lang> {
  return 'en';
}
export async function serverT() {
  const lang = await serverLang();
  return { lang, t: (k: string, p?: Record<string, string | number>) => translate(lang, k, p) };
}
