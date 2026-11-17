'use client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { isLang, Lang, translate } from '@/lib/i18n';

/** Client-side language: ?lang=sw|en wins, then localStorage, else English (the static HTML is English). */
type Ctx = { lang: Lang; setLang: (l: Lang) => void };
const C = createContext<Ctx>({ lang: 'en', setLang: () => {} });
const KEY = 'mapema.lang';

export function LangProvider({ lang: initial, children }: { lang: Lang; children: ReactNode }) {
  const [lang, set] = useState<Lang>(initial);
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('lang');
    let stored: string | null = null;
    try { stored = localStorage.getItem(KEY); } catch { /* storage blocked */ }
    const want = isLang(q) ? q : isLang(stored) ? stored : initial;
    if (isLang(q)) try { localStorage.setItem(KEY, q); } catch { /* ignore */ }
    set(want);
  }, [initial]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = useCallback((l: Lang) => { set(l); try { localStorage.setItem(KEY, l); } catch { /* ignore */ } }, []);
  return <C.Provider value={{ lang, setLang }}>{children}</C.Provider>;
}
export function useLang() { return useContext(C).lang; }
export function useT() { const { lang } = useContext(C); return (k: string, p?: Record<string, string | number>) => translate(lang, k, p); }

/** Translated text node, usable from server components. */
export function T({ k, p }: { k: string; p?: Record<string, string | number> }) { return <>{useT()(k, p)}</>; }

export function LangSwitch() {
  const { lang, setLang } = useContext(C);
  const to: Lang = lang === 'en' ? 'sw' : 'en';
  return (
    <button type="button" className="py-2 text-sm underline" lang={to} onClick={() => setLang(to)} data-testid="lang-switch">
      {translate(lang, 'nav.lang')}
    </button>
  );
}
