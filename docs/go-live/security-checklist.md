# Go-live security checklist

**[Security Engineer]** 18 Nov 2026, branch `go-live-hardening`. Numbering note: Phase 1b and Phase 2/3 reused some
ids (Phase 1b S-09 = rate limits, S-12 = picomatch). This list uses the **Phase 2/3 meaning** of S-09 and S-12..S-16, as
in the go-live brief, and gives picomatch its own line.

## Items closed in this phase

| Id | Finding | Fix | Evidence |
| --- | --- | --- | --- |
| S-09 | Report artefacts (the CRB file has borrower identifiers) stored unencrypted | AES-256-GCM in the application, key derived from `STORAGE_ENCRYPTION_KEY` (HMAC, purpose label), AAD = snapshot/template/filename so ciphertext cannot be moved between rows; download verifies decryption and sha256 (409 `ARTIFACT_INTEGRITY` otherwise); app role still cannot rewrite artefacts; one-off script encrypts legacy rows with a round-trip check | TC-GL-S09, TC-GL-BAK-01, FUND-05 reads via the download endpoint |
| S-12 | M-Pesa callback token in the URL path reaches logs | Masked in API problem responses and error logs (`redactUrl`) and in nginx (`infra/proxy/nginx.conf` log format); rotation: `MPESA_CALLBACK_TOKEN_PREVIOUS` accepted, each use audited (`mpesa.callback_previous_token`); optional `MPESA_CALLBACK_ALLOWED_IPS` (CIDR) behind one trusted proxy; constant-time compare | TC-GL-S12 |
| S-13 | ERP connectors could call any URL (SSRF) | `ERP_ALLOWED_HOSTS` (exact or `*.suffix`), empty = deny all; https only (http only in development/test with `ERP_ALLOW_HTTP`); private, loopback, link-local, CGNAT, ULA and metadata addresses refused after DNS resolution; redirects refused; checked when a connection is saved (400 with a reason code) and on every request | TC-GL-S13, adapters golive.test.ts (7 tests) |
| S-14 | Integration users mixed with staff | `is_integration` flag (backfilled) with a CHECK that they stay inactive; excluded from the staff list / access review; separate `GET /v1/admin/service-accounts`; identity refuses them even with a valid token | TC-GL-S14 |
| S-15 | Batch approval re-used one step-up for up to 100 items | Each item checks the approver's authentication age against `BATCH_STEP_UP_WINDOW_SEC` (default 900 s, min 60); items after expiry fail with `STEP_UP_EXPIRED` and stay approved-not-released for a fresh approval | TC-GL-S15 |
| S-16 | CSV drop folder trusted | lstat/realpath checks (no symlinks, FIFOs, directories, escapes, world-writable files), ClamAV INSTREAM scan, quarantine of infected files, fail-closed on scanner errors, mock scanner refused in production; SFTP host chroot/key-only (sftp-drop.md) | adapters golive.test.ts (fake clamd) |
| D-32 / S-11 (1b) | OIDC code exchange in the browser | Server-side BFF: confidential client, PKCE S256, state + nonce, single-use hashed state, HttpOnly SameSite=Lax binding cookie scoped to `/v1/auth/oidc`, ID-token nonce/audience check, access-token MFA check, open-redirect protection on `returnTo`, `Referrer-Policy: no-referrer`; web app holds no token and no sessionStorage; CSP `connect-src` no longer lists the IdP | TC-GL-BFF-01..06, web session tests, TC-GL-KC-01..04 |
| SYS-05 | MFA only tested with the dev IdP | Real Keycloak 26.8.2; amr references configured by script; OTP mandatory; enrolment login re-prompted once | TC-GL-KC-01..04 (keycloak-local.md) |
| Lint | No ESLint config | Flat config (typescript-eslint, react-hooks, ban on `localStorage`/`sessionStorage.setItem`); `npm run lint` clean with `--max-warnings=0`; in CI | CI |
| Config | Unsafe values could reach staging | Staging/production refuse non-https `OIDC_ISSUER` / `OIDC_REDIRECT_URI`, a short `OIDC_CLIENT_SECRET`, malformed `MPESA_CALLBACK_ALLOWED_IPS` | config.test.ts |

## Still open / accepted

| Id | Item | Status |
| --- | --- | --- |
| picomatch | GHSA-fc5q-39xc-vjpf ReDoS, affects ≤ 4.0.7; **no patched release** (4.0.7, 24 Aug 2026, is the latest) | Accepted: dev-only (vitest, vite, unplugin-swc), never in production images; `npm audit --omit=dev --audit-level=high` passes. Re-check monthly |
| S-10 (1b) | Rate limiter fails open if Postgres is down | Accepted (D-34) |
| S-11 (2) | Accounting/CRM tokens are long-lived | Open: OAuth refresh tokens in the secret manager in staging |
| Pen test | Independent test | Not done (pentest-scope-and-rfp.md) |
| Supplier SMS OTP | Keycloak SMS authenticator | Open (D-12) |
| Infected-file alert | Infected/unsafe drop files are recorded on the import run; push alert to ops | Open: CloudWatch alarm in monitoring.md |
| Secrets | Secret manager, key ceremony for `STORAGE_ENCRYPTION_KEY` with an offline copy | Needs staging and Deng |

## Pre-production checks (run in staging)

TLS A+ (no TLS 1.0/1.1), HSTS; `DEV_IDP_ENABLED=false` and dev routes absent; every adapter not `mock`; Keycloak admin
console not public; RDS not public, encrypted; S3 public access blocked; no secrets in images or CI logs; nginx log
format masked; `npm audit --omit=dev` clean; `/v1/audit/verify` ok; restore test passed; pen test retest letter.
