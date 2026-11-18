# Phase 4 report: security

**[Product Manager + Tech Lead]** 18 Nov 2026, Europe/London. Repo `/workspace/mapema/app`, branch `phase-4-security`, local only. Nothing was pushed, deployed or sent, no accounts were created, no live provider was called and no money was spent. The marketing-site Worker was not touched. Mapema is still described everywhere as **not yet licensed**. The worked example is unchanged (KES 1,000,000 over 48 days → advance 800,000, fee 44,800, verification fee 2,500, total cost 47,300, supplier balance 152,700).

- Proposal and study citations: [`proposal.md`](proposal.md)
- Stories and acceptance criteria: [`stories.md`](stories.md)
- Buyer security and data pack (draft): [`buyer-security-and-data-pack.md`](buyer-security-and-data-pack.md)
- Anti-fraud notice (draft): [`anti-fraud-notice.md`](anti-fraud-notice.md)
- Credit insurance note (P4-7): [`credit-insurance.md`](credit-insurance.md)
- Test detail: [`qa-report.md`](qa-report.md)
- Security: [`security-checklist.md`](security-checklist.md)
- Compliance review: [`compliance-review.md`](compliance-review.md)
- Decisions D-73 to D-81: [`../decisions-log.md`](../decisions-log.md)
- Counsel questions I1–I6: [`../go-live/counsel-question-pack.md`](../go-live/counsel-question-pack.md)

## "Done when" check

| Criterion | Status | Evidence |
| --- | --- | --- |
| CEO sign-off of D-73 to D-80 / Q-S to Q-Z is in the decisions log | ✅ | D-73 to D-81, 18 Nov 2026 (Europe/London) |
| P4-1 registry search before funding, file after, registration number stored, fail closed; mock adapter only (no invented API) | ✅ | TC-P4-REG-01..06; `MockRegistry` / `ManualRegistry` |
| P4-2 notify both parties; unique eTIMS CU; similar-invoice review flag | ✅ | TC-P4-DUP-01..03 |
| P4-3 buyer pack + anti-fraud notice as docs; notice on the site as a non-deployed draft; still “not yet licensed” | ✅ | docs + `/legal/anti-fraud` + `site-draft/`; TC-P4W-03 |
| P4-4 counsel questions added to the counsel pack; contracts unchanged | ✅ | pack I1–I6 |
| P4-5 goods-received attestation required at confirmation | ✅ | TC-P4-ATT-01..03 |
| P4-6 eTIMS unavailable cannot proceed to funding | ✅ | TC-P4-ETIMS-01..02 |
| P4-7 credit insurance is a doc note only | ✅ | `credit-insurance.md` |
| P4-8 government-payer flag on the credit file; no CRB change | ✅ | TC-P4-GOV-01..03 |
| Worked example and existing suites still pass | ✅ | see qa-report.md |
| Screenshots and zip | ✅ | `/workspace/mapema/phase-4-shots/`, `/workspace/mapema/mapema-phase-4.zip` |

## What was built

| # | Scope | Built | Where |
| --- | --- | --- | --- |
| P4-1 | MPSRA registry evidence | Search and filing as maker-checker PDF uploads; `REGISTRY_SEARCH` check; ops filing task; mock + portal-only manual adapter | `db/migrations/011_phase4.sql`, `packages/adapters/src/registry.ts`, `apps/api/src/modules/registry.ts`, `advances.ts` |
| P4-2 | Notifications, unique CU, similar flag | `invoice.submitted` to both orgs; unique index on CU; `similar_review` | `invoices.ts`, i18n |
| P4-3 | Drafts | Buyer pack, anti-fraud notice, application draft page, marketing site-draft (not deployed) | `docs/phase-4-security/`, `apps/web/app/legal/anti-fraud/` |
| P4-4 | Counsel pack | I1–I6 | `docs/go-live/counsel-question-pack.md` |
| P4-5 | Attestation | Required on single and bulk approve; optional PO/GRN | `invoices.ts`, `bulk.ts`, buyer / bulk UI |
| P4-6 | eTIMS unavailable | Clear check wording; maker-checker override path | `advances.ts`, `registry.ts` |
| P4-7 | Insurance | Doc note only | `credit-insurance.md` |
| P4-8 | Government payer | Flag + mandatory comment; credit-file UI; CRB unchanged | `onboarding.ts`, `staff-extra.tsx` |

New migration: `011_phase4.sql`. New approval actions: `registry_search`, `registry_filing` (and the existing `etims_override` handler is now implemented). New setting: `ADAPTER_MODE_REGISTRY`.

## Story status (8 Phase 4 items)

✅ 7 built and tested · 🟡 P4-3 / P4-4 / P4-7 need counsel (or a later insurer conversation) before they are published or change contracts · ❌ 0.

## Demo notes

Seed paths (`scripts/seed.mjs`) send `governmentPayerDependent: false`, the goods-received attestation, and a clear approved registry search before credit approves an advance, so `SEED_DEMO_GROWTH=true` still works.

## Screenshots

`/workspace/mapema/phase-4-shots/` (see qa-report.md).

## Questions

Q-S to Q-Z were all accepted as the defaults in D-73 to D-80 on 18 Nov 2026 (Europe/London). No new product questions in this phase. Counsel questions I1–I6 are outstanding and do not block this build.
