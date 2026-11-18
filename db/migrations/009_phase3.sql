-- =============================================================================
-- Mapema Phase 3 migration [Backend Engineer + Compliance & Risk Analyst]
-- Growth: ERP connectors (connections, versioned field mappings, import runs/items), multi-lender
-- funding sources and tags (with history), M-Pesa B2C payout state, payout batches.
-- Money stays integer cents (money_cents); all changes that matter are maker-checker.
-- =============================================================================
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'erp_mapping_change';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'funding_source_change';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'funding_retag';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'mpesa_cap_change';

BEGIN;
SET search_path = mapema, public;

INSERT INTO platform_setting (key, value) VALUES ('mpesa_payout_cap_cents', '15000000'::jsonb) -- KES 150,000 (Q-N)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- ERP
CREATE TABLE erp_connection (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id            uuid NOT NULL REFERENCES organisation(id),
  kind                text NOT NULL CHECK (kind IN ('odoo','csv_sftp','sap','sage','dynamics')),
  name                text NOT NULL,
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-secret settings only (base URL, database, username)
  secret_env          text CHECK (secret_env ~ '^ERP_SECRET_[A-Z0-9_]{1,60}$'),  -- NAME of the env var; never the secret
  status              text NOT NULL DEFAULT 'pending_mapping' CHECK (status IN ('pending_mapping','active','paused','disabled')),
  integration_user_id uuid NOT NULL REFERENCES user_account(id),  -- uploader of record (no roles): keeps four eyes with the buyer checker
  cursor              text,
  auth_failures       int NOT NULL DEFAULT 0,
  last_run_at         timestamptz,
  last_error          text,
  created_by          uuid NOT NULL REFERENCES user_account(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX erp_connection_buyer ON erp_connection (buyer_id);

CREATE TABLE erp_field_mapping (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid NOT NULL REFERENCES erp_connection(id),
  version        int NOT NULL,
  definition     jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','superseded','rejected')),
  proposed_by    uuid NOT NULL REFERENCES user_account(id),
  approved_via   uuid REFERENCES approval_request(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, version)
);
CREATE UNIQUE INDEX erp_field_mapping_one_active ON erp_field_mapping (connection_id) WHERE status = 'active';

CREATE TABLE erp_import_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid NOT NULL REFERENCES erp_connection(id),
  trigger        text NOT NULL CHECK (trigger IN ('schedule','manual')),
  status         text NOT NULL CHECK (status IN ('running','completed','failed')),
  error_code     text,
  fetched        int NOT NULL DEFAULT 0,
  created        int NOT NULL DEFAULT 0,
  duplicates     int NOT NULL DEFAULT 0,
  errors         int NOT NULL DEFAULT 0,
  skipped        int NOT NULL DEFAULT 0,
  changed        int NOT NULL DEFAULT 0,
  cursor_before  text,
  cursor_after   text,
  files          jsonb,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

CREATE TABLE erp_import_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    uuid NOT NULL REFERENCES erp_connection(id),
  external_id      text NOT NULL,
  external_version text NOT NULL,
  status           text NOT NULL CHECK (status IN ('created','duplicate','error','skipped','changed_after_import')),
  error_code       text,
  error_detail     text,
  invoice_id       uuid REFERENCES invoice(id),
  mapping_version  int NOT NULL,
  last_run_id      uuid NOT NULL REFERENCES erp_import_run(id),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)   -- idempotency: one item per ERP record, ever
);

-- ---------------------------------------------------------------- funding sources
CREATE TABLE funding_source (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,23}$'),
  name             text NOT NULL,
  type             text NOT NULL CHECK (type IN ('equity','debt_facility','other')),
  limit_cents      money_cents,
  priority         int NOT NULL CHECK (priority BETWEEN 0 AND 1000),
  active           boolean NOT NULL DEFAULT false,
  eligibility      jsonb NOT NULL DEFAULT '{}'::jsonb,
  covenants        jsonb NOT NULL DEFAULT '{}'::jsonb,
  fineract_fund_id bigint,
  approved_via     uuid REFERENCES approval_request(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'debt_facility' OR limit_cents IS NOT NULL)
);
ALTER TABLE advance ADD CONSTRAINT advance_funding_source_fk FOREIGN KEY (funding_source_id) REFERENCES funding_source(id);  -- column reserved in 001
ALTER TABLE advance ADD COLUMN funding_requested_code text;   -- named by credit at approval (validated again at release)
ALTER TABLE advance ADD COLUMN funding_tagged_at timestamptz;

CREATE TABLE funding_tag_history (
  id            bigserial PRIMARY KEY,
  advance_id    uuid NOT NULL REFERENCES advance(id),
  from_source_id uuid REFERENCES funding_source(id),
  to_source_id  uuid NOT NULL REFERENCES funding_source(id),
  effective_on  date NOT NULL,
  reason        text NOT NULL,
  approved_via  uuid REFERENCES approval_request(id),
  ledger_synced_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX funding_tag_history_advance ON funding_tag_history (advance_id, id);

-- ---------------------------------------------------------------- M-Pesa B2C on payouts
ALTER TABLE payout ADD COLUMN mpesa_state text CHECK (mpesa_state IN ('accepted','completed','failed','timeout','unknown'));
ALTER TABLE payout ADD COLUMN mpesa_conversation_id text;
ALTER TABLE payout ADD COLUMN mpesa_requested_at timestamptz;
ALTER TABLE payout ADD COLUMN mpesa_result jsonb;
ALTER TABLE payout ADD COLUMN mpesa_last_query_at timestamptz;

-- ---------------------------------------------------------------- payout batches
CREATE TABLE payout_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status        text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','processing','completed','partially_failed','failed','cancelled')),
  note          text NOT NULL,
  total_cents   money_cents NOT NULL,
  item_count    int NOT NULL,
  created_by    uuid NOT NULL REFERENCES user_account(id),
  approved_by   uuid REFERENCES user_account(id),
  approved_at   timestamptz,
  step_up_auth_ref text,
  released_cents money_cents NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT payout_batch_four_eyes CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE TABLE payout_batch_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES payout_batch(id),
  seq           int NOT NULL,
  advance_id    uuid NOT NULL REFERENCES advance(id),
  amount_cents  money_cents NOT NULL,
  rail          text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected','released','failed')),
  error_code    text,
  error_detail  jsonb,
  reject_reason text,
  decided_at    timestamptz,
  UNIQUE (batch_id, seq)
);
CREATE UNIQUE INDEX payout_batch_item_open ON payout_batch_item (advance_id) WHERE status = 'pending';

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE ON erp_connection, erp_field_mapping, erp_import_run, erp_import_item, funding_source, payout_batch, payout_batch_item TO mapema_app;
GRANT SELECT, INSERT ON funding_tag_history TO mapema_app;
GRANT UPDATE (ledger_synced_at) ON funding_tag_history TO mapema_app;
GRANT USAGE ON SEQUENCE funding_tag_history_id_seq TO mapema_app;
GRANT SELECT ON erp_connection, erp_field_mapping, erp_import_run, erp_import_item, funding_source, funding_tag_history, payout_batch, payout_batch_item TO mapema_readonly;
COMMIT;
