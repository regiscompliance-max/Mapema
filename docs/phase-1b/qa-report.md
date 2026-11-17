# Phase 1b QA test report

**[QA Engineer]** Run on 17 Nov 2026, 19:13–19:16 GMT (London), on the shared build box, at the Phase 1b head of `/workspace/mapema/app`. Every number comes from an actual run; logs were captured from the npm scripts. No staging environment exists.

## Environment

Node 24.22.1 · PostgreSQL 17 (embedded) · Apache Fineract **1.16.1** (binary, JDK 25, `http://localhost:8443`, tenant `default`, Fineract's local demo login) · vitest 5.1.0 · Google Chrome via playwright-core + axe-core, 390×844.

## Results

| Command | Result | Duration |
| --- | --- | --- |
| `npm run build` | ✅ exit 0 (pricing, adapters, api, worker, Next.js web) | 7.4 s |
| `npm run typecheck` | ✅ exit 0, 0 errors | 5.8 s |
| `npm run lint:openapi` | ✅ both files valid, 0 warnings (104 operations) | 2 s |
| Code lint | **Not run: no ESLint config exists** (unchanged from Phase 1; follow-up) | — |
| `npm test` | ✅ **160 / 160**, 0 failed, 0 skipped | 13.2 s |
| `npm run test:fineract` | ✅ **6 / 6** on real Fineract | 3.2 s |
| `npm run test:e2e:fineract` | ✅ **77 / 77** on real Fineract (titles say `[ledger=real Fineract]`; Fineract loan count rose from 100 to 110 when the settlement file was re-run on its own) | 16.3 s |
| `npm audit` | ⚠️ 8 high, **dev-only** (picomatch ≤ 4.0.7, GHSA-fc5q-39xc-vjpf, through vitest/vite/unplugin-swc); no fixed version published | — |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities | — |
| `ENV_FILE=… scripts/smoke-stack.sh` then `scripts/ui-smoke.mjs` | ✅ **42 / 42**; axe 0 serious or critical; 0 unexpected console errors | 7.1 s |

### `npm test` breakdown (160; Phase 1 was 103)

| Suite | Tests | New in 1b |
| --- | --- | --- |
| packages/pricing | 31 | — |
| packages/adapters (mocks) | 13 | — |
| apps/api `worked-example.e2e` | 6 | — |
| apps/api `settlement-scenarios.e2e` | 12 | TC-SET-08 shortfall tracked and paid through, TC-SET-09 supplier closes shortfall |
| apps/api `security.e2e` | 24 | — |
| apps/api `onboarding-public.e2e` | 10 | — |
| apps/api `session-cookies.e2e` | 9 | TC-SES-01..09 |
| apps/api `rate-limit.e2e` | 3 | TC-RL-01..03 (two instances share a budget) |
| apps/api `credit-reviews.e2e` | 5 | TC-CRD-07a..e |
| apps/api `screens-api.e2e` | 8 | TC-DOC-01..03, TC-BUY-13, TC-SUP-03, TC-SUP-13, TC-ADM-07, TC-ADM-01 |
| apps/worker | 2 | — |
| apps/web (3 files) | 37 | session (5: no browser-storage tokens, credentials and CSRF on writes, reload, sign-out), screens (upload checks, consent purposes, labels, reachability) |

Test-first evidence in git: failing-test commits come before the implementation for sessions (`b140396`, `389d3af`, `0922770`), the rate limiter (`069ab48`), CRD-07 (`1991941`) and the screen APIs (`af30887`). The shortfall tests TC-SET-08/09 landed in the **same** commit as the shortfall code (`b13f4d4`), so git cannot show they were red first.

## Browser smoke (390×844, fresh database)

42 checks:
- public pages and the Swahili toggle
- the cookie is HttpOnly, Secure and SameSite=Strict; no token in local/session storage; a write without the CSRF header gets 403; the CSRF token is restored after a reload; sign-out clears the session
- supplier: offer, terms, accept, consent, my data, add invoice, upload, shortfall list
- credit: buyer and supplier credit files, programme proposal, review tasks and reminder run, write-offs, release checks including PROGRAMME_IN_REVIEW_DATE and KYC_CURRENT
- ops: release, shortfalls
- buyer: calendar, programme utilisation, notice PDF download, receipt, KYB upload, hold/release
- staff: DSR status update, staff list, float/limit forms
- audit chain intact
- axe

Found and fixed during the smoke:
- Scrollable tables were not keyboard-focusable (axe `scrollable-region-focusable`). They are now `role=region` with `tabIndex=0` and a label.
- The mock bank had to be funded before release. The smoke now funds it through the dev endpoint.

## Defects found in Phase 1b and fixed

1. SQL enum vs text comparisons in the document and staff queries (`type::text`, `array_agg(role::text)`).
2. A 204 response built with a body.
3. An idle-timeout test loop that ran past the absolute lifetime.
4. The my-data retention text stated a legal period as fact. It now says "may have to be kept for a legal retention period" (unverified until counsel confirms).
