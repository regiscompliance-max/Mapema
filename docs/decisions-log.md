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
