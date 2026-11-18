# Phase 4 security stories

**[Product Manager + Architect + Compliance]** Written from the CEO-approved proposal (`proposal.md`) and decisions D-73 to D-80 before the build. Tests (`TC-P4-*`, `TC-P4W-*`) were written first.

## P4-1 Registry search before funding, filing after (D-73)

**As** a credit officer **I want** a maker-checker record of a Movable Property Security Rights registry search on each invoice **so that** we do not fund a receivable that already has a competing filing.

Acceptance:

- Staff upload a PDF search certificate from the official portal (`POST /invoices/:id/registry-search`). Result is `clear`, `conflict` or `conflict_waived` (a waived conflict needs a note). A second credit officer approves. The maker cannot approve their own request.
- An advance cannot be approved or released without an approved search that is `clear` or `conflict_waived` (check `REGISTRY_SEARCH`). Missing search or unwaived conflict fails closed.
- After funding, an ops task `registry_filing_due` is opened. Ops upload filing evidence and the registration number (`POST /advances/:id/registry-filing`); a different ops user approves; the number is stored on the advance and the task closes.
- The adapter is mock (PIN starting `P099` → conflict) or a portal-only manual stub. **No invented registry API.**

Tests: TC-P4-REG-01..06, adapter unit tests, TC-P4W-01..03.

## P4-2 Duplicate and similar-invoice controls (D-74)

**As** a buyer or supplier **I want** to be told when an invoice is submitted, and **as** credit **I want** unique eTIMS control-unit numbers and a review flag on similar invoices.

Acceptance:

- `invoice.submitted` is sent to both organisations on every insert (single, CSV, supplier, ERP).
- When an eTIMS CU number is present it is unique (case-insensitive). Conflict → `DUPLICATE_ETIMS_CU`.
- Same supplier PIN + amount + date with a different invoice number is flagged `similar_review` (not a hard block). The existing financed-invoice `NO_DUPLICATE` hard check stays.

Tests: TC-P4-DUP-01..03.

## P4-3 Buyer security pack and anti-fraud notice (D-75)

**As** counsel and the CEO **I want** a draft buyer pack and a public anti-fraud notice **so that** buyers can see how we check invoices, without implying we are licensed.

Acceptance:

- Docs: `buyer-security-and-data-pack.md`, `anti-fraud-notice.md`.
- The notice is also an application page `/legal/anti-fraud`, marked DRAFT, not deployed to the marketing Worker. The wording still says Mapema is **not yet licensed**.

Tests: TC-P4W-03.

## P4-4 Counsel questions (D-76)

**As** Kenyan counsel **I want** the open legal questions in the counsel pack **so that** contracts are not changed on an unconfirmed reading of the studies.

Acceptance: questions I1–I6 added to `docs/go-live/counsel-question-pack.md`. No contract template change in this phase.

Tests: documentation review (compliance-review.md).

## P4-5 Goods-received attestation (D-77)

**As** a buyer checker **I must** attest that goods or services have been received (or give a reason) before I confirm an invoice.

Acceptance:

- Approve requires `goodsReceived` boolean. If false, `goodsReceivedNote` is required. Optional `poReference`. Applies to single and bulk confirmation. Four-eyes still applies first.

Tests: TC-P4-ATT-01..03, TC-P4W-01.

## P4-6 eTIMS unavailable cannot proceed to funding (D-78)

**As** credit **I want** an unavailable eTIMS result to be obvious and to block funding until a documented override.

Acceptance:

- Confirmation of an `unavailable` invoice is allowed; ILU leaves status `ilu_signed` (not eligible). Quote and funding are refused.
- Credit may propose `etims_override`; a second credit officer approves; status becomes `overridden` and `ilu_signed` invoices become `eligible`. The `valid` | `overridden` gate at approve/release stays. Check detail names the block clearly.

Tests: TC-P4-ETIMS-01..02.

## P4-7 Credit insurance (D-79)

Documentation note only. Not a launch blocker. See `credit-insurance.md`.

## P4-8 Government-payer flag; no CRB change (D-80)

**As** credit **I want** a government-payer dependency flag on the buyer credit file **so that** construction or government-dependent programmes are not approved without a comment.

Acceptance:

- Programme propose requires `governmentPayerDependent`. If true, or the sector is `CONS`, a comment is required. The flag is shown on the credit file. Sector caps are unchanged. The CRB file still treats the supplier as the borrower.

Tests: TC-P4-GOV-01..03, TC-P4W-01.
