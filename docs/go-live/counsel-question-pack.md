# Counsel question pack (all phases, consolidated)

**[Compliance & Risk Analyst]** 18 Nov 2026. For Mapema's Kenyan advocate. This is **not legal advice**; it collects
every legal question raised from Phase 0 to go-live, with what the platform does today (the working default) so
counsel can confirm or change it. Regulation numbers for the **CBK (Non-Deposit-Taking Credit Providers) Regulations
2026 (LN 191 of 29 Sep 2026)** follow law-firm commentary (Bowmans, CDH, ZMS Legal) and **have not been checked
against the gazetted text**; please confirm them. Note: on 12 Nov 2026 Parliament's Delegated Legislation Committee
asked CBK to redraft contested provisions, so amendments are likely. Mapema is **not yet licensed** and does not
provide credit; lending is switched off in the platform until a licence number is entered and approved.

References: Phase 0 compliance review (C-01..C-23) and questions (Q-01..Q-30); Phase 1 compliance review; Phase 2
(Q-A..Q-J); Phase 3 (P3-C1..C10, Q-K..Q-R); go-live decisions D-65..D-72.

## A. Licensing and product (top priority)

| # | Question | Current default in the platform | Source |
| --- | --- | --- | --- |
| A1 | Licence or registration? Initial capital vs the KES 20m threshold; do borrowings (debt facilities) and the loan book count toward conversion and capital tests? | Plan for a licence; lending switch off until a licence number is approved by a second person | C-01, Q-22, P3-C6 |
| A2 | Prior CBK approval of the product and pricing (reg. 26): what must the application contain; 30-day customer notice for changes (regs 54(7), 55) | Pricing versions carry a CBK approval reference and need a second approver to activate | C-02 |
| A3 | Supplier-balance pass-through (KES 152,700 in the worked example) vs the bans on payment services, fund transfer and trust operations (reg. 18(1)(i)–(j)) | Whole invoice assigned; balance treated as deferred purchase price owed by Mapema, paid within 1 business day, never pooled; fallback: bank escrow/split settlement | C-03, Q-18 |
| A4 | Is the 3.5%-per-30-days discount fee "interest" and the KES 2,500 verification fee a "fee or charge" for the allocation order (reg. 56) and the NPL cap (reg. 29)? | Discount fee = interest, verification fee = fee; one config switch | Q-01 |
| A5 | APR method for advertising and the key information document (regs 48, 51–52, 54(4)) | Simple annualised: 44.96% for the worked example (800,000 advance, 44,800 fee, 2,500 verification, 847,300 total) | C-05, Q-02 |
| A6 | Early repayment: interest on actual days only; may the KES 2,500 verification fee be kept? | Interest on actual days, quote is a maximum; verification fee not refunded | C-06, Q-17 |
| A7 | After the due date: any late charge allowed? | None; discount fee stops at the due date | Q-08 |
| A8 | "One flat fee" slogan | Replaced; counsel to approve final marketing wording | Q-02 |
| A9 | Verification fee only on funded advances: compatible with reg. 18(1)(d)? | Yes, only on funded advances, collected at settlement | Q-20 |

## B. Credit risk, NPLs and collections

| # | Question | Default | Source |
| --- | --- | --- | --- |
| B1 | NPL periods (30 days for tenors ≤ 30 days, else 90) and the in duplum-style cap wording; default clause in the master agreement | Stricter cap: interest + fees ≤ principal advanced; recon break if exceeded | C-07, Q-D, Phase 1 #10 |
| B2 | 30-day recourse trigger to the supplier; enforceability of recourse; personal director guarantees (guarantor consent, 14-day notice, exhaust borrower first) | 30 days; recourse to the supplier company only, with maker-checker; no personal guarantees | Q-D, Q-24, Phase 2 #5 |
| B3 | Reminder and recourse-demand wording (English and Swahili), contact hours, debt-collection conduct (reg. 30) | Factual texts, sent 08:00 EAT on business days only | C-12, Q-I |
| B4 | **New (go-live):** DPD/NPL ageing counts calendar days from the contractual due date even when the due date falls on a weekend or public holiday; reminders move to business days (pre-due earlier, due/overdue later). Is that right, or must a due date on a holiday roll to the next business day for default purposes? | Calendar days for DPD; business-day reminders (D-67) | Public Holidays Act Cap. 110 |
| B5 | Buyer underpayment after the loan closes: supplier chases the buyer? | Shortfall is a buyer obligation owed to the supplier | Phase 1 #4 |
| B6 | Early part-payments above principal held in suspense until the due date: compatible with the trust-operations limit? | Held in suspense | Phase 1 #5 |
| B7 | Buyer pays the supplier directly instead of Mapema | Master agreement obliges the supplier to pass it on within 2 business days; misdirected-payment workflow | Q-30 |
| B8 | Credit appraisal and any AI scoring (regs 28, 60) | A human credit officer approves every advance; no AI decision | C-08 |

## C. Credit bureau and regulatory reporting

| # | Question | Default | Source |
| --- | --- | --- | --- |
| C1 | CRB submission of borrowers who did not consent (corporate borrowers); pre-listing and post-listing notices (regs 33–34) | Excluded and listed as exceptions | Q-C, C-13, Phase 2 #2 |
| C2 | CBK monthly return: prescribed form and channel for NDTCPs; deadlines (reg. 66) | Outputs stay DRAFT until the official template arrives | Q-A, C-15, Phase 2 #1 |
| C3 | Incident reporting: significant cyber/fraud incident to CBK within 24 hours (reg. 66) and personal-data breach to ODPC within 72 hours (DPA s.43) | Runbook starts both clocks at detection | C-14, monitoring.md |

## D. Contracts, signatures and assignment

| # | Question | Default | Source |
| --- | --- | --- | --- |
| D1 | Advanced e-signatures under KICA; which CSPs are recognised; company execution (Companies Act s.37) | A counsel-approved provider; two authorised signatories | C-09 |
| D2 | Does electronic delivery of the notice of assignment perfect the assignment against the buyer? | PDF generated, stored, buyer notified | C-09, Phase 1 |
| D3 | ILU batch size and signatories | Up to 200 invoices per batch ILU; signatories per the buyer's board resolution (default 2) | Q-28 |
| D4 | Programme agreement clause authorising Mapema to pull the buyer's AP data from its ERP; supplier notice | Clause to be drafted | P3-C4 |

## E. Payments and AML

| # | Question | Default | Source |
| --- | --- | --- | --- |
| E1 | Is a Safaricom M-Pesa B2C channel a material outsourcing / channel needing CBK notice or approval? Safaricom agreement terms | Mock and sandbox only | P3-C2, Q-M |
| E2 | Paying a company supplier into a director's personal M-Pesa wallet vs a company till/paybill; AML treatment of receiver-name mismatches; STR timelines (POCAMLA, goAML) | Only call-back-verified director wallets; name mismatch raises an AML flag; cap KES 150,000 | P3-C3, C-19 |
| E3 | Who bears the B2C charge, and must it be disclosed? | Mapema absorbs it | Q-O, P3-C7 |
| E4 | Outsourcing notices (≥ 30 days before material outsourcing: cloud hosting, Fineract hosting, KYC, payments) (reg. 31) | One notice listing all providers once chosen | C-10 |

## F. Data protection

| # | Question | Default | Source |
| --- | --- | --- | --- |
| F1 | Hosting outside Kenya (staging AWS af-south-1, Cape Town; production TBD): transfer basis under DPA s.48–50 and regs 40–46 of the General Regulations; confirm reg. 26 localisation does not apply; apply the ODPC cross-border guidance note (2026) | Staging synthetic data only; production region after counsel | C-18, Q-09, staging-plan.md |
| F2 | ODPC registration (mandatory for financial services) | Before any real data | C-17 |
| F3 | DPIA for KYC biometrics, CRB and profiling (DPA s.31) | Before real users | Phase 1 |
| F4 | Data-subject request deadline (7 days?) and the conflict between erasure and lending-record retention | 7 days; erasure manual | Phase 1 |
| F5 | Retention schedule (7 years assumed for lending records; logs 1 year) | Draft | Q-16 |
| F6 | Transfers to Xero and HubSpot (hosted abroad); processor agreements | Transfer clauses in processor terms | Phase 2 #6 |
| F7 | Controller/processor roles for the ERP pull; buyer ERP hosted abroad | Buyer = controller of its AP data; Mapema = controller of the advance | P3-C9 |
| F8 | Named loan tapes for debt-facility lenders (confidentiality and privacy-notice basis) | Named only under a signed facility with confidentiality clause; else anonymised | Q-Q, P3-C5 |

## G. Tax

| # | Question | Default | Source |
| --- | --- | --- | --- |
| G1 | Are invoice-discounting fees VAT-exempt financial services? eTIMS invoicing obligations for Mapema's own fee invoices | Fee-invoice hook disabled until advice | C-21, Q-12, Q-J |

## H. Public holidays (go-live)

| # | Question | Default | Source |
| --- | --- | --- | --- |
| H1 | Confirm the business-day calendar: Public Holidays Act (Cap. 110) Schedule Part I as amended by Act No. 3 of 2024 (Mazingira Day 10 Oct), s.4 Sunday rule, s.3 gazetted additions/substitutions, s.2(4)–(5) election and swearing-in days. Part II (Idd-ul-Azha) and Part III (Diwali) are treated as **business days** because they apply to Muslims / Hindus only. Correct for a lender's settlement and notice periods? | As stated; ops adds gazetted days with maker-checker | D-66 |
| H2 | Contract wording: "business day" definition in the master agreement and buyer programme agreement to match the calendar | Draft clause: "a day other than a Saturday, Sunday or public holiday in Kenya under the Public Holidays Act" | D-66 |
