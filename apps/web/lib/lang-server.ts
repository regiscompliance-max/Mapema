import { cookies } from 'next/headers';
import { isLang, Lang, translate } from './i18n';

export async function serverLang(): Promise<Lang> {
  const v = (await cookies()).get('lang')?.value;
  return isLang(v) ? v : 'en';
}
export async function serverT() {
  const lang = await serverLang();
  return { lang, t: (k: string, p?: Record<string, string | number>) => translate(lang, k, p) };
}
