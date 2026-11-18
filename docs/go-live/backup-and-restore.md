# Backup, point-in-time recovery and the monthly restore test

**[DevOps + QA]** 18 Nov 2026. Applies to staging first, then production. Nothing is provisioned yet.

## What is backed up

| Data | Where | Backup | Retention |
| --- | --- | --- | --- |
| Platform DB (`mapema` schema: audit log, invoices, advances, report artefacts encrypted at rest) | RDS PostgreSQL 17 | Automated snapshots + WAL = **PITR to any second** in the window | staging 7 days, production **35 days** (RDS maximum) |
| Fineract DB (the ledger) | same RDS instance, separate database and role | same PITR, restored **together** with the platform DB to the same timestamp | same |
| Keycloak DB | same instance, separate database | same | same |
| Long-term copies | monthly manual snapshot copied to a second region (e.g. eu-west-1 or an in-country store, counsel to confirm) | encrypted with KMS | 7 years for lending records (draft retention, Phase 1 Q-16, counsel to confirm) |
| Object storage (exports) | S3, versioned, KMS | versioning + lifecycle | 90 days of old versions |
| Secrets | Secrets Manager | replicated by AWS; **`STORAGE_ENCRYPTION_KEY` also kept offline by Deng (sealed envelope / password manager)**: without it field-encrypted columns and report artefacts are unreadable | indefinite |

Targets (Phase 0 Q-15 default): **RPO 15 minutes, RTO 4 hours** (RDS PITR typically achieves about 5 minutes).

## Restoring (incident or test)

1. Pick the timestamp T (before the incident). Restore **both** platform and Fineract to the same T (RDS
   `restore-db-instance-to-point-in-time` into a new instance; never over the live one).
2. Run the restore check against the new instance:
   `RESTORED_DATABASE_URL=<restored> STORAGE_ENCRYPTION_KEY=<key> node scripts/restore-check.mjs`
   (migrations all recorded, audit hash chain recomputes, a sample of report artefacts decrypts and matches sha256,
   key tables non-empty, latest audit time = achieved RPO). Exit code 0 = usable.
3. Run the daily reconciliation for the restored day: bank = Fineract cash = platform must balance. Any unexplained
   break after a restore is investigated before traffic is switched.
4. Re-point the API/worker (`DATABASE_URL`) and Fineract; replay nothing by hand: the outbox resumes pending jobs and
   is idempotent (no payout is ever resent automatically, D-58).

## Monthly restore test (first Tuesday, 10:00 EAT)

- Restore staging (production once live) to "now minus 1 hour" into a throwaway instance.
- Run `scripts/restore-check.mjs` and reconciliation as above; record RPO/RTO achieved, operator, result, in the
  ops log; delete the throwaway instance.
- Failure = P2 incident; two failures in a row are reported to the board (C-14 business continuity).
- `TC-GL-BAK-01` (apps/api/test/golive.e2e.test.ts) proves the check itself: it passes on a good database and catches
  a tampered artefact and a missing migration.
