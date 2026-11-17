import { createElement, ReactNode } from 'react';
import { T } from '@/components/lang';
import { contactParams } from './site-config';
import { Lang } from './i18n';

/** Static site: HTML is rendered in English; <T> re-renders text in the visitor's chosen language on the client. */
export async function serverLang(): Promise<Lang> {
  return 'en';
}
export async function serverT() {
  const lang = await serverLang();
  return { lang, t: (k: string, p?: Record<string, string | number>): ReactNode => createElement(T, { k, p: { ...contactParams(), ...p } }) };
}
