# Go-live QA report

**[QA Engineer]** 18 Nov 2026, branch `go-live-hardening`. Tests were written first for each item (go-live test ids TC-GL-*).
All times are GMT (London).

## Local results (final run, about 07:45–07:52 GMT)

| Suite | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | ✅ |
| Typecheck (all workspaces) | `npm run typecheck` | ✅ |
| ESLint | `npm run lint` (`--max-warnings=0`) | ✅ clean |
| OpenAPI | `npm run lint:openapi` (v1.4.0-golive, 164 operations) | ✅ valid |
| Pricing (incl. holiday calendar TC-GL-CAL) | `npm test` | ✅ 65 / 65 |
| Adapters (incl. S-13 egress, S-16 scanning, fake clamd) | `npm test` | ✅ 59 / 59 |
| API E2E, mock ledger | `npm test` | ✅ 151 passed, 4 skipped (the Keycloak live tests, opt-in) |
| Worker | `npm test` | ✅ 4 / 4 |
| Web (incl. no sessionStorage, BFF sign-in) | `npm test` | ✅ 91 / 91 |
| API E2E on **real Apache Fineract 1.16.1** | `E2E_LEDGER=fineract npm run test -w @mapema/api` | ✅ 150 passed, 5 skipped (4 Keycloak live, 1 mock-only) |
| Fineract adapter proof (worked example 800,000 / 44,800 / 2,500 / 847,300 / 152,700; CBK order) | `npm run test:fineract` | ✅ 7 / 7 |
| **Keycloak 26.8.2 live MFA (SYS-05)** | `KEYCLOAK_URL=... npx vitest run test/keycloak.live.test.ts` | ✅ 4 / 4 |
| Terraform skeleton | `terraform fmt -check`, `init -backend=false`, `validate` (1.9.8) | ✅ |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` | ✅ (picomatch is dev-only, no fix upstream) |

## New tests

TC-GL-S09 (artefact encryption, tamper, legacy migration), TC-GL-S12 (token masking, rotation, IP allow-list),
TC-GL-S13 (+7 adapter tests), TC-GL-S14, TC-GL-S15, S-16 adapter tests (4), TC-GL-BFF-01..06 (incl. the one-time
MFA re-prompt), config tests (3), TC-GL-HOL-01/02, TC-GL-CAL (pricing calendar and reminder rolling), TC-GL-REC-HOL,
TC-GL-BAK-01 (restore check), TC-GL-KC-01..04 (real Keycloak, real browser). Phase 2 COL-01/02 rewritten to be
calendar-aware; FUND-05 reads the loan tape through the decrypting download endpoint.

## CI (GitHub Actions)

| Branch | Commit | Run | Result |
| --- | --- | --- | --- |
| main | 4ed063c | [44255945691](https://github.com/regiscompliance-max/Mapema/actions/runs/44255945691) (07:03–07:05 GMT) | ✅ success |
| go-live-hardening | 40675d7 | [44262515801](https://github.com/regiscompliance-max/Mapema/actions/runs/44262515801) (07:54–07:57 GMT) | ✅ success: build-test (build, typecheck, lint, openapi lint, all tests, prod audit) and iac (terraform validate) |

CI does not run the Keycloak live tests or real Fineract (no services in CI); both were run locally as above.

## Not tested (needs staging or providers)

Deployment, TLS, backups/PITR on RDS, alarms, real provider sandboxes, pen test, load test.
