# Public site on Cloudflare (static)

Live: https://mapema.regiscompliance.workers.dev (Worker `mapema`, free workers.dev subdomain).

Build: `cd apps/web && npx next build` (output: 'export' -> apps/web/out).
The deploy connection could not use the Workers static-assets upload endpoint (it needs an upload JWT the
connector cannot pass), so `worker.generated.mjs` embeds every file from `out/` and serves them with the
security headers from `apps/web/public/_headers`. With a Cloudflare API token, `wrangler deploy` with an
`assets.directory = "apps/web/out"` config is the cleaner replacement.
