# Phase 3 — Growth: user stories

**[Product Manager]** 18 Nov 2026. Reviewed by the **Architect** and the **Compliance & Risk Analyst** (notes after each epic).

- **Done when (brief):** the first buyer submits invoices automatically from its ERP, and advances can be tagged to a funding source.
- **Non-negotiables still hold:** KES only, integer cents · allocation principal → fees → interest · maker-checker on limits, pricing, payouts, roles (and now ERP mappings, funding sources, re-tags, payout batches, the M-Pesa cap) · Fineract is the ledger · every provider behind an adapter with mock and sandbox modes · append-only audit · MFA · mobile-first, Swahili-ready · tests first · worked example 800,000 / 44,800 / 2,500 / 847,300 / 152,700.
- **Test IDs:** `TC-P3-*` API e2e, `TC-P3U-*` unit, `TC-P3W-*` web.
- **Status key:** ✅ built and tested · 🟡 built, needs an outside input before go-live · ❌ not built this phase.

## Epic ERP: buyer ERP connectors

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| ERP-01 | As **ops**, I want one ERP adapter interface so any buyer ERP plugs in the same way. | 1. `ErpConnector.fetchApproved(cursor, limit)` returns raw records plus the next cursor; `health()`. 2. Kinds: `odoo`, `csv_sftp`, `sap`, `sage`, `dynamics`. 3. `ADAPTER_MODE_ERP=mock` uses an in-memory fixture per connection; `sandbox` calls the configured endpoint (Odoo JSON-RPC, SAP/Sage/Dynamics REST) or reads the drop folder (CSV). 4. Credentials come from an env var named on the connection, never stored in the database. | TC-P3U-ERP-01..06 | ✅ |
| ERP-02 | As **a buyer**, I want approved invoices pulled from my Odoo automatically. | 1. Vendor bills (`account.move`, `move_type=in_invoice`) that are posted (or match the mapping's approval filter) and changed since the cursor are read over JSON-RPC (`common.authenticate`, `object.execute_kw search_read`), ordered by `write_date, id`. 2. Supplier VAT/KRA PIN read from `res.partner`. 3. Proven end to end against a local fake Odoo HTTP server. | TC-P3-ERP-01 | ✅ (🟡 real Odoo instance: Q-K) |
| ERP-03 | As **a buyer without an API**, I want to drop a CSV file by SFTP. | 1. Files in `<ERP_DROP_ROOT>/<connection>/incoming/*.csv` are read, header-mapped, and moved to `processed/` (or `rejected/` if unreadable) named with their SHA-256. 2. The same file dropped twice is skipped. 3. The SFTP server itself is infrastructure (OpenSSH chroot, key-only) and is not part of the app. | TC-P3-ERP-02 | ✅ (🟡 SFTP host: Q-L) |
| ERP-04 | As **compliance**, I want ERP invoices to pass exactly the same checks as uploads. | 1. Each mapped record goes through the shared `insertOne`: minimum amount, tenor, supplier linked, **duplicate hash** and PIN+number block, **eTIMS validation**. 2. Invoices land as `awaiting_confirmation`, uploaded by the connection's integration user; a human buyer checker must still approve and sign the **ILU** (four-eyes holds because the uploader is the integration user). 3. KES only: other currencies rejected. | TC-P3-ERP-01, TC-P3-ERP-03 | ✅ |
| ERP-05 | As **ops**, I want imports idempotent with clear errors. | 1. One `erp_import_item` per (connection, external id); a rerun skips items already created or rejected as duplicates. 2. A record changed in the ERP after import is flagged `changed_after_import` (never silently updated). 3. Errors are mapped: `ERP_AUTH_FAILED` (connection paused after 3), `ERP_UNAVAILABLE` / timeout (retry next run, cursor not advanced), `MAPPING_ERROR` (per record), domain codes (`DUPLICATE_INVOICE`, `SUPPLIER_NOT_LINKED`, `TENOR_OUT_OF_RANGE`, `CURRENCY_NOT_KES`…). 4. Each run is recorded with counts and audited. | TC-P3-ERP-03, TC-P3-ERP-04 | ✅ |
| ERP-06 | As **ops**, I want a per-buyer field mapping with maker-checker. | 1. Mapping = JSON (field → source path + transform: `trim`, `upper`, `date`, `decimal_to_cents`, `cents`, `const`) plus an approval filter. 2. A change (proposed by the buyer admin or ops) only applies after a **different ops user** approves (`erp_mapping_change`). 3. Imports always use the active version, recorded on each item. | TC-P3U-ERP-02, TC-P3-ERP-05 | ✅ |
| ERP-07 | As **a buyer using SAP, Sage or Dynamics**, I want the same pull. | Connectors built against the vendors' documented REST/OData shapes (SAP S/4HANA `API_SUPPLIERINVOICE_PROCESS_SRV`, Sage Business Cloud Accounting `purchase_invoices`, Dynamics 365 Business Central `purchaseInvoices`), unit-tested with an injected `fetch`; mock-backed in e2e. **Field names, approval states and auth flows are assumptions** until tested on a real tenant. | TC-P3U-ERP-04..06 | 🟡 real tenants (Q-K) |
| ERP-08 | As **ops**, I want imports scheduled. | Worker job `erp-import` every 15 minutes for active connections; manual "run now" for ops. | TC-P3-WRK-01 | ✅ |

> **Architect:** Connectors are stateless per connection; the platform owns the cursor and the item ledger, so connectors never decide idempotency. Mapping is a pure function (`mapErpRecord`) unit-tested without HTTP. The Odoo connector uses JSON-RPC (the same service model as XML-RPC). No ERP write-back in this phase.
>
> **Compliance:** Pulling invoices is processing of the buyer's and suppliers' data: the buyer agreement must authorise it, and only the mapped fields are stored (raw ERP payloads are not kept, only the external id and version). Credentials stay in the secret store. ERP data sharing needs a clause in the programme agreement (counsel).

## Epic FUND: multi-lender funding tags

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| FUND-01 | As **the CEO**, I want funding sources (equity, debt facility A…) set up under maker-checker. | 1. Source: code, name, type (`equity`, `debt_facility`, `other`), commitment limit (cents, optional), priority, active, eligibility rules, covenants. 2. Create/change proposed by admin or credit, approved by the CEO (`funding_source_change`). | TC-P3-FUND-01 | ✅ |
| FUND-02 | As **credit**, I want eligibility rules per source. | Pure rules: buyer allow-list, sector allow/deny list, max tenor days, min/max advance, eTIMS valid. Results give every failed reason. | TC-P3U-FUND-01 | ✅ |
| FUND-03 | As **ops**, I want each advance tagged to one source at approval or release. | 1. Credit may name a source at approval; at release the system validates it (eligibility, facility headroom, hard covenants pro forma) or auto-picks the first eligible source by priority. 2. Check `FUNDING_SOURCE` joins the release checks; if no sources are configured the check passes as "untagged" (backwards compatible). 3. Tag recorded on the advance with history. | TC-P3-FUND-02 | ✅ |
| FUND-04 | As **finance**, I want the tag consistent in Fineract. | 1. Each source maps to a Fineract **fund** (created on demand); loans are booked with `fundId`. 2. Because Fineract does not allow changing `fundId` on an active loan (verified on 1.16.1), the **current** tag is kept in a loan datatable `mapema_funding_tag`, updated on re-tag. 3. A consistency check lists any advance whose platform tag differs from Fineract. | TC-P3U-FUND-03 (real Fineract), TC-P3-FUND-03 | ✅ |
| FUND-05 | As **the CEO**, I want re-tagging under maker-checker. | Proposed by credit or ops with a reason; approved by the CEO (`funding_retag`); target must be eligible with headroom; history and audit kept; Fineract datatable updated after commit. | TC-P3-FUND-03 | ✅ |
| FUND-06 | As **a funder**, I want utilisation and covenant checks per facility. | Outstanding principal, limit, headroom, used %; covenants (max single-buyer concentration of the facility, max NPL ratio, max 30+ DPD ratio) with actual vs limit; a breached covenant blocks new tags to that source and shows on the funding screen. | TC-P3U-FUND-02, TC-P3-FUND-04 | ✅ |
| FUND-07 | As **a funder**, I want my own lender pack. | `generate {kind:'lender_pack', fundingSource}` filters the month-end snapshot to loans tagged to that source at month end (tag history), recomputes the loan-level summary (portfolio, ageing, NPL, flows) and names the source in the file names and PDF title; reproducible byte for byte. Platform-wide lines (float, concentration vs float, complaints) stay platform-wide. A facility utilisation/covenant section inside the pack is **not** built yet (shown on the Funding screen instead). | TC-P3-FUND-05 | ✅ (pack covenant section ❌) |

> **Architect:** Eligibility, utilisation and covenants are pure BigInt functions in `@mapema/pricing` (`funding.ts`). Fineract fund = funder at disbursement (immutable); datatable = current funder.
>
> **Compliance:** Debt facilities bring borrowing covenants and reporting duties; whether lender reporting shares borrower data (loan tape names) needs the facility agreement and the privacy notice to allow it (counsel). Under the NDTCP Regulations, borrowings count toward the KES 20m licence threshold (C-01).

## Epic MPESA: M-Pesa B2C payouts

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| MP-01 | As **ops**, I want small supplier payouts sent by M-Pesa B2C. | 1. `MpesaAdapter` (mock, Daraja sandbox): OAuth client credentials, `POST /mpesa/b2c/v3/paymentrequest` (`BusinessPayment`), transaction status query; balance and statement in mock mode only (Daraja's balance query is asynchronous and has no statement API, so sandbox reconciliation falls back to the bank side - Q-M). 2. Rail chosen at approval: M-Pesa if the supplier has a **verified** M-Pesa number (same call-back verification as bank accounts), the amount is ≤ the cap and in whole shillings; otherwise bank. | TC-P3U-MP-01..03, TC-P3-MP-01 | ✅ (🟡 Daraja account: Q-M) |
| MP-02 | As **the CEO**, I want a configurable cap. | Setting `mpesa_payout_cap_cents` (default KES 150,000), changed only through maker-checker (`mpesa_cap_change`, CEO approves). Safaricom's own per-transaction limit still applies. | TC-P3-MP-02 | ✅ |
| MP-03 | As **compliance**, I want the same controls as bank payouts. | Credit approves, a different ops user releases with step-up; all release checks (incl. concentration limits and funding source) run at release. | TC-P3-MP-01 | ✅ |
| MP-04 | As **ops**, I want callbacks and timeouts handled. | 1. Result callback (`/webhooks/mpesa/b2c/result/:token`) success → payout confirmed with the M-Pesa receipt; failure → ledger disbursal undone, advance `release_failed`, supplier told. 2. Timeout callback or no result within `MPESA_RESULT_TIMEOUT_MINUTES` → status query; still unknown → `unknown` for ops, **never auto-resent**. 3. Duplicate callbacks are ignored. 4. Receiver name returned by M-Pesa is compared with the supplier; a mismatch raises an AML flag. | TC-P3-MP-03, TC-P3-MP-04 | ✅ |
| MP-05 | As **ops**, I want M-Pesa in the daily reconciliation. | The M-Pesa working account balance and statement are added to the bank side; payouts match by receipt; pending ones are timing for one business day, then unexplained; B2C charges are explained. | TC-P3-MP-05 | ✅ |

> **Compliance:** Paying suppliers by M-Pesa makes Safaricom a payment channel: CBK approval of channels and AML (receiver-name check, KYC of the wallet holder as a director/authorised person of the supplier) need counsel. Sending to a personal wallet of a company supplier is a risk: only wallets verified by call-back to a director are allowed.

## Epic BULK: bulk tools

| ID | Story | Acceptance criteria | Tests | Status |
|---|---|---|---|---|
| BULK-01 | As **a buyer**, I want bulk upload and bulk confirmation. | CSV upload (up to 500, per-line results, existing) plus `POST /invoices/bulk-decision` (up to 200; per-item result; four-eyes per item) and one ILU for many (existing, ≤ 200). | TC-P3-BULK-01 | ✅ |
| BULK-02 | As **a supplier**, I want bulk advance requests and offers. | `POST /invoices/bulk-quote` (≤ 50) returns a disclosure per eligible invoice and an error per other; accepting several disclosures at once uses the existing accept. | TC-P3-BULK-02 | ✅ |
| BULK-03 | As **ops**, I want payout batches with batch- and item-level maker-checker. | 1. Ops creates a batch of approved advances (≤ 100). 2. A **different** ops user (step-up) approves the batch and may reject single items with a reason. 3. Release runs item by item with all release checks (concentration limits re-checked per item, so exposure accumulates), and a failure of one item does not stop the others. 4. Batch ends `completed`, `partially_failed` or `failed`; every item decision and result is audited. | TC-P3-BULK-03 | ✅ |

## Epic QA and security

| ID | Story | Status |
|---|---|---|
| QA-03 | Tests first, incl. money to the cent, batch partial failures, M-Pesa timeouts (qa-report.md). | ✅ |
| SEC-03 | Security checklist for ERP credentials, callbacks, batches, funding data (security-checklist.md). | ✅ |
| CMP-03 | Compliance review: CBK NDTCP Regs 2026, DPA (compliance-review.md). | ✅ |

## Not in this phase (❌)
- Remote SFTP pull (the app reads a drop folder served by an SFTP host).
- ERP write-back (marking bills as financed in the ERP).
- Lender-user portal scoped to one funder (packs are generated by staff).
- A facility utilisation / covenant section inside the per-funder lender pack (on the Funding screen only).
- Treasury transfers between the bank account and the M-Pesa working account (recorded as funding movements for now).
