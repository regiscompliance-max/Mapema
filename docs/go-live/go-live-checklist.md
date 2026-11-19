# Go-live checklist

**[Product Manager + Compliance + Tech Lead]** 18 Nov 2026. Every "done when" from the brief and every compliance item,
with its status. ✅ done · 🟡 built, waiting on an outside input · ❌ not done · ⛔ blocked on whom. Mapema is **not yet
licensed**; lending stays switched off until the licence number is entered and approved by a second person.

## 1. Brief "done when" criteria

| Phase | Criterion | Status | Blocked on |
| --- | --- | --- | --- |
| 1 | Worked example under the direct-legacy profile (D-82; KES 1,000,000, 48 days: 800,000 advance, 44,800 discount fee, 2,500 verification, 847,300 to Mapema, 152,700 to the supplier) end to end with correct fees, repayment order and payouts. The bank-funded-A example (19,200 + 5,000 = 24,200, balance 175,800) is covered in pricing-model-a tests. | ✅ locally on mock and real Fineract 1.16.1 · ❌ in staging | ⛔ Deng: cloud account (staging-plan.md) |
| 1 | All tests green | ✅ (qa-report.md) | — |
| 1 | Pen-test findings fixed | ❌ no independent test yet | ⛔ Deng: pick a firm (pentest-scope-and-rfp.md), after staging |
| 2 | Monthly CBK and lender reports with no manual edits | ✅ lender pack · 🟡 CBK return and CRB file DRAFT | ⛔ CBK template, CRB specification (Q-A) |
| 2 | Daily reconciliation with zero unexplained breaks | ✅ locally (now holiday-aware) · 🟡 real bank feed | ⛔ partner bank (Q-B) |
| 3 | First buyer submits invoices automatically from its ERP | ✅ local Odoo-compatible server · 🟡 real tenant | ⛔ first buyer's Odoo test database + integration user (Q-K) |
| 3 | Advances tagged to a funding source | ✅ (real Fineract) · 🟡 real facility | ⛔ first debt facility term sheet (Q-P) |
| GL | MFA for every user end to end (SYS-05) | ✅ real Keycloak 26.8.2, TC-GL-KC-01..04 | supplier SMS OTP needs an extension (D-12) |
| GL | Security items S-09, S-12..S-16, D-32 | ✅ (security-checklist.md) | — |
| GL | Kenyan holiday calendar | ✅ seeded, maker-checker, used in recon and reminders | counsel to confirm (pack H1, B4) |
| GL | Lint clean, CI on the branch | ✅ | — |

## 2. Infrastructure and operations

| Item | Status | Blocked on |
| --- | --- | --- |
| Staging environment | ❌ IaC skeleton validated (`terraform validate`), deploy workflow disabled | ⛔ Deng: AWS account, GitHub OIDC role, `staging` environment, `STAGING_ENABLED` |
| Domain, TLS, sending domain | ❌ | ⛔ Deng: domain choice and DNS access |
| Backups / PITR / monthly restore test | 🟡 designed, restore check script + test (TC-GL-BAK-01) | ⛔ staging |
| Monitoring and alerting | 🟡 designed (monitoring.md), core alarms in Terraform | ⛔ staging; on-call contact from Deng |
| Secrets in a secret manager, `STORAGE_ENCRYPTION_KEY` offline copy | ❌ | ⛔ Deng (holds the key) |
| SFTP drop host | 🟡 configuration written (sftp-drop.md) | ⛔ staging; Q-L |
| Keycloak in staging, admin console not public | 🟡 script + realm ready | ⛔ staging |

## 3. Providers (provider-sandbox-checklist.md)

| Provider | Status | Blocked on |
| --- | --- | --- |
| Partner bank | 🟡 adapter + mock/sandbox | ⛔ Deng: bank choice and sandbox agreement (Q-B) |
| eTIMS integrator | 🟡 | ⛔ Deng: integrator contract (Q-23) |
| CRB | 🟡 | ⛔ Deng: Metropol/TransUnion subscriber agreement + spec (Q-A) |
| KYC (Smile ID) | 🟡 | ⛔ Deng: sandbox keys; DPIA first |
| E-signature | 🟡 | ⛔ counsel: recognised CSP (C-09), then Deng |
| SMS (Africa's Talking) | 🟡 | ⛔ Deng: sandbox key, sender id |
| Email (Postmark) | 🟡 | ⛔ Deng: account, sending domain |
| M-Pesa Daraja | 🟡 sandbox-ready | ⛔ counsel (E1/E2) then Deng: Daraja app, later shortcode |
| Xero | 🟡 | ⛔ Deng: Xero org + app; accountant's GL map (Q-E) |
| HubSpot | 🟡 | ⛔ Deng: portal, token; D1 read-only token (Q-F) |

## 4. Compliance (counsel-question-pack.md)

| Item | Status | Blocked on |
| --- | --- | --- |
| CBK licence / registration (C-01) | ❌ | ⛔ Deng + counsel (A1) |
| Product and pricing approval (C-02) | ❌ | ⛔ counsel + CBK (A2) |
| Supplier-balance structure (C-03) | 🟡 default built | ⛔ counsel (A3) |
| Fee classification, APR, early repayment (C-04..C-06) | ✅ built · 🟡 confirmation | ⛔ counsel (A4–A6) |
| NPL cap and periods (C-07) | ✅ stricter cap built | ⛔ counsel (B1, B4) |
| E-signature and assignment (C-09) | 🟡 | ⛔ counsel (D1, D2) |
| Outsourcing notice to CBK ≥ 30 days (C-10) | ❌ | ⛔ Deng after providers are chosen (E4) |
| Complaints SLAs (C-11) | ✅ | — |
| Debt-collection conduct, reminder wording (C-12) | ✅ business days, 08:00 EAT · 🟡 wording review | ⛔ counsel + Swahili translator (Q-I) |
| CRB consent and notices (C-13) | 🟡 | ⛔ counsel (C1) |
| Cyber controls and incident reporting (C-14) | ✅ controls · 🟡 runbook | ⛔ staging; counsel (C3) |
| Regulatory returns (C-15) | 🟡 DRAFT | ⛔ CBK template |
| KES only (C-16), audit trail (C-22) | ✅ | — |
| ODPC registration, DPIA, retention, DSR (C-17) | ❌ | ⛔ Deng + counsel (F2–F5) |
| Hosting / transfers (C-18) | 🟡 staging default | ⛔ counsel (F1) |
| AML/CFT (C-19) | 🟡 | ⛔ counsel (E2); goAML registration by Deng |
| Accessibility WCAG 2.2 AA (C-20) | ✅ automated checks · 🟡 manual audit | ⛔ external accessibility review (optional) |
| Tax on fees, eTIMS for fee invoices (C-21) | ❌ hook disabled | ⛔ tax adviser (G1) |
| Swahili strings reviewed by a native financial translator | 🟡 | ⛔ Deng: translator |
| Public site says "not yet licensed" | ✅ unchanged | — |
