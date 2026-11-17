# Decisions log (Phase 1 onwards)

Phase 0 decisions D-01 to D-18 are in `phase-0/README.md` (delivered in `mapema-phase-0.zip`).

### Phase 1 defaults approved (17 Nov 2026)

**[Product Manager]** Recorded 17 Nov 2026, 18:48 GMT (London) / 21:48 EAT. Deng Ayom (CEO) approved all 12 recommended defaults in `app/docs/phase-1/questions-for-ceo.md`. Phase 1b proceeds on this basis.

| ID | Decision |
| --- | --- |
| D-19 (P1-1) | Staging environment in the nearest African cloud region. Accounts are created by Deng or his developer, not by the build team. |
| D-20 (P1-2) | Quotes from 2 qualified pen-test firms (at least one Kenyan); pen test before any real money moves. |
| D-21 (P1-3) | Start sandbox onboarding: whichever of Stanbic, NCBA or KCB offers virtual accounts first; Metropol or TransUnion (CRB); Smile ID (KYC); a counsel-approved e-signature provider; an approved eTIMS integrator. |
| D-22 (P1-4) | Buyer underpayment after Mapema is repaid: the **supplier chases the buyer**; the system tracks the shortfall (counsel to confirm). |
| D-23 (P1-5) | Early part-payments above principal stay in suspense until the due date, pending counsel. |
| D-24 (P1-6) | Get VAT/eTIMS tax advice now. Fee invoices and statements stay blocked until then. |
| D-25 (P1-7) | Sign-in tokens move from browser storage to secure httpOnly cookies. |
| D-26 (P1-8) | A native-speaker financial translator reviews the Swahili strings. |
| D-27 (P1-9) | Phase 1b finishes the remaining screens before Phase 2. |
| D-28 (P1-10) | The 30/90-day non-performing period goes in the master agreement, pending counsel. |
| D-29 (P1-11) | Keep the Postgres job queue instead of Redis for now. |
| D-30 (P1-12) | Confirm the simple APR method (44.96% for the worked example) with counsel before marketing uses it. |

### Phase 1b engineering decisions (17 Nov 2026)

**[Tech Lead + Security Engineer]** Recorded 17 Nov 2026, 19:20 GMT (London). Defaults taken while building Phase 1b. Each is listed as a question for Deng in `app/docs/phase-1b/README.md`; they stand unless he says otherwise.

| ID | Decision |
| --- | --- |
| D-31 | Browser sessions are server-side. The `mapema_sid` cookie (HttpOnly, Secure, SameSite=Strict) holds an opaque id; only its SHA-256 is stored. CSRF uses an HMAC synchroniser token in `X-CSRF-Token`, an Origin allow-list and SameSite. Sessions last 15 min idle and 8 h at most; step-up rotates the id. Bearer tokens remain for API clients. Implements D-25. |
| D-32 | For now the OIDC PKCE code exchange stays in the browser (token in memory only, swapped for the cookie at once). A server-side BFF exchange is required before go-live. |
| D-33 | Shortfall (implements D-22): after Mapema is repaid, any unpaid remainder is recorded as owed by the buyer to the supplier. Later buyer payments matched by invoice reference go to the supplier. The supplier admin can close a shortfall as recovered directly or forgiven. Mapema does not chase the buyer for the supplier. Wording to counsel. |
| D-34 | The rate limiter is shared through Postgres (UNLOGGED table) instead of adding Redis (consistent with D-29). It fails open if the store errors. |
| D-35 | KYC checks are valid for 12 months (`KYC_REFRESH_MONTHS`). This is a Mapema policy default, not a cited regulatory figure (unverified), for compliance/counsel to confirm. Reminders go out at 30/7/0 days; new advances are refused once a check expires or a programme passes its review date. |
| D-36 | Payment receipts (BUY-12) are issued as plain receipts marked "not a tax invoice". Statements and fee invoices stay blocked on tax advice (D-24). |
