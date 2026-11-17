import { NextRequest, NextResponse } from 'next/server';
import { isLang } from '@/lib/i18n';

export function GET(req: NextRequest) {
  const to = req.nextUrl.searchParams.get('to');
  const back = req.headers.get('referer');
  const dest = back && new URL(back).origin === req.nextUrl.origin ? back : new URL('/', req.url).toString();
  const res = NextResponse.redirect(dest);
  if (isLang(to)) res.cookies.set('lang', to, { path: '/', sameSite: 'lax', maxAge: 365 * 86400 });
  return res;
}
