import type { Metadata, Viewport } from 'next';
import './globals.css';
import { LangProvider } from '@/components/lang';
import { Footer, Header } from '@/components/site';
import { serverLang } from '@/lib/lang-server';

export const metadata: Metadata = { title: 'Mapema - get paid early on approved invoices', description: 'Buyer-led supplier early payment in Kenya.' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await serverLang();
  return (
    <html lang={lang}>
      <body>
        <LangProvider lang={lang}>
          <a href="#main" className="sr-only focus:not-sr-only">Skip to content</a>
          <Header lang={lang} />
          <main id="main" className="mx-auto max-w-5xl px-4 py-8">{children}</main>
          <Footer lang={lang} />
        </LangProvider>
      </body>
    </html>
  );
}
