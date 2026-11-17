# Phase 1b security checklist update

**[Security Engineer]** 17 Nov 2026. These are changes to [`../phase-1/security-checklist.md`](../phase-1/security-checklist.md). Rows not listed here are unchanged.

| Control | Phase 1 | Phase 1b | Evidence |
| --- | --- | --- | --- |
| Web session token storage | 🟡 tokens in `sessionStorage` | ✅ | Opaque 256-bit session id in cookie `mapema_sid` (HttpOnly, Secure, SameSite=Strict, host-only, Path=/). The database keeps only its SHA-256. The web code never writes a token to storage and sends no `Authorization` header (web test plus the smoke check that storage is empty and `document.cookie` cannot read the cookie). D-31 |
| CSRF | n/a (bearer header) | ✅ | Three checks on every cookie-authenticated POST/PUT/PATCH/DELETE: (1) `X-CSRF-Token` = HMAC(key derived from `PII_BLIND_INDEX_KEY`, sid), compared in constant time; (2) `Origin` must be in `WEB_ORIGIN`; (3) SameSite=Strict. CORS sends credentials only to `WEB_ORIGIN`. TC-SES-03, TC-SES-08; smoke gets 403 `CSRF_FAILED` |
| Session lifetime | token expiry only | ✅ | Idle 15 min, absolute 8 h (`SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`). Step-up re-authentication rotates the id (blocks session fixation); logout revokes on the server. TC-SES-05..07 |
| MFA at session creation | ✅ | ✅ | Same `amr` checks as bearer tokens; no session without a second factor. TC-SES-04 |
| API clients | bearer | ✅ | Bearer tokens still accepted. They are not sent automatically by the browser, so no CSRF header is needed. TC-SES-09 |
| OIDC code exchange | in browser | 🟡 | The PKCE code exchange still runs in the browser. The token is kept in memory only and swapped for the cookie at once. Move it to a server-side BFF before go-live (D-32) |
| Rate limiting | 🟡 in-memory, per instance | ✅ / 🟡 | Shared in Postgres (UNLOGGED `rate_limit_hit`, one upsert per request); TC-RL-01 shows two instances share one budget. **Fails open** if the database errors (logged), D-34. UNLOGGED counters reset after a database crash (by design) |
| Document downloads | n/a | ✅ | Org-scoped (404 outside the caller's orgs, so no existence leak); every download is audited; files stay AES-encrypted at rest. TC-DOC-03 |
| My-data view (SUP-13) | n/a | ✅ | Shows masked national IDs and bank last 4 only; test asserts no raw IDs or full account numbers. TC-SUP-13 |
| Staff list (ADM-01) | n/a | ✅ | Admin only; others get 403. TC-ADM-01. Invitations still need a second admin |
| Uploads | 🟡 | 🟡 | Client-side type/size checks added (PDF/JPEG/PNG, 10 MB). The server checks are unchanged and remain the control. Real AV is still a go-live item |
| Accessibility (SYS-06) | not audited | 🟡 | axe-core WCAG 2 A/AA: 0 serious or critical on all screens visited at 390 px. This is not a full manual audit |
| A06 vulnerable components | ✅ 0 | 🟡 | Production deps: **0**. Dev deps: 8 high via picomatch ≤ 4.0.7 (GHSA-fc5q-39xc-vjpf; ReDoS in glob matching in test/build tooling). No fixed version is published; recheck. Not in shipped code |

## New review findings (Phase 1b)

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| S-08 | Bearer tokens in `sessionStorage` readable by any XSS | Medium | Fixed: httpOnly cookie sessions + CSRF |
| S-09 | Per-instance rate limits multiply with instance count | Low | Fixed: shared Postgres store |
| S-10 | Rate limiter fails open when Postgres is down | Low | Accepted by default (D-34); other controls still apply |
| S-11 | OIDC code exchange in the browser | Low | Open; BFF follow-up (D-32) |
| S-12 | picomatch ReDoS in dev tooling | Low (dev only) | Open; no upstream fix yet |
