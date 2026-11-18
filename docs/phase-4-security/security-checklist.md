# Phase 4 security checklist

**[Security Engineer]** 18 Nov 2026, Europe/London. Adds to the Phase 0 / 1 / 2 / 3 and go-live checklists; those still apply.

| Item | Status | Notes |
| --- | --- | --- |
| No invented MPSRA API; no live registry calls | ✅ | `MockRegistry` / `ManualRegistry` (portal-only stub). Funding depends on uploaded evidence, not on the adapter result. |
| Registry evidence is PDF, type-sniffed, size-capped, malware-scanned (existing hook), stored encrypted, WORM | ✅ | `registry_search_certificate`, `registry_filing_evidence` |
| Maker-checker on search, filing and eTIMS override | ✅ | Four-eyes constraint; required roles credit / ops |
| Funding fail-closed without an approved clear or waived search | ✅ | `REGISTRY_SEARCH` in `AdvancesService.checks`, also at release |
| eTIMS unavailable cannot be funded without override | ✅ | Existing `ETIMS_VALID` gate kept; wording named; override is maker-checker |
| Unique eTIMS CU | ✅ | Unique index + `DUPLICATE_ETIMS_CU` |
| Similar-invoice flag is review-only; financed same PIN+amount+date still hard-blocked | ✅ | `similar_review` vs existing `NO_DUPLICATE` |
| Notifications go to both parties at submission | ✅ | `invoice.submitted` |
| Attestation required at confirmation; four eyes still first | ✅ | Uploader cannot approve even if they omit the attestation |
| Government-payer comment is audited on the organisation | ✅ | `organisation.government_payer.set` |
| CRB file unchanged (supplier is the borrower) | ✅ | D-80; TC-P4-GOV-03 |
| “Not yet licensed” wording preserved; draft notice is not a live publication | ✅ | `/legal/anti-fraud` banner; marketing Worker not deployed |
| MFA, step-up, append-only audit, KES cents, no secrets in `.env.example` | ✅ | Existing controls; new env flag is `ADAPTER_MODE_REGISTRY=mock` with a comment |
| Production refuses `ADAPTER_MODE_REGISTRY=mock` | ✅ | Factory rule unchanged; live/sandbox is the manual stub |
