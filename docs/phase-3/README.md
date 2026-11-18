# Phase 3 report: growth

**[Product Manager + Tech Lead]** 18 Nov 2026, finished about 07:00 GMT (London). Repo `/workspace/mapema/app`, branch `phase-3`, local only. Nothing was pushed, deployed or sent, no accounts were created, no live provider was called and no money was spent. The marketing-site Worker was not touched. Mapema is still described everywhere as **not yet licensed**.

- Stories and acceptance criteria, with Architect and Compliance notes: [`stories.md`](stories.md)
- Test detail: [`qa-report.md`](qa-report.md)
- Security: [`security-checklist.md`](security-checklist.md)
- CBK NDTCP Regulations 2026 and DPA 2019 review, with items for Kenyan counsel: [`compliance-review.md`](compliance-review.md)
- Decisions D-50 to D-63: [`../decisions-log.md`](../decisions-log.md)

## "Done when" check

| Criterion | Status | Evidence |
| --- | --- | --- |
| The first buyer submits invoices automatically from its ERP | ✅ (local fake Odoo) · 🟡 real Odoo tenant (Q-K) | TC-P3-ERP-01: posted Odoo vendor bills are pulled over JSON-RPC from a local Odoo-compatible server, mapped with the buyer's approved field mapping, and pass **the same checks as a manual upload** (supplier linked, tenor, duplicate, eTIMS, KES only). The buyer's human checker confirms, signs the ILU, the supplier is quoted and the advance is funded. The worker runs the import every 15 minutes. CSV/SFTP drop works end to end too (TC-P3-ERP-02). Passes on the mock ledger **and on real Apache Fineract 1.16.1**. |
| Advances can be tagged to a funding source | ✅ | TC-P3-FUND-01..05: sources (equity, facility A) approved by the CEO become Fineract **funds**; every release auto-picks the first eligible source by priority (eligibility, facility headroom, covenants pro forma) or validates the one credit named; the tag is stored on the loan (`fundId`) and in the loan datatable `mapema_funding_tag`; re-tagging is maker-checker and moves the Fineract datatable; a consistency check compares platform and Fineract; per-funder lender pack. Verified against real Fineract. |

## What was built

| # | Scope item | Built | Where |
| --- | --- | --- | --- |
| 1 | ERP connectors | One `ErpConnector` interface, `ADAPTER_MODE_ERP` mock / sandbox. **Odoo** (JSON-RPC `common.authenticate` + `execute_kw search_read` on `account.move`, cursor `write_date|id`, supplier PIN from `res.partner.vat`) and **CSV/SFTP drop folder** (incoming → processed / rejected, SHA-256 file de-duplication, 500 rows / 5 MB per file) are complete end to end. **SAP S/4HANA, Sage Business Cloud and Dynamics 365 Business Central** connectors follow the vendors' documented REST/OData shapes and are unit-tested with an injected `fetch`; their field names, approval states and auth are **assumptions** until tested on a real tenant (ERP-07). Per-buyer JSON field mapping (transforms `trim`, `upper`, `date`, `decimal_to_cents`, `cents`, `const`), versioned, maker-checker (a second ops user). Idempotent item ledger (one item per ERP record ever); edits after import are flagged `changed_after_import`, never applied; error mapping (`ERP_AUTH_FAILED` pauses after 3, `ERP_UNAVAILABLE` keeps the cursor, per-record domain codes). Each connection has its own integration user, so four eyes hold. Secrets only from `ERP_SECRET_*` env vars. | `packages/adapters/src/erp.ts`, `apps/api/src/modules/erp.ts` |
| 2 | M-Pesa Daraja B2C | `MpesaAdapter` mock + Daraja sandbox (OAuth, `b2c/v3/paymentrequest`, transaction status). Rail chosen at approval: verified wallet (call-back verified, `2547…` format), amount ≤ cap (default **KES 150,000**, CEO approves changes, never above Daraja's KES 250,000), whole shillings; otherwise bank. Same four eyes, step-up and limit checks at release. Result / timeout callbacks on a path token (timing-safe compare), idempotent; failure undoes the Fineract disbursal and frees the invoice; timeout or no result → status query; still unknown → ops task, **never resent**. Receiver-name mismatch → AML flag. M-Pesa float and statement feed the daily reconciliation (receipts match, B2C charges explained, pending payouts are timing). | `packages/adapters/src/mpesa.ts`, `apps/api/src/modules/mpesa.ts`, `reconciliation.ts` |
| 3 | Bulk tools | Buyer bulk confirmation (≤ 200, per-item results, one ILU for many); supplier bulk quotes (≤ 50, totals) + one acceptance for many; **ops payout batches** (≤ 100): maker builds, a **different ops user approves with step-up** and may reject single items; items release one by one through the normal release path (all limits re-checked per item, so exposure accumulates); one failure does not stop the others; batch `completed` / `partially_failed` / `failed`; audit at batch and item level. | `apps/api/src/modules/bulk.ts` |
| 4 | Multi-lender funding tags | Sources with eligibility (sector, buyer allow-list, tenor, min/max advance, eTIMS) and covenants (single-buyer concentration, NPL ratio, 30+ DPD ratio), pure BigInt functions; tag at approval (named) or release (auto); Fineract fund at origination + datatable for the current tag; re-tag maker-checker (credit proposes, CEO approves); utilisation and covenants on the Funding screen; per-funder lender pack from the month-end snapshot using the tag history at month end. If no source is configured, advances stay untagged (Phase 2 behaviour). | `packages/pricing/src/funding.ts`, `apps/api/src/modules/funding.ts`, `regulatory.ts` |
| 5 | Screens | Staff: ERP connections (runs, items, mapping proposal), Funding sources (utilisation, covenants, consistency, propose, re-tag), M-Pesa (cap, pending payouts, check now), Payout batches (build, approve, drop items). Buyer: ERP status, bulk confirm. Supplier: bulk quotes, M-Pesa wallet. 119 new label keys in English **and Swahili**. No page-level horizontal scroll at 390 px; axe serious/critical: 0. | `apps/web/components/portals/phase3.tsx` |
| 6 | Worker | `erp-import` every 15 min, `mpesa-pending` every 5 min, next to the Phase 2 jobs (`buildJobs`, unit-tested). | `apps/worker/src/main.ts` |
| 7 | QA, security, compliance | Tests written first (commit `2adc56d`, red), code after. QA report, security checklist, compliance review with counsel items. | this folder |
| 8 | Deliverables | This README; decisions D-50 to D-63; questions below; OpenAPI regenerated (**159 operations, 144 paths**, Redocly lint clean; Phase 2 had 128 / 116); `.env.example` updated (no real secrets); growth demo seed (`SEED_DEMO_GROWTH=true`); screenshots; zip. | — |

New migration: `009_phase3.sql` (ERP connections, mappings, runs, items; funding sources and tag history; M-Pesa payout state; payout batches and items; settings `mpesa_payout_cap_cents`). New approval actions: `erp_mapping_change`, `funding_source_change`, `funding_retag`, `mpesa_cap_change`.

## Story status (26 Phase 3 stories)

✅ 22 built and tested · 🟡 4 built, need an outside input before go-live · ❌ 0. Detail in [`stories.md`](stories.md).

| Epic | ✅ | 🟡 (needs) |
| --- | --- | --- |
| ERP (8) | ERP-01, 04, 05, 06, 08 | ERP-02 real Odoo tenant (Q-K), ERP-03 SFTP host (Q-L), ERP-07 SAP/Sage/Dynamics tenants (Q-K) |
| FUND (7) | FUND-01 to 07 (FUND-07 without a covenant section inside the pack) | — |
| MP (5) | MP-02 to 05 | MP-01 Daraja account and B2C onboarding (Q-M) |
| BULK (3) | BULK-01 to 03 | — |
| QA / SEC / CMP (3) | QA-03, SEC-03, CMP-03 | — |

## Real numbers (18 Nov 2026, final run 06:48 GMT)

All runs on this box, fresh databases, no network calls outside localhost.

| Suite | Phase 2 | Phase 3 | Command |
| --- | --- | --- | --- |
| `@mapema/pricing` unit | 41 | **51 passed** | `npm test -w @mapema/pricing` |
| `@mapema/adapters` unit (incl. local FakeOdoo, CSV drop, Daraja/SAP/Sage/Dynamics with injected fetch) | 23 | **48 passed** | `npm test -w @mapema/adapters` |
| Fineract adapter against real Apache Fineract 1.16.1 (incl. funds + funding-tag datatable, worked example interest still 44,800) | 6 | **7 passed** | `npm run test:fineract` |
| API e2e, mock ledger | 110 | **132 passed** (22 new Phase 3) | `npm test -w @mapema/api` |
| API e2e, real Fineract | 109 + 1 skipped | **131 passed + 1 skipped** | `npm run test:e2e:fineract` |
| Worker | 3 | **4 passed** | `npm test -w @mapema/worker` |
| Web (incl. TC-P3W-01..04: story screens, routes exist, money/maker-checker wording, every label in en + sw) | 62 | **90 passed** | `npm test -w @mapema/web` |
| Browser check (Playwright, growth demo, 390 px + 1440 px, axe-core) | — | **31/31 checks, 0 serious/critical axe findings, 0 console errors** | `node scripts/phase3-shots.mjs` |

Total automated: **463 passed, 1 skipped (the Phase 1 skip on real Fineract), 0 failed**. The worked example (KES 1,000,000 invoice → 800,000 advance, 44,800 discount fee, 2,500 verification fee, 847,300 Mapema keeps, 152,700 supplier balance) still holds: pricing unit tests, the Phase 1 e2e on both ledgers, the real-Fineract funding-tag test, and the supplier bulk-quote screen (KES 800,000 advance / KES 47,300 total cost).

Money to the cent in Phase 3 tests: facility utilisation KES 800,000 of 2,000,000 = 40.00% (4000 bps) with headroom KES 1,200,000.00; pro forma concentration refusing a KES 600,000 advance at 70% > 60%; M-Pesa 120,000.00 paid, B2C charge KES 15.00 explained twice; batch released KES 480,000.00 with one item rejected and one failed at M-Pesa.

## Growth demo

`ENV_FILE=… SEED_DEMO_GROWTH=true scripts/smoke-stack.sh` (web built with `NEXT_PUBLIC_DEV_SIGNIN=true`). Through the API, in mock mode: the Phase 1 demo world; funding sources EQUITY and FAC-A (KES 5m, FMCG, ≤ 60 days, single-buyer ≤ 60%) approved by the CEO; a mock Odoo connection for Acme whose mapping is approved by ops2, with three vendor bills pushed (2 imported, 1 refused `SUPPLIER_NOT_LINKED`); a verified M-Pesa wallet, a KES 100,000 advance paid by M-Pesa and confirmed by the result callback; the two ERP invoices confirmed in bulk, quoted and accepted in bulk, approved by credit and put in a payout batch that ops2 approves in the browser check. All names, PINs and phone numbers are fictitious. Sign in at `/signin` as `ceo@mapema.test`, `ops2@mapema.test`, `ap@acme.test`, `checker@acme.test` or `finance@juakali.test` (SMS factor).

## Screenshots

`/workspace/mapema/phase-3-shots/` (17 files, 390 px and desktop 1440 px):
`staff-funding-*`, `staff-erp-*`, `staff-mpesa-*`, `staff-payout-batch-pending-*`, `staff-payout-batch-released-desktop`, `buyer-erp-*`, `buyer-bulk-confirm-*`, `supplier-bulk-quote-*`, `supplier-mpesa-wallet-*`.

## Questions for Deng

Each has a default; nothing waits on an answer except the item named.

| # | Question | Default if no answer | Unblocks |
| --- | --- | --- | --- |
| Q-K | Which buyer goes first, and on which ERP? We need a test tenant (Odoo database or SAP/Sage/Dynamics sandbox) and an integration user created by the buyer. | Acme-style Odoo first; the buyer creates a read-only integration user and puts the API key in our secret store as `ERP_SECRET_<BUYER>_ODOO`. SAP/Sage/Dynamics stay mock-backed. | ERP-02, ERP-07 go ✅ |
| Q-L | Who hosts the SFTP drop (our server, or the partner bank's file service)? | An OpenSSH chroot on our infra, key-only, one directory per connection, writing into `ERP_DROP_ROOT`. No remote pull. | ERP-03 |
| Q-M | Safaricom Daraja: which paybill/B2C shortcode, and who signs the B2C onboarding? Is the M-Pesa statement available as a daily file? | Apply for a B2C shortcode in Mapema's name only after counsel clears the channel question (P3-C2); until then mock and sandbox only. Recon uses the bank side only in sandbox. | MP-01, live M-Pesa |
| Q-N | Is KES 150,000 the right M-Pesa cap? | Keep 150,000 (CEO can change it with maker-checker, never above 250,000). | — |
| Q-O | Who pays the B2C transaction charge: Mapema or the supplier? | Mapema absorbs it (booked as a bank charge, explained in recon); not deducted from the supplier. | pricing disclosure |
| Q-P | First debt facility: which lender, and what eligibility and covenants are in the term sheet? | Configure as FAC-A with the term-sheet rules when signed; until then everything is funded from EQUITY. | real tags |
| Q-Q | May the per-funder lender pack name borrowers (loan tape), or must it be anonymised? | Named loan tape only under a signed facility agreement with a confidentiality clause and a privacy-notice update (P3-C5); otherwise an anonymised tape (template change). | sending packs |
| Q-R | Should buyers be able to propose their own ERP field mapping, or only ops? | Buyer admins may propose; a Mapema ops user always approves (current). | — |

## Not done or left for later

- Real Odoo / SAP / Sage / Dynamics tenants, the SFTP host and a Daraja account (Q-K, Q-L, Q-M): nothing was called outside localhost.
- Remote SFTP pull and ERP write-back (marking bills as financed in the ERP).
- A facility utilisation and covenant section inside the per-funder pack (shown on the Funding screen instead).
- M-Pesa account balance and statement in sandbox mode (Daraja's balance query is asynchronous and there is no statement API); recon then shows M-Pesa payouts as breaks.
- Treasury transfers between the bank and the M-Pesa float (recorded as funding movements).
- A lender-user portal scoped to one funder (staff generate the packs).
- Batch items are listed by the browser before the API re-checks; an advance already in a pending batch is refused at batch creation (`IN_BATCH`), not hidden from the picker.
- Native-speaker review of the 119 new Swahili strings (D-26 process).
