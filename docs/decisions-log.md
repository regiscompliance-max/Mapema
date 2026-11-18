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

## D-64 Phase 3 sign-off (18 Nov 2026, 06:52 GMT)

CEO approved Phase 3 and its defaults Q-K to Q-R as recorded in docs/phase-3/README.md. All four brief phases now signed off; go-live still depends on staging, pen test, provider sandboxes, counsel and tax advice.

### Go-live readiness decisions (18 Nov 2026)

**[Tech Lead + Security Engineer + Compliance + DevOps]** Recorded 18 Nov 2026, about 07:45 GMT (London). Deng's "Next" after D-64 starts go-live readiness on the branch `go-live-hardening` (not merged to main; no PR opened without asking). Working defaults; each can be changed.

| ID | Decision |
| --- | --- |
| D-65 | Go-live hardening lives on `go-live-hardening`; CI runs on it. Nothing is deployed, no accounts are opened, no live provider calls are made, and the marketing-site worker is untouched. |
| D-66 | Business days = Monday to Friday minus Kenyan public holidays: Public Holidays Act (Cap. 110) Schedule Part I as amended by Act No. 3 of 2024 (Mazingira Day 10 Oct), computed in code with the s.4 Sunday rule; Idd-ul-Fitr, election/swearing-in days and any s.3 Gazette additions or substitutions are entered by ops with a Gazette Notice reference and approved by a second ops user (`holiday_gazette`). Part II (Idd-ul-Azha) and Part III (Diwali) are faith-specific and stay business days. Seeded: Idd-ul-Fitr Fri 20 Mar 2026 (Gazette Notice No. 3955 of 18 Mar 2026). Used by the reconciliation timing window and the reminder schedule. |
| D-67 | Days past due (late ladder, recourse, NPL) keep counting **calendar days** from the contractual due date (counsel to confirm, pack B4). Reminders move to business days: pre-due steps earlier, due/overdue/supplier steps later; nothing is sent on a non-business day; when steps land on the same business day only the latest goes out and the others are recorded as skipped. |
| D-68 | D-32 closed: sign-in is a server-side OIDC flow (BFF) with a confidential Keycloak client, PKCE, state + nonce, an HttpOnly binding cookie and single-use server-side state. No token reaches the browser. A login whose token lacks an MFA factor (the TOTP-enrolment login) is sent back to Keycloak once with `prompt=login`; a second miss fails closed. |
| D-69 | Keycloak MFA is codified in `scripts/keycloak-configure.mjs` (amr references `pwd`/`otp` with a max age; OTP REQUIRED for everyone) and must run after every realm import. Proven end to end against Keycloak 26.8.2 (TC-GL-KC-01..04). |
| D-70 | S-09: report artefacts are sealed in the application with AES-256-GCM (key derived from `STORAGE_ENCRYPTION_KEY`; AAD binds snapshot, template and filename); `sha256` stays the plaintext hash so reproducibility checks still work. Legacy rows are encrypted once by `scripts/encrypt-report-artifacts.mjs`. |
| D-71 | S-13/S-16 fail closed: ERP egress only to `ERP_ALLOWED_HOSTS` over https, private addresses refused after DNS, no redirects; CSV drop files must be regular, non-symlinked, not world-writable and pass ClamAV; a scanner outage leaves files unprocessed. S-14: integration users carry `is_integration`, can never sign in and are listed separately as service accounts. S-15: each batch item checks the approver's step-up age against `BATCH_STEP_UP_WINDOW_SEC` (default 900 s). S-12: callback token masked in API logs and nginx; a previous token is accepted during rotation and every use audited; optional Safaricom IP allow-list. |
| D-72 | Staging default: AWS af-south-1 (Cape Town) with synthetic data only, about USD 330/month (estimate). Production region decided after counsel (pack F1) and the CBK outsourcing notice. picomatch GHSA-fc5q-39xc-vjpf: no patched release exists (4.0.7 is the latest and affected); dev-only (vitest/vite), production audit clean; accepted until upstream fixes it. |

**Questions for Deng (defaults apply if no answer):** see docs/go-live/README.md §"Questions for Deng".

## Phase 4 security (CEO sign-off 18 Nov 2026, Europe/London)

Deng approved the Phase 4 security proposal on 18 Nov 2026 (Europe/London) with **all defaults D-73 to D-80 and open questions Q-S to Q-Z**. Recorded here before the build. Sources: IFC 2022 Kenya SCF Market Assessment; FSD Kenya 2013 briefing note; FSD Kenya 2015 technical note; UNCTAD 2025 Unlocking Growth. Page-cited quotes live in `docs/phase-4-security/proposal.md`.

| Id | Decision |
| --- | --- |
| D-73 | P4-1 (Q-S, Q-T): search the Movable Property Security Rights registry before funding; file the assignment after funding; store the registration number; fail closed if a search is missing. Evidence is a staff-uploaded certificate from the official portal, under maker-checker. The adapter is mock (tests) or a portal-only manual stub (sandbox/live). **No invented registry API.** |
| D-74 | P4-2 (Q-U): notify the buyer and the supplier when an invoice is submitted; the eTIMS control-unit number must be unique when present; the same supplier PIN + amount + date with a different invoice number is flagged for review, not hard-blocked. The existing hard `NO_DUPLICATE` check on already-financed invoices with the same PIN + amount + date stays. |
| D-75 | P4-3 (Q-V): draft a buyer security and data pack and a public anti-fraud notice. The notice may appear in the application as a clearly marked draft that is not deployed to the marketing site. The site and the application still say Mapema is **not yet licensed**. |
| D-76 | P4-4 (Q-X, Q-Y, Q-Z): add counsel questions I1–I5 (MPSRA filing and priority versus the Insolvency Act; anti-assignment clauses; the small-claims path; whether a factoring Act was enacted since 2022). Default: proceed on MPSRA + assignment documents. **Do not change contracts until counsel answers.** |
| D-77 | P4-5: a goods/services-received attestation is required at buyer confirmation. A purchase-order or GRN reference is optional. Confirming without receipt needs a short reason (for example a contractual milestone). |
| D-78 | P4-6 (Q-U continued): eTIMS is the working original. An `unavailable` invoice cannot silently pass to funding. Confirmation may proceed; eligibility and funding require `valid` or a maker-checker `overridden` status. The existing `valid` \| `overridden` gate is kept and surfaced clearly. |
| D-79 | P4-7 (Q-W credit insurance): credit insurance is considered after the first live programme. It is not a launch blocker. Documentation note only. |
| D-80 | P4-8 (Q-W CRB, UNCTAD government delays): a government-payer dependency flag (and a mandatory comment when the flag is true or the sector is construction) sits on the buyer credit file before programme approval. No tighter sector cap. **No CRB file change** — the supplier remains the reported borrower (D-38, D-45) until counsel answers. |
| D-81 | Phase 4 security (P4-1 to P4-8) is built on branch `phase-4-security` against the sign-off above. Worked example unchanged. Marketing-site Worker not deployed. |

**Questions for Deng (defaults apply if no answer):** Q-S to Q-Z in `docs/phase-4-security/proposal.md`, all accepted as the defaults above.
