-- =============================================================================
-- Mapema Phase 2 migration [Backend Engineer + Compliance & Risk Analyst]
-- Scale and reporting: reconciliation v2 (classification, baseline, item keys), collections
-- automation (reminders, recourse cases, NPL/in duplum snapshot), month-end report snapshots and
-- artefacts (append-only), report templates (DRAFT until official formats), accounting journal pushes,
-- fee-invoice hook (disabled, D-24), CRM sync.
-- =============================================================================
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'collections_policy_change';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'recourse_start';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'reconciliation_baseline_set';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'reconciliation_break_resolve';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'report_template_activate';

BEGIN;
SET search_path = mapema, public;

-- ---------------------------------------------------------------- settings
INSERT INTO platform_setting (key, value) VALUES
  ('collections_policy', '{"preDueDays":[7,1],"overdueDays":[1,7,14],"supplierWarningDay":14,"recourseAfterDays":30,"nplDaysShortTerm":30,"nplDaysLongTerm":90,"shortTermMaxDays":30,"counselConfirmed":false}'::jsonb),
  ('fee_invoices_enabled', 'false'::jsonb)   -- D-24: blocked on tax advice
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- advance: dates + in duplum snapshot
ALTER TABLE advance ADD COLUMN npl_at date;
ALTER TABLE advance ADD COLUMN npl_principal_cents money_cents;     -- principal outstanding when it became non-performing
ALTER TABLE advance ADD COLUMN npl_charges_cents money_cents;       -- interest+fees+penalties charged (net of waivers) at NPL
ALTER TABLE advance ADD COLUMN in_duplum_waived_cents money_cents NOT NULL DEFAULT 0;
ALTER TABLE advance ADD COLUMN late_at date;
ALTER TABLE advance ADD COLUMN recourse_at date;
ALTER TABLE advance ADD COLUMN written_off_on date;
ALTER TABLE advance ADD COLUMN settled_on date;
ALTER TABLE payout ADD COLUMN value_date date;                       -- business date the bank was instructed (statement matching)

-- ---------------------------------------------------------------- collections
CREATE TABLE reminder_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id   uuid NOT NULL REFERENCES advance(id),
  step_key     text NOT NULL,                       -- pre_7, due_0, od_1, sup_warn_14 ...
  audience     text NOT NULL CHECK (audience IN ('buyer','supplier')),
  scheduled_for date NOT NULL,
  status       text NOT NULL CHECK (status IN ('sent','skipped')),
  run_date     date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (advance_id, step_key)
);

CREATE TABLE recourse_case (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id      uuid NOT NULL UNIQUE REFERENCES advance(id),
  supplier_id     uuid NOT NULL REFERENCES organisation(id),
  status          text NOT NULL DEFAULT 'due' CHECK (status IN ('due','demanded','closed_repaid','closed_written_off','closed_other')),
  opened_on       date NOT NULL,
  dpd_at_open     integer NOT NULL,
  proposed_by     uuid REFERENCES user_account(id),
  approved_via    uuid REFERENCES approval_request(id),
  demanded_on     date,
  amount_demanded_cents money_cents,
  closed_on       date,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE in_duplum_waiver (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id   uuid NOT NULL REFERENCES advance(id),
  as_of_date   date NOT NULL,
  amount_cents money_cents NOT NULL CHECK (amount_cents > 0),
  ledger_ref   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (advance_id, as_of_date)
);

-- ---------------------------------------------------------------- reconciliation v2
ALTER TABLE reconciliation_run DROP CONSTRAINT IF EXISTS reconciliation_run_status_check;
ALTER TABLE reconciliation_run ADD CONSTRAINT reconciliation_run_status_check CHECK (status IN ('balanced','explained','breaks','error'));
ALTER TABLE reconciliation_run ADD COLUMN unexplained_count integer NOT NULL DEFAULT 0;
ALTER TABLE reconciliation_run ADD COLUMN detail jsonb;             -- movements, differences, baseline used
ALTER TABLE reconciliation_break DROP CONSTRAINT IF EXISTS reconciliation_break_status_check;
ALTER TABLE reconciliation_break ADD CONSTRAINT reconciliation_break_status_check CHECK (status IN ('open','explained','closed','cleared'));
ALTER TABLE reconciliation_break ADD COLUMN item_key text;
ALTER TABLE reconciliation_break ADD COLUMN classification text CHECK (classification IN ('timing','explained','unexplained'));
ALTER TABLE reconciliation_break ADD COLUMN category text;
ALTER TABLE reconciliation_break ADD COLUMN expected_clear_by date;
ALTER TABLE reconciliation_break ADD COLUMN carry_forward boolean NOT NULL DEFAULT false;
ALTER TABLE reconciliation_break ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX reconciliation_break_item ON reconciliation_break (run_id, item_key) WHERE item_key IS NOT NULL;

CREATE TABLE reconciliation_baseline (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_cents      signed_money_cents NOT NULL,
  fineract_cents  signed_money_cents NOT NULL,
  platform_cents  signed_money_cents NOT NULL,
  note            text NOT NULL,
  approved_via    uuid NOT NULL REFERENCES approval_request(id),
  effective_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- reports
CREATE TABLE report_template (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('cbk_return','crb_file','lender_pack')),
  version      text NOT NULL,
  status       text NOT NULL CHECK (status IN ('assumed_draft','official')),
  source_ref   text NOT NULL,                    -- where the layout came from (official doc ref, or 'ASSUMPTION')
  mapping      jsonb NOT NULL,
  active       boolean NOT NULL DEFAULT false,
  approved_via uuid REFERENCES approval_request(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, version)
);
CREATE UNIQUE INDEX report_template_one_active ON report_template (kind) WHERE active;

CREATE TABLE report_snapshot (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period       text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  version      integer NOT NULL,
  as_of_date   date NOT NULL,
  data         jsonb NOT NULL,
  sha256       text NOT NULL,
  reason       text,
  created_by   uuid REFERENCES user_account(id),   -- null = month-end job
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period, version)
);

CREATE TABLE report_artifact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id  uuid NOT NULL REFERENCES report_snapshot(id),
  kind         text NOT NULL,
  template_id  uuid REFERENCES report_template(id),
  format       text NOT NULL CHECK (format IN ('csv','pdf')),
  filename     text NOT NULL,
  draft        boolean NOT NULL,
  content      bytea NOT NULL,
  sha256       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, template_id, filename)
);

-- ---------------------------------------------------------------- integrations
CREATE TABLE accounting_push (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date   date NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL CHECK (status IN ('opening_captured','pushed','nothing_to_push','error')),
  trial_balance   jsonb NOT NULL,           -- Fineract TB at push time (next day's delta base)
  journal         jsonb,
  provider        text NOT NULL,
  provider_ref    text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fee_invoice_hook (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id  uuid NOT NULL UNIQUE REFERENCES advance(id),
  status      text NOT NULL CHECK (status IN ('skipped_disabled','queued','issued','error')),
  provider_ref text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_sync (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL DEFAULT 'site_d1',
  source_id    text NOT NULL,
  source_created_at text NOT NULL,
  status       text NOT NULL CHECK (status IN ('synced','skipped','error','erasure_pending')),
  reason       text,
  crm_contact_id text,
  crm_deal_id  text,
  lawful_basis text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE ON reminder_event, recourse_case, in_duplum_waiver, reconciliation_baseline, report_template, accounting_push, fee_invoice_hook, crm_sync TO mapema_app;
-- append-only: snapshots and artefacts can be added, never changed or removed
GRANT SELECT, INSERT ON report_snapshot, report_artifact TO mapema_app;
REVOKE UPDATE, DELETE, TRUNCATE ON report_snapshot, report_artifact FROM mapema_app;
GRANT SELECT ON reminder_event, recourse_case, in_duplum_waiver, reconciliation_baseline, report_template, report_snapshot, report_artifact, accounting_push, fee_invoice_hook, crm_sync TO mapema_readonly;
COMMIT;
