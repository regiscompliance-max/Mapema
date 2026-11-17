-- =============================================================================
-- Mapema Phase 1 migration [Backend Engineer + Compliance & Risk Analyst]
-- Adds what the Phase 1 build needed on top of the signed-off Phase 0 schema:
--   * platform_setting: lending switch (D-05) and minimum invoice (D-07)
--   * approval actions for the lending switch
--   * payment ledger posting state (held remainders before due date)
--   * advance quote columns used by settlement, sectors seed
-- =============================================================================
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'lending_enable';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'lending_disable';

BEGIN;
SET search_path = mapema, public;

-- Key/value platform settings. Changes to lending.* only via approval_request (four-eyes).
CREATE TABLE platform_setting (
  key          text PRIMARY KEY,
  value        jsonb NOT NULL,
  updated_via  uuid REFERENCES approval_request(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_setting (key, value) VALUES
  ('lending', '{"enabled": false, "cbk_licence_no": null}'::jsonb),     -- D-05: off until licence entered + second-person approved
  ('invoice_minimum_cents', '5000000'::jsonb);                        -- D-07: KES 50,000

-- Advance: keep the economic terms used at settlement next to the workflow row
ALTER TABLE advance ADD COLUMN rate_bps_per_30d bps;
ALTER TABLE advance ADD COLUMN term_days integer CHECK (term_days BETWEEN 1 AND 120);
ALTER TABLE advance ADD COLUMN due_date date;
ALTER TABLE advance ADD COLUMN disbursement_date date;
ALTER TABLE advance ADD COLUMN released_by uuid REFERENCES user_account(id);
ALTER TABLE advance ADD CONSTRAINT advance_release_four_eyes CHECK (released_by IS NULL OR approved_by IS NULL OR released_by <> approved_by);

-- Payment: ledger posting state. Before the due date only principal is posted immediately; a
-- remainder smaller than fees+interest payoff is held (unapplied) and posted on the due date so
-- Fineract applies it fees-before-interest (proof test TC-FIN-03/04, qa-report section 4).
ALTER TABLE payment ADD COLUMN status text NOT NULL DEFAULT 'unmatched'
  CHECK (status IN ('unmatched','matched','applied','partially_applied','refund_due','refunded'));
ALTER TABLE payment ADD COLUMN held_cents money_cents NOT NULL DEFAULT 0;
ALTER TABLE payment ADD COLUMN advance_id uuid REFERENCES advance(id);
CREATE UNIQUE INDEX payment_one_per_bank_txn ON payment(bank_transaction_id);

-- Supplier deferred price (D-01) payout proposals carry the system as maker
ALTER TABLE payout ADD COLUMN proposed_by_system boolean NOT NULL DEFAULT false;
ALTER TABLE payout ADD COLUMN payment_id uuid REFERENCES payment(id);
CREATE UNIQUE INDEX payout_one_balance_per_payment ON payout(payment_id) WHERE type = 'balance' AND status NOT IN ('failed','returned','cancelled');

-- Invitation metadata (role to grant, time-boxed access for auditors/lenders, inviting buyer)
ALTER TABLE invitation ADD COLUMN role_to_grant user_role;
ALTER TABLE invitation ADD COLUMN access_expires_at timestamptz;
ALTER TABLE invitation ADD COLUMN buyer_id uuid REFERENCES organisation(id);

-- Notice of assignment / receipts reference
ALTER TABLE notification ADD COLUMN entity_type text;
ALTER TABLE notification ADD COLUMN entity_id uuid;
ALTER TABLE notification ADD COLUMN recipient_hint text;  -- masked address for display

-- Sectors (illustrative KNBS-style list; credit to confirm)
INSERT INTO sector (code, name) VALUES
  ('MFG', 'Manufacturing'), ('FMCG', 'Fast-moving consumer goods'), ('AGRI', 'Agriculture and agro-processing'),
  ('CONS', 'Construction'), ('HEALTH', 'Health and pharmaceuticals'), ('LOGI', 'Transport and logistics'),
  ('HOSP', 'Hospitality'), ('ICT', 'ICT and telecoms'), ('ENERGY', 'Energy'), ('OTHER', 'Other')
ON CONFLICT (code) DO NOTHING;
INSERT INTO limit_config (subject, subject_sector_id, pct_of_float_bps)
SELECT 'sector', id, 3500 FROM sector
WHERE NOT EXISTS (SELECT 1 FROM limit_config lc WHERE lc.subject = 'sector' AND lc.subject_sector_id = sector.id);

-- Retention schedule placeholders (Q-16: counsel to confirm periods)
INSERT INTO retention_policy (record_type, retain_for, legal_basis) VALUES
  ('loan_records', interval '7 years', 'NDTCP Regulations record keeping (counsel to confirm)'),
  ('kyc_records', interval '7 years', 'POCAMLA s.46 (counsel to confirm)'),
  ('audit_event', interval '10 years', 'Audit trail (counsel to confirm)'),
  ('marketing_leads', interval '2 years', 'DPA s.39 storage limitation')
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON platform_setting TO mapema_app;
GRANT SELECT ON platform_setting TO mapema_readonly;
COMMIT;

-- Capital / facility cash movements into the Mapema bank accounts (needed so daily
-- reconciliation can explain platform cash; recorded with maker-checker via float_change).
BEGIN;
SET search_path = mapema, public;
CREATE TABLE funding_movement (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_cents money_cents NOT NULL CHECK (amount_cents > 0),
  direction    text NOT NULL CHECK (direction IN ('in','out')),
  source       text NOT NULL,            -- e.g. 'equity', 'facility A drawdown'
  reference    text NOT NULL UNIQUE,
  value_date   date NOT NULL,
  approved_via uuid REFERENCES approval_request(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON funding_movement TO mapema_app;
GRANT SELECT ON funding_movement TO mapema_readonly;
COMMIT;

-- E-signature envelopes in flight (master agreement + deed, programme agreement, ILUs)
BEGIN;
SET search_path = mapema, public;
CREATE TABLE esign_envelope (
  envelope_id  text PRIMARY KEY,
  purpose      text NOT NULL CHECK (purpose IN ('supplier_agreements','programme_agreement','ilu')),
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  status       text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','completed','declined','expired')),
  document_id  uuid REFERENCES document(id),
  created_by   uuid REFERENCES user_account(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
GRANT SELECT, INSERT, UPDATE ON esign_envelope TO mapema_app;
GRANT SELECT ON esign_envelope TO mapema_readonly;
COMMIT;

-- failed requests release their idempotency key so the client can retry
GRANT DELETE ON mapema.idempotency_key TO mapema_app;
