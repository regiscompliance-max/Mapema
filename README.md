# Mapema platform — Phase 1 + 1b (lending core MVP)

**[Technical Writer]** Buyer-led supplier early-payment platform for Kenya. One web app (public site plus buyer, supplier, staff and read-only portals), a NestJS API, a background worker, PostgreSQL, and **Apache Fineract as the loan and accounting ledger**. Every outside provider sits behind an adapter that has a mock.

> Phase 1 status, coverage, test numbers and open items: [`docs/phase-1/README.md`](docs/phase-1/README.md). Phase 1b (remaining screens, cookie sessions, shortfalls, shared rate limit, review reminders): [`docs/phase-1b/README.md`](docs/phase-1b/README.md). Phase 2 (reconciliation, CBK/CRB/lender reports, late-payment automation, dashboards, Xero and HubSpot adapters): [`docs/phase-2/README.md`](docs/phase-2/README.md).
> Nothing here is deployed. There is no staging environment yet, and no pen test has been done.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/pricing` | Pure money and pricing engine: integer cents (bigint), quote, actual-days interest, CBK allocation order, in duplum, NPL days, EAT dates |
| `packages/adapters` | Provider adapters and mocks: Fineract ledger (real client plus mock), bank, eTIMS, CRB, KYC, e-signature, SMS (Africa's Talking), email (Postmark), webhooks |
| `apps/api` | NestJS API (`/v1`): auth/MFA/step-up, onboarding, invoices, advances, payments, approvals (maker-checker), ops, admin, reports/audit, public, dev-only routes |
| `apps/worker` | Scheduled jobs: outbox, payout status, held remainders, late ladder, reconciliation (one active worker via an advisory lock) |
| `apps/web` | Next.js 16 / React 19 / Tailwind 4: public site, sign-in, invitation, portals (EN plus draft SW) |
| `db/migrations` | SQL migrations (001 Phase 0 schema, 002 Phase 1, 003 role-grant approval, 004 supplier shortfall, 005 web sessions, 006 shared rate limit, 007 credit review tasks) |
| `openapi/openapi.yaml` | Generated contract for the API as implemented (`npm run openapi:gen`) |
| `openapi/phase-0-design.yaml` | Phase 0 design contract (warnings fixed) |
| `scripts/` | `migrate.mjs`, `seed.mjs`, `gen-openapi.mjs`, `ui-smoke.mjs`, `smoke-stack.sh` |
| `infra/` | Dockerfiles, Keycloak realm, DB init (written, **not run**: no Docker on the build box) |
| `docs/phase-1/` | Phase 1 report, compliance review, QA report, security checklist, CEO questions |
| `docs/phase-1b/` | Phase 1b report, QA report, security checklist update |
| `docs/phase-2/` | Phase 2 stories, report, QA report, security checklist, compliance review, sample month-end reports |

## Prerequisites

- Node 24 (`.nvmrc`), npm 11
- PostgreSQL 15+ (Phase 1 tested on embedded PostgreSQL 17)
- Optional: Apache Fineract 1.16.1 for real-ledger runs (Phase 1 ran the binary release on JDK 25 against the same PostgreSQL), and Google Chrome for `scripts/ui-smoke.mjs`

## Quick start (local, mock providers)

```bash
npm ci
cp .env.example .env            # then fill the <...> values: openssl rand -hex 32 for each key
npm run build

# 1) database: migrations, the least-privilege login role mapema_api, and demo staff
DATABASE_ADMIN_URL=postgres://postgres:...@localhost:5432/mapema APP_DB_LOGIN_PASSWORD=... npm run db:seed

# 2) API (with DEV_IDP_ENABLED=true in .env for local sign-in)
set -a; . ./.env; set +a; npm run start -w @mapema/api

# 3) demo world through the API: pricing with a CBK ref, float, lending on, buyer, supplier, one eligible invoice
DATABASE_ADMIN_URL=... SEED_API_URL=http://localhost:4000 npm run db:seed

# 4) web
NEXT_PUBLIC_API_URL=http://localhost:4000 NEXT_PUBLIC_DEV_SIGNIN=true npm run build -w @mapema/web && npm run start -w @mapema/web
```

Open http://localhost:3000/signin and sign in with any demo user (the dev IdP issues an MFA token; it can't be switched on in production):

| User | Role | Notes |
| --- | --- | --- |
| `finance@juakali.test` (factor: SMS) | supplier admin | Jua Kali Packaging Ltd: get paid early on `DEMO-INV-0001` |
| `ap@acme.test` / `checker@acme.test` | buyer admin (maker) / buyer checker | Acme Supermarkets Ltd |
| `credit@`, `credit2@`, `ops@`, `ops2@`, `compliance@`, `admin@`, `ceo@`, `auditor@mapema.test` | staff | two of each approving role, so maker-checker can be tried |

With mock providers, run the API **without** a separate worker and trigger jobs with `POST /v1/dev/jobs/run`. Mocks keep state in process memory, so a separate worker process would have its own mock bank and e-signature state. The worker is for sandbox and live adapters.

### Worked example in the UI (about 2 minutes)

1. Sign in as the supplier, tap **Get paid now** on DEMO-INV-0001, and check the disclosure: KES 800,000 advance, KES 44,800 maximum discount fee, KES 2,500 verification fee, KES 152,700 balance. Accept.
2. Sign in as `credit@` → Advances → Approve. Then sign in as `ops@` → Advances → Release payment.
3. The buyer payment is simulated with `POST /v1/dev/bank/credit`. Then run jobs. The ops user releases the KES 152,700 balance under Payments.

`scripts/ui-smoke.mjs` automates these steps and every Phase 1b screen (42 checks, cookie/CSRF checks, axe scan); see Tests below for how to run it on a fresh stack.

## Tests

| Command | What it runs |
| --- | --- |
| `npm test` | pricing, adapters (mocks), API E2E (mock ledger), worker, web. Needs `TEST_DATABASE_ADMIN_URL` (a superuser URL; each API test file creates and drops its own database and connects as a **non-superuser** role) |
| `npm run test:e2e:fineract` | Same API suites against a **real Fineract** (`E2E_LEDGER=fineract`, `FINERACT_*`). Fineract rejects future-dated transactions, so dates are shifted 500 days into the past |
| `npm run test:fineract` | Fineract adapter proof test: exactly KES 44,800 interest, principal-first allocation |
| `npm run typecheck` / `npm run build` | All workspaces |
| `npm run lint:openapi` | Redocly lint of both OpenAPI files (0 warnings) |
| `ENV_FILE=/path/env scripts/smoke-stack.sh` then `NODE_PATH=<dir with playwright-core, axe-core> WEB_URL=http://localhost:3000 API_URL=http://localhost:4000 node scripts/ui-smoke.mjs` | Fresh database + seeded stack, then the 42-check browser smoke at 390 px with an axe scan. Build the web first with `NEXT_PUBLIC_API_URL=http://localhost:4000 NEXT_PUBLIC_DEV_SIGNIN=true`. The smoke funds the mock bank via `/v1/dev/bank/fund` before releasing |

Key money tests: `apps/api/test/worked-example.e2e.test.ts` (the brief's worked example end to end through HTTP), `settlement-scenarios.e2e.test.ts` (early, partial, held, duplicate, unmatched, AML, overpayment, late ladder, disputes, complaints), and `packages/adapters/test/fineract.live.test.ts`.

## Environment variables

The full list with comments is in [`.env.example`](.env.example). It contains no real secrets. In summary:

- Runtime: `APP_ENV`, `PORT`, `WEB_ORIGIN`
- Database: `DATABASE_URL` (app role), `DATABASE_ADMIN_URL`, `TEST_DATABASE_ADMIN_URL`, `APP_DB_LOGIN_PASSWORD`
- Identity: `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`, `DEV_IDP_ENABLED`, `STEP_UP_MAX_AGE_SEC`
- Phase 2: `ADAPTER_MODE_ACCOUNTING`, `ADAPTER_MODE_CRM`, `ADAPTER_MODE_SITE_LEADS` (all `mock` by default), Xero/HubSpot/D1 credentials (empty), `ACCOUNTING_GL_MAP`, `CRB_SUBMISSION_REQUIRE_CONSENT` (true), `SEED_DEMO_MONTH` (e.g. `2026-10`). See `.env.example`.
- Browser sessions and limits (Phase 1b): `SESSION_IDLE_MINUTES` (15), `SESSION_MAX_HOURS` (8), `RATE_LIMIT_STORE` (`postgres`|`memory`), `KYC_REFRESH_MONTHS` (12). The web signs in by swapping the IdP token for an httpOnly `mapema_sid` cookie; writes send `X-CSRF-Token`
- Encryption: `PII_ENCRYPTION_KEY`, `PII_BLIND_INDEX_KEY`, `STORAGE_ENCRYPTION_KEY`, `STORAGE_DIR`
- Business: `INVITE_TTL_HOURS`, `QUOTE_TTL_MINUTES`, `BANK_ACCOUNT_COOLING_OFF_HOURS`
- Adapters: `ADAPTER_MODE_{LEDGER,BANK,ETIMS,CRB,KYC,ESIGN,SMS,EMAIL}` (`mock|sandbox|live`; live only in production, and production refuses mock), `FINERACT_*`, `BANK_WEBHOOK_SECRET`, `ESIGN_WEBHOOK_SECRET`, `ESIGN_MOCK_AUTOCOMPLETE`, `AT_*`, `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM`
- Web: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DEV_SIGNIN`, `NEXT_PUBLIC_OIDC_ISSUER`, `NEXT_PUBLIC_OIDC_CLIENT_ID`
- Seed and tests: `SEED_API_URL`, `E2E_LEDGER`

## Non-negotiables and where they live

| Rule | Where |
| --- | --- |
| KES integer cents only | `packages/pricing/src/money.ts`, zod `zCents`/`zKes`, DB `money_cents` domain, bigint everywhere, JSON as decimal strings |
| Principal → fees and charges → interest | `pricing.allocate`, Fineract allocation strategy, payment posting policy in `payments.ts`, TC-SET-01..03 |
| Fineract is the ledger | `packages/adapters/src/fineract.ts`. The platform keeps only a mirror; the trial balance comes from Fineract |
| Maker-checker | `approvals.ts` plus DB `four_eyes` constraint. Covers credit approve vs ops release, limits, pricing, float, lending switch, bank verification, manual match, dispute close, break close, write-off, staff/auditor role grants |
| Limits enforced at release | `advances.ts` `checks()` re-run under `pg_advisory_xact_lock` in both decide and release |
| Pricing changes need a CBK approval reference | `admin.ts` activation + DB CHECK on `pricing_version` |
| In duplum | quote invariant (cost ≤ principal), settlement guard → reconciliation break, NPL 30/90 days |
| Full disclosure stored with acceptance | `price_disclosure` rows (amounts, APR, terms and KID versions), referenced by the acceptance |
| Append-only audit log | `audit_event` hash chain, UPDATE/DELETE revoked from the app role, `/audit/verify`, CSV export |
| PII encrypted | AES-256-GCM field encryption plus HMAC blind index (national ID, phone, bank account), encrypted document store |
| MFA for all users | API rejects tokens without an MFA `amr`; step-up for money movements |
| Mobile-first, Swahili-ready | web `lib/messages/{en,sw}.json` (key parity tested), 390 px smoke run |
