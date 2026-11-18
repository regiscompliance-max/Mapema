# Phase 3 QA report

**[QA Engineer]** 18 Nov 2026, final runs 06:47–06:48 GMT (London); browser check 06:45 GMT.

Environment: Node 24 · PostgreSQL 17 (embedded) · Apache Fineract **1.16.1** (local binary, `http://localhost:8443`, tenant `default`, Fineract's local demo login) · vitest 5.1.0 · Google Chrome via playwright-core + axe-core. ERP: a local Odoo-compatible JSON-RPC server (`FakeOdoo`) and a temporary CSV drop folder. M-Pesa: `MockMpesa` with Daraja-shaped callbacks. No call left localhost.

## Tests first

Stories and tests were committed red before the code: commit `2adc56d` ("Phase 3: stories + tests first (red)"): `packages/pricing/test/funding.test.ts`, `packages/adapters/test/phase3.test.ts`, the real-Fineract funding-tag test, `apps/worker/test/schedule.test.ts` (TC-P3-WRK-01) and `apps/api/test/phase3.e2e.test.ts` (22 tests). Code went green in `c1519ff` and later commits. Test corrections made after the code, all to the tests' own set-up and none to an expected business result: the approval table name (`approval_request`), the CSV route (`/invoices/csv`), MP-05 reading `run.breaks`; distinct issue dates for same-amount invoices (the Phase 1 fuzzy duplicate check, same PIN + amount + date, rightly refused them); the payout-in-transit sign (+, the Phase 2 convention for platform-side items); the worker test's mock (a spread of a JS Proxy copies no keys); and the Phase 1 health test now lists `erp` and `mpesa`. Web screen tests TC-P3W-01..04 were written before the screens in the same session.

## Results

| Command | Result |
| --- | --- |
| `npm test -w @mapema/pricing` | ✅ 51 / 51 (10 new: TC-P3U-FUND-01..03) |
| `npm test -w @mapema/adapters` | ✅ 48 / 48 (25 new: TC-P3U-ERP-01..05, MP-01/02, FUND-04 mock ledger) |
| `npm run test:fineract` | ✅ 7 / 7 on real Fineract (new: funds P3-FAC-A / P3-EQUITY, loan booked with `fundId`, datatable tag moved, interest still 44,800) |
| `npm test -w @mapema/api` | ✅ 132 / 132 (22 new in `phase3.e2e`) |
| `npm run test:e2e:fineract` | ✅ 131 passed, 1 skipped (Phase 2's mock-only TC-P2-COL-04 hook); all 22 Phase 3 tests pass with titles `[ledger=real Fineract]` |
| `npm test -w @mapema/worker` | ✅ 4 / 4 (TC-P3-WRK-01 new) |
| `npm test -w @mapema/web` | ✅ 90 / 90 (28 new: TC-P3W-01..04) |
| `scripts/phase3-shots.mjs` on the growth demo | ✅ 31 / 31 checks; axe 0 serious/critical on every screen checked (18 scans); 0 console errors |
| `npm run lint:openapi` | ✅ valid (159 operations, 144 paths) |

Phase 2 baseline is intact: every Phase 1/1b/2 test still passes on both ledgers.

## Money to the cent

| Test | What it proves |
| --- | --- |
| TC-P3U-FUND-02 / TC-P3-FUND-04 | Facility A: KES 800,000.00 outstanding of 2,000,000.00 → 4000 bps used, headroom 1,200,000.00; a KES 600,000 advance would take single-buyer concentration to 7000 bps > 6000 pro forma → refused for FAC-A and funded from EQUITY |
| TC-P3U-ERP-01 | `"200,000.00"` → 20,000,000 cents; `500000.0` → 50,000,000; three decimals or exponent notation refused (`MAPPING_ERROR`) — no floats |
| TC-P3-MP-01 / MP-05 | KES 150,000 invoice → KES 120,000.00 B2C payout (12,000,000 cents, whole shillings); two KES 15.00 B2C charges explained in recon; a pending KES 120,000.00 payout is timing; run status `explained`, 0 unexplained |
| TC-P3-BULK-02 | Four bulk quotes total KES 800,000.00 advance (each KES 240,000 / 80,000 as the worked-example rate gives) |
| TC-P3-BULK-03 | Batch of 4 (KES 800,000.00): item 2 rejected, item 4 failed at M-Pesa, released KES 480,000.00 exactly |
| Real-Fineract funding test | Worked example loan booked against fund P3-FAC-A still accrues KES 44,800.00 interest |
| Browser check | Supplier bulk quote screen shows KES 800,000.00 advance and KES 47,300.00 total cost (44,800 + 2,500) for the worked-example invoice |

## Batch partial failures

- TC-P3-BULK-03: one item rejected by the checker (`rejected`, reason kept), one fails at M-Pesa (`failed`, `MPESA_REJECTED`; the Fineract disbursal is undone, the advance is `release_failed`), the other two release; batch `partially_failed`; audit trail in order: `create, approve, item_released, item_rejected, item_released, item_failed, completed`.
- TC-P3-BULK-04: after the supplier limit is cut to KES 1m, a batched item fails `CHECKS_FAILED` with `failedChecks: ['SUPPLIER_LIMIT', …]`; batch `failed`; the bank balance is unchanged (nothing paid).
- Maker cannot approve (403 `FOUR_EYES`); wrong role 403; a batched advance cannot be released on its own (409 `IN_BATCH`).

## M-Pesa timeouts and failures

- TC-P3-MP-04: timeout callback → status query → still `unknown` → payout stays `released`/`unknown`, ops notified (`mpesa.unknown`); 31 minutes later the job queries again (`checked 1, unknown 1`); Safaricom later reports success → applied (`completed 1`), advance funded; receiver "JOHN DOE" ≠ "Peter Kamau" → AML flag `MPESA_NAME_MISMATCH`; the request was sent **once**.
- TC-P3-MP-03: failure result `2001` → disbursal undone in the ledger, invoice back to eligible, `failure_reason 'MPESA_2001: The initiator information is invalid.'`, nothing resent.
- TC-P3-MP-01: wrong path token 401; duplicate result callback ignored; `0712…` wallet refused (400).

## ERP edge cases

Odoo: drafts never fetched; unknown supplier PIN `SUPPLIER_NOT_LINKED`; USD `CURRENCY_NOT_KES`; same PIN + number as a manual upload `DUPLICATE_INVOICE`; re-run creates nothing; a fixed record is retried; an amount edit after import is flagged `changed_after_import` and the invoice keeps KES 500,000; Odoo down → `ERP_UNAVAILABLE`, cursor unchanged; three auth failures pause the connection; resume by ops only. CSV: bad tenor itemised `TENOR_OUT_OF_RANGE`; a `pending` row skipped; file archived; identical re-drop `duplicate_file`. Mapping v2 (adds `poReference`) recorded on new items.

## Browser check (growth demo)

17 screenshots in `/workspace/mapema/phase-3-shots/`. Checks: every story screen renders; no page-level horizontal scroll at 390 px on Funding, ERP, Payout batches and Bulk quotes; ERP pages show `ERP_SECRET_DEMO_ODOO` but never the key; ops2 approves the demo batch and both items release; buyer admins cannot add connections.
