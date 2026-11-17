'use client';
import { createContext, ReactNode, useContext } from 'react';
import { Lang, translate } from '@/lib/i18n';

const Ctx = createContext<Lang>('en');
export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) { return <Ctx.Provider value={lang}>{children}</Ctx.Provider>; }
export function useLang() { return useContext(Ctx); }
export function useT() { const lang = useContext(Ctx); return (k: string, p?: Record<string, string | number>) => translate(lang, k, p); }
