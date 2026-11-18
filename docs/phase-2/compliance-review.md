# Phase 2 compliance review

**[Compliance & Risk Analyst]** 18 Nov 2026. Scope: the Phase 2 surface (reports, reconciliation, collections, accounting and CRM integrations) against the **CBK (Non-Deposit Taking Credit Providers) Regulations 2026** and the **Data Protection Act 2019**. Regulation numbers follow the Phase 0 review (`phase-0/compliance-review.md`), which relied on law-firm commentary (Bowmans, CDH, ZMS Legal). **They have not been checked against the gazetted text**; ⚖️ marks items for Kenyan counsel. This is not legal advice.

| Topic | Rule (as summarised in Phase 0) | What Phase 2 does | Status |
| --- | --- | --- | --- |
| Regulatory returns to CBK | NDTCPs must make periodic returns to CBK in the prescribed form | Monthly snapshot and CBK return generator with a template layer. **The prescribed form has not been seen**, so every field is labelled "(assumed)" and every file says DRAFT, DO NOT SUBMIT. Nothing is sent to CBK | 🟡 needs the official form (Q-A) |
| Credit information sharing (CRB Regulations 2020; NDTCP regs 33–34) | Share credit information with licensed CRBs; negative listing only after a 30-day notice and above KES 1,000 | CRB file generator (DRAFT, assumed columns). Borrowers without a CRB consent on file are excluded and listed as exceptions. **No listing or submission happens**; no negative-listing logic yet | 🟡 ⚖️ Is consent needed for submission, or is submission mandatory? (Q-C). Pre-listing notice workflow before any submission |
| NPL classification and recovery cap (C-07, reg. 29) | NPL after 30 days (terms ≤ 30 days) or 90 days, or the default period in the agreement; recovery capped at principal at NPL plus contractual interest up to that principal plus reasonable costs | Ladder classifies NPL at the configured days (default 30/90). From NPL, charges are capped at principal at NPL and the excess is waived in Fineract; principal is never reduced. Our cap is stricter than the summary (it caps contractual interest **and** fees together at principal) | 🟡 ⚖️ Confirm reading and default periods; master agreement wording (Q-D, D-28) |
| Fair debt collection; recovery costs itemised (reg. 43) | No harassment; costs strictly necessary and itemised | Reminders are factual, sent once per step, 08:00 EAT only, never while an invoice is disputed; no late fees or recovery costs are charged (D-09 unchanged) | 🟡 ⚖️ Review the reminder and recourse texts; confirm contact hours |
| Recourse to the supplier | Contractual (master agreement) | Maker-checker: credit proposes, a second credit user or the CEO approves; supplier warned at day 14 and told on approval; amount demanded = ledger payoff | 🟡 ⚖️ Recourse clause in the master agreement |
| Accurate books; reconciliation | Proper records; returns must agree to the books | Daily three-way reconciliation with classified breaks, alerts, maker-checker resolution and an audit trail; reports are built from a hashed, append-only snapshot | ✅ |
| Outsourcing (C-10, reg. 31) | Material outsourcing needs 30 days' notice to CBK and access rights | Xero and HubSpot would be new processors. Adapters are mock-only; nothing is outsourced yet | 🟡 Add Xero and HubSpot to the vendor register and assess materiality before sandbox/live |
| Records retention | Keep records (7 years assumed in Phase 0) | Snapshots, artefacts and resolutions are append-only; no deletion path | ✅ (period to confirm, Q-16 Phase 0) |
| DPA: purpose limitation and lawful basis (s.25, s.30) | Process for specified purposes with a lawful basis | CRM import only takes buyer leads who accepted the privacy notice on the book-a-call form, for the purpose shown ("request to be contacted"); no marketing subscription is set | ✅ 🟡 privacy notice must name HubSpot as a processor |
| DPA: data-subject rights (erasure, objection) | Honour deletion and objection requests | Site erasure/objection requests are skipped at import; earlier syncs are flagged `erasure_pending` for deletion in HubSpot | ✅ (manual deletion step until HubSpot is live) |
| DPA: cross-border transfers (s.48–49) | Safeguards for transfers outside Kenya | Xero and HubSpot host outside Kenya | 🟡 ⚖️ Transfer basis and DPAs before use |
| DPA: data minimisation in reports | Only necessary data | CRB file holds company identifiers only; lender pack holds no personal data (company names only) | ✅ |
| Licence wording | Do not hold out as licensed before grant | Public statement says "not yet licensed"; in non-production it also says DEMO even if test data holds a licence number (D-42). Lender pack prints the licence number from settings, which is empty until a real licence is entered by maker-checker | ✅ |
| Fee invoices / tax | D-24: blocked until tax advice | Hook built and disabled; records `skipped_disabled` | ✅ (blocked as instructed) |

## Items for Kenyan counsel (Phase 2)

1. CBK monthly return: the prescribed form and submission channel for NDTCPs.
2. CRB: consent versus mandatory submission for corporate borrowers; pre-listing notice process (regs 33–34).
3. NPL periods, recovery cap reading (reg. 29) and the master-agreement default clause.
4. Reminder and recourse-demand wording; contact hours.
5. Recourse clause enforceability against suppliers.
6. Cross-border transfer basis for Xero and HubSpot; processor agreements.
