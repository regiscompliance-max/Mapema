# Phase 2 — Scale and reporting: user stories

**Product Manager.** Reviewed by the **Architect** and by the **Compliance & Risk Analyst** (their notes follow each epic).

- **Done when:** the monthly CBK and lender reports come out of the system with no manual edits, and reconciliation runs every day with zero unexplained breaks.
- **Non-negotiables still hold:**
  - KES only, as integer cents.
  - Allocation order is principal, then fees, then interest.
  - Maker-checker on limits, pricing, payouts and roles, and now also on collections policy, recourse, reconciliation baselines and break resolution, and report templates.
  - Fineract stays the ledger.
  - Every provider sits behind an adapter with mock and sandbox modes.
  - The audit log is append-only.
  - MFA is required.
  - Screens are mobile-first and ready for Swahili.
  - Tests are written first.
  - The worked example (800,000 / 44,800 / 2,500 / 847,300 / 152,700) still holds.
- **Test IDs:** `TC-P2-*` (API e2e), `TC-P2U-*` (unit) and `TC-P2W-*` (web).

**Status key:** ✅ built and tested · 🟡 built, but needs an external input before go-live · ❌ not built this phase.

## Epic REC: daily reconciliation

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| REC-01 | As **ops**, I want reconciliation to run on its own every day, so cash is proven without anyone remembering to run it. | 1. Worker job `reconciliation` runs at 06:30 EAT for the previous day. 2. It compares bank balance = Fineract cash GL = platform records. 3. Rerunning the same date updates that run; breaks are never duplicated (unique by run + item key). 4. Every run is audited. | TC-P2-REC-01, TC-P2-REC-06 | ✅ |
| REC-02 | As **ops**, I want each break classified as timing, explained or unexplained, so I only chase what matters. | 1. Itemised matching of bank statement lines against platform movements by bank reference. 2. **Timing:** a bank credit on the as-of day not yet ingested, a payout released on the as-of day or one business day before and not yet on the statement, or a ledger posting still pending or retrying in the outbox. 3. **Explained:** a bank charge or interest line (statement type `charge`/`interest`), or an item whose earlier break was resolved as "explained" and carried forward by approval. 4. **Unexplained:** amount mismatches, unknown bank items, missing bank items older than the timing window, dead ledger postings, and any residual left after itemised classification. 5. The classified amounts always add up to the headline differences; any remainder becomes an `unexplained residual`. | TC-P2U-REC-01..08 | ✅ |
| REC-03 | As **compliance**, I want an alert on every unexplained break, so the daily recon obligation is visible. | 1. Any unexplained break notifies ops **and** compliance (in-app, SMS and email). 2. A run with only timing or explained breaks raises no alert and gets status `explained`. 3. A run with zero breaks gets status `balanced`. | TC-P2-REC-02 | ✅ |
| REC-04 | As **ops**, I want a screen to resolve breaks, with maker-checker sign-off and an audit trail. | 1. Ops proposes a resolution (`explained` with a note and an optional carry-forward, or `closed` with a note). 2. A **different** ops user approves (four-eyes and step-up). 3. The maker cannot approve their own resolution. 4. Every proposal and approval is in the audit chain. 5. The screen lists runs and breaks with classification, category, amount and age, and works at 390 px. | TC-P2-REC-03, TC-P2W-01 | ✅ |
| REC-05 | As **ops**, I want an opening balance baseline set by maker-checker, so a shared or migrated Fineract tenant reconciles by movement. | 1. `POST /reconciliation/baseline` proposes the bank, Fineract and platform openings. 2. It takes effect after approval by a second ops user. 3. The engine compares (balance − baseline). | TC-P2-REC-04 (mock), TC-P2-REC-05 (real Fineract) | ✅ |
| REC-06 | As **QA**, I want recon proven against real Fineract and the mock ledger. | The worked example plus an injected unknown Fineract journal produce: balanced → an unexplained break raised → resolved by maker-checker, on both ledgers. | TC-P2-REC-05 | ✅ |
| REC-07 | As **ops**, I want real bank statement feeds. | The bank adapter has `getStatement()`. The partner bank is not chosen yet, so sandbox/live fail fast with `PROVIDER_NOT_CONFIGURED`. | TC-P2U-ADP-01 | 🟡 bank not chosen (Q-B) |

> **Architect:**
> - Classification is a **pure function** (`apps/api/src/modules/recon-engine.ts`), so every edge case is unit-tested without a database.
> - The service only gathers inputs: the statement, platform movements, outbox state, the baseline and earlier resolutions.
> - Break identity is `item_key`, so reruns are idempotent.
> - Fineract is not date-filtered by `glBalance`. The run reads the balance at run time, and the recon job runs at 06:30 for the prior day before business hours, so the statement window and the ledger read line up. This is noted as an assumption (D-39).
>
> **Compliance:**
> - Alerting compliance as well as ops on unexplained breaks matches the brief ("Daily recon alerts").
> - The resolution note and approver are retained in the audit chain for the 7-year retention period.

## Epic RPT: CBK return, CRB file, lender pack

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| RPT-01 | As **compliance**, I want a month-end snapshot built only from system data, so every report for a month comes from one frozen data set. | 1. `POST /reports/snapshots {period:'YYYY-MM'}` builds per-advance as-of balances. These come from allocations received on or before the month end, and from due dates (DPD, bucket and status at month end). Aggregates cover portfolio, flows in the month, income, ageing, concentration against the limits, collections, NPL, recourse, write-offs, complaints, float and recon. 2. The snapshot is stored append-only (no UPDATE/DELETE grant) with the SHA-256 of its canonical JSON. 3. Asking again for the same month returns the **same** snapshot. A restatement needs a reason and makes version n+1, which is audited. | TC-P2-RPT-01 | ✅ |
| RPT-02 | As **compliance**, I want the monthly CBK return generated through a configurable template layer and marked DRAFT until CBK supplies the official format. | 1. The template is a JSON mapping (field code → snapshot path → format) stored in `report_template` with status `assumed_draft` or `official`. 2. While the active template is `assumed_draft`, every output carries `DRAFT – ASSUMED LAYOUT – NOT AN OFFICIAL CBK FORMAT`. 3. No official field definitions are invented: each field label says "assumed". 4. A new template is activated only by maker-checker (`report_template_activate`, compliance proposes, the CEO approves). 5. CSV and PDF are produced. | TC-P2-RPT-02, TC-P2-RPT-05 | 🟡 official CBK format needed (Q-A) |
| RPT-03 | As **compliance**, I want the monthly CRB data-submission file generated from system data through a mapping layer, marked DRAFT. | 1. One record per borrower facility (advance) active in the month. 2. Columns come from the template mapping, which is assumed and labelled. 3. Borrowers without a `crb_enquiry_and_reporting` consent on file are listed in an exceptions section and left out by default (`CRB_SUBMISSION_REQUIRE_CONSENT=true`), pending counsel. 4. National IDs and PINs are only in the file, never in logs. 5. Downloads are audited. | TC-P2-RPT-03 | 🟡 CRB format and counsel (Q-A, Q-C) |
| RPT-04 | As **the CEO**, I want a monthly lender pack (CSV and PDF) with no manual edits, reproducible for a month-end snapshot. | 1. The CSV loan tape plus a summary CSV and a multi-page PDF (portfolio, ageing, concentration against the 25/10/35 limits, collections, NPL and recourse, income, reconciliation for the month). 2. Regenerating from the same snapshot gives byte-identical files (the SHA-256 is stored and compared; no wall-clock timestamps; the "generated" stamp is the snapshot's). 3. The worked-example numbers appear exactly. | TC-P2-RPT-04 | ✅ |
| RPT-05 | As **ops**, I want month-end reports produced automatically. | The worker job `month-end-reports` runs on the 1st at 02:00 EAT for the previous month (snapshot plus all three reports). | TC-P2-WRK-01 | ✅ |
| RPT-06 | As **an auditor**, I want to read snapshots and reports, read-only. | The auditor role can list and download; it cannot create or restate. | TC-P2-RPT-06 | ✅ |

> **Architect:**
> - Generators are pure functions of (snapshot, template). PDFs are hand-built, so there is no timestamp, font embedding or randomness.
> - The SHA-256 of each artefact is stored in `report_artifact`, so "reproducible" is checkable by anyone.
> - Snapshot amounts are strings of integer cents.
>
> **Compliance:**
> - Neither the CBK nor the CRB formats are public in a form we can rely on. We **must not** submit DRAFT files.
> - Needed from Deng: the CBK NDTCP monthly return template or e-portal schema, the licensed CRB's data-submission specification (e.g. the CRB's "Data Specification" document under the CRB Regulations 2020), and counsel's view on the consent-versus-mandatory-submission question.

## Epic COL: late-payment automation

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| COL-01 | As **ops**, I want reminders sent automatically before, on and after the due date by SMS and email through the existing adapters. | 1. The schedule comes from the `collections_policy` setting: pre-due 7 and 1 days before, the due day, and overdue days 1, 7 and 14 (the buyer's AP gets SMS and email). The supplier is told at overdue day 14 that recourse may follow, and again when recourse is approved. 2. Each (advance, step) is sent once: a unique `reminder_event`, so reruns don't resend. 3. Nothing is sent for settled, written-off or disputed invoices. 4. English and Swahili templates exist. 5. A missed day catches up with only the latest due step, so there is no burst of stale messages. | TC-P2-COL-01, TC-P2-COL-02 | ✅ |
| COL-02 | As **credit**, I want DPD status to move Late → Recourse → NPL, with configurable periods still flagged for counsel. | 1. DPD ≥ 1 → `late`. 2. DPD ≥ `recourseAfterDays` (default 30) → a `recourse_case` opens (status `due`) and credit gets a task. 3. DPD ≥ the NPL days (default 30 if the term is ≤ 30 days, otherwise 90) → `non_performing`, whatever the recourse state. 4. Policy changes are maker-checker (`collections_policy_change`: credit proposes, the CEO approves). 5. Every move is audited. | TC-P2U-COL-01..04, TC-P2-COL-03 | 🟡 counsel to confirm periods (Q-D) |
| COL-03 | As **compliance**, I want interest and charges capped under the NPL in duplum rule. | 1. At NPL the system snapshots the principal outstanding and the interest + fees + penalties charged. 2. Each day, charges added since NPL are capped at the principal at NPL. Any excess is waived in the ledger (`waiveInterest`) and recorded with an audit event. 3. The cap never reduces principal. 4. Allocation order is unchanged. | TC-P2U-COL-05, TC-P2-COL-04 | ✅ |
| COL-04 | As **credit**, I want a recourse-to-supplier workflow with maker-checker. | 1. Credit proposes recourse on a `due` case (reason, step-up). 2. A **different** credit user or the CEO approves. 3. On approval: the advance becomes `recourse`, the case becomes `demanded` with the amount demanded (the payoff from the ledger), and the supplier gets SMS and email. 4. The case closes automatically when the advance settles (`closed_repaid`) or is written off. 5. The old direct `POST /advances/:id/recourse` now creates the proposal (D-41). | TC-P2-COL-05, TC-OPS-01 (updated) | ✅ |
| COL-05 | As **ops**, I want a collections screen with the late book by DPD, reminders sent, and recourse cases. | It lists DPD, bucket, status, last reminder and case state, and offers the propose and approve actions. It works at 390 px. | TC-P2W-02 | ✅ |

> **Architect:**
> - DPD maths lives in `@mapema/pricing` (`collections.ts`), pure and BigInt.
> - The daily job is idempotent through unique keys.
> - Waivers go through the ledger adapter: Fineract's `waiveinterest` command, and an equivalent in MockLedger.
>
> **Compliance:**
> - The NDTCP Regulations 2026 NPL definition and the in duplum application are taken from law-firm commentary (C-07), and counsel must confirm them (Q-D).
> - Reminder texts must not threaten or shame (fair-collection rules): the templates are factual.
> - Contact times are restricted to 08:00–18:00 EAT (the job runs at 08:00).
> - Supplier recourse depends on the master agreement's recourse clause (counsel).

## Epic DSH: dashboards

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| DSH-01 | As **staff**, I want a portfolio dashboard. | Shows outstanding principal, count, float and headroom; utilisation of each buyer against the 25% limit, each supplier against 10% and each sector against 35% (used, cap, %, breach flag); ageing/DPD buckets; late, recourse and NPL counts and values; NPL ratio; collections month to date; and the latest recon status. All as cents strings. | TC-P2-DSH-01 | ✅ |
| DSH-02 | As **a buyer**, I want a mobile-first dashboard of what I owe and when. | Shows payments due in the next 30 days, overdue amounts, invoices by status, programme utilisation, and the collection account. Scoped to my organisation only. | TC-P2-DSH-02 | ✅ |
| DSH-03 | As **a supplier**, I want a mobile-first dashboard of my money. | Shows funded outstanding, balances still to come, recent payouts, open recourse demands, and invoices that can be financed. Scoped to my organisation only. | TC-P2-DSH-03 | ✅ |
| DSH-04 | As **staff**, I want the staff dashboard usable on a phone. | Usable at 390 px with no horizontal scroll on the cards; tables scroll inside their container. | TC-P2W-03, screenshots | ✅ |

## Epic ACC: accounting sync

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| ACC-01 | As **finance**, I want daily journals pushed to Xero idempotently. | 1. The daily job takes the Fineract trial balance movement for the day (today's TB − the last pushed TB), maps GL keys to accounting codes (config, assumed), and pushes one balanced manual journal with idempotency key `mapema-je-YYYY-MM-DD`. 2. A repeat push is a no-op (the same provider ref). 3. Unbalanced or unmapped → no push, error recorded, ops alerted. 4. Adapter modes: mock and sandbox (Xero; not exercised, no credentials). | TC-P2U-ADP-02, TC-P2-ACC-01 | 🟡 Xero org and account codes (Q-E) |
| ACC-02 | As **the CEO**, I want fee invoices kept off until tax advice lands (D-24). | The hook `issueFeeInvoice` exists and is called at settlement. While the setting `fee_invoices_enabled=false` (the default), it records `skipped_disabled` and sends nothing. It is documented. | TC-P2-ACC-02 | 🟡 blocked on tax advice (D-24) |

## Epic CRM: HubSpot leads

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| CRM-01 | As **sales**, I want buyer "book a call" leads from the site's D1 database to land in the HubSpot pipeline. | 1. A lead-source adapter reads the site's `call_requests` (mock fixture; the sandbox reads the D1 HTTP API with a token env var, and is never called in this phase). 2. Only `role=buyer` rows with a recorded privacy-notice acceptance go into the buyer pipeline. Others are recorded as `skipped` with a reason. 3. Contact and deal are created through the CRM adapter (mock; the HubSpot sandbox is not exercised). 4. Each source row is synced once (unique `source_id`). 5. No marketing subscription is set: the lawful basis recorded is "request to be contacted" (the purpose shown on the form). | TC-P2U-ADP-03, TC-P2-CRM-01 | 🟡 HubSpot portal and D1 token (Q-F) |
| CRM-02 | As **compliance**, I want CRM sync to respect erasure. | A lead with a completed deletion request is not synced, and an already-synced lead is flagged for manual deletion in HubSpot (task). | TC-P2-CRM-02 | ✅ |

## Epic QA and security

| ID | Story | Status |
|---|---|---|
| QA-01 | Tests come from these criteria before code, including money flows to the cent and recon edge cases (see qa-report.md). | ✅ |
| SEC-01 | Security checklist for the Phase 2 surface: report access, PII in CRB files, CRM data sharing, adapter secrets (security-checklist.md). | ✅ |
| CMP-01 | Compliance review against the CBK NDTCP Regulations 2026 and the DPA 2019 (compliance-review.md). | ✅ |

## Not in this phase (❌)
- Live submission to CBK or a CRB (no portal access; DRAFT only).
- Supplier repayment matching for recourse demands. Supplier payments are matched by the existing manual-match maker-checker, as in Phase 1.
- Staff-configurable reminder templates (templates are code-reviewed i18n files).
