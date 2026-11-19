# Phase 1: lending core MVP — status report

**[Product Manager]** 17 Nov 2026. This report covers Phase 1 as the brief defines it:

> **Scope:** public site, buyer/supplier/staff portals, onboarding, invoice confirmation, eTIMS, CRB, KYC, e-signature, Fineract, bank collections and payouts, SMS/email.
> **Done when:** the worked example (KES 1,000,000, 48 days) runs end to end **in staging** with correct fees, repayment order and payouts; all tests green; pen-test findings fixed.

## Verdict against "Done when"

| Criterion | Status | Evidence |
| --- | --- | --- |
| Worked example end to end with correct fees, repayment order and payouts (preserved under the direct-legacy profile, D-82) | ✅ **locally**, through the HTTP API, against the mock ledger **and a real Apache Fineract 1.16.1**. Also clicked through the web UI against a seeded local stack | `apps/api/test/worked-example.e2e.test.ts`, `packages/adapters/test/fineract.live.test.ts`, `scripts/ui-smoke.mjs`, [qa-report.md](qa-report.md) |
| …in **staging** | ❌ **Not met.** No staging exists, and the instruction was not to deploy anywhere or create accounts | Docker/CI/Keycloak files are written but not run |
| All tests green | ✅ 103/103 (mock ledger) and 56/56 (real Fineract) | [qa-report.md](qa-report.md) |
| Pen-test findings fixed | ❌ **Not met.** No independent pen test has been done (needs a vendor and a deployed staging). An internal security review was done and its findings fixed | [security-checklist.md](security-checklist.md) |

**So Phase 1 is code-complete for a local demo, but not "done" by the brief's definition.** Two things remain, and both need your decisions or spending: a staging environment, and an independent pen test. Real provider sandboxes (bank, eTIMS, CRB, KYC, e-signature, SMS, email) also need commercial accounts that I was told not to create.

## Coverage by scope item

| Scope item | Built | Real or mock |
| --- | --- | --- |
| Public site | Home, buyers, suppliers, pricing with a fee calculator (same engine as lending), book-a-call (privacy-notice consent), CBK status (from the lending switch), complaints, data protection with a DSR form, privacy and terms (**drafts for counsel**), EN/SW toggle | Real |
| Buyer portal | Invoices, add invoice and CSV, confirmation queue (approve/reject/dispute), ILU signing (per invoice or batch), payment calendar with pay-to account, invite suppliers, users (maker/checker), complaints | Real (e-sign mocked) |
| Supplier portal | Confirmed invoices, quote with full disclosure → accept, advances, account (directors, payout bank account, submit KYC, sign master agreement), complaints | Real (KYC and e-sign mocked) |
| Staff portal | Dashboard, approvals (maker-checker), advances (credit decide / ops release with live checks), payments (balance release, unmatched → manual match), reconciliation, organisations (buyer prospect, CRB pull, supplier limit), compliance (AML, complaints, DSR), settings (lending switch, pricing, float) | Real |
| Read-only portal | Portfolio, audit log with a chain check and CSV export, Fineract trial balance; time-boxed access | Real |
| Onboarding | Buyer: prospect → KYB → CRB (consent-gated) → programme (CEO four-eyes) → e-signed agreement → virtual account. Supplier: buyer invite → KYC/KYB/sanctions → master agreement and deed → bank call-back (four-eyes) → supplier limit (four-eyes) | Workflow real; providers mocked |
| Invoice confirmation | Maker-checker, duplicate block (PIN + normalised number, plus a fuzzy check), eTIMS validation, ILU batches ≤ 200 | Real |
| eTIMS / CRB / KYC / e-signature | Adapters with interfaces, mocks and failure modes (invalid, mismatch, down, sanctions hit). Sandbox clients are **not** written; they need provider docs and accounts | **Mock only** |
| Fineract | Real REST client: product, client, loan create/approve/disburse, payoff quote, repayment, journals, write-off, trial balance. Advanced payment allocation principal → fees → interest | **Real (1.16.1, local)** |
| Bank collections and payouts | Signed webhook (HMAC over raw body), statement CSV import, idempotent per bank ref, matching (virtual account + invoice no., unique amount), payouts ledger-first then bank with undo, status polling | **Mock bank only** (no bank chosen) |
| SMS / email | Notifier + outbox with retries; EN/SW templates; Africa's Talking and Postmark HTTP clients written | Mock in all tests; **HTTP clients never exercised** |

## Story status (Phase 1 stories from `phase-0/user-stories.md`)

✅ done and tested · 🟡 partly done (the gap is noted) · ❌ not done. "API" means the API exists and is tested, but there is no portal screen yet.

| Story | Status | Note |
| --- | --- | --- |
| SYS-01 KES integer cents | ✅ | bigint, DB domain, zod, property tests |
| SYS-02 append-only audit | ✅ | hash chain, revoked UPDATE/DELETE, verify + export |
| SYS-03 maker-checker + limits | ✅ | incl. role grants (added this phase) |
| SYS-04 CBK allocation order | ✅ | pricing + Fineract strategy + scenarios TC-SET-01..03 |
| SYS-05 MFA all users | 🟡 | API enforces MFA `amr` + step-up; Keycloak realm written, not run |
| SYS-06 mobile, accessible, EN/SW | 🟡 | mobile layout smoke-tested at 390 px; SW is a **draft** for native review; no axe/WCAG audit yet |
| PUB-01..07 | ✅ | legal pages are drafts for counsel |
| BUY-01 accept invite + MFA | ✅ | |
| BUY-02 KYB | 🟡 | directors/bank/submit in API; document upload API only (no upload screen) |
| BUY-03 programme agreement e-sign | ✅ | mock e-sign |
| BUY-04 users maker/checker | ✅ | |
| BUY-05 invite suppliers email/SMS | ✅ | |
| BUY-06 upload one / CSV | ✅ | |
| BUY-07 approve/reject/hold | 🟡 | hold/release-hold in API; UI has approve/reject |
| BUY-08 ILU per invoice/batch | ✅ | |
| BUY-09 notice of assignment | 🟡 | PDF generated and stored (WORM) at funding; no download screen |
| BUY-10 payment calendar | ✅ | |
| BUY-11 raise dispute | ✅ | blocks new advances; closing needs compliance approval |
| BUY-12 receipts | 🟡 | receipt notification sent; no downloadable receipt |
| BUY-13 programme limit/utilisation | 🟡 | API (org + exposure); no buyer screen |
| SUP-01 sign up from link | ✅ | |
| SUP-02 KYC/KYB with upload | 🟡 | KYC checks (mock) on submit; upload API only |
| SUP-03 consent give/withdraw | 🟡 | API; no screen |
| SUP-04 master agreement + deed once | ✅ | |
| SUP-05 confirmed invoices | ✅ | |
| SUP-06 supplier submits invoice | 🟡 | API; no screen |
| SUP-07 request early payment, exact fee first | ✅ | disclosure stored with acceptance; idempotent; one-at-a-time in UI (API takes many) |
| SUP-08 paid to verified account + SMS/email | ✅ | mock bank/SMS/email |
| SUP-09 balance released when buyer pays | ✅ | D-06: system proposes, one ops person releases |
| SUP-10 statements, receipts, fee invoices | ❌ | fee invoices wait on tax advice (C-21); statements not built |
| SUP-11 change payout account safely | ✅ | cooling-off + new call-back |
| SUP-12 complaints | ✅ | 7/30-day clocks |
| SUP-13 see data / correction / deletion | 🟡 | DSR intake + staff queue; no self-service data view |
| SUP-14 early-repayment and recourse terms | 🟡 | shown in disclosure; terms are a draft for counsel |
| CRD-01 buyer credit file | 🟡 | API; staff UI lists orgs + CRB pull only |
| CRD-02 CRB pull | ✅ | consent-gated, mock bureau |
| CRD-03 programme, CEO four-eyes | 🟡 | API + approvals UI; no proposal form in the UI |
| CRD-04 supplier credit file | 🟡 | API only |
| CRD-05 supplier limit maker-checker | ✅ | |
| CRD-06 advance queue with checks | ✅ | eTIMS, ILU, limits (buyer/supplier/sector/float), duplicate, dispute, account verified |
| CRD-07 review-date reminders | ❌ | not built |
| CRD-08 decision with reasons | ✅ | |
| OPS-01 buyer prospects | ✅ | |
| OPS-02 release payouts | ✅ | step-up, different person from the approver |
| OPS-03 disbursement status | ✅ | mock bank statuses + undo on failure |
| OPS-04 auto-match | ✅ | |
| OPS-05 manual match maker-checker | ✅ | |
| OPS-06 daily reconciliation | ✅ | bank vs Fineract vs platform; breaks recorded; close needs approval |
| OPS-07 late ladder | ✅ | automated D1/D7/D14/D30 + NPL |
| OPS-08 dispute log | ✅ | |
| OPS-09 recourse at D30 | ✅ | credit, step-up |
| OPS-10 bank change call-back | ✅ | |
| OPS-11 complaints SLA | ✅ | |
| OPS-12 DSR | 🟡 | queue + status API; UI list only; **7-day clock pending counsel** |
| OPS-14 AML flags + FRC records | ✅ | goAML ref required to file an STR record (no goAML integration) |
| ADM-01 staff users and roles maker-checker | 🟡 | API (added this phase); no staff-admin screen |
| ADM-02 pricing with CBK ref | ✅ | |
| ADM-03 limits + float | 🟡 | API; settings screen is read-only for these |
| ADM-04 CEO approves buyer limits | ✅ | |
| ADM-05 basic dashboard | ✅ | basic version (Phase 1 scope) |
| ADM-07 write-off maker-checker | 🟡 | API (CEO approval → Fineract write-off); no screen |
| ADM-08 flags + sandbox/live switches | ✅ | env-based per adapter; production refuses mock; lending switch |
| AUD-01, AUD-02, AUD-04 | ✅ | |

Count: **50 ✅, 19 🟡, 2 ❌** of the 71 Phase 1 stories (SUP-15, OPS-13, ADM-06, ADM-09 and AUD-03 are Phase 2–3). Most 🟡 items have a tested API and are missing only a screen.

## Mocked or not done (plain list)

- **Mock only:** bank, eTIMS, CRB, KYC/sanctions, e-signature. Each has a provider-neutral interface; a sandbox client can't be written until a provider is chosen and an account opened.
- **Written but never exercised:** Africa's Talking SMS and Postmark email clients; the Keycloak realm and the OIDC (PKCE) web sign-in; Dockerfiles; docker-compose; the CI workflow.
- **Not built:** staging and production hosting, backups and monitoring; Redis/BullMQ (replaced by a Postgres outbox plus a single-leader worker — fine for Phase 1 volumes); S3 storage client (local AES-encrypted store instead); a real malware scanner (EICAR signature check only); downloadable statements, receipts and fee invoices; credit review-date reminders; some staff and supplier screens (see the 🟡 rows above).
- **Not done (needs spend or vendors):** independent pen test, native Swahili review, accessibility audit, counsel review of the legal drafts.

## Differences from the Phase 0 design contract

The API as built (`openapi/openapi.yaml`, generated from code, 90 operations) differs from `openapi/phase-0-design.yaml`. It uses camelCase JSON, some different paths (`/advances/queue`, `/approvals/{id}/approve`), money as decimal **strings** of cents (JSON numbers lose precision above 2^53), and problem+json with the code in `title`. The generated file is the one to build against. The Phase 0 file is kept for traceability, with its 80 lint warnings fixed (62 missing 4xx responses, 17 tag descriptions, 1 licence).

## Other Phase 1 documents

- [compliance-review.md](compliance-review.md): Compliance & Risk Analyst (CBK NDTCP Regulations 2026, DPA 2019, items for a Kenyan lawyer)
- [qa-report.md](qa-report.md): QA Engineer (real numbers)
- [security-checklist.md](security-checklist.md): Security Engineer
- [questions-for-ceo.md](questions-for-ceo.md): decisions needed before Phase 1 can be called done

**Stop point:** work stops here at the end of Phase 1, as instructed.
