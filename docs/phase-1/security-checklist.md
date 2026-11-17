# Phase 1 security checklist

**[Security Engineer]** 17 Nov 2026. This checklist covers the Phase 1 code against the Phase 0 threat model (`phase-0/threat-model.md`), the brief's security list, and the OWASP Top 10 (2021). ✅ done and tested · 🟡 partly done · ❌ not done · ⏭ needs an environment or vendor that doesn't exist yet

> **No independent penetration test has been done.** The brief's Phase 1 exit criterion needs one, with its findings fixed. That requires a deployed staging environment and a CREST/OSCP-qualified tester. The items below are an internal review, not a pen test.

## Identity and access

| Control | Status | Evidence |
| --- | --- | --- |
| MFA for every user (API rejects tokens without an MFA `amr`) | ✅ | `security.e2e`: single-factor tokens rejected |
| Staff and buyers must use an authenticator app; SMS OTP only for supplier users (D-12/D-14) | ✅ | `security.e2e` |
| Step-up re-authentication (≤ 300 s) for release, approvals, recourse, funding | ✅ | `security.e2e` |
| JWT verification: JWKS, issuer, audience, RS256/ES256 only | ✅ | `auth.ts` |
| Dev IdP can't run in production (config refuses to start) | ✅ | `security.e2e` production guards |
| Keycloak realm: TOTP required action, brute-force lockout, password policy, PKCE S256, 5-min access tokens | 🟡 ⏭ | `infra/keycloak/mapema-realm.json`, **not imported or tested**. Supplier SMS OTP needs a Keycloak SMS authenticator extension (open) |
| Role-based access + object-level scoping (no cross-tenant reads) | ✅ | `security.e2e`: a second supplier can't see or quote |
| Read-only auditor; access time-boxed and expiring | ✅ | `security.e2e` |
| Maker-checker on limits, pricing, float, payouts, lending switch, bank verification, manual match, dispute/break close, write-off, **staff and auditor role grants** | ✅ | Service check + DB `four_eyes` and `payout_four_eyes` constraints; `security.e2e` |
| Invitations: only the token hash is stored; single-use; email-bound; 72 h expiry; link encrypted in the outbox and scrubbed | ✅ | `security.e2e` |
| Web session: tokens held in `sessionStorage` | 🟡 | Exposed to XSS if any XSS exists. **Recommend** a backend-for-frontend with httpOnly, SameSite cookies before go-live (Q-P1-07) |

## Data protection and cryptography

| Control | Status | Evidence |
| --- | --- | --- |
| Field encryption, AES-256-GCM: national ID, phone, bank account; HMAC blind index for lookups | ✅ | `security.e2e`: PII encrypted at rest, never in the outbox |
| Documents encrypted at rest; WORM for agreements, ILUs, notices, receipts; SHA-256 stored | ✅ | adapters `storage` test |
| Keys from the environment (32-byte hex) with no defaults; app fails fast if missing | ✅ | `security.e2e`: missing secrets fail fast |
| Secrets in a managed vault, key rotation | ❌ ⏭ | No hosting yet. Rotation needs a key-version column (Phase 2) |
| TLS 1.2+ in transit; HSTS | 🟡 ⏭ | HSTS header is sent; TLS terminates at the (not yet chosen) load balancer |
| Database least privilege: app logs in as a non-superuser in the `mapema_app` role; UPDATE/DELETE on the audit log revoked | ✅ | Tests run as that role; `security.e2e` |
| Backups, PITR, monthly restore test | ❌ ⏭ | No hosting |

## Application security (OWASP Top 10)

| Risk | Status | Control |
| --- | --- | --- |
| A01 Broken access control | ✅ | Global AuthGuard (deny by default; `@Public` explicit), `@Roles`, org scoping, four-eyes in service and DB |
| A02 Cryptographic failures | ✅ / ⏭ | as above; TLS pending hosting |
| A03 Injection | ✅ | Parameterised SQL only (pg); zod validation on every body/query; CSV parsed without eval; React escapes output |
| A04 Insecure design | ✅ | Threat model, ledger-first then bank with undo, idempotency keys, advisory locks, held-payment policy |
| A05 Misconfiguration | ✅ | helmet (CSP, HSTS, nosniff, frame-ancestors none), CORS limited to `WEB_ORIGIN`, no `x-powered-by`, problem+json without stack traces, production refuses mock adapters |
| A06 Vulnerable components | ✅ | `npm audit`: **0** (zod 3 → 4.6.7 fixed GHSA-mrhx-c7xc-m3w5, high; vitest 3 → 5.1 fixed dev-only tinypool/mocker criticals). CI runs `npm audit --omit=dev --audit-level=high` (CI not run) |
| A07 Authentication failures | ✅ / 🟡 | as above; lockout depends on Keycloak (not run) |
| A08 Software/data integrity | ✅ | Webhooks HMAC-SHA256 over the raw body with a timestamp window; e-sign webhook signed; audit hash chain; lockfile committed |
| A09 Logging and monitoring | 🟡 | Append-only audit log for every action, request IDs. **No error tracking, uptime alerts or log shipping** (no hosting) |
| A10 SSRF | ✅ | No user-supplied URLs are fetched; provider base URLs come from config only |

| Other control | Status | Notes |
| --- | --- | --- |
| Rate limiting | 🟡 | 300 req/min per IP globally; fee calculator 30/min; leads 5/min. **In-memory store** → per instance; use Redis storage when scaling out |
| File upload scanning | 🟡 | MIME allow-list (PDF/JPEG/PNG/CSV), magic-byte sniffing, 15 MB body limit, EICAR test signature. **Real AV (ClamAV or provider) is a go-live item** |
| Idempotency on money-moving calls | ✅ | `Idempotency-Key` on accept and release; replay returns the first response; reuse with a different body → `IDEMPOTENCY_KEY_REUSED` |
| Concurrency on limits | ✅ | `pg_advisory_xact_lock` in decide and release; tested |
| Web security headers (CSP, HSTS, Referrer-Policy, Permissions-Policy, frame-ancestors) | ✅ | `apps/web/next.config.ts`. CSP still allows `'unsafe-inline'` scripts (Next.js inline runtime); move to nonces before go-live |
| Dependency and secret scanning in CI | 🟡 | `npm audit` in the workflow; add gitleaks/CodeQL when the repo has a remote |
| Container hardening | 🟡 ⏭ | Non-root UID 10001, slim base; images not built; pin digests |

## Internal review findings fixed in Phase 1

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| S-01 | Raw invitation tokens persisted in the outbox payload | High | Encrypted (`linkEnc`), scrubbed after sending; test asserts no PII or tokens in the outbox |
| S-02 | Concurrent credit approvals could jointly exceed a limit | High | Advisory lock in both decide and release; concurrency test |
| S-03 | Staff/auditor role grants needed only one person | High | Approval (`user_role_change`), acceptance blocked until approved; migration 003; tests |
| S-04 | zod < 4.6.6 memory exhaustion (GHSA-mrhx-c7xc-m3w5) | High | zod 4.6.7 |
| S-05 | tinypool prototype-pollution RCE, vitest mocker (dev only) | Critical (dev) | vitest 5.1.0 |
| S-06 | Dev routes could be mounted outside dev | Medium | Mounted only when `DEV_IDP_ENABLED=true` **and** `APP_ENV` is development or test; config refuses the dev IdP in production |
| S-07 | API connected as a superuser in early tests | Medium | Harness and seed use a non-superuser login role in `mapema_app` |

## Open before go-live (owner: Security Engineer unless noted)

1. **Independent pen test** on staging, and fix its findings (exit criterion). ⏭
2. Staging and production on the chosen Kenya/Africa region (D-08), with a vault, TLS, WAF, backups/PITR and restore tests, monitoring and alerts to the operations phone. ⏭ DevOps
3. Keycloak deployed and tested (TOTP for staff/buyers, SMS OTP for suppliers), plus a BFF with httpOnly cookies instead of `sessionStorage`.
4. Real malware scanning; S3-compatible encrypted storage with object lock.
5. CSP nonces (remove `'unsafe-inline'`); Redis-backed rate limiting.
6. Incident runbook with the **24 h CBK** and **72 h ODPC** clocks (compliance C-14/C-17).
7. Key rotation design; quarterly access reviews; a vendor security review for each provider before `live`.
