# Phase 1 Compliance & Risk Review

**[Compliance & Risk Analyst]** Reviewed 17 Nov 2026. Scope: the Phase 1 code in this repository, checked against **The Central Bank of Kenya (Non-Deposit Taking Credit Providers) Regulations, 2026 (LN 191 of 2026)** and the **Data Protection Act, 2019** with its 2021 Regulations.

> **This isn't legal advice.** I didn't consult any new sources in Phase 1. The regulatory facts and regulation numbers below come from the Phase 0 review (`phase-0/compliance-review.md`), which cites public sources checked on 17 Nov 2026. Many of those regulation numbers come from law-firm commentary rather than the gazetted text, and they stay **unverified until counsel checks them**. Also note: on 12 Nov 2026 Parliament's Delegated Legislation Committee directed CBK to redraft contested provisions, so amendments are likely. That's why rules are kept in configuration where possible.

Legend: ✅ implemented and tested · 🟡 partly implemented or depends on a decision · ❌ not implemented · ⚖️ needs a Kenyan advocate

## 1. Lending rules built into the code (brief "Compliance, security and audit")

| Rule | Status | How it's enforced | Test evidence |
| --- | --- | --- | --- |
| KES only, integer cents (C-16) | ✅ | zod `zKes`/`zCents` at the API (non-KES → 400), DB `money_cents` domain, bigint arithmetic, bank ingest rejects non-KES | `security.e2e` (USD rejected), pricing property tests, CSV upload test (USD row rejected) |
| Repayment order principal → fees and charges → interest, including partials (C-04, reg. 56 per commentary) | ✅ | Fineract `advanced-payment-allocation-strategy` set principal → fee → interest; platform posting policy reads the Fineract payoff first; early partials above principal are **held** and posted on the due date so fees aren't paid ahead of the schedule; allocation mismatches raise a reconciliation break | Worked example; TC-SET-01..03 against **real Fineract**; Fineract proof test (exactly KES 44,800 interest, principal first) |
| Pricing changes need a CBK approval reference (C-02, reg. 26) | ✅ | Activation needs `cbkApprovalRef`, a customer-notice date and an effective date, plus a second approver; DB CHECK backs it up | `worked-example` setup; security tests |
| 30-day customer notice and acceptance for changes (regs 54(7), 55) | 🟡 | Notice date is required. Existing disclosures keep the terms that were accepted. **No customer re-acceptance flow** for a new pricing version yet | — |
| Full disclosure before acceptance, stored with the acceptance (C-05, regs 48, 54) | ✅ | `price_disclosure` stores invoice, advance, maximum discount fee, verification fee, total cost, amount Mapema keeps, supplier balance, APR, terms and KID versions, and expiry. The acceptance references the disclosure IDs and must arrive before expiry; the UI shows the same figures | Worked example (`quotes exactly… and stores the full disclosure`) |
| APR method (C-05, reg. 59) | 🟡 ⚖️ | Simple annualised rate: (total cost ÷ advance) × 365 ÷ days = **44.96%** for the worked example. The method needs counsel/CBK confirmation | pricing tests |
| Early repayment: no interest for the unexpired period (C-06) | ✅ | D-03: interest on actual days, with the quote as the maximum. The verification fee isn't refunded (D-03; ⚖️ check this is allowed) | TC-SET-01: day-30 payment → interest KES 28,000; supplier gets KES 169,500 |
| NPL recovery cap (in duplum style) (C-07, reg. 29) | ✅ 🟡 | (1) A quote is refused if interest + fees would exceed the advance. (2) No late charges (D-09), and interest stops at the disclosed maximum. (3) A settlement guard raises an `in_duplum_breach` reconciliation break if interest + fees collected ever exceed principal. (4) NPL classification at 30 days for tenors ≤ 30 days, else 90 days. **The cap wording (principal at NPL + contractual interest) and the default period need counsel**; our cap is the stricter "charges ≤ principal advanced" | pricing tests (`IN_DUPLUM`, `nplDaysFor`); TC-OPS-01 (ladder to NPL) |
| Concentration limits at release, not only approval | ✅ | Buyer 25%, supplier 10%, sector 35% of float, plus programme and supplier limits and available float. Checked at credit decision **and again at release**, under a Postgres advisory lock so concurrent approvals can't jointly breach a limit | `security.e2e` concurrency test |
| Maker-checker: no money moves on one person's say-so (SYS-03) | ✅ | Credit approves and a *different* ops user releases (DB CHECK on payouts). Four-eyes covers limits, pricing, float, lending switch, bank verification, manual match, dispute close, break close, write-off and **staff/auditor role grants (added in Phase 1)**. D-06: the balance release is proposed by the system and released by one ops user | `security.e2e` four-eyes tests |
| Licence gate (C-01, reg. 5) | ✅ ⚖️ | Lending is off until a licence number is entered and approved by a second person (D-05). The public site says "not yet licensed… we do not provide credit" until then. The demo data uses the fictitious `DEMO-LICENCE-001` | public tests |
| Credit appraisal and human sign-off (C-08, reg. 28) | ✅ | Every advance needs a named credit officer's decision with a reason; automated checks are advisory. No AI scoring | worked example |
| Complaints (C-11, reg. 40) | ✅ | Acknowledge clock 7 days, resolve clock 30 days, overdue flag. The 48-hour oral-complaint confirmation isn't modelled | TC-OPS-03 |
| Debt-collection conduct (C-12, reg. 30) | 🟡 ⚖️ | Ladder creates *tasks* for staff (call, demand letter); the system contacts only the buyer (the debtor), never third parties. **Quiet hours for reminders aren't enforced yet.** Demand-letter template needs counsel | TC-OPS-01 |
| Disputes freeze new advances (brief workflow 5) | ✅ | An open dispute blocks quotes/releases against the invoice; closing needs compliance approval | TC-OPS-02 |
| CRB consent and reporting (C-13, regs 33–34) | 🟡 | CRB pulls blocked without consent; withdrawal blocks again. Monthly CRB submission is Phase 2 (OPS-13) | onboarding test |
| AML/CFT (C-19, POCAMLA) | 🟡 ⚖️ | KYC/KYB + sanctions screening (mock provider) before signing; sanctions hit → review + AML flag; payer-not-buyer flag on receipts; STR record requires a goAML reference. **No goAML integration, no beneficial-ownership registry check, no MLRO workflow** | onboarding + TC-SET-06 |
| Audit trail (C-22, reg. 61) | ✅ | Hash-chained append-only `audit_event` (app role can't UPDATE/DELETE), chain verify, CSV export (the export itself is audited) | worked example (`audit chain verifies`) |
| Reconciliation (brief) | ✅ | Daily bank vs Fineract GL vs platform; breaks recorded and alerted; closing a break needs a second person | worked example (mock), TC-SET-04/07 |
| Outsourcing notice to CBK (C-10, reg. 31) | ❌ ⚖️ | Process, not code. No adapter is `live`; production refuses mock adapters, so going live forces the vendor decision | — |
| Cyber incident reporting 24 h to CBK (C-14, reg. 66) | ❌ | Runbook not written (needs hosting and monitoring first) | — |
| Regulatory returns (C-15) | ❌ | Phase 2 | — |

## 2. Data Protection Act 2019

| Requirement | Status | Notes |
| --- | --- | --- |
| ODPC registration (mandatory for financial services) | ❌ ⚖️ | Business action before processing real data |
| Lawful basis / consent, express, specific, withdrawable (DPA; NDTCP regs 32, 53, 58) | 🟡 | Versioned consent records with withdrawal (CRB, data sharing, marketing, cross-border); the book-a-call form requires privacy-notice acceptance (version `PN-2026-11-v1`). **Privacy notice and terms are drafts** |
| Data minimisation and encryption | ✅ | National ID, phone and bank account numbers field-encrypted (AES-256-GCM) with blind indexes; masked in API responses; documents encrypted at rest; invitation links encrypted in the outbox and scrubbed after sending |
| Data-subject rights | 🟡 ⚖️ | Public DSR intake + staff queue + overdue clock. Default **7 days** (from secondary sources; **counsel to confirm**). Access/correction/deletion are **manual**; there's no automated export or erase, and erasure conflicts with lending-record retention |
| Retention schedule (Q-16) | ❌ ⚖️ | Not implemented. The privacy draft says "the period the law requires (draft assumes 7 years; counsel to confirm)" |
| Breach notification 72 h (DPA s.43) | ❌ | Runbook pending, with the CBK 24 h clock |
| DPIA (DPA s.31): KYC biometrics, CRB, profiling | ❌ ⚖️ | Must be done before real users. The selfie/ID check will process **sensitive personal data** |
| Cross-border transfer / hosting (C-18, D-08) | 🟡 ⚖️ | D-08: Kenya or the nearest African region, pending counsel. Nothing is hosted yet. Each provider's data location must go in the vendor register |
| Processor agreements | ❌ | No providers contracted yet |

## 3. New risks found while building Phase 1

1. **Buyer underpayment after the loan closes** (🟠, ⚖️ + CEO). If the buyer pays less than the full invoice but enough to close the loan, the supplier gets what's left and the shortfall stays a **buyer obligation to the supplier** under the assigned invoice. The system doesn't track it. Decide who chases it (Q-P1-04).
2. **Early partial payments above principal are held in suspense until the due date.** This keeps the CBK order when the schedule hasn't yet made fees and interest due. Counsel should confirm that holding customer money in suspense for days fits the reg. 18 limits on trust operations (linked to C-03).
3. **Verification fee is collected at settlement (D-10).** If an advance is written off, the fee is never collected. That's consistent with D-10, but the fee needs the reg. 30 disclosure wording.
4. **Notice of assignment** is generated as a PDF and stored, and the buyer is notified. Whether e-delivery perfects the assignment is part of C-09 ⚖️.
5. **Swahili text is a machine-quality draft.** If customer-facing Swahili is wrong, it's a disclosure risk. A native legal and financial review is needed before launch.

## 4. Items needing a Kenyan lawyer (Phase 1 additions to the Phase 0 list)

Phase 0 items C-01, C-02 and C-03 (licence route, product approval, collections/balance structure) are **still open and still block live lending**. Phase 1 adds:

1. Confirm the **APR formula** and the **KID template** that the disclosure screen and `price_disclosure` record implement.
2. Confirm the **in duplum cap wording**, the **NPL default period** (30/90 days by tenor), and that charges ≤ principal advanced satisfies reg. 29.
3. Confirm the **verification fee is not refundable** on early repayment, and how it's classified (fee/charge vs interest).
4. Confirm **holding early partial payments in suspense** (risk 2) and the deferred-price balance model (D-01) against reg. 18(1)(i)–(j).
5. Review the **privacy notice, terms, master agreement / deed of assignment, ILU and notice-of-assignment** texts (all drafts generated by the system) and their e-signature validity (C-09).
6. Confirm the **DSR response period**, the **retention schedule**, and the erasure-vs-retention position.
7. Approve the **collection templates** (D1 reminder SMS/email, D14 demand letter) and quiet hours.
8. Confirm the wording of the public **CBK status statement** before and after licensing.

## 5. Sign-off

Phase 1 is **compliant by design for the lending rules the brief puts into code** (KES only, CBK order, disclosure, pricing approval reference, limits at release, maker-checker, in duplum, audit). It is **not cleared for live lending**: C-01, C-02 and C-03 and the data-protection prerequisites (ODPC registration, DPIA, retention, final privacy notice) are open, and every provider is still a mock.
