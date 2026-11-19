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
| A10 | **New (bank partnership, 19 Nov 2026; research note added 19 Nov, see "A10 and A11: research so far" below):** Under model A (a licensed bank books and funds every advance, pays suppliers from its own accounts, carries the credit risk and is the secured party on the MPSRA filing; Mapema only provides technology, onboarding, verification and servicing for a platform fee and revenue share), does Mapema itself need NDTCP registration or a licence? **Sharper questions:** (a) Is Mapema outside s.2 CBK Act "non-deposit taking credit business" because it grants no credit "using own funds and assets"? (b) Does any of these pull Mapema back in: Mapema contracting with or charging the supplier directly (e.g. the KES 2,500 verification fee), Mapema setting price or limits, Mapema holding any recourse or first-loss, or the supplier master agreement naming Mapema? (c) Is Mapema a "payment service provider" under NPS Act s.2 limb (iii) ("processes or stores data on behalf of ... payment service providers") if it only sends payment instructions to the bank and never holds funds? (d) Confirm Mapema is a material outsourcing provider to the bank under CBK/PG/16 (needs the bank's prior CBK approval, para 4.1.1) and not a bank agent under CBK/PG/15; what CBK access, audit, data-location and exit clauses must the contract carry? (e) Given PG/16 para 4.1.2 (the decision to grant loans cannot be outsourced), how must the bank sign off each limit and advance in Mapema's maker-checker flow? (f) Data Protection Act: is Mapema a processor for the bank, a controller, or both, and what registration follows? (g) Does the 12 Nov 2026 Delegated Legislation Committee directive change anything for model A? | Treat Mapema as the bank's technology/outsourcing service provider, not a lender: lending switch stays off; no customer funds touch Mapema; collection account in the bank's name; bank staff are the final approver of every limit and advance; all borrower-facing fees charged by the bank. CEO chose model A on 19 Nov 2026. | Bank partnership plan (model A); research below |
| A11 | **New (bank partnership, 19 Nov 2026; research note added 19 Nov, see "A10 and A11: research so far" below):** Can a participating bank place Mapema-originated invoice-discounting / reverse-factoring advances under the National Treasury MSME Credit Guarantee Scheme (PFM (Credit Guarantee Scheme) Regulations 2020, LN 197 of 2020)? **Sharper questions:** (a) Is the scheme (or its successor, the Kenya Credit Guarantee Company) issuing new guarantees now, and under which rules and agreement? Business Daily reported a pause on new guarantees from early 2025. (b) Is a revolving invoice-discounting line an eligible "credit facility" for "working capital" (reg. 10(1)(f)(i)), and does the KES 5m cap apply per line or per invoice? (c) The 3-month lock-in in reg. 14(11)(c) runs from the *last disbursement*; on a revolving line each drawdown restarts it. Is a 30–60 day advance ever claimable? (d) Reg. 11(a) excludes risk already covered by another guarantee or insurer: does buyer confirmation, an irrevocable letter of undertaking (ILU) or trade credit insurance count, and does it exclude the facility or only reduce cover? (e) Who is the "borrower" in reverse factoring: the supplier (an MSME) or the buyer (often not an MSME, so excluded under reg. 11(f))? (f) Standard Chartered is not a participating bank; can it join, or would only KCB's book qualify? (g) Guarantee fee level and who pays it (not stated in the Regulations or on the Treasury page). | Assume **no** CGS cover in pilot pricing until counsel and the partner bank confirm in writing. Do not mention CGS in marketing. | treasury.go.ke/credit-guarantee-scheme; research below |
| A12 | **New (fee research, 19 Nov 2026; see "A12: fee structure under model A" below):** Under model A the pitch price is option D: 1.5% of the advance per 30 days plus a KES 5,000 verification and platform fee. The recommended structure is that the **bank** charges every supplier-facing amount: the discount fee plus a tiered processing fee of 0.5% of the invoice, minimum KES 1,500 and maximum KES 5,000, collected at funding. The bank then pays Mapema a B2B platform fee (the processing fee plus 50% of the margin over its cost of funds). **Questions:** (a) Does any fee Mapema contracts for or collects from suppliers (today's KES 2,500) risk making Mapema a credit provider under the CBK Act and LN 191? Is the bank-charged structure clean? (b) Under CBK/PG/22 para 3.4.6, must the processing fee sit in the bank's tariff, does it need s.44 Banking Act approval as a new charge, and how is it shown in the bank's TCC and APR? (c) s.44A in duplum: does a fee count as "interest" in the cap, and does collecting it at disbursement remove the question? (d) Tax: is the bank's processing fee excisable at 20% as "other fees", with the discount fee excluded as interest or return on the loan? Is Mapema's platform fee to the bank standard-rated at 16% VAT, and does the Finance Act 2026 widening of "royalty" reach it? Does "digital lender" in the Excise Duty Act now cover NDTCPs? (e) If an anchor buyer pays a programme fee instead, is that outside the supplier's cost of credit, and does it ease the CAK buyer-power risk? (f) Is a small supplier a "consumer" under the Consumer Protection Act 2012? | Until answered, no live supplier pricing changes. The platform still models the KES 2,500 verification fee as a fee (A4, A9). Under model A, design for the bank to charge all supplier-facing amounts. | Bank partnership plan, Fee research; research below |

### A10 and A11: research so far (19 Nov 2026, not legal advice)

Desk research by the Compliance & Risk Analyst, for counsel to confirm. Kenya Law (kenyalaw.org) blocked automated
download of LN 191 of 2026, so NDTCP regulation numbers below still come from law-firm commentary or the CBK's
2025 draft, not the gazetted text. Confidence: **high** = primary text read; **medium** = consistent law-firm or
official secondary sources; **low** = inference or single secondary source.

**A10: NDTCP status under model A. Likely answer: no NDTCP licence or registration for Mapema, provided it never
funds, owns or guarantees the advances (medium).**

- The CBK Act s.2 (as amended by the Business Laws (Amendment) Act 2024, s.4) defines "non-deposit-taking credit
  provider" as a person licensed to carry on non-deposit taking credit business **"using own funds and assets"**.
  "Non-deposit taking credit business" covers loans or credit facilities to the public, asset finance, BNPL, credit
  guarantees, PAYG, P2P and "any other activity" the CBK determines. There is **no express mention of factoring or
  invoice discounting**, and **no express carve-out for technology or service providers** to banks. **High** (primary
  text read). Source: [Business Laws (Amendment) Act 2024, s.4 and s.7 (new s.33R)](https://investmentpromotion.go.ke/sites/default/files/2026-07/Business-Laws-%28Amendment%29-Act%2C-2024.pdf).
- The NDTCP Regulations 2026 (LN 191, gazetted 29 Sep 2026) apply to non-deposit taking credit business "not regulated
  under any other written law" and exclude Banking Act institutions (reg. 3(3)(a) per commentary; reg. 2(2)(a) in the
  2025 draft). So the **bank's** book is outside them. Existing unregulated operators must apply by **29 Mar 2027**.
  **High** for the draft text, **medium** for the final numbering. Sources: [CBK 2025 draft, reg. 2](https://www.centralbank.go.ke/wp-content/uploads/2025/08/Draft-Central-Bank-of-Kenya-Non-Deposit-Taking-Credit-Providers-Regulations-2025.pdf);
  [CDH, 28 Oct 2026](https://www.cliffedekkerhofmeyr.com/en/news/publications/2026/Kenya/Corporate-Commercial/corporate-and-commercial-alert-28-october-New-rules-for-non-deposit-taking-credit-providers);
  [Bowmans, 7 Oct 2026](https://bowmanslaw.com/insights/kenya-non-deposit-taking-credit-provider-regulations-are-here-what-lenders-need-to-know/).
- Law-firm view: classification follows **substance**: who advances credit, carries the risk, sets terms, owns the
  receivables and collects. **Medium.** Source: [CM Advocates, 17 Oct 2026](https://www.cmadvocates.com/media/blog/pdf/Kenyas_Non-Deposit_Taking_Credit_Providers_Regulations_2026.pdf).
  The CBK's general "any other entity approved by the Bank" exclusion was **dropped** from the final text, and the
  remaining power to exclude persons is narrow (Bowmans, CDH above). So there is no exemption to apply for. Mapema must
  simply stay outside the definition.
- Risk points that could pull Mapema in (low/medium, inference): Mapema charging the supplier directly (the KES 2,500
  verification fee), owning or buying any receivable, any first-loss or recourse to Mapema, or Mapema being the
  contracting "credit provider" in the supplier agreement.
- **Bank side: outsourcing, not agency.** CBK Prudential Guideline CBK/PG/16 (Outsourcing): para 4.1.1 needs prior
  CBK approval for material outsourcing; para 4.1.4 lists "application processing (loan originations)", "claims
  administration (loan processing, collateral management, collection of bad debts)", KYC and "provision of mobile
  financial services channels/technology" as material. Para 4.1.2: the **decision to grant loans cannot be
  outsourced**. **High** (primary text, 2013 guideline in CBK's consolidated prudential guidelines; counsel to confirm no
  later revision). Source: [CBK Prudential Guidelines, CBK/PG/16, pp. 393–396](https://www.centralbank.go.ke/wp-content/uploads/2016/08/PRUDENTIAL-GUIDELINES.pdf).
- CBK/PG/15 (Agent Banking) defines an agent as an entity contracted to provide the institution's services, with
  permissible activities centred on cash in/out at outlets (para 3.2). Mapema handles no cash and runs no outlets, so
  **agent status looks unlikely** (medium). Same source, pp. 347 onwards.
- **National Payment System Act 2011, s.2**: "payment service provider" includes limb (iii), any person that
  "processes or stores data on behalf of such payment service providers or users". Authorisation under s.12. Limb (iii)
  is broad, so counsel should confirm that sending payout instructions to the bank, with funds only in a bank-named
  account, is not PSP business. **High** for the text, **low** for the conclusion. Source: [NPS Act 2011 (CBK copy), s.2 and s.12](https://www.centralbank.go.ke/images/docs/legislation/NATIONAL%20PAYMENT%20SYSTEM%20ACT%20(No%2039%20of%202011)%20(2).pdf).
- **Credit information**: no rule found that makes a bank's technology provider a credit reference bureau. CRB
  reporting should stay with the bank. **Low**, not researched in depth.
- **"CBK (Amendment) Act 2025"**: not found. The 2024 Business Laws (Amendment) Act is the operative amendment.
- **12 Nov 2026 Parliament directive**: the National Assembly Delegated Legislation Committee directed CBK to suspend the
  rollout and redraft provisions (open-ended discretion, penalties of up to KES 2m under reg. 86, drafting). Bowmans:
  this is **not an annulment**. The Regulations remain in force, the 29 Mar 2027 deadline is unchanged, and the CBK Act
  ban on unlicensed NDTCP business stands. **High.** Sources: [Kenya News Agency, 14 Nov 2026](https://www.kenyanews.go.ke/parliamentary-committee-halts-proposed-cbk-credit-regulations-over-legal-flaws/);
  [Bowmans, 16 Nov 2026](https://bowmanslaw.com/insights/kenya-paused-rollout-of-the-non-deposit-taking-credit-provider-regulations-what-lenders-need-to-know-now/).

**A11: CGS cover for invoice finance. Likely answer: possibly yes in principle through KCB, but not available to plan
on today (medium-low).**

- Eligible borrower (reg. 10): a registered, tax-compliant MSME with a county permit, borrowing for business purposes
  "including working capital". The guarantee covers only "a portion" of the facility. Reg. 11 excludes risk already
  covered by another guarantee or insurer (11(a)), non-MSMEs (11(f)) and financial intermediaries (11(e)). Invoice
  finance is **neither named nor excluded**. **High** (primary text). Source: [PFM (Credit Guarantee Scheme) Regulations 2020, regs 10–16](https://www.treasury.go.ke/sites/default/files/PFM-Credit-Guarantee-Scheme-Regulations-2020.pdf).
- Claims need the facility to be non-performing, recalled and in recovery, and a **3-month lock-in from the last
  disbursement or guarantee-fee payment** (reg. 14(11)). The bank keeps full recourse (reg. 14(8)), and one MSME may not
  use more than 1% of the bank's guarantee funds (reg. 14(2)). A guarantee fee exists (reg. 14(11)(c)) but **no rate is
  published** (not found). **High.** Same source.
- Treasury FAQ: maximum **KES 5m**. Two CGS facilities cannot run concurrently. Participating banks: **Absa, Credit Bank,
  DTB, KCB, NCBA, Stanbic, Co-operative Bank**. **Standard Chartered is not listed.** **High** (official page; may be
  stale). Source: [Treasury CGS page, FAQs 6, 8, 13](https://www.treasury.go.ke/credit-guarantee-scheme).
- Cover and tenor: 50% of outstanding principal, capped at 25% of principal; up to 3 years with up to 5 months' grace.
  **Medium-high** (Treasury report tabled in Parliament). Source: [Annual performance report, MSME CGS (Parliament, Mar 2025)](https://www.parliament.go.ke/sites/default/files/2025-03/Annual%20Perfomance%20for%20the%20MSMEs%20Credit%20Guarantee%20Scheme.pdf).
- Evidence that invoice discounting has been guaranteed in practice: a KBA working paper using a tier-1 bank's
  guarantee-scheme book (2,398 MSMEs, 2022 to Feb 2025) lists "invoice discounting" as a facility type (about 10% of
  loans). It does not say for certain that this is the Treasury CGS. **Medium.** Source: [KBA WPS 03/26, Muli et al., s.3.4 and Table 4.1](https://www.kba.co.ke/wp-content/uploads/2026/05/WPS0326-Muli-et-al.pdf).
  KCB offers invoice discounting of up to 6 months: [KCB product page](https://ke.kcbgroup.com/products/sme-solutions-invoice-discounting).
- **Status risk:** Treasury paused new guarantees in early 2025 pending a new Kenya Credit Guarantee Scheme Company.
  Banks are to own 75%, with plans to widen the scheme to all banks and raise capital from KES 3bn to 10bn. A Sep 2026
  report says the company has been established with a USD 30m facility. **No evidence found that new guarantees
  have resumed** or of new rules. **Medium.** Sources: [Business Daily, 16 Jan 2025](https://www.businessdailyafrica.com/bd/economy/treasury-freezes-uhuru-era-sh10bn-loan-scheme-for-smes-4891090);
  [Business Daily, 21 Sep 2025](https://www.businessdailyafrica.com/bd/economy/banks-to-own-75-percent-of-credit-guarantee-firm-5201334);
  [Business Daily, 21 Dec 2025](https://www.businessdailyafrica.com/bd/economy/smes-set-for-sh50bn-funding-in-expanded-state-backed-scheme-5304704) (CBK draft rules for private credit guarantee companies);
  [Sacco Review, 24 Sep 2026](https://saccoreview.co.ke/msme-financing-kenya-seeks-private-capital-for-small-firms/).
- **Hustler Fund** is a direct digital lending programme, not a bank guarantee scheme (Business Daily, 21 Dec 2025,
  above). **Stawi** was a 2019 CBK-backed bank MSME loan product, not a guarantee scheme, and has stopped lending.
  Sources: [CBK press release](https://www.centralbank.go.ke/uploads/press_releases/825716068_Press%20Release%20-%20A%20Revolution%20in%20the%20Financing%20of%20MSMEs.pdf);
  [Citizen Digital](https://citizen.digital/article/gachora-why-stawi-died-a-natural-death-n295211). Neither covers invoice finance (medium).
- No 2023 or 2024 amendment to the CGS Regulations was found (not found ≠ does not exist; counsel to check).

### A12: fee structure under model A, research so far (19 Nov 2026, not legal or tax advice)

Desk research for counsel and a tax adviser to confirm. Confidence uses the same scale as A10 and A11.

- **Who may charge the supplier.** CBK/PG/22 (Consumer Protection) para 3.4.6(b)–(d) lets a bank's product carry
  **third-party fees**, but the bank must disclose them in advance, and the third party "must be approved by the
  Central Bank of Kenya" under the Outsourcing or Agent Banking guidelines. Para 3.4.5(ii)–(iii): the **total cost of
  credit includes all fees, charges and commissions, including charges paid to third-party providers**. So the fee
  counts in the bank's TCC and APR whoever collects it. **High** (primary text). Source:
  [CBK Prudential Guidelines, CBK/PG/22, pp. 499–500](https://www.centralbank.go.ke/wp-content/uploads/2016/08/PRUDENTIAL-GUIDELINES.pdf);
  cost-of-credit portal: [Banking Circular No. 3 of 2017](https://regalert.today/document/banking-circular-no-3-of-2017-cost-of-credit-website-portal-fcfbf4b0-78ab-4f40-aeb4-985097e4048d) (secondary copy, medium).
- **NDTCP risk.** The 2025 draft defines "charges" as payments a customer makes to a credit provider "in consideration
  of the loan" (draft reg. 3). Law-firm commentary says classification follows substance, including who sets terms
  and collects. A fee that Mapema **contracts for and collects from the supplier** in return for funding is the
  clearest fact that could make Mapema look like a credit provider. A fee the **bank** charges and shares with Mapema
  under an outsourcing contract is not. **Medium/low** (inference from the draft and commentary; see A10). The draft
  also bars NDTCPs from "registration fees or membership fees from loan applicants" (draft reg. on prohibited
  activities (c); see A9). That supports charging only on funded invoices.
- **Banking Act s.44**: "No institution shall increase its rate of banking or other charges except with the prior
  approval of the Cabinet Secretary". The Supreme Court held in *Stanbic v Santowels* [2024] KESC 31 that this
  includes interest rates. A new or higher fee in the bank's tariff may therefore need approval: that is the bank's
  process, and one more reason the bank should own the tariff. **High** for the text and holding, **low** for how it
  applies to a new product fee. Sources: [Banking Act (CBK copy), s.44](https://www.centralbank.go.ke/wp-content/uploads/2026/03/Banking-Act.pdf);
  [Dentons HHM on Santowels, 1 Jul 2024](https://www.dentonshhm.com/en/insights/alerts/2024/july/1/supreme-court-settles-the-applicability-of-section-44-of-the-banking-act-on-interest-rates).
- **In duplum, s.44A**: on a non-performing loan the bank may recover only principal, contractual interest up to that
  principal, and recovery expenses (s.44A(2)). "Loan" includes "any advance, credit facility" (s.44A(5)(b)). Fees are
  not listed separately, so whether an unpaid fee counts as "interest" within the cap, or is irrecoverable once the
  loan is non-performing, needs counsel. Collecting the fee at disbursement (netted from the advance) avoids the
  question. **High** (text), **low** (fee treatment). Same source.
- **Excise duty.** The Excise Duty Act charges 20% on "other fees charged by financial institutions". This is defined as
  fees, charges or commissions "relating to their licensed activities", excluding interest or return on a loan. A
  financial institution is a person licensed under the Banking Act, CBK Act, Insurance Act or Microfinance Act. Digital
  lenders' fees are also 20%. A **bank-charged** processing or verification fee is therefore likely excisable at 20%
  (KES 1,000 on KES 5,000). The discount fee is likely excluded if it is treated as interest or return on the loan.
  Mapema, not being licensed, would likely charge **VAT at 16%** on a fee it charged directly instead. **Medium.**
  Sources: [Excise Duty Act (Kenya Law), First Schedule Part II](https://new.kenyalaw.org/akn/ke/act/2015/23);
  [PwC Kenya](https://www.pwc.com/ke/en/blog/excise-duty.html); [Deloitte on the Finance Act 2021 "other fees" change](https://www.deloitte.com/content/dam/assets-zone1/za/en/docs/services/tax/2023/Tax%20Alert%20-%20The%20Finance%20Act%202021_13%2007%202021.pdf).
  Not found: whether "digital lender" in the Excise Act now covers NDTCPs licensed under LN 191.
- **VAT.** Financial-services exemptions are in the VAT Act 2013 **First Schedule, Part II, para 1** (not the Second
  Schedule), including "(h) the making of any advances or the granting of any credit". The Finance Act 2026 removed
  the exemption for payment processing, settlement, gateway or aggregation services supplied over a platform by a
  payment service provider. Mapema's B2B platform fee to the bank is most likely **standard-rated at 16%**, and a bank
  making exempt supplies may not recover that input VAT, so it is a real cost in the split. **Medium** for the
  structure, **low** for Mapema's classification. Sources: [KCB v Commissioner, TAT 2025, paras 112–115](https://new.kenyalaw.org/akn/ke/judgment/ketat/2025/2/eng%402025-01-17);
  [EY on the Finance Act 2026](https://globaltaxnews.ey.com/news/2026-1445-kenya-enacts-finance-act-2026).
  The Finance Act 2026 also widened "royalty" for withholding tax to cover payments for "access to ... payment networks
  and payment processing systems". Counsel should confirm it does not catch the bank's platform fee to Mapema (low).
- **Competition Act (CAK).** Abuse of buyer power includes delayed payment and "transferring commercial risks and
  operational costs to suppliers". Buyer–supplier contracts must state payment terms. An anchor that lengthens terms and
  pushes the programme's cost onto suppliers carries some risk under this heading. **Medium** (CAK guidance). Source:
  [CAK, Demystifying abuse of buyer power](https://www.cak.go.ke/demystifying-abuse-buyer-power-kenyan-economy).
- **Consumer Protection Act 2012**: s.2 "consumer" is broad enough that a small supplier could qualify. It is not
  clearly excluded. **Low.** Source: [CPA 2012 (Parliament copy)](https://www.parliament.go.ke/sites/default/files/2017-05/ConsumerProtectionActNo46of2012.pdf).
- **Third-party cost floor.** A Collateral Registry search costs KES 500, and registering or cancelling a notice is free.
  **High.** Source: [BRS fee schedule](https://brs.go.ke/fee-schedule-collateral-registry/).

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


## I. Phase 4 security (MPSRA, assignment, factoring, CRB) — added 18 Nov 2026 after CEO sign-off of D-73 to D-80

Do **not** change contract templates until these are answered (D-76). Defaults in the right-hand column are how the platform proceeds in the meantime.

| # | Question | Default | Source |
| --- | --- | --- | --- |
| I1 | Confirm the practical filing path at the Office of the Registrar of Security Rights under the Movable Property Security Rights Act, 2017: who files (Mapema or the supplier), what evidence we should keep, and how long a search certificate remains reliable before funding. | Search before funding, file after, store the registration number, fail closed if the search is missing. Manual portal evidence, maker-checker. No invented API. | D-73, IFC 2022 pp.7–8, 11; Q-S, Q-T |
| I2 | How does a perfected MPSRA filing of an assigned receivable rank against other creditors, especially in insolvency? Has the Insolvency Act been harmonised with MPSRA since IFC 2022 noted the gap? | Proceed on MPSRA + notice of assignment + ILU; counsel to confirm priority. Do not rely on the pre-2017 FSD 2013 finding that “invoices cannot be sold”. | D-76, IFC 2022 p.11; FSD 2013 p.6 (historical) |
| I3 | Anti-assignment clauses in buyer–supplier contracts: can they defeat an assignment to Mapema, and should the buyer programme agreement and supplier master agreement address them expressly? | Current drafts already assign financed invoices in full; add specific anti-assignment language only after counsel drafts it. | D-76, Q-X |
| I4 | Is the small-claims path appropriate for residual supplier balances or buyer shortfalls, and up to what amount? Any specialist recovery forum for assigned receivables? | Keep the current collections ladder and recourse; do not advertise a small-claims path until counsel confirms. | D-76, Q-Y |
| I5 | Has a Kenyan factoring Act, or any amendment that changes the treatment of invoice assignment or a receivables registry, been enacted since the IFC 2022 assessment? If yes, what must Mapema change? | Proceed on MPSRA 2017 + assignment documents until counsel confirms otherwise. | D-76, Q-Z, IFC 2022 |
| I6 | FSD 2013 p.6 suggested a CRB file should include both buyer and supplier. May we add the buyer as a reported party, or must the supplier remain the only borrower on the assumed-layout file? | **No CRB change** until counsel answers (D-80, D-38, D-45). | D-80, Q-W, FSD 2013 p.6 |
