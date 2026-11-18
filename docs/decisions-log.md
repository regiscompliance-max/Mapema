# Decisions log (Phase 1 onwards)

Phase 0 decisions D-01 to D-18 are in `phase-0/README.md` (delivered in `mapema-phase-0.zip`).

### Phase 1 defaults approved (17 Nov 2026)

**[Product Manager]** Recorded 17 Nov 2026, 18:48 GMT (London) / 21:48 EAT. Deng Ayom (CEO) approved all 12 recommended defaults in `app/docs/phase-1/questions-for-ceo.md`. Phase 1b proceeds on this basis.

| ID | Decision |
| --- | --- |
| D-19 (P1-1) | Staging environment in the nearest African cloud region. Accounts are created by Deng or his developer, not by the build team. |
| D-20 (P1-2) | Quotes from 2 qualified pen-test firms (at least one Kenyan); pen test before any real money moves. |
| D-21 (P1-3) | Start sandbox onboarding: whichever of Stanbic, NCBA or KCB offers virtual accounts first; Metropol or TransUnion (CRB); Smile ID (KYC); a counsel-approved e-signature provider; an approved eTIMS integrator. |
| D-22 (P1-4) | Buyer underpayment after Mapema is repaid: the **supplier chases the buyer**; the system tracks the shortfall (counsel to confirm). |
| D-23 (P1-5) | Early part-payments above principal stay in suspense until the due date, pending counsel. |
| D-24 (P1-6) | Get VAT/eTIMS tax advice now. Fee invoices and statements stay blocked until then. |
| D-25 (P1-7) | Sign-in tokens move from browser storage to secure httpOnly cookies. |
| D-26 (P1-8) | A native-speaker financial translator reviews the Swahili strings. |
| D-27 (P1-9) | Phase 1b finishes the remaining screens before Phase 2. |
| D-28 (P1-10) | The 30/90-day non-performing period goes in the master agreement, pending counsel. |
| D-29 (P1-11) | Keep the Postgres job queue instead of Redis for now. |
| D-30 (P1-12) | Confirm the simple APR method (44.96% for the worked example) with counsel before marketing uses it. |

### Phase 1b engineering decisions (17 Nov 2026)

**[Tech Lead + Security Engineer]** Recorded 17 Nov 2026, 19:20 GMT (London). Defaults taken while building Phase 1b. Each is listed as a question for Deng in `app/docs/phase-1b/README.md`; they stand unless he says otherwise.

| ID | Decision |
| --- | --- |
| D-31 | Browser sessions are server-side. The `mapema_sid` cookie (HttpOnly, Secure, SameSite=Strict) holds an opaque id; only its SHA-256 is stored. CSRF uses an HMAC synchroniser token in `X-CSRF-Token`, an Origin allow-list and SameSite. Sessions last 15 min idle and 8 h at most; step-up rotates the id. Bearer tokens remain for API clients. Implements D-25. |
| D-32 | For now the OIDC PKCE code exchange stays in the browser (token in memory only, swapped for the cookie at once). A server-side BFF exchange is required before go-live. |
| D-33 | Shortfall (implements D-22): after Mapema is repaid, any unpaid remainder is recorded as owed by the buyer to the supplier. Later buyer payments matched by invoice reference go to the supplier. The supplier admin can close a shortfall as recovered directly or forgiven. Mapema does not chase the buyer for the supplier. Wording to counsel. |
| D-34 | The rate limiter is shared through Postgres (UNLOGGED table) instead of adding Redis (consistent with D-29). It fails open if the store errors. |
| D-35 | KYC checks are valid for 12 months (`KYC_REFRESH_MONTHS`). This is a Mapema policy default, not a cited regulatory figure (unverified), for compliance/counsel to confirm. Reminders go out at 30/7/0 days; new advances are refused once a check expires or a programme passes its review date. |
| D-36 | Payment receipts (BUY-12) are issued as plain receipts marked "not a tax invoice". Statements and fee invoices stay blocked on tax advice (D-24). |

### Phase 2 decisions (18 Nov 2026)

**[Product Manager + Tech Lead + Compliance]** Recorded 18 Nov 2026, about 06:00 GMT (London). Deng replied "Next" at 05:18 GMT, which signs off the marketing site and the Phase 1b defaults. The defaults below were taken while building Phase 2; each open point is a question in `app/docs/phase-2/README.md` and they stand unless Deng says otherwise.

| ID | Decision |
| --- | --- |
| D-37 | Deng's "Next" (18 Nov 2026, 05:18 GMT) approves the site and Phase 1b, including defaults P1b-1 to P1b-7 (D-31 to D-36 stand). |
| D-38 | CBK return and CRB file use an **assumed, labelled layout** behind a JSON template layer. Output is watermarked DRAFT while the active template is `assumed_draft`; an official template is loaded as a new version through maker-checker (compliance proposes, the CEO approves). No official field definitions are invented. |
| D-39 | Reconciliation reads Fineract balances at run time (Fineract has no as-of GL balance), so the job runs at 06:30 EAT for the previous day, before business hours. Movements are compared from an approved baseline. Timing window: one business day, skipping weekends only (public holidays: Q-G). |
| D-40 | Month-end reporting is on a cash basis as of the month end: balances from allocations received on or before the month end; income = interest and fees received in the month. |
| D-41 | Recourse to the supplier is maker-checker: credit proposes with step-up, a different credit user or the CEO approves. The old direct endpoint now creates the proposal. |
| D-42 | Outside production the public CBK statement always says "not yet licensed" with a DEMO marker, even if test data holds a licence number. |
| D-43 | Collections defaults: reminders 7 and 1 days before, on the due day, and 1, 7, 14 days after; supplier warning at day 14; recourse case at 30 DPD; NPL at 30 DPD (terms ≤ 30 days) or 90; sent at 08:00 EAT; a missed day sends only the latest step. Policy changes are maker-checker (credit proposes, the CEO approves). Flagged `counselConfirmed: false`. |
| D-44 | In duplum: from NPL, interest and fees charged are together capped at the principal outstanding at NPL; any excess is waived in the ledger. Principal is never reduced. Stricter than the commentary's reading, pending counsel. |
| D-45 | The CRB file leaves out borrowers without a CRB consent on file and lists them as exceptions (`CRB_SUBMISSION_REQUIRE_CONSENT=true`), pending counsel (Q-C). |
| D-46 | Accounting: Xero first (QuickBooks would implement the same adapter). One DRAFT manual journal per day from the Fineract trial-balance movement, idempotent by date; the first run captures the opening TB only; the accountant posts the drafts. Fee-invoice hook built and disabled (D-24). |
| D-47 | CRM: HubSpot via adapter; hourly import of buyer leads with privacy-notice acceptance only; no marketing opt-in; erasure requests skipped or flagged; the site's D1 is read with a read-only token, and the site Worker is not changed. |
| D-48 | Month-end snapshots are idempotent per month; a restatement needs a reason and creates version n+1. Snapshots and artefacts are append-only with SHA-256 hashes, and regenerated files must be byte-identical. |

## D-49 Phase 2 sign-off (18 Nov 2026, 06:02 GMT)

CEO approved Phase 2 and its defaults Q-A to Q-J as recorded in docs/phase-2/README.md. CBK/CRB outputs stay DRAFT until official formats arrive.

### Phase 3 decisions (18 Nov 2026)

**[Product Manager + Tech Lead + Architect + Compliance]** Recorded 18 Nov 2026, about 06:50 GMT (London). Deng's "Next" after D-49 starts Phase 3 "Growth". These are working defaults; each can be changed by Deng.

| ID | Decision |
| --- | --- |
| D-50 | ERP connectors are stateless; the platform owns the cursor and an item ledger (one row per connection + ERP record, ever), so connectors never decide idempotency. A record that changes in the ERP after import is flagged `changed_after_import` and never applied; corrections go through the normal invoice flows. |
| D-51 | Every ERP connection gets its own inactive integration user as the uploader, so the buyer's human checker is always a different person (four eyes) and the ILU is still signed by a person. |
| D-52 | ERP secrets come only from env vars named `ERP_SECRET_*` (secret manager in staging/production); the database stores the variable name, never the key. |
| D-53 | Odoo and CSV/SFTP are complete; SAP S/4HANA, Sage Business Cloud and Dynamics 365 BC are built to the vendors' documented shapes but their field names, approval states and auth are assumptions until a real tenant is tested (Q-K). No ERP write-back. |
| D-54 | CSV/SFTP is a drop folder (`ERP_DROP_ROOT/<connection>/incoming`) written by an SFTP host; the app never pulls from a remote SFTP server. Files are de-duplicated by SHA-256. |
| D-55 | Field mappings are JSON with a fixed set of transforms, versioned; changes proposed by a buyer admin or ops apply only after a different ops user approves (`erp_mapping_change`). |
| D-56 | The payout rail is chosen at credit approval: M-Pesa B2C if the supplier has a call-back-verified wallet, the amount is ≤ the cap and in whole shillings; otherwise bank. |
| D-57 | M-Pesa cap default KES 150,000 (`mpesa_payout_cap_cents`), changed only with CEO approval, never above Daraja's KES 250,000. |
| D-58 | An M-Pesa advance stays `released` until Safaricom's result arrives. Failure undoes the Fineract disbursal; timeout or no result → status query; still unknown → ops task. **Nothing is ever resent automatically.** |
| D-59 | Daraja does not sign callbacks, so result/timeout URLs carry a random path token compared in constant time (S-12: mask it in proxy logs). |
| D-60 | Payout batches: maker builds (≤ 100 approved advances), a different ops user approves with step-up and may drop items; items release one by one through the normal release (limits accumulate), and one failure never stops the others. Limit failures therefore show per item. |
| D-61 | Funding: each source is a Fineract fund, set on the loan at origination (`fundId`; Fineract does not allow changing it on an active loan). The current tag lives in the loan datatable `mapema_funding_tag`; re-tags update it after commit and a consistency check compares platform and Fineract. |
| D-62 | Funding sources and re-tags are approved by the CEO. At release the system validates the source credit named (eligibility, headroom, covenants pro forma) or auto-picks the first eligible source by priority. With no sources configured, advances stay untagged (Phase 2 behaviour). |
| D-63 | The per-funder lender pack uses the tag history as at month end, recomputes the loan-level summary for that funder's loans, keeps platform-wide lines as they are, and is reproducible byte for byte. |
