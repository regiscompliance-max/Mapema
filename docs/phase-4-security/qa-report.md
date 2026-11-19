# Phase 4 QA report

**[QA Engineer]** 18 Nov 2026, Europe/London. Tests were written first (`apps/api/test/phase4.e2e.test.ts`, `packages/adapters/test/phase4.test.ts`, `apps/web/test/phase4.test.ts`) from `stories.md`. Existing helpers (`eligibleInvoice`, `fund`, `buildWorld`, `scripts/seed.mjs`) were updated so prior suites keep passing. The dev `jobs/run` endpoint now drains the outbox (Phase 4 added `invoice.submitted` notifications, which otherwise overflowed a single 100-item tick in long settlement files).

## Suites run (18 Nov 2026, Europe/London)

| Suite | Result |
| --- | --- |
| `npm test` (pricing, adapters excl. live Fineract, API, worker, web) | **403 passed**, 4 skipped (Keycloak live file is skipped when `KEYCLOAK_URL` is unset) |
| `npm run lint` and `npm run typecheck` | clean |
| `npm run openapi:gen` + `lint:openapi` | **171 operations, 155 paths**, Redocly clean (Phase 3 was 159 / 144) |
| `npm run test:fineract` (real Apache Fineract 1.16.1 on localhost:8443) | **7 passed** |
| `npm run test:e2e:fineract` (`E2E_LEDGER=fineract`) | **167 passed**, 5 skipped |
| Keycloak live (`test/keycloak.live.test.ts`) | **not completed**: Keycloak was listening on 8180 but the admin token request returned HTTP 400 with the documented local compose admin user. The four tests in that file remain skipped in `npm test` when `KEYCLOAK_URL` is unset (same as go-live). No further login attempts were made. |

Pricing 65, adapters 62, API (mock ledger) 168 passed / 4 skipped, worker 4, web 104.

## New tests

| Id | Result | Notes |
| --- | --- | --- |
| TC-P4-REG-01..06 | ✅ | Search required; four eyes; conflict / waiver; filing stores the registration number and closes the ops task |
| TC-P4-DUP-01..03 | ✅ | Notifications to both orgs, unique CU (case-insensitive), similar-invoice flag |
| TC-P4-ATT-01..03 | ✅ | Attestation required; optional PO/GRN; note if confirming without receipt |
| TC-P4-ETIMS-01..02 | ✅ | Unavailable invoice is `ilu_signed` not eligible; maker-checker override then fund |
| TC-P4-GOV-01..03 | ✅ | Flag required; comment when dependent; CRB source still treats the supplier as borrower |
| Adapter P4-1 | ✅ | Mock clear / P099 conflict; manual stub; production refuses mock |
| TC-P4W-01..04 | ✅ | Story marks, routes, draft “not yet licensed” notice, Swahili keys |

## Worked example

Holds on the mock ledger and on real Fineract: invoice KES 1,000,000, 48 days, advance 800,000, fee 44,800, verification 2,500, total cost 47,300, supplier balance 152,700.

## Screenshots

`/workspace/mapema/phase-4-shots/` produced by `scripts/phase4-shots.mjs`.

## Known gaps

- Real MPSRA portal evidence is manual until an official API exists (D-73).
- Anti-fraud notice is a draft and is not published on the marketing site (D-75).
- Counsel I1–I6 outstanding; contracts unchanged (D-76).
- Credit insurance not built (D-79).
- Keycloak live admin login was not completed on this run (see above).
