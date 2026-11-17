# Public site on Cloudflare

Live: https://mapema.regiscompliance.workers.dev (Worker `mapema`, free workers.dev subdomain, `X-Robots-Tag: noindex`).

Public pages only (home, buyers, suppliers, fees + calculator, book a call, CBK status, complaints, data rights,
draft privacy notice and terms). Portals, API, worker, Fineract and the platform database are NOT deployed;
the header shows "Portal coming soon".

## Placeholders (all in `apps/web/lib/site-config.ts`)

Every value is fake and cannot reach a real person (`.example` is a reserved domain; the phone has X digits).
Each is shown on the site followed by `(placeholder)`.

| Key | Placeholder | Where it shows |
| --- | --- | --- |
| `complaintsEmail` | `complaints@your-domain.example` | Complaints page, footer |
| `complaintsPhone` | `+254 7XX XXX XXX` | Complaints page, footer |
| `generalEmail` | `hello@your-domain.example` | Footer |
| `dataProtectionEmail` | `dpo@your-domain.example` | Data-protection notices on both forms |
| `postalAddress` | `P.O. Box XXXXX-00100, Nairobi` | Footer |
| `PLACEHOLDER_TAG` | `(placeholder)` | Set to `''` once real details are in |

To go real: edit `site-config.ts`, then rebuild and redeploy (below).

## Forms -> D1

`POST /api/book-a-call` and `POST /api/data-request` are handled by the Worker (validation, same-origin check,
8 KB limit, hidden `website` honeypot: filled = silently dropped). Rows go to the free-tier D1 database
`mapema-site` (id in `site.json`, schema in `schema.sql`): tables `call_requests` and `data_requests`.
No emails are sent.

View submissions: Cloudflare dashboard (regiscompliance@gmail.com) -> Storage & databases -> D1 SQL database ->
`mapema-site` -> Console, then e.g. `SELECT * FROM call_requests ORDER BY created_at DESC;`
and `SELECT * FROM data_requests ORDER BY created_at DESC;`.

## Rebuild and deploy

    node scripts/build-site.mjs        # builds pricing + apps/web (output: 'export'), writes dist/worker.mjs + dist/mcp-deploy.js

Deploy with the Cloudflare connector: call its `execute` tool with code `$file:<abs path>/infra/cloudflare-site/dist/mcp-deploy.js`.
(The connector cannot use the Workers static-assets upload endpoint, so the Worker embeds every file from `apps/web/out`.)
With a Cloudflare API token, `wrangler deploy dist/worker.mjs --name mapema` plus a `d1_databases` binding `DB` works too.

Language: English HTML; the Kiswahili switch is client-side (`?lang=sw|en`, remembered in localStorage). Swahili strings are drafts.

## Design assets

Self-hosted variable fonts in `apps/web/public/fonts` (Fraunces for headings, Inter for text and tabular figures; SIL OFL
licences alongside), plus `favicon.svg`, `favicon.ico` and `apple-touch-icon.png`. Binary files (woff2/ico/png) are
embedded in the Worker as base64 by `scripts/build-site.mjs`. No external requests, so the CSP stays `'self'`.
Mark/wordmark: `apps/web/components/brand.tsx`. Colour tokens: `apps/web/app/globals.css`.
