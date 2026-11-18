# Phase 2 QA report

**[QA Engineer]** 18 Nov 2026, runs between 05:45 and 05:57 GMT (London).

Environment: Node 24 · PostgreSQL 17 (embedded) · Apache Fineract **1.16.1** (binary, JDK 25, `http://localhost:8443`, tenant `default`, Fineract's local demo login) · vitest 5.1.0 · Google Chrome via playwright-core + axe-core.

## Tests first

The tests were written from `stories.md` and committed red before the code: commit `a81b667` ("stories + tests first (red)"). The code went green in commit `3b0a6a9`. The web screen tests (TC-P2W-01..03) were written in the same session as the screens; they check structure, wiring to real API routes and wording, while behaviour on screen is covered by the browser check.

## Results

| Command | Result | Time |
| --- | --- | --- |
| `npm test -w @mapema/pricing` | ✅ 41 / 41 (10 new: TC-P2U-COL-01..05) | 0.2 s |
| `npm test -w @mapema/adapters` | ✅ 23 / 23 (10 new: TC-P2U-ADP-01..04 + factory) | 0.2 s |
| `npm test -w @mapema/api` | ✅ 110 / 110 (33 new: 25 `phase2.e2e`, 8 `recon-engine`) | 12.0 s |
| `npm test -w @mapema/worker` | ✅ 3 / 3 (TC-P2-WRK-01 new) | 0.4 s |
| `npm test -w @mapema/web` | ✅ 62 / 62 (25 new: TC-P2W-01..03) | 0.2 s |
| `npm run test:fineract` | ✅ 6 / 6 on real Fineract | 2.1 s |
| `npm run test:e2e:fineract` | ✅ 109 passed, 1 skipped (TC-P2-COL-04, mock-only hook) on real Fineract; test titles say `[ledger=real Fineract]` | 18.7 s |
| `scripts/phase2-shots.mjs` on the demo month | ✅ 18 / 18 checks; axe 0 serious/critical on 9 screens; 0 console errors | 7 s |
| `npm run lint:openapi` | ✅ valid (128 operations) | 1 s |

## Money to the cent

| Test | What it proves |
| --- | --- |
| TC-P2-REC-01 | Worked example settles with allocation principal 80,000,000 / fees 250,000 / interest 4,480,000 / supplier balance 15,270,000 cents (= KES 800,000 / 2,500 / 44,800 / 152,700); recon then balances with zero breaks, on both ledgers |
| TC-P2-RPT-04 | The lender pack shows the worked-example numbers exactly and is byte-identical when regenerated |
| TC-P2-DSH-01 | Staff dashboard: outstanding 48,000,000 cents, buyer cap 2,500,000,000, used 192 bps, NPL ratio 1,667 bps, recourse 40,000,000, NPL 8,000,000 |
| TC-P2-COL-04 / TC-P2U-COL-05 | In duplum: charges after NPL never exceed principal at NPL; the excess (400,000 cents in the scenario) is waived in the ledger; principal never reduced |
| TC-P2-ACC-01 / TC-P2U-ADP-02 | Journals are balanced to the cent; unbalanced journals are refused; amounts sent to Xero with 2 decimals from integer cents |

## Reconciliation edge cases (TC-P2U-REC-01..08 plus e2e)

1. All three balances agree and items match: balanced.
2. A credit on the as-of day not yet ingested: timing (clears next business day).
3. An un-ingested credit from an earlier day: unexplained (unknown bank item).
4. A payout released within one business day but not on the statement: timing; older: unexplained; weekends skipped.
5. Bank charges: explained; matched reference with a different amount: unexplained.
6. Fineract vs platform: a pending ledger posting is timing, a dead posting is unexplained, and any remainder becomes an unexplained residual.
7. Baseline: balances compared as movements since the approved opening.
8. An approved carry-forward explains the same item on later runs.
- e2e (both ledgers): rogue Fineract journal → unexplained residual → alerts to ops and compliance → resolution proposed by ops, refused for the maker and for credit, approved by ops2 → next run `explained`; the late credit becomes unexplained after its timing window and clears after statement import.
- Real Fineract caught one real bug in the test itself: the expected "clears by" date must skip weekends (the shifted real-ledger dates fell on a Friday). The test now uses the same business-day function.

## Regression notes

- Phase 1 tests still pass after recon, the late ladder and recourse moved out of `ops.ts` into their own services.
- TC-OPS-01 changed on purpose: recourse is now proposed by credit and approved by credit2 (D-41).
- The public-health test now expects 11 adapters (accounting, CRM and site leads added).

## Known gaps

- Sandbox modes of the new adapters are tested with an injected `fetch`, never against the real services.
- TC-P2-COL-04 runs on the mock ledger only; on Fineract the waiver command is exercised by the adapter code path but no maturity interest accrues in the test tenant to cap.
- The browser check is automated axe plus scripted clicks, not a manual screen-reader audit.
