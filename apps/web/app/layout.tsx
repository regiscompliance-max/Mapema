import type { Metadata, Viewport } from 'next';
import './globals.css';
import { LangProvider } from '@/components/lang';
import { Footer, Header } from '@/components/site';
import { serverLang } from '@/lib/lang-server';

export const metadata: Metadata = {
  title: 'Mapema - get paid early on approved invoices', description: 'Buyer-led supplier early payment in Kenya.',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }, { url: '/favicon.ico', sizes: '32x32' }], apple: '/apple-touch-icon.png' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a1324' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await serverLang();
  return (
    <html lang={lang}>
      <body>
        <LangProvider lang={lang}>
          <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2">Skip to content</a>
          <Header lang={lang} />
          <main id="main">{children}</main>
          <Footer lang={lang} />
        </LangProvider>
      </body>
    </html>
  );
}
