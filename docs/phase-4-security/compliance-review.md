# Phase 4 compliance review

**[Compliance & Risk Analyst]** 18 Nov 2026, Europe/London. Read with the go-live counsel pack (now including section I) and `proposal.md`.

## What this phase does for compliance

- Treats the MPSRA Office of the Registrar of Security Rights as the place to search and file, without inventing an API (IFC 2022). Evidence and registration numbers are retained.
- Tightens invoice-fraud controls that buyers in the FSD 2013 note asked for: notify both parties, unique official invoice identifiers, similar-invoice review, goods-received attestation.
- Keeps eTIMS as the working original (UNCTAD 2025): unavailable is not a silent pass to funding.
- Surfaces government-payer dependency on the buyer credit file (UNCTAD 2025 government payment delays, especially construction) without tightening sector caps or changing the CRB file.
- Defers credit insurance (FSD 2015) and contract wording changes until after the first live programme / counsel answers.

## Counsel (added, not sent)

I1–I6 in `docs/go-live/counsel-question-pack.md`. The pack itself is still not sent in this phase. Contract templates (master agreement, programme agreement, ILU, notice of assignment) are unchanged.

## Licensing and public wording

Mapema remains **not yet licensed**. The anti-fraud notice is a draft in the application and a non-deployed `site-draft`. It must not be published on the marketing site until counsel reviews it and Deng asks for a deploy.

## Data protection

Search certificates and filing evidence are treated as documents that may contain PII, stored in the encrypted WORM bucket, access-controlled like other staff evidence. No new live processor. No change to the CRB assumed-layout file (still supplier as borrower).

## Residual risks

- Manual portal search can go stale between search and funding; I1 asks counsel how long a certificate remains reliable.
- Priority in insolvency is not confirmed (I2).
- Anti-assignment clauses (I3) and a possible factoring Act (I5) could change the legal design.
- Government-payer flag is a credit judgement aid, not a cure for delayed government settlement.
