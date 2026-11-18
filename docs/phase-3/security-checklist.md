# Phase 3 security checklist

**[Security Engineer]** 18 Nov 2026. Scope: ERP credentials and imports, M-Pesa callbacks, bulk tools and payout batches, funding data. Findings continue from Phase 2 (S-11).

| # | Control | How | Evidence |
| --- | --- | --- | --- |
| 1 | ERP secrets never stored or shown | A connection stores only the **name** of an env var, which must match `^ERP_SECRET_` (DB CHECK + zod); `DATABASE_URL` and others are refused. API responses never include the key | TC-P3-ERP-05 (`not.toContain('k-acme-odoo')`, `secretEnv: 'DATABASE_URL'` → 400); browser check "never shows the key" |
| 2 | ERP four eyes | Each connection gets its own inactive integration user as uploader, so the human buyer checker is always a different person | TC-P3-ERP-01 |
| 3 | ERP mapping changes are maker-checker | `erp_mapping_change` approval by a different ops user; mapping validated (known fields/transforms only) | TC-P3-ERP-05, 05b |
| 4 | ERP input handling | Strict decimal → cents parser (no floats), ISO dates, KES only; CSV: 500 rows / 5 MB per file, header check, files moved out of `incoming`; SHA-256 de-dup of files; record edits after import flagged, never applied | TC-P3U-ERP-01..03, TC-P3-ERP-02/03 |
| 5 | ERP outbound calls | Only to the configured base URL of the connection (ops-created, maker-checker on activation); sandbox mode only outside production; query strings built with `encodeURIComponent` | TC-P3U-ERP-04 |
| 6 | ERP auth failures | Three consecutive `ERP_AUTH_FAILED` pause the connection; only ops can resume (with a reason, audited) | TC-P3-ERP-04 |
| 7 | M-Pesa callbacks authenticated | Daraja does not sign callbacks, so result/timeout URLs carry a ≥ 16-char random path token, compared with `timingSafeEqual`; wrong token → 401 | TC-P3-MP-01 |
| 8 | M-Pesa callbacks idempotent | Callbacks matched by OriginatorConversationID; a repeat is a no-op; amount and receiver name checked | TC-P3-MP-01, MP-04 |
| 9 | No double payment | A pending/unknown payout is only ever queried, **never resent**; a retryable error at request time leaves the payout `unknown` rather than retrying | TC-P3-MP-03, MP-04 (`requests` length 1) |
| 10 | Wallet changes | New wallet: supplier admin with step-up, `2547XXXXXXXX` only, non-default, unverified until an ops call-back approved by a second ops user | TC-P3-MP-01 |
| 11 | M-Pesa cap | Setting changed only by `mpesa_cap_change` (CEO), range KES 10–250,000, whole shillings | TC-P3-MP-02 |
| 12 | Payout batch maker-checker | Maker cannot approve (`FOUR_EYES`); approver needs ops role and step-up; DB CHECK `approved_by <> created_by`; items re-run every release check under the release lock; an advance can be in only one pending batch (unique index) and cannot be released singly while batched (`IN_BATCH`) | TC-P3-BULK-03, BULK-04 |
| 13 | Bulk endpoints bounded | Bulk decision ≤ 200, bulk quote ≤ 50, batch ≤ 100; per-item authorisation (buyer checker only for own invoices, supplier only for own) | TC-P3-BULK-01/02 |
| 14 | Funding data integrity | Sources and re-tags are maker-checker (CEO); tag history insert-only (only `ledger_synced_at` may be updated); consistency check flags any platform/Fineract difference | TC-P3-FUND-01, 03 |
| 15 | Production guard | `ADAPTER_MODE_ERP` / `ADAPTER_MODE_MPESA` go through the same `mode()` guard as every adapter: production refuses mock, non-production refuses live | `packages/adapters/src/factory.ts` (guard shared with the Phase 1 adapters) |
| 16 | Audit | All new actions in the hash-chained audit log; chain verifies after the Phase 3 suite | TC-P3-AUD-01 |

## New findings

| ID | Finding | Severity | Action |
| --- | --- | --- | --- |
| S-12 | The M-Pesa callback token sits in the URL path and so in reverse-proxy access logs | Medium | Strip/mask `/webhooks/mpesa/b2c/*/<token>` in proxy logs; rotate the token with Safaricom URL re-registration; consider IP allow-listing Safaricom's callback ranges once known |
| S-13 | ERP sandbox connectors call any base URL ops enters (SSRF surface) | Medium | Before live: allow-list ERP hosts per connection at the egress proxy; block private IP ranges |
| S-14 | Integration users are created inactive but still exist as rows in `user_account` | Low | Exclude them from staff lists and access reviews. They cannot sign in: `active = false`, MFA off, and their subject `erp-integration:<id>` is never issued by the IdP |
| S-15 | Payout batch approval re-uses the session's step-up time; a long approval of 100 items could finish after the step-up window | Low | Acceptable (check is at approval start); revisit if batches grow |
| S-16 | The CSV drop folder is trusted local disk | Low | The SFTP host must be chroot, key-only, one directory per connection, with AV scanning (Q-L) |
