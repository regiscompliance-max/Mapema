import type { NextConfig } from 'next';

// Static export of the public site only (served as Cloudflare Workers static assets).
// Security headers live in public/_headers because `headers()` is not applied to static exports.
const config: NextConfig = {
  output: 'export',
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
};
export default config;
