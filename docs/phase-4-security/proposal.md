# Phase 4 security proposal

**[Product Manager + Compliance & Risk Analyst + Security Engineer]** 18 November 2026, Europe/London. Branch `phase-4-security`, local only. This is a proposal. No product code was changed, nothing was pushed, no accounts were opened, no money was spent and no live provider was called.

Deng asked that we use the Kenya supply-chain finance studies, with security as the main concern, to tweak the business. The non-negotiables still hold: KES only, stored as integer cents; payments allocated principal, then fees, then interest; maker-checker; Fineract is the ledger; adapters with sandbox and mock modes; append-only audit log; MFA for every user; mobile-first and Swahili-ready; tests first; Mapema is **not yet licensed** and does not provide credit until a licence number is entered and approved; the worked example is unchanged (KES 1,000,000 over 48 days → advance 800,000, discount fee 44,800, verification fee 2,500, Mapema keeps 847,300, supplier balance 152,700).

The studies do not ask us to change the product shape. They confirm it: buyer-led early payment, risk on the buyer, invoices confirmed after delivery, and a platform that reduces fraud and data-sharing fear. The tweaks below tighten legal security over the receivable, fraud controls against duplicate presentation, and the security and data-protection story buyers need before they will connect their systems.

---

## 1. How to use this document

1. Findings, with page-cited quotations from the four studies. No figure or quotation is invented; if a 2013 legal point was later changed, that is said in the same place.
2. What Mapema already covers, so we do not reopen built controls.
3. A prioritised list of concrete changes. Each has a why, the residual gap, effort, and a default decision (**D-73** onwards). Defaults stand unless Deng says otherwise.
4. Open questions **Q-S** onwards, each with a default.

Code work starts only after Deng signs this off (or says "Next" / "Approve"). Counsel items are additions to `docs/go-live/counsel-question-pack.md`, not a substitute for sending that pack.

---

## 2. Sources

Texts were downloaded on 18 November 2026 and converted with `pdftotext`. Page numbers are the printed page numbers in each PDF, not the PDF file index.

| Short name | Document | URL |
| --- | --- | --- |
| IFC 2022 | IFC, *Supply Chain Finance Market Assessment: Kenya*, October 2022 | https://www.ifc.org/content/dam/ifc/doc/mgrt/202210-supply-chain-finance-market-assessment-kenya.pdf |
| FSD 2013 | FSD Kenya, *Supply chain finance support facility: Project briefing note*, 2013 | https://www.fsdkenya.org/wp-content/uploads/2021/aws/Archive%20data%20FSD/13-06-03_Supply_chain_finance_briefing_note.pdf |
| FSD 2015 | FSD Kenya, *Supply chain financing for SMEs*, Project Technical Note, July 2015 | https://www.fsdkenya.org/wp-content/uploads/2021/aws/Archive%20data%20FSD/15-07-30-GrowthCap-Technical-Note-SME-Supply-Chain-Finance.pdf |
| UNCTAD 2025 | UNCTAD, *Unlocking Growth: Determinants of Supply Chain Finance in African Markets*, 2025 (UNCTAD/ALDC/2025/3) | https://unctad.org/system/files/official-document/aldc2025d3_en.pdf |

Field research in IFC 2022 was done between June and December 2021 (IFC 2022, p. 12). FSD 2013 and 2015 predate the Movable Property Security Rights Act, 2017; where the later IFC assessment records a change in the law, the later source is treated as current and the earlier finding is labelled as historical.

---

## 3. Findings

### 3.1 Fraud and buyer trust (the main concern)

This is the finding that most directly answers Deng. In 2013, FSD Kenya recorded that buyers often refuse to cooperate in invoice discounting because they fear fraud:

> "Fear of fraud is another factor preventing buyers from cooperating in IDF. Buyers worry that when their certified invoices are passed on to third parties, multiple (and therefore fraudulent) invoices may be presented and accidentally honoured, leaving buyers responsible to pay for the originals. This is a legitimate fear, and IDF providers must carefully ensure that such practices are impossible." (FSD 2013, p. 4)

The same note says a buyer's first reaction is often mistrust, and that many "view it as charity to their suppliers and added risk and uncertainty for themselves" (FSD 2013, p. 4). The control it recommends is specific:

> "The simplest method is for buyers to sign and certify (with a seal) a specific form, together with the original invoice, in which the buyer approves the transfer of the invoice to a specific IDF provider. The invoice can only be granted when the original is presented together with the attached paper authorizing the transfer. The IDF provider will also send an email to both the original issuer of the invoice (the supplier) and the buyer confirming the submitter and submission date of the original invoice. Such procedures should deal with most buyer concerns of fraud." (FSD 2013, p. 4)

UNCTAD 2025 makes the same control a product requirement, not an optional extra. In its table of SCF products, factoring "Requires robust debtor verification and fraud controls" and "Legal enforcement varies by country"; receivables discounting faces "Legal & regulatory complexity (including tax treatment)" and "Buyer disputes can block repayment" (UNCTAD 2025, p. 5). It also states that electronic invoicing systems "support SCF adoption and reduce invoice fraud risk", and that firms with ERP, electronic invoicing and integrated data platforms are better placed to use SCF "thanks to enhanced information sharing, transparency, and process efficiency" (UNCTAD 2025, p. 34). Kenya now "mandates that deductible expenses must be backed by an e-invoice" (UNCTAD 2025, p. 7).

The 2013 process also required the buyer to sign a receipt of goods note recognising the invoice before the invoice was discounted (FSD 2013, p. 2, process steps 4–5 and 6). That is a delivery-and-acceptance control, not only a signature on a finance form.

Trust cuts the other way too. UNCTAD records that "a small supplier might suspect that a buyer's invitation to join a reverse factoring program is actually a ploy to extend payment terms" (UNCTAD 2025, p. 33). Mapema's marketing and programme wording already need to say clearly that the buyer's due date does not move.

### 3.2 Legal enforceability, assignment and the collateral registry

FSD 2013, written before the 2017 Act, said the legal gap was fundamental:

> "At the macro-level, lack of regulation is a current obstacle to IDF. As invoices are not recognized as legal title papers, they cannot be sold. As a result, buyers are under no obligation to pay an invoice presented by an entity other than the original issuer. This means that IDF can only function when the buyer cooperates." (FSD 2013, p. 6)

IFC 2022 records that this legal position has changed, and that all eight SCF products are now viable in Kenya:

> "It passed the Movable Property Security Rights Act (2017) creating an Office of Registrar of Security Rights to facilitate the registration of ownership of intangible assets. This enabled registration of receivables, thereby decreasing risk when offering receivables-based financing products." (IFC 2022, p. 8)

> "Specifically, the Movable Property Security Rights Act and supporting regulations facilitate the transfer of outstanding receivables and inventory and the movable asset registry provides additional security for SCF transactions." (IFC 2022, p. 8)

> "Despite the contradictions in the legal framework, all eight SCF products are viable from a legal perspective." (IFC 2022, p. 8)

The same assessment, however, says the registry is hard to use and that insolvency law is not fully aligned:

> "although digitized, registering assets on the movable asset registry can be cumbersome and labor-intensive." (IFC 2022, p. 8)

> "While the collateral registry is digitized, banks report that it is still cumbersome and difficult to access and register notification of rights to receivables or other types of collateral." (IFC 2022, p. 11)

> "Yet, enduring shortcomings in the legal framework, such as the lack of full harmonization between the Movable Property Security Rights Act and other relevant laws like the Insolvency Act, may increase the costs of rolling-out SCF." (IFC 2022, p. 8)

Non-bank lenders interviewed by IFC cited "challenges registering outstandings on the collateral registry" among the barriers to scaling SCF, alongside "frequent late payments or default compounded by weak enforcement mechanisms" (IFC 2022, p. 7). Commercial banks likewise named "weak contract enforcement mechanisms impacting both payments along supply chains and bank repayment" (IFC 2022, p. 6).

IFC also records two related legal tools already in place: a small claims court under the Small Claims Act (2016) for disputes "valued at less than 1 million shillings ($9,000)", whose "efficacy is debatable according to interviewed financial institutions"; and "the enforceability of e-signatures via the Business Laws Amendment Act (2020)" together with "an electronic invoicing platform in 2021" (IFC 2022, p. 8). UNCTAD 2025 adds that governments and development institutions are "investing in digital infrastructure like electronic collateral registries and credit bureaus that incorporate supplier payment data" (UNCTAD 2025, p. 35), and that Latin American "electronic invoice registries… sparked a factoring boom for SMEs" (UNCTAD 2025, p. 34). Kenya's eTIMS system is a tax e-invoice mandate, not a factoring registry; it is useful against fake invoices, but it is not a substitute for a search of prior security rights.

FSD 2013 also recommended that "Credit bureaus should receive separate reporting on IDF, including data on both the buyer and supplier per invoice" (FSD 2013, p. 6). That is a data and consent question, not something to start doing on the assumed CRB layout.

### 3.3 Cybersecurity, data protection and ERP integration

This is the second direct "security" finding, and it is about buyer reluctance to connect systems, not only about Mapema's own cyber hygiene:

> "The government should review cybersecurity and data protection laws that foster reluctance among anchor firms and MSMEs to integrate their enterprise resource planning systems with banks to facilitate automated SCF solutions." (IFC 2022, p. 11)

Anchor firms in the IFC interviews already felt the operational pain: "there is no single platform for every customer/supplier, there will be need for integration for the different systems to transparently see invoices and orders between customers, banks and the anchor company" (IFC 2022, p. 5, construction-sector anchor). They "cite frequent challenges in the shift to end-to-end digital engagement owing to incompatible systems between suppliers, buyers, and auxiliary service providers, including banks" (IFC 2022, p. 5). MSMEs had the digital raw material (more than 80 percent already sent electronic or digital invoices to at least some clients; 92 percent used digital payments for at least some transactions; 75 percent used ERP or CRM) but "the gap between the use of digital enterprise resource planning platforms, or customer relationship management systems and digital invoicing and payment may stem from challenges in integrating these systems with those of suppliers and buyers, and of other service providers such as financial institutions" (IFC 2022, p. 4).

FSD 2015 makes the same point from the lender side: "There are typically huge challenges to implement a well-functioning technology and communication system, particularly as there are so many different parties involved in a supply chain. Getting this aspect right can pose a hurdle for entry into SCF" (FSD 2015, p. 12). Sharing information along the chain "generates data that helps to manage risk" (FSD 2015, p. 11).

The implication for Mapema is not "add more encryption for its own sake". The platform already has strong technical controls. The gap is a buyer-facing security and data-protection pack, and counsel-approved terms for the ERP pull, so that a finance director can say yes to integration without fearing a data or cyber incident.

### 3.4 Operational, credit-information and residual credit risk

Other barriers the studies name, which bear on security of recovery even if they are not "cyber":

- **Manual processes.** "Despite high levels of digitization overall, many banks still rely on manual processes for SCF, which limits the potential for scale" (IFC 2022, p. 10). "Many SMEs rely on manual collection processes that are paper intensive. This makes the process slow, unreliable and costly." (FSD 2015, p. 6)
- **Credit is on the buyer, not the supplier.** "the supplier applies for the credit, but the risk depends on the buyer"; "risk assessment and due diligence performed on the client's business partner (the buyer), and not on the bank's client (the supplier)" (FSD 2013, p. 2). "Products held by buyer, invoice approved, but not yet paid. The FI can offer invoice credit to the SME producer using the buyer's credit rating." (FSD 2015, p. 6)
- **Credit insurance is often missing.** "The provision of credit insurance is key to the delivery of SCF products. … Insurance can also mitigate insolvency risk and payment risk. This financial service is not always offered by the provider of other SCF products." (FSD 2015, p. 12). FSD 2015 also lists "credit and transaction dispute insurance" among SCF tools (p. 9).
- **Unreliable formal credit information** makes "trust and word-of-mouth information even more important" (UNCTAD 2025, p. 30).
- **Government payment delays in Kenya**, "particularly in construction and infrastructure projects. Large contractors report waiting months for government disbursements, which creates a cascade effect—leaving subcontractors and suppliers unpaid" (UNCTAD 2025, p. 8, citing IFC 2022).
- **Cost, relationship interference and distrust.** "More than half of all interviewed MSMEs indicated cost as the greatest barrier to using SCF." Further barriers include "concerns that financial institutions may interrupt relationships with key buyers, lack of flexibility in terms of repayment, and general distrust of the financial sector" (IFC 2022, p. 4).
- **Awareness and product approval.** Banks lack internal capacity and market awareness; CBK product-approval processes are described as lengthy (IFC 2022, pp. 6, 8). Tax treatment of fees is flagged by UNCTAD as part of legal and regulatory complexity (UNCTAD 2025, p. 5). Those points are already on the counsel and tax lists (product approval, VAT/eTIMS on fees). They are not new build items.

### 3.5 Buyer-led SCF is still rare in Kenya, and that is a feature

> "In Nigeria and Kenya, however, receivables discounting (Table 1) is the most commonly offered SCF product. This preference exists because receivables discounting relies on relatively simple invoice-based collateral and doesn't require the buyer-led setups that reverse factoring demands." (UNCTAD 2025, p. 4)

FSD 2013's operational lesson is the same model Mapema already chose: start with the buyer, let the buyer introduce suppliers, approve a line, then clear individual invoices in hours (FSD 2013, pp. 2–3). IFC 2022 likewise notes that "Buyer-led products like payables finance could facilitate access to new clients at scale, through an anchor firm streamlining customer acquisition processes" (IFC 2022, p. 6). We should not walk back the buyer-led design. We should make it safer and easier for the buyer to say yes.

UNCTAD's closing condition still applies: SCF scales "only when paired with strong legal frameworks, robust digital infrastructure, and tailored financial products", while "regulatory gaps, limited awareness, and weak enforcement continue to hold back adoption" (UNCTAD 2025, p. 36).

---

## 4. What Mapema already covers

The studies should not be used to invent work that is already in the platform. The mapping below was checked against the brief, the decisions log to D-72, Phase 0–3 and go-live documents, and the code in `apps/api` (invoice insert, ILU, advances, CRB template, ERP and security hardening).

| Study concern | Already in Mapema | Where |
| --- | --- | --- |
| Buyer-led programme; buyer introduces suppliers; risk assessed on the buyer | Year-1 supplier sign-up is by buyer invitation; credit files, programme and limits are buyer-first; supplier limit sits on top | Brief; FSD 2013 lesson already adopted |
| Buyer must confirm the invoice and authorise transfer to a named financier | Buyer maker/checker; the uploader cannot approve; checker or admin signs an Irrevocable Letter of Undertaking (ILU) per invoice or batch (max 200); ILU is a WORM document | `invoices.ts`, D-17 |
| "Original" invoice and tax e-invoice | eTIMS validation at insert; confirmation is refused if eTIMS is `invalid`; credit and release checks require `valid` or a maker-checker `overridden` status | `invoices.ts`, `advances.ts`, `approvals.ts` |
| Duplicate presentation of the same invoice on this platform | Hard block on supplier KRA PIN + normalised invoice number (any amount, any buyer), plus the brief's hash of PIN + number + amount (D-12 / Q-06) | Unique constraints in `001_phase0_schema.sql`; `insertOne` |
| Notice to the buyer that the invoice has been assigned, and payment only to the financier | Notice of assignment PDF generated and stored at funding; buyer notified; notice names the Mapema collection virtual account and says payment to anyone else will not discharge the debt; ILU waives set-off | `advances.ts` `markFunded`; counsel D2 still open on whether e-delivery perfects the assignment |
| Collection into a financier account, not the supplier's account | Virtual collection account per buyer; payment calendar and instructions; matching on virtual account + reference | Phase 1 bank flows; structure of the supplier balance still with counsel (C-03 / A3) |
| Debtor verification, KYC/KYB, sanctions | Smile ID-shaped KYC/KYB adapter (mock); sanctions screening; CRB pull consent-gated; 12-month KYC refresh (D-35) | Onboarding; residual: no beneficial-ownership registry check yet (Phase 1 compliance) |
| Concentration and "do not over-rely on one name" | Configurable limits: 25% per buyer, 10% per supplier, 35% per sector, re-checked at release under a lock | Brief; `security.e2e` |
| Buyer disputes can block repayment | Dispute sets the invoice to `disputed` (reasons include `goods_not_received`, `quality`, `pricing`, `duplicate`); new advances against that buyer are frozen until compliance closes the dispute | TC-OPS-02 |
| Sharing data along the chain / ERP integration | Phase 3 ERP connectors (Odoo and CSV/SFTP complete); read-only, no write-back (D-53); same invoice controls as a manual upload; human checker still confirms and signs the ILU; ERP secrets not stored in the database; egress allow-list, HTTPS, private addresses refused (S-13 / D-71); drop files ClamAV-scanned and fail closed (S-16) | Phase 3; go-live hardening |
| Manual, paper-intensive processes | Portal + ERP + eTIMS + virtual accounts, rather than paper originals as the primary path | — |
| Cyber hygiene, access control, audit | MFA for every user (Keycloak OTP, D-69); server-side BFF OIDC so tokens never reach the browser (D-68); httpOnly sessions and CSRF (D-31); field encryption and report-artefact encryption (D-70); append-only hash-chained audit log; maker-checker on limits, pricing, payouts and roles; payout-account change controls (step-up, cooling-off, call-back) in the threat model (T6) | Go-live security checklist |
| Incident clocks | Runbook starts a 24-hour CBK clock for a significant cyber/fraud incident and a 72-hour ODPC clock for a personal-data breach | `docs/go-live/monitoring.md`; counsel C3 |
| Independent security test before real money | Pen-test scope and RFP draft; D-20: quotes from at least two firms, one Kenyan, before real money moves | `docs/go-live/pentest-scope-and-rfp.md` |
| E-signature enforceability | E-sign adapter with ordered signers and a witness; counsel pack D1 (KICA, Companies Act s.37) already raised | C-09 |
| Licence, product approval, tax on fees, DPA transfers | Already in the counsel pack and tax-advice item; lending switch off; public wording is "not yet licensed" (D-42) | Counsel pack A, F, G |
| Credit bureau reporting of the *supplier* as borrower | Assumed-layout CRB file, DRAFT until the official specification arrives; consent gate (D-45, D-38) | Phase 2 |

Residual gaps that the studies highlight, and that the code and counsel pack do **not** yet close, are listed in section 5. In particular, the Phase 0 threat model already foresaw one of them and deferred it:

> "Invoice already financed elsewhere | … Phase 2: check other financiers' registers if one exists (unverified that one exists in Kenya)" (threat model T7)

IFC 2022 confirms that a receivables register does exist: the Office of the Registrar of Security Rights under the Movable Property Security Rights Act, 2017. That check was not built in Phase 2 and is not in the counsel pack today.

Two smaller gaps against our own earlier defaults: the Q-06 "flag same PIN + amount + date with a different number for review" was not implemented (only the hard PIN + number block is); and invoice creation does not notify both the buyer and the supplier of the submitter and the submission date, which is the FSD 2013 anti-fraud email.

---

## 5. Prioritised changes

Effort: **Small** = days, mostly in this codebase; **Medium** = one to two weeks, or a mix of counsel and build; **Large** = depends on a third party (registry operator, insurer, official specification) and is not a launch blocker. Priority **P0** is before the first live buyer is invited; **P1** is before the first live advance; **P2** is after the first programme, not required to go live.

No change in this list alters the worked example, the 80% advance, the 3.5% per 30 days fee, the KES 2,500 verification fee, the repayment order, or the "not yet licensed" wording.

### P4-1. Search and file the receivable on the Movable Property Security Rights registry (P0, legal / credit-security)

**Why.** IFC 2022, pp. 7–8 and 11: registration of receivables "decreasing risk when offering receivables-based financing products", but lenders still struggle to search and to "register notification of rights to receivables". FSD 2013, p. 6 described the pre-2017 gap (invoices could not be sold); the 2017 Act is the later, governing account. Threat model T7 already planned a check of "other financiers' registers if one exists". This is the official register. It is also the practical answer to "the same invoice financed twice, by someone else".

**Already covered.** Deed of assignment, notice of assignment, ILU, in-platform duplicate block. Counsel D2 asks whether electronic notice perfects the assignment against the buyer, but not whether a registry filing is needed for priority against other creditors or a later insolvency (IFC 2022, p. 8, on the Insolvency Act).

**Change.** Treat a registry search and a post-funding filing as part of the advance, not as a later legal nice-to-have.

1. Ask counsel to confirm the correct filing (assignment, security right, or both), the form, stamp duty if any (already C-09), and how priority works against the Insolvency Act.
2. Before credit approval can pass, staff must attach evidence of a registry search against the supplier (and, if counsel so advises, the buyer) and record the result: clear, conflict, or not-searched-blocked.
3. After funding, ops files the notice and stores the registration number on the advance. A missing filing raises an ops task; it does not silently pass.
4. Build this behind a `CollateralRegistryAdapter` with mock and sandbox modes, like every other provider. Do **not** invent an API. If the registry is portal-only, the first version is a maker-checker evidence upload (search certificate in, registration number in). An API implementation waits on a real interface.

**Effort.** Medium (Small to ship the evidence checklist and adapter shell; Medium once counsel and any portal process are known).

**Default (D-73).** Search before funding, file after funding, store the registration number, fail closed if the search is missing. Manual evidence upload first. Counsel confirms the form. This is a go-live control for live advances, not a reason to delay writing the counsel pack.

### P4-2. Close the remaining duplicate-presentation gaps (P0, fraud)

**Why.** FSD 2013, p. 4: buyers fear multiple, fraudulent invoices being presented to third parties, and they want a confirmation email to *both* the supplier and the buyer at the moment the invoice is submitted, plus a buyer-signed authorisation tied to the original. UNCTAD 2025, pp. 7 and 34: e-invoicing reduces invoice-fraud risk; Kenya already requires an e-invoice for deductible expenses. Unique official invoice identifiers belong in the control set.

**Already covered.** Buyer confirmation, ILU, eTIMS invalid block, PIN + number hard block, notice of assignment and buyer notification at funding, four-eyes on confirmation.

**Change.**

1. When an invoice is created (buyer upload, supplier submit, ERP or CSV), notify **both** the buyer and the supplier: who submitted it, invoice number, amount, issue date, and the eTIMS control-unit number if present. This is the FSD 2013 email, digitised.
2. If an eTIMS control-unit number is present, treat it as unique. A second invoice with the same CU number is a hard block, the same way a repeated PIN + invoice number is.
3. Implement the rest of the Q-06 default that was never built: same supplier PIN + amount + issue date with a *different* invoice number is not a hard block, but is flagged for credit review and shown on the confirmation and approval screens.
4. Keep the ILU as the buyer's authorisation of transfer to Mapema. Counsel can add a short "this invoice, this financier" line if the current ILU draft is not explicit enough; do not invent a paper seal or require a wet-ink original.

**Effort.** Small.

**Default (D-74).** All four points above. The e-invoice, where present, is the "original" for fraud-control purposes (see also D-78).

### P4-3. Buyer security and data-protection pack, so anchors will connect ERP (P0, product / cyber / trust)

**Why.** IFC 2022, p. 11: cybersecurity and data-protection concerns "foster reluctance among anchor firms and MSMEs to integrate their enterprise resource planning systems" with a financier. IFC 2022, pp. 4–5: integration fear, not lack of systems, is what holds digital SCF back. UNCTAD 2025, p. 33: suppliers also mistrust buyer-led programmes as a way to stretch terms. FSD 2013, p. 4: buyers' first reaction is mistrust.

**Already covered.** The technical ERP path is already conservative (read-only, no write-back, allow-listed egress, ClamAV, four-eyes, same invoice controls, MFA, BFF, encryption, audit). Counsel already has D4 (programme-agreement ERP clause), F1–F8 (DPA, DPIA, transfers) and P3-C4 / P3-C9. A pen test is already planned. What is missing is a single pack a buyer's finance and IT directors can read, and a public statement of what Mapema will not do.

**Change.** Write a buyer-facing security and data pack, reviewed by counsel, and attach it to the programme agreement and the buyer pages:

- what data we take from AP / ERP (mapped fields only; raw payloads are not kept — already true);
- that the connector is read-only and never writes back into the buyer's system (D-53);
- access control, MFA, audit, encryption, and incident clocks;
- that we do not change the buyer's contractual due date, and that early payment is the supplier's choice;
- that we do not on-sell the buyer's AP data;
- how a data-subject or buyer exit request is handled;
- a pointer to the independent pen-test letter once staging has been tested.

Also publish a short public anti-fraud notice (threat model T18): Mapema will never ask a supplier, by SMS or email, to change bank details via a link.

**Effort.** Small for the pack and site/legal pages; counsel review is the critical path. No change to lending maths.

**Default (D-75).** Yes. Draft the pack in this phase after sign-off; it is not published on the marketing site until counsel has reviewed it. The site continues to say Mapema is not yet licensed.

### P4-4. Add the missing legal-security questions to the counsel pack (P0, legal)

**Why.** IFC 2022, p. 8: MPSRA is not fully harmonised with the Insolvency Act, and that may raise the cost of SCF. IFC 2022, pp. 6–7: weak enforcement, late payment and default. IFC 2022, p. 8: small-claims court exists for disputes under KES 1 million, but institutions doubt it. UNCTAD 2025, p. 5: buyer disputes can block repayment; legal enforcement varies. FSD 2013, p. 6 (historical): without buyer cooperation or a clear title, a third-party presenter could not compel payment — the modern residual is anti-assignment clauses in the supplier–buyer contract, and priority in insolvency.

**Already covered.** Counsel pack sections A–H already cover licensing, the supplier-balance structure, e-signatures, whether e-delivery of the notice of assignment perfects the assignment, stamp duty (C-09), recourse, CRB consent, DPA and tax. Those stay. This item only adds what the studies raised and the pack does not yet ask.

**Change.** Add counsel questions (suggested pack ids I1–I5):

1. MPSRA search and filing: correct form, who must sign, fees, stamp duty, and whether filing is required for priority against other creditors (ties to D-73).
2. Priority of an assigned or charged receivable in a supplier or buyer insolvency, given the IFC finding on the Insolvency Act.
3. Anti-assignment or payment-instruction clauses in the underlying supply contract: does the ILU plus notice plus registry filing override them, or must the programme agreement include a buyer waiver and a supplier warranty?
4. Recovery path: small claims court for invoices under KES 1 million versus the ordinary courts; whether that belongs in the ILU or the programme agreement.
5. Whether any factoring-specific statute has been enacted in Kenya since the IFC 2022 finding that the eight SCF products are already viable. Default until counsel answers: proceed on MPSRA plus the assignment documents, as IFC described.

**Effort.** Small for the pack update; the legal work is counsel's.

**Default (D-76).** Add these questions to the counsel pack in this phase. Do not change contracts or code until counsel answers. Do not assume a dedicated Kenyan factoring Act exists.

### P4-5. Goods-received attestation at confirmation (P1, fraud / dilution)

**Why.** FSD 2013, p. 2: the buyer signs a receipt of goods note recognising the invoice before it is discounted. UNCTAD 2025, p. 5: buyer disputes can block repayment. Financing an invoice for goods not received is the classic dilution fraud, including where buyer and supplier collude (threat model T7 residual: collusion).

**Already covered.** Confirmation four-eyes; optional `po_reference`; dispute reason `goods_not_received`; disputes freeze further advances. Proof of delivery is not required, and the checker does not currently attest to receipt.

**Change.** At approve, the buyer checker must attest that the goods or services have been received, or must give a reason for confirming without receipt (for example a contractual milestone). A purchase-order or goods-received reference stays optional but is prompted. No new document type is mandatory in version one, so we do not slow the 24-hour path with a paper GRN. Credit sees the attestation on the approval screen.

**Effort.** Small.

**Default (D-77).** Mandatory attestation, optional supporting reference. Collusion remains a residual credit risk, limited by buyer and supplier caps.

### P4-6. Treat the eTIMS invoice as the working original (P1, fraud / operations)

**Why.** UNCTAD 2025, pp. 7 and 34; IFC 2022, p. 8 (electronic invoicing platform launched in 2021). FSD 2013, p. 4 wanted an "original" invoice. In 2026 the official original, for a Kenyan taxable supply, is the e-invoice, not a PDF the supplier can print twice.

**Already covered.** eTIMS validation; invalid invoices cannot be confirmed; funding requires `valid` or a maker-checker override. An `unavailable` result can still be confirmed and ILU-signed, but it cannot be funded until it is overridden or a later check returns `valid`. There is no uniqueness rule on the control-unit number (that is in D-74).

**Change.** Policy, not a new fee: Mapema treats the eTIMS record, when present, as the original invoice. Paper copies are supporting evidence only. Keep the current funding gate (`valid` or maker-checker `overridden` with a reason). Do not relax it. Surface "eTIMS unavailable — cannot fund until validated or overridden" clearly on buyer, supplier and credit screens. CU uniqueness is D-74.

**Effort.** Small (mostly copy and a clearer status on existing screens).

**Default (D-78).** As above. An eTIMS outage must not be a silent pass to funding.

### P4-7. Portfolio credit insurance after the first programme (P2, credit-security)

**Why.** FSD 2015, pp. 9 and 12: credit insurance is "key" and can mitigate insolvency and payment risk, but "is not always offered" alongside other SCF products. IFC 2022, p. 7: late payment and default plus weak enforcement. Mapema already has recourse to the supplier at 30 days past due (D-43, counsel to confirm) and concentration limits. Insurance is residual protection against buyer default, not a replacement for those controls.

**Already covered.** Recourse workflow, NPL and in-duplum rules, collections ladder, buyer and supplier and sector limits. No insurance product and no insurance adapter.

**Change.** After the first live programme is running, seek a portfolio credit-insurance quote covering buyer non-payment. Do not build an insurance adapter, do not change pricing, and do not delay staging or the pen test for this. If a policy is bound later, record the policy number against the programme and the insurer as a recovery party in ops, under counsel's wording.

**Effort.** Large in calendar time (broker and underwriter), Small in engineering until a policy exists.

**Default (D-79).** Not a launch blocker. Raise it after the first programme. No change to the worked example or to fees.

### P4-8. Credit-policy flags: government-payable cascade, and CRB reporting of the buyer (P2, credit / data)

**Why.** UNCTAD 2025, p. 8 (citing IFC 2022): Kenyan government payment delays, especially in construction, cascade unpaid subcontractors and suppliers. FSD 2013, p. 6: credit bureaus should receive IDF data on both the buyer and the supplier. UNCTAD 2025, p. 30: formal credit information is unreliable.

**Already covered.** Sector cap 35%; construction is not excluded. The assumed CRB file reports the **supplier** as the borrower only. The lender pack already names both buyer and supplier. Official CRB format is still outstanding (Q-A). Reporting a buyer who is not the borrower, without a clear legal basis, would be a data-protection and CRB-regulation risk.

**Change.**

1. On the buyer credit file, add a mandatory flag: whether a material part of that buyer's own receipts is from government or a state entity. A credit officer must comment before a construction (or government-dependent) programme is approved. Do not invent a tighter sector cap; keep 25 / 10 / 35 unless Deng wants a different number.
2. Do not add the buyer as a CRB subject on the assumed file. Ask counsel (with the official CRB specification, when it arrives) whether a related-party or invoice-debtor field is permitted and required. Until then the file stays supplier-borrower only, and DRAFT.

**Effort.** Small for the credit-file flag; CRB change is blocked on counsel and the official specification.

**Default (D-80).** Flag and mandatory comment, yes. No change to the CRB file until counsel and the official specification say so. Sector limits unchanged.

---

## 6. Open questions (defaults apply if Deng does not answer)

These follow Q-K to Q-R (Phase 3) and GL-1 to GL-10 (go-live). They do not replace the outstanding questions already in those documents.

| ID | Question | Default |
| --- | --- | --- |
| Q-S | Should every live advance require a Movable Property Security Rights registry search before funding and a filing afterwards? | Yes (D-73). Counsel confirms the form. Manual evidence upload until a real interface exists. |
| Q-T | Does the registry offer an API or only a web portal? | Assume portal-only. Do not invent an integration. Deng or counsel can correct this when they have the Office of the Registrar of Security Rights' current process. |
| Q-U | Must the buyer checker attest that goods or services have been received before confirming an invoice? | Yes (D-77). A PO or GRN reference is optional. |
| Q-V | Should Mapema buy portfolio credit insurance? | Seek quotes after the first live programme; not a launch blocker (D-79). |
| Q-W | May the CRB file include the buyer as well as the supplier? | No, until counsel and the official CRB specification say so (D-80). |
| Q-X | Should construction, or buyers who themselves wait on government payers, have a tighter sector cap than 35%? | No new cap. Mandatory credit-file flag and officer comment (D-80). |
| Q-Y | May the buyer security and data pack be drafted now and published after counsel review, including a public anti-fraud notice? | Yes (D-75). The site still says Mapema is not yet licensed. |
| Q-Z | Implement the two-sided submission notice, eTIMS CU uniqueness, and the similar-invoice review flag in this phase once the proposal is signed off? | Yes (D-74). Small code change, tests first, worked example unchanged. |

---

## 7. What this phase will not change

- The worked example, pricing, advance rate, verification fee, repayment order, or concentration limit defaults.
- The "not yet licensed" wording, the lending switch, or any claim that Mapema is a licensed credit provider.
- The buyer-led model, invitation-only supplier onboarding in Year 1, or the rule that a human credit officer approves every advance.
- Fineract as the ledger; KES only; maker-checker; adapter sandbox and mock modes; the append-only audit log; MFA for every user.
- Go-live blockers already on Deng's list: cloud account and staging, pen test, provider sandboxes, sending the existing counsel pack, tax advice, official CBK and CRB formats. Those remain the path to live money. This proposal adds controls and questions; it does not replace them.

---

## 8. Suggested sequence, if this proposal is approved

1. Add I1–I5 to the counsel pack and send the pack (still Deng's action with a Kenyan advocate).
2. Draft the buyer security and data pack (D-75) for counsel review; add the public anti-fraud notice in draft.
3. Build D-74 and D-77 and the D-80 credit-file flag, with tests first, on this branch. Still no push unless Deng asks.
4. Build the D-73 registry adapter shell and the search-and-file checklist, using the mock until the real process is known.
5. After the first live programme, run D-79 (insurance quotes) and reopen Q-W if the official CRB specification includes a buyer or invoice-debtor field.

---

*This document is not legal advice and is not a claim of current licensing. Quotations are from the four studies listed in section 2, with printed page numbers. IFC market-size and supply figures (for example the 7 to 10 percent of potential SCF supply in Kenya) are the studies' figures, not Mapema's, and are not used as Mapema forecasts.*
