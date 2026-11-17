# Phase 1b report: remaining screens, cookie sessions, shortfalls, shared rate limit, review reminders

**[Product Manager + Tech Lead]** 17 Nov 2026, finished 19:20 GMT (London). Repo `/workspace/mapema/app`, local only: nothing pushed, deployed or sent, and no accounts created. Decisions are in [`../decisions-log.md`](../decisions-log.md) (D-19 to D-30 are the approved Phase 1 defaults; D-31 to D-36 are new in Phase 1b). Detailed results: [`qa-report.md`](qa-report.md). Security changes: [`security-checklist.md`](security-checklist.md).

## What was done

| # | Item | Result |
| --- | --- | --- |
| 0 | Record the CEO approval of the 12 Phase 1 defaults | `docs/decisions-log.md` D-19 to D-30 |
| 1 | Screens for the 19 partly done stories | 15 stories now have tested screens (below). The other 4 stay 🟡 for reasons outside code: Keycloak not run (SYS-05), native Swahili review (SYS-06), counsel review (SUP-14, OPS-12). |
| 2 | Tokens move from browser storage to httpOnly cookies, with CSRF protection, tests first | `mapema_sid` cookie (HttpOnly, Secure, SameSite=Strict, host-only, Path=/). The server keeps only the SHA-256 of the session id. CSRF uses three checks: an HMAC synchroniser token in `X-CSRF-Token`, an Origin allow-list and SameSite=Strict. Sessions expire after 15 min idle or 8 h total. Step-up rotates the id; logout revokes it. Tests TC-SES-01..09 (API) and 5 web tests. No token is written to browser storage. D-31, D-32 |
| 3 | Buyer underpayment shortfall owed to the supplier (D-22), tests first | `supplier_shortfall` table (migration 004). Once Mapema is repaid, the unpaid remainder is tracked as owed by the buyer to the supplier. A later buyer top-up matched by invoice reference is paid through to the supplier and closes the shortfall. A supplier admin can close it as recovered directly or forgiven (reason required). Shown in the supplier, buyer and staff portals. TC-SET-08/09. D-33 |
| 4 | Shared rate limiter | `PgThrottlerStorage`: one UNLOGGED table and one upsert per request (migration 006). `RATE_LIMIT_STORE=postgres` (default) or `memory`. If the database is unavailable it fails open. TC-RL-01..03 prove two API instances share one budget. D-34 |
| 5 | CRD-07 credit review-date reminders | Daily worker job at 07:00 EAT (`review-reminders`). It creates one `credit_task` per item at 30, 7 and 0 days before a programme review date, a buyer or supplier limit review date, or a KYC expiry, and notifies credit. Release checks `PROGRAMME_IN_REVIEW_DATE` and `KYC_CURRENT` refuse new advances once a date passes. "Review tasks" screen for credit. TC-CRD-07a..e. D-35 |
| — | Statements and fee invoices (SUP-10) | **Left blocked on tax advice** (D-24). Payment receipts (BUY-12) are built and say "not a tax invoice". D-36 |

New migrations: 004 `supplier_shortfall`, 005 `web_session`, 006 `rate_limit`, 007 `credit_task` (also sets `kyc_check.expires_at`). New API endpoints:
- `/auth/session` (POST, GET, DELETE)
- `documents` and their content
- `buyer/programme`
- `consents`
- `me/data`
- `admin/users`
- `credit/tasks` (+ done, reminders run)
- shortfall list and close

OpenAPI regenerated: 104 operations, 96 paths, with cookie and CSRF security schemes.

## Story status now (71 Phase 1 stories)

| Story | Phase 1 | Phase 1b | How |
| --- | --- | --- | --- |
| BUY-02 KYB upload | 🟡 | ✅ | Upload screen for the buyer admin (type/size checked client- and server-side) |
| BUY-07 hold / release hold | 🟡 | ✅ | Hold (asks for a reason) and release-hold, with an on-hold list |
| BUY-09 notice of assignment | 🟡 | ✅ | Documents tab; PDF download (audited, org-scoped) |
| BUY-12 receipts | 🟡 | ✅ | Receipt PDF created when a payment is applied; listed and downloadable ("not a tax invoice") |
| BUY-13 limit / utilisation | 🟡 | ✅ | Programme tab: limit, used, available, per-supplier exposure |
| SUP-02 KYC/KYB upload | 🟡 | ✅ | Upload screen on the account page |
| SUP-03 consents | 🟡 | ✅ | Privacy tab: list, withdraw, give again (text shown for each purpose) |
| SUP-06 supplier submits invoice | 🟡 | ✅ | Add-invoice form (buyer list from the supplier's programmes) |
| SUP-13 see my data | 🟡 | ✅ | My-data view (masked IDs, bank last 4, consents, counts) plus correction and deletion requests via DSR |
| CRD-01 buyer credit file | 🟡 | ✅ | Credit file: KYB, CRB pulls, documents, limits, programme |
| CRD-03 programme proposal | 🟡 | ✅ | Proposal form, then CEO four-eyes in approvals |
| CRD-04 supplier credit file | 🟡 | ✅ | Credit file with per-buyer limit |
| ADM-01 staff admin | 🟡 | ✅ | Staff and auditor list; propose invitation (second admin approves) |
| ADM-03 limits + float | 🟡 | ✅ | Forms; each change goes to approvals |
| ADM-07 write-off | 🟡 | ✅ | Write-off screen for recourse and non-performing advances; CEO approves |
| CRD-07 review reminders | ❌ | ✅ | See item 5 |
| OPS-12 DSR | 🟡 | 🟡 | Status-update screen added; **7-day clock still pending counsel** |
| SUP-14 terms explained | 🟡 | 🟡 | Explained in the offer and on a terms screen; **text is a draft for counsel** |
| SYS-05 MFA | 🟡 | 🟡 | Enforced by the API; **Keycloak realm still not run** |
| SYS-06 mobile, accessible, EN/SW | 🟡 | 🟡 | axe WCAG 2 A/AA: 0 serious or critical on all screens visited at 390 px. **Swahili is a draft, and most new-screen labels are English only** |
| SUP-10 statements, fee invoices | ❌ | ❌ | Blocked on tax advice (D-24) |

**Count: 66 ✅, 4 🟡, 1 ❌** of 71 (Phase 1: 50 ✅, 19 🟡, 2 ❌).

## Real numbers (17 Nov 2026, 19:13–19:16 GMT)

| Check | Result |
| --- | --- |
| `npm run build` (5 workspaces incl. Next.js) | ✅ exit 0, 7.4 s |
| `npm run typecheck` | ✅ exit 0, 0 errors, 5.8 s |
| Lint | `npm run lint:openapi` ✅ both files valid, 0 warnings. **There is no ESLint config in the repo** (as in Phase 1); TypeScript `strict` is the code check |
| `npm test` (mock ledger) | ✅ **160 / 160**: pricing 31, adapters 13, API 77 (8 files), worker 2, web 37 (3 files). 13.2 s |
| `npm run test:fineract` (real Fineract 1.16.1) | ✅ **6 / 6**, 3.2 s |
| `npm run test:e2e:fineract` (API on real Fineract) | ✅ **77 / 77**, 16.3 s. The real ledger was confirmed by test titles (`[ledger=real Fineract]`) and by the Fineract loan count rising from 100 to 110 during a re-run of the settlement file |
| `npm audit` (all deps) | ⚠️ **8 high, all dev-only**: picomatch ≤ 4.0.7 ReDoS (GHSA-fc5q-39xc-vjpf), reached through vitest/vite/unplugin-swc. No patched picomatch exists yet (4.0.7 is the latest). `npm audit fix --force` would downgrade vitest to 3.1.4, which brings back Phase 1's critical advisories, so it was not applied |
| `npm audit --omit=dev` (what ships) | ✅ **0 vulnerabilities** |
| Browser smoke `scripts/ui-smoke.mjs`, 390×844, fresh stack | ✅ **42 / 42 checks**; axe WCAG 2 A/AA **0 serious or critical**; no console errors; 7.1 s |
| OpenAPI | 104 operations, 96 paths |

## Remaining items

- **Blocked on others:**
  - tax advice (SUP-10 statements and fee invoices)
  - counsel: shortfall wording (D-22), DSR clock, SUP-14 and the legal texts, the 30/90-day NPL period, APR method
  - native Swahili review, including the new screens' strings
- **Engineering follow-ups:**
  - Backend-for-frontend OIDC code exchange (D-32). Today the PKCE code is exchanged in the browser; the token is kept in memory only and swapped for the cookie at once.
  - Run Keycloak and test MFA end to end (SYS-05).
  - Add ESLint.
  - Re-check `npm audit` once picomatch ships a fix.
  - Monitor the rate-limit table size (expired rows are pruned every 1,000 requests per instance).
- **Needs spend or accounts (approved in D-19 to D-21; not done by us):** staging, pen test, and bank/CRB/KYC/e-sign sandboxes.

## Questions for Deng, with the default we will use if there is no answer

| # | Question | Default |
| --- | --- | --- |
| P1b-1 | How long is a KYC check valid before re-check? | **12 months** (Mapema policy, `KYC_REFRESH_MONTHS`). Not a regulatory figure; **unverified**; compliance/counsel to confirm (D-35) |
| P1b-2 | Move the OIDC code exchange to a server-side BFF before go-live? | **Yes**, before any real user signs in (D-32) |
| P1b-3 | If the shared rate-limit store is down, fail open or closed? | **Fail open** (keep serving; log it). Auth, MFA and four-eyes controls still apply (D-34) |
| P1b-4 | Session lengths | **15 min idle, 8 h total**; step-up for money movements unchanged (D-31) |
| P1b-5 | Shortfall: should Mapema ever help collect from the buyer (e.g. reminders), or is it fully the supplier's job? | **Supplier's job**; we only track and pass through later payments; wording for counsel (D-33) |
| P1b-6 | Should the Swahili translator also cover the Phase 1b screens? | **Yes**, same engagement as D-26 |
| P1b-7 | Accept the dev-only picomatch advisory until a fix ships? | **Yes**: it is not in the shipped code; recheck weekly |
