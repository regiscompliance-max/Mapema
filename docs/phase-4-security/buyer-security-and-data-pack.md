# Buyer security and data pack (draft)

**[Product Manager + Compliance & Risk Analyst + Security Engineer]** Draft for counsel review (D-75). Not a customer-facing publication until counsel signs it off. Mapema is **not yet licensed** by the Central Bank of Kenya as a non-deposit-taking credit provider and does not provide credit until licensed.

This pack is what a cautious Kenyan accounts-payable or treasury team can be given to explain how Mapema reduces invoice fraud and what data we process. It draws on the approved Phase 4 controls (D-73 to D-80) and on earlier platform controls (four eyes, eTIMS, ILU, notice of assignment, MFA, encryption, append-only audit).

## 1. What Mapema is

A buyer-led early-payment service. A supplier is paid early only after the buyer has confirmed the invoice and signed an irrevocable letter of undertaking (ILU) to pay Mapema in full, on the due date, without set-off, into Mapema's collection account. The supplier assigns the financed invoice to Mapema.

## 2. How we check an invoice before money moves

1. **Submission notice.** When an invoice is uploaded (by the buyer, the supplier, a CSV or the buyer's ERP), both organisations are notified (D-74, FSD 2013 p.4).
2. **Duplicates.** The same supplier KRA PIN and invoice number cannot be submitted twice. A hash of PIN, number and amount is also blocked. Similar invoices (same PIN, amount and date, different number) are flagged for review, not auto-rejected.
3. **eTIMS.** The invoice is validated against KRA eTIMS using the control-unit number. A CU number cannot be reused. If eTIMS is unavailable the invoice may still be confirmed, but it **cannot proceed to funding** until a credit officer records a documented override approved by a second person (D-78, UNCTAD 2025 p.34).
4. **Goods or services received.** The buyer checker (who cannot be the uploader) must attest that the goods or services have been received, or give a short reason for confirming without receipt (for example a contractual milestone). A purchase-order or GRN reference is optional (D-77).
5. **ILU.** The buyer signs an irrevocable undertaking to pay in full on the due date.
6. **Registry search.** Before funding, credit officers search the Movable Property Security Rights registry (Office of the Registrar of Security Rights, MPSRA 2017) in the official portal and upload the certificate. A second person approves the search. Funding is blocked if the search is missing or a conflict has not been waived. After funding, the assignment is filed and the registration number is stored (D-73, IFC 2022 pp.7–8, 11). There is no invented registry API.
7. **Limits and four eyes.** Concentration limits (buyer 25%, supplier 10%, sector 35%) and the float are re-checked at approval and at release. Credit approves; a different ops user releases. MFA and step-up apply.

## 3. Data we process about the buyer and its people

Company identity, KRA PIN, sector, directors and authorised signatories (including ID numbers, held encrypted), bank accounts, invoices, ERP records we are allowed to read, credit-bureau reports (with consent), the government-payer dependency flag, and an append-only audit trail. Legal basis, retention, processors and rights are in the draft privacy notice. ERP integration is read-only: we do not write back to the buyer's system (D-53). Hosting and cross-border transfers remain counsel items (pack F).

## 4. What we ask of the buyer

- Keep authorised signatories and checkers current; do not let the uploader approve their own invoices.
- Tell us if a programme depends on a government payer, especially in construction (D-80, UNCTAD 2025 p.8).
- Pay financed invoices only to the Mapema collection account named on the notice of assignment.
- Raise a complaint immediately if an invoice was not authorised.

## 5. Status of this pack

Draft, version BSDP-2026-11-v1, 18 Nov 2026 (Europe/London). Subject to Kenyan counsel review together with the programme agreement, ILU, privacy notice and anti-fraud notice. Not for publication on the marketing site until that review is done.
