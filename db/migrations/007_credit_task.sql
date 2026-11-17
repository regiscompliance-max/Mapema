-- [Backend Engineer + Credit] Phase 1b CRD-07: review-date and KYC-expiry reminders become credit tasks.
-- One row per (subject, due date, threshold) so the daily job is idempotent.
SET search_path = mapema, public;
CREATE TABLE credit_task (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('programme_review','limit_review','kyc_expiry')),
  org_id         uuid NOT NULL REFERENCES organisation(id),
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  due_date       date NOT NULL,
  threshold_days smallint NOT NULL CHECK (threshold_days IN (30, 7, 0)),  -- 0 = date reached: party excluded from new advances
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  done_by        uuid REFERENCES user_account(id),
  done_at        timestamptz,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, entity_id, due_date, threshold_days),
  CHECK ((status = 'done') = (done_at IS NOT NULL))
);
CREATE INDEX credit_task_open ON credit_task (status, due_date);
GRANT SELECT, INSERT, UPDATE ON credit_task TO mapema_app;
GRANT SELECT ON credit_task TO mapema_readonly;
-- Existing KYC results without an expiry get the default 12-month validity from when they were run.
UPDATE kyc_check SET expires_at = checked_at + interval '12 months' WHERE expires_at IS NULL;
