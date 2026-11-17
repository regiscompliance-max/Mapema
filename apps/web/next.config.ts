import type { NextConfig } from 'next';

const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const securityHeaders = [
  { key: 'Content-Security-Policy', value: [
    "default-src 'self'", `connect-src 'self' ${api} ${process.env.NEXT_PUBLIC_OIDC_ISSUER ?? ''}`.trim(), "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
  ].join('; ') },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() { return [{ source: '/:path*', headers: securityHeaders }]; },
};
export default config;
