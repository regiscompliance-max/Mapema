# Phase 1 QA test report

**[QA Engineer]** Run on 17 Nov 2026, 11:52–11:53 GMT (London), on the shared build box, at commit `HEAD` of `/workspace/mapema/app` (see `git log`). Every number below comes from an actual run. The logs were captured by `npm` scripts. Nothing was run in staging, because no staging environment exists.

## Environment

| Item | Version |
| --- | --- |
| Node | 24.22.1 |
| PostgreSQL | 17 (embedded binary; each API test file creates and drops its own database and connects as a non-superuser role) |
| Apache Fineract | **1.16.1** binary release on JDK 25 (`http://localhost:8443`, tenant `default`, Fineract's local demo login), on PostgreSQL. Fineract ran directly because there is no Docker |
| Test runner | vitest 5.1.0 (upgraded from 3.x in this phase for dev-dependency advisories) |
| Browser smoke | Google Chrome via playwright-core, 390×844 viewport |

## Results

| Command | Result | Duration |
| --- | --- | --- |
| `npm run build` (pricing, adapters, api, worker, web) | ✅ exit 0; Next.js 16.4.6 build produced 16 routes | 6 s |
| `npm run typecheck` (all workspaces) | ✅ exit 0, 0 errors | 5 s |
| `npm run lint:openapi` (implemented API + Phase 0 design) | ✅ **0 errors, 0 warnings** on both files (Phase 0 file had 80 warnings before) | 2 s |
| `npm test` (mock ledger) | ✅ **103 / 103 passed**, 0 failed, 0 skipped | 6 s |
| `npm run test:fineract` (Fineract adapter proof) | ✅ **6 / 6 passed** against real Fineract | 1.3 s |
| `npm run test:e2e:fineract` (API E2E on real Fineract) | ✅ **50 / 50 passed** | 7.2 s |
| `npm audit` (all deps, incl. dev) | ✅ **0 vulnerabilities** (after upgrading zod to 4.6.7 and vitest to 5.1.0) | — |
| `scripts/ui-smoke.mjs` (browser) | ✅ 12 / 12 checks (results below) | 5 s |
| Built API + worker smoke | ✅ API `/v1/public/health` 200 with all 8 adapters listed; worker started and took the job lock; seed built the demo world through the running API | — |

### `npm test` breakdown (103)

| Suite | Tests |
| --- | --- |
| `packages/pricing` (money, pricing, allocation, dates, in duplum, NPL days; property-based with fast-check) | 31 |
| `packages/adapters` mocks (Fineract mock maths, bank, webhooks, eTIMS, CRB, KYC, e-sign, SMS, storage WORM, factory guards) | 13 |
| `apps/api` E2E over HTTP (4 files) | 50 |
| ↳ `worked-example.e2e` | 6 |
| ↳ `settlement-scenarios.e2e` | 10 |
| ↳ `security.e2e` | 24 |
| ↳ `onboarding-public.e2e` | 10 |
| `apps/worker` (schedule in EAT, due-job selection) | 2 |
| `apps/web` (i18n EN/SW key parity + every UI key exists, KES input parsing, fee calculator = worked example) | 7 |

On real Fineract, the same 50 API tests pass. One assertion is skipped deliberately: the absolute three-way reconciliation total, because the shared Fineract tenant carries balances from earlier runs. The per-run GL deltas are still asserted.

## The two mandated proof tests

**1. Worked example money flow (TC-E2E-01, through the HTTP API, mock ledger and real Fineract):**

| Step | Expected (brief) | Asserted |
| --- | --- | --- |
| Quote | advance 800,000; discount fee 44,800; verification fee 2,500; Mapema keeps 847,300; supplier balance 152,700 | ✅ exact cents (80,000,000 / 4,480,000 / 250,000 / 84,730,000 / 15,270,000); APR 44.96% shown and stored |
| Accept → credit approve → ops release (different people, step-up) | Funded; KES 800,000 paid to the verified account | ✅ ledger first, then bank; SMS + email queued |
| Buyer pays KES 1,000,000 on the due date | principal 800,000 → fees 2,500 → interest 44,800, then supplier 152,700 | ✅ allocation row matches; loan closed in Fineract |
| Balance release (D-06) | system proposes, one ops user releases | ✅ payout 152,700 released by ops; four-eyes enforced |
| Ledger | income = 44,800 + 2,500 | ✅ GL deltas; trial balance sums to zero |
| Reconciliation | bank = Fineract cash = platform | ✅ balanced (mock run) |
| Audit | every transition recorded | ✅ hash chain verifies |

**2. Fineract proof test (`fineract.live.test.ts`, real Fineract 1.16.1):** TC-FIN-01 books **exactly KES 44,800 interest** and the KES 2,500 fee (total 847,300). TC-FIN-02 shows a full payment going principal → fees → interest. TC-FIN-03 runs partials in CBK order (500k → principal; then 310k → 300k P, 2.5k F, 7.5k I). TC-FIN-04 shows early settlement at day 30 charging 28,000 (actual days). TC-FIN-05 shows idempotent booking. TC-FIN-06 shows journals hitting the bank GL. **All 6 pass.**

## Settlement and operations scenarios (all pass on mock and real Fineract)

| ID | Scenario | Key assertion |
| --- | --- | --- |
| TC-SET-01 | Early full payment on day 30 | interest 28,000; supplier gets 169,500 |
| TC-SET-02 | 500k on day 30, then 500k on the due date | principal first; interest 34,300 |
| TC-SET-03 | Early partial above principal | excess held, then posted fee-before-interest on the due date |
| TC-SET-04 | Duplicate webhook (same bank ref) | applied once; bad signature rejected |
| TC-SET-05 | Unmatched credit | manual match by ops, approved by a second ops user |
| TC-SET-06 | Payer isn't the buyer | AML flag for compliance |
| TC-SET-07 | Overpayment | supplier balance capped at the invoice; excess `refund_due` |
| TC-OPS-01 | Late ladder | D1 reminder, D7/D14/D30 tasks, NPL, recourse (credit, step-up) |
| TC-OPS-02 | Buyer dispute | buyer frozen; close needs compliance approval |
| TC-OPS-03 | Complaint and DSR | 7/30-day clocks; public DSR starts the statutory clock |

## Security and control tests (24, in `security.e2e`)

These cover: forged, missing and single-factor tokens rejected; SMS factor only for suppliers; step-up (300 s) for money actions; auditor expiry and read-only access; tenant isolation (a second supplier can't see or quote); single-use, email-bound invitations; **staff/auditor role grants need a second person** (new); four-eyes enforced in both the service and the DB; uploader can't approve and approver can't release; KES and integer cents only, minimum invoice and duplicate block; lending switch; pricing needs a CBK reference; **limits re-checked at release**; **concurrent approvals can't jointly breach a limit**; idempotency replay and reuse; immutable disclosures; the app role can't update or delete audit or business records; PII encrypted and never in the outbox; audit export audited; security headers and problem+json; production guards (no dev IdP, no mocks, secrets required).

## Browser smoke (`scripts/ui-smoke.mjs`, seeded local stack, 390 px wide)

| Check | Result |
| --- | --- |
| Home renders; pricing page shows 44,800 | ✅ |
| Swahili toggle switches the home headline | ✅ "Lipwa kwa ankara zilizoidhinishwa ndani ya siku, si miezi" |
| Supplier sign-in (SMS factor) → offer shows 800,000 / 44,800 / 152,700 → accept | ✅ "Requested…" |
| Credit officer approves | ✅ "Approved" |
| Ops: release checks all green, release | ✅ "Released" |
| Auditor: portfolio lists the advance; audit chain intact (42 events) | ✅ |
| Buyer: six tabs incl. maker-checker confirm; calendar shows the pay-to virtual account | ✅ |
| Console errors | 1: a 404 for `/favicon.ico` (cosmetic) |

## Defects found and fixed during Phase 1 QA

1. Supplier balance was wrong on partial payments because it read scheduled rather than collected interest → it now uses the Fineract payoff at the value date and computes the balance from collected amounts.
2. Settlement scenarios silently ran on the mock ledger in Fineract mode → the harness now passes the ledger environment through.
3. Raw invitation tokens were stored in the outbox → now encrypted and scrubbed after sending.
4. The release limit check could be raced by concurrent approvals → advisory lock taken in both decide and release.
5. The buyer payment-calendar screen expected an array but the API returns `{payTo, due}` → fixed (found by the browser smoke).
6. Staff and auditor invitations could be granted by one person → maker-checker added (tests written first, failed red, then passed).
7. In duplum was a library function not wired into the API → origination invariant, settlement guard and NPL 30/90 days wired in, with tests.
8. The public site claimed Mapema "has applied" for a CBK licence (unverified) → neutral "not yet licensed" wording.
9. `npm audit` showed 1 high (zod) and 2 critical + 1 moderate (dev-only vitest/tinypool) → upgraded; 0 left.

## Not tested (and why)

- **Staging**: none exists (no deploying or account creation in Phase 1).
- **Real bank, eTIMS, CRB, KYC, e-signature sandboxes**: no provider chosen and no accounts. Mocks only.
- **Africa's Talking / Postmark HTTP clients**: written, never called.
- **Keycloak and the OIDC PKCE web flow**: realm written, not imported. Tests use the dev IdP, which signs tokens with the same claims.
- **Docker images, compose, CI workflow**: no Docker on the box; no pushing to a remote.
- **Load, accessibility (axe/WCAG) and cross-browser testing**: not done.
- **Independent pen test**: not done (see the security checklist).

## QA verdict

All automated tests are green: 103/103 on the mock ledger and 56/56 on real Fineract. The worked example is proven to the cent end to end, including in a real browser. The brief's Phase 1 exit criterion still isn't met, because it requires the worked example **in staging** and a **fixed pen test**.
