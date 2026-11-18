# Phase 2 report: scale and reporting

**[Product Manager + Tech Lead]** 18 Nov 2026, finished about 06:00 GMT (London). Repo `/workspace/mapema/app`, branch `phase-2`, local only. Nothing was pushed, deployed or sent, no accounts were created, and no live provider was called. The marketing-site Worker was not touched.

- Stories and acceptance criteria, with Architect and Compliance notes: [`stories.md`](stories.md)
- Test detail: [`qa-report.md`](qa-report.md)
- Security changes: [`security-checklist.md`](security-checklist.md)
- CBK NDTCP Regulations 2026 and DPA 2019 review, with items for Kenyan counsel: [`compliance-review.md`](compliance-review.md)
- Decisions D-37 to D-48: [`../decisions-log.md`](../decisions-log.md)
- Sample outputs from the demo month (October 2026), byte for byte as the system produced them: [`sample-reports/`](sample-reports/)

## "Done when" check

| Criterion | Status | Evidence |
| --- | --- | --- |
| Monthly CBK and lender reports come out of the system with no manual edits | ✅ lender pack · 🟡 CBK return | The demo-month seed runs the `month-end-reports` job on 1 Sep, 1 Oct and 1 Nov 2026 (for August, September and October). With no human step it produces the snapshot, the lender pack (loan-tape CSV, summary CSV, 2-page PDF), the CBK return (CSV and PDF) and the CRB file (CSV). Regenerating from the same snapshot gives byte-identical files (SHA-256 stored and compared, TC-P2-RPT-04). **The CBK return and CRB file use an assumed layout and are watermarked DRAFT** until CBK's official return format and the CRB's submission specification are supplied (Q-A). Swapping in the official format is a template change (maker-checker), not a code change. |
| Reconciliation runs daily with zero unexplained breaks | ✅ | Worker job at 06:30 EAT for the previous day. Demo seed: **109 daily runs (1 Aug to 17 Nov 2026), all `balanced`, 0 breaks of any kind**. Tests inject each kind of break (timing, bank charge, unknown credit, rogue ledger journal, missing payout) and show classification, alerting and maker-checker resolution on the **mock ledger and on real Apache Fineract 1.16.1**. |

## What was built

| # | Scope item | Built | Where |
| --- | --- | --- | --- |
| 1 | PM stories, Architect and Compliance review | 29 stories in 7 epics, each with acceptance criteria, test IDs and status | `stories.md` |
| 2 | Dashboards | **Staff:** outstanding principal, float and headroom; buyer, supplier and sector utilisation against the 25% / 10% / 35% limits, with bars and breach flags; ageing buckets; late, recourse and NPL with values; NPL ratio; collections month to date; latest recon status. **Buyer:** due in 30 days, overdue, programme used, collection account. **Supplier:** advanced, balances still to come, ready to finance, recourse demands, recent payments. Mobile-first: no page-level horizontal scroll at 390 px. Auditors get a read-only copy. | `apps/api/src/modules/dashboards.ts`, `apps/web/components/portals/phase2.tsx` |
| 3 | CBK monthly return and CRB file generators | Built from the month-end snapshot only. JSON template/mapping layer (`report_template`), one active version per report, new versions activated by maker-checker (compliance proposes, CEO approves). Every assumed field is labelled "(assumed)"; every file carries `DRAFT - ASSUMED LAYOUT - ... - DO NOT SUBMIT` while the template is `assumed_draft`. The CRB file leaves out borrowers with no CRB consent on file and lists them as exceptions (D-45). | `apps/api/src/modules/regulatory.ts`, `apps/api/src/reporting/` |
| 4 | Lender pack | Loan-tape CSV, summary CSV and multi-page PDF; no manual edits; reproducible from a given month-end snapshot (snapshot and artefacts are append-only at the database-grant level, with SHA-256 hashes). Restating a month needs a reason and creates version n+1. | same |
| 5 | Daily reconciliation | Bank = Fineract cash = platform, measured as movements since an approved baseline (maker-checker). Itemised by bank reference. Breaks classified **timing / explained / unexplained**; unexplained alerts ops and compliance. Staff screen to explain or close a break (a second ops user approves), with optional carry-forward and an audit trail. Pure classification engine with 8 unit tests. | `apps/api/src/modules/recon-engine.ts`, `reconciliation.ts` |
| 6 | Xero/QuickBooks adapter | `AccountingAdapter` with mock and Xero sandbox modes (QuickBooks would be a second implementation of the same interface). Daily DRAFT manual journal = Fineract trial-balance movement, idempotency key `mapema-je-YYYY-MM-DD`; a second push is a no-op. The first run only captures the opening TB. **Fee-invoice hook is built and called at settlement but disabled** (`fee_invoices_enabled=false`, D-24); it records `skipped_disabled` and sends nothing. | `packages/adapters/src/accounting.ts`, `apps/api/src/modules/integrations.ts` |
| 7 | HubSpot adapter | `CrmAdapter` (mock, HubSpot sandbox) and `LeadSourceAdapter` (mock, Cloudflare D1 query API in sandbox mode, read-only). Hourly import of buyer "book a call" rows with privacy-notice acceptance; suppliers and erasure requests skipped; no marketing opt-in set; each row synced once. Sandbox modes not exercised: no portal or token exists. | `packages/adapters/src/crm.ts`, `leads.ts` |
| 8 | Late-payment automation | Reminders pre-due (7, 1 days), due day, overdue (1, 7, 14 days) to the buyer by SMS and email; supplier warning at day 14. Once per step; a missed day catches up with the latest step only; nothing sent while an invoice is disputed. DPD ladder Late (1) → recourse case due (30) → NPL (30 days for terms up to 30 days, else 90). All periods configurable (maker-checker, CEO approves) and flagged `counselConfirmed: false`. In duplum: charges after NPL capped at principal at NPL, excess waived in the ledger. Recourse to the supplier is now maker-checker (D-41). | `packages/pricing/src/collections.ts`, `apps/api/src/modules/collections.ts` |
| 9 | QA and security | Tests written from the stories before the code (commit `a81b667` red, `3b0a6a9` green), including money to the cent and recon edge cases. QA report, security checklist, compliance review. | this folder |
| 10 | Deliverables | This README; decisions D-37 to D-48; questions table below; OpenAPI regenerated (**128 operations, 116 paths**, Redocly lint clean); `.env.example` updated (no real secrets); demo-month seed (`SEED_DEMO_MONTH=2026-10`); screenshots; zip. | — |

New migration: `008_phase2.sql` (reminder events, recourse cases, in duplum waivers, reconciliation v2 and baseline, report templates/snapshots/artefacts, accounting pushes, fee-invoice hook, CRM sync). New worker jobs: `reconciliation` 06:30, `accounting-push` 06:45, `collections` 08:00, `crm-import` hourly, `month-end-reports` 02:00 on the 1st (all EAT).

## Story status (29 Phase 2 stories)

| Epic | ✅ | 🟡 (needs an outside input) |
| --- | --- | --- |
| REC reconciliation (7) | REC-01..06 | REC-07 real bank statement feed: bank not chosen (Q-B) |
| RPT reports (6) | RPT-01, 04, 05, 06 | RPT-02 CBK official format (Q-A); RPT-03 CRB format and consent question (Q-A, Q-C) |
| COL collections (5) | COL-01, 03, 04, 05 | COL-02 NPL/recourse periods: counsel (Q-D) |
| DSH dashboards (4) | DSH-01..04 | — |
| ACC accounting (2) | — | ACC-01 Xero org and account codes (Q-E); ACC-02 fee invoices blocked on tax advice (D-24) |
| CRM (2) | CRM-02 | CRM-01 HubSpot portal and D1 token (Q-F) |
| QA / SEC / CMP (3) | all 3 | — |

**Count: 22 ✅, 7 🟡, 0 ❌.** Every 🟡 is built and tested in mock mode; what is missing is a format, an account or a legal view, not code.

## Real numbers (18 Nov 2026, 05:56 GMT)

| Suite | Result | Phase 1b baseline |
| --- | --- | --- |
| `@mapema/pricing` | ✅ **41 / 41** | 31 |
| `@mapema/adapters` (mocks) | ✅ **23 / 23** | 13 |
| `@mapema/api` (mock ledger) | ✅ **110 / 110**, 12.0 s | 77 |
| `@mapema/worker` | ✅ **3 / 3** | 2 |
| `@mapema/web` | ✅ **62 / 62** | 37 |
| `npm run test:fineract` (adapter on real Fineract 1.16.1) | ✅ **6 / 6** | 6 |
| `npm run test:e2e:fineract` (API on real Fineract) | ✅ **109 passed, 1 skipped**, 18.7 s. The skip is TC-P2-COL-04 (in duplum) which needs the mock ledger's post-maturity-interest hook; the cap's maths is also covered by TC-P2U-COL-05 | 77 / 77 |
| Browser check `scripts/phase2-shots.mjs` (demo month, 390 px and 1440 px) | ✅ **18 / 18**; axe WCAG 2 A/AA: **0** serious or critical; 0 console errors | — |
| OpenAPI | 128 operations, 116 paths; `redocly lint` valid | 104 / 96 |
| `npm audit --omit=dev` | 0 vulnerabilities | 0 |

Total **239** tests on the mock stack (79 new) and 115 on real Fineract.

## Demo month

```
ENV_FILE=/path/to/env SEED_DEMO_MONTH=2026-10 scripts/smoke-stack.sh   # fresh DB, API, seed, web
NODE_PATH=... SHOTS_DIR=/workspace/mapema/phase-2-shots node scripts/phase2-shots.mjs
```

The seed drives the API on the dev business clock from 1 Aug 2026 to today and then hands the clock back to real time. It funds the worked example W (paid on its due date: 800,000 / 44,800 / 2,500 / 847,300 / 152,700), E (KES 300,000, paid in October), B (KES 500,000, late, then recourse to the supplier approved by a second credit user in October), C (KES 100,000, NPL in September) and D (KES 2,000,000, current). Every day it runs collections (20 reminders sent in total), reconciliation, the accounting push (1 opening capture, 2 journals pushed on the days money moved, 106 no-ops) and the CRM import, and on the 1st the month-end reports. October 2026 result: 3 loans outstanding, KES 2,080,000 principal, NPL ratio 3.85%, 31 recon runs with 0 unexplained breaks. Files in `sample-reports/`.

## Screenshots

`/workspace/mapema/phase-2-shots/`:
- `staff-dashboard-390.png`, `staff-dashboard-desktop.png`
- `staff-reconciliation-390.png` / `-desktop.png`, `staff-collections-390.png` / `-desktop.png`, `staff-reports-390.png` / `-desktop.png`
- `buyer-dashboard-390.png`, `supplier-dashboard-390.png`

The footer in a non-production environment now says "DEMO ENVIRONMENT - test data only (fictitious licence reference ...). Mapema is not yet licensed..." even when the demo lending switch holds a licence number (D-42), so no screenshot claims a licence.

## Questions for Deng

Each has a recommended default; the build already follows it, so nothing waits on an answer except the item named.

| # | Question | Recommended default | Unblocks |
| --- | --- | --- | --- |
| Q-A | Please obtain CBK's official NDTCP monthly return template (or e-portal schema) and the chosen CRB's data-submission specification. | Ask CBK's licensing contact during the application, and Metropol or TransUnion (D-21) for their data specification. Until then, outputs stay DRAFT and are not submitted. | RPT-02, RPT-03 go ✅ (template swap, maker-checker) |
| Q-B | Which partner bank, and does it offer a statement API (or MT940/CAMT.053 files)? | Whichever of Stanbic, NCBA or KCB first offers virtual accounts **and** a daily statement feed (D-21). | REC-07 |
| Q-C | Must CRB submission include borrowers who have not consented, given the CRB Regulations? | Leave them out and list them as exceptions until counsel answers (current behaviour, D-45). | RPT-03 |
| Q-D | Confirm the 30-day recourse trigger, the 30/90-day NPL periods and our in duplum reading with counsel, and put them in the master agreement. | Keep the defaults; counsel to confirm (D-28, D-43, D-44). | COL-02 |
| Q-E | Xero or QuickBooks, and who provides the chart-of-accounts mapping? | Xero; the external accountant maps Mapema's GL codes via `ACCOUNTING_GL_MAP`. Deng creates the Xero org and app; we never hold his login. | ACC-01 |
| Q-F | HubSpot portal and buyer pipeline, plus a read-only Cloudflare API token for the site's D1 database. | HubSpot free CRM with one "Buyer" pipeline; a D1-read-only token created by Deng and stored as a secret, never in the repo. | CRM-01 |
| Q-G | Should the recon timing window skip Kenyan public holidays as well as weekends? | Yes: ops maintains a holiday list in settings (not built yet; weekends only today, D-39). | fewer false "unexplained" breaks after holidays |
| Q-H | Who receives the lender pack, and do they need their own template? | Use the v1 Mapema format until a lender sends theirs; it is a new template version, not code. | — |
| Q-I | Counsel and translator review of the reminder and recourse texts (English and Swahili). | Factual wording, sent 08:00 EAT only; native-speaker review as in D-26. | go-live of reminders |
| Q-J | Tax advice on fee invoices (D-24) still outstanding. | Keep the hook disabled. | ACC-02 |

## Not done or left for later

- Live submission to CBK or a CRB (no access; DRAFT only).
- Real bank statement feeds, Xero, HubSpot and D1 calls in sandbox mode (no accounts; the sandbox adapters are unit-tested with an injected `fetch`, so no network call is ever made).
- Matching supplier repayments to recourse demands automatically (manual match with maker-checker, as in Phase 1).
- Public-holiday calendar for recon timing (Q-G).
- Staff-editable reminder templates (they are reviewed i18n files).
- Encryption of stored report artefacts at the application level (security finding S-09).
- Swahili strings for the new staff screens (English only; buyer and supplier dashboards use plain English labels pending translation).
