# Go-live readiness (branch `go-live-hardening`)

**[Tech Lead]** 18 Nov 2026. Started by Deng's "Next" after the Phase 3 sign-off (D-64). This branch hardens the
platform and writes the plan to go live; it is **not merged to main** and **no pull request has been opened**.
Nothing was deployed, no accounts were opened, no money was spent, no live provider was called and the marketing-site
worker was not touched. Mapema is **not yet licensed**; lending stays off until a licence number is approved.

The non-negotiables still hold and are re-tested: KES only in integer cents; allocation principal -> fees -> interest;
maker-checker; Fineract is the ledger; every provider behind an adapter with mock and sandbox modes; append-only,
hash-chained audit log; MFA for everyone; mobile-first and Swahili-ready; the worked example 800,000 / 44,800 / 2,500 /
847,300 / 152,700.

## What was fixed

| Item | Summary |
| --- | --- |
| S-09 | Report artefacts encrypted in the application (AES-256-GCM, AAD-bound), integrity-checked on download; legacy rows script |
| S-12 | M-Pesa callback token masked in API logs/errors and nginx; rotation with an audited previous token; optional IP allow-list |
| S-13 | ERP egress allow-list, https only, private addresses refused after DNS, no redirects (fail closed) |
| S-14 | Integration users flagged, out of staff lists and access reviews, listed as service accounts, can never sign in |
| S-15 | Batch approvals re-check the approver's step-up age per item (`BATCH_STEP_UP_WINDOW_SEC`, 900 s) |
| S-16 | CSV drop: file-type/symlink/permission checks, ClamAV scanning with quarantine, fail closed; SFTP chroot config |
| D-32 | Server-side OIDC (BFF): tokens never reach the browser |
| SYS-05 | MFA proven end to end with a real Keycloak 26.8.2 (4 live tests) and codified in `scripts/keycloak-configure.mjs` |
| Holidays | Kenyan business-day calendar (Public Holidays Act, Cap. 110, as amended 2024), seeded, ops adds gazetted days with maker-checker; used in the recon timing window and reminders |
| ESLint | Flat config, `npm run lint` clean, in CI |
| picomatch | No fix exists upstream (4.0.7 is the latest and affected); dev-only; accepted and re-checked monthly |

## Documents

| File | What |
| --- | --- |
| [staging-plan.md](staging-plan.md) | Hosting options in/near Kenya, DPA residency, monthly cost **estimate** with sources |
| [../../infra/terraform](../../infra/terraform) | IaC skeleton (validated, never applied) |
| [../../.github/workflows/deploy-staging.yml](../../.github/workflows/deploy-staging.yml) | CD to staging: manual and disabled |
| [backup-and-restore.md](backup-and-restore.md) | Backups, PITR, monthly restore test (`scripts/restore-check.mjs`) |
| [monitoring.md](monitoring.md) | Signals, alert thresholds, incident clocks |
| [pentest-scope-and-rfp.md](pentest-scope-and-rfp.md) | Pen-test scope and RFP draft |
| [provider-sandbox-checklist.md](provider-sandbox-checklist.md) | Bank, eTIMS, CRB, KYC, e-sign, SMS, email, Daraja, Xero, HubSpot, ERP: what Deng supplies |
| [counsel-question-pack.md](counsel-question-pack.md) | Every legal question from Phase 0 to go-live, with the current default |
| [go-live-checklist.md](go-live-checklist.md) | Each "done when" and compliance item: done / blocked on whom |
| [security-checklist.md](security-checklist.md) | Closed and open security items |
| [qa-report.md](qa-report.md) | Test results, CI runs |
| [keycloak-local.md](keycloak-local.md) | Running and testing Keycloak MFA locally |
| [sftp-drop.md](sftp-drop.md) | SFTP drop host configuration |

## Blockers (outside the build team)

1. **Staging**: Deng opens the cloud account (AWS af-south-1 by default) and the GitHub deploy role.
2. **Pen test**: choose a firm from the RFP once staging exists.
3. **Provider sandboxes**: agreements and keys (provider-sandbox-checklist.md).
4. **Counsel**: licence path, product approval, supplier-balance structure, M-Pesa channel, hosting/transfers, DPIA,
   ODPC registration, holiday/DPD reading (counsel-question-pack.md). **Tax** advice on fees.
5. **CBK and CRB formats** for the returns and the bureau file.

## Questions for Deng (defaults apply if you don't answer)

| # | Question | Default |
| --- | --- | --- |
| GL-1 | Staging host? | AWS af-south-1 (Cape Town), synthetic data only, about USD 330/month (estimate); production region after counsel |
| GL-2 | Who opens the cloud account and holds the root login? | You (root MFA, billing alarm at USD 400); your developer gets a scoped role |
| GL-3 | Pen-test firms to invite? | Two firms, at least one Kenyan; budget agreed after quotes |
| GL-4 | Domain for staging and the sending domain for email? | A domain you control (not mapema.co.ke mail until that is set up) |
| GL-5 | DPD on holidays: count calendar days from the due date? | Yes (D-67), counsel to confirm |
| GL-6 | Who may add gazetted holidays? | Ops proposes, a different ops user approves (as built) |
| GL-7 | Batch step-up window | 15 minutes |
| GL-8 | Merge `go-live-hardening` into main? | Not until you say so; I can open a PR for review when you ask |
| GL-9 | Restore-test owner and day | Ops engineer, first Tuesday of the month, 10:00 EAT |
| GL-10 | On-call contact for alerts | You, until an ops engineer is hired |
