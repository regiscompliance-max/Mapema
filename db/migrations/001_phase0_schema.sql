-- =============================================================================
-- Mapema platform database schema v1 (from Phase 0, signed off 17 Nov 2026) (PostgreSQL 15+)
-- [Solution Architect + Backend Engineer + Security Engineer]
--
-- WHAT LIVES HERE vs IN APACHE FINERACT
--   Platform DB (this file): organisations, people, users/roles, programmes,
--     invoices, confirmations/ILUs, price disclosures, advance WORKFLOW state,
--     approvals (maker-checker), payouts (instructions), incoming bank
--     transactions & matching, limits/float config, documents, KYC/CRB checks,
--     consents, disputes, complaints, DSRs, reconciliation, outbox, audit log.
--   Apache Fineract (system of record for money; NEVER duplicated as a ledger):
--     client & loan accounts, loan schedules, interest accrual, charges,
--     repayment transactions and their principal/fee/interest split, write-offs,
--     general ledger, journal entries, trial balance.
--   Columns named fineract_* hold Fineract IDs. Columns named mirror_* are a
--     read-only cache refreshed from Fineract for display/reconciliation; they
--     are never used to decide money movements without re-reading Fineract.
--
-- RULES ENCODED
--   * Money = KES integer cents (bigint) via domain money_cents. No float/numeric.
--   * Currency column constrained to 'KES'.
--   * Rates = integer basis points (1 bp = 0.01%).
--   * audit_event is append-only (trigger + privileges) and hash-chained.
--   * approval_request: checker must differ from maker (CHECK).
--   * PII marked [ENCRYPTED]: stored as application-level envelope-encrypted
--     bytea (AES-256-GCM, KMS-wrapped data key); *_bidx = HMAC-SHA256 blind
--     index for exact-match lookup. Plaintext never stored.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS mapema;
SET search_path = mapema, public;

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------
CREATE DOMAIN money_cents AS bigint CHECK (VALUE >= 0);
CREATE DOMAIN signed_money_cents AS bigint;            -- only for differences/breaks
CREATE DOMAIN currency_code AS char(3) DEFAULT 'KES' CHECK (VALUE = 'KES');
CREATE DOMAIN bps AS integer CHECK (VALUE >= 0 AND VALUE <= 10000);
CREATE DOMAIN kra_pin AS text CHECK (VALUE ~ '^[A-Z][0-9]{9}[A-Z]$');
CREATE DOMAIN sha256_hex AS char(64) CHECK (VALUE ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE org_type AS ENUM ('buyer','supplier');
CREATE TYPE org_status AS ENUM (
  'prospect','kyb_submitted','under_review','approved','live',          -- buyer
  'invited','kyc_pending','kyc_review','kyc_passed','kyc_failed',
  'agreement_signed','active',                                           -- supplier
  'suspended','offboarded');
CREATE TYPE user_role AS ENUM (
  'buyer_admin','buyer_maker','buyer_checker',
  'supplier_admin','supplier_user',
  'credit','ops','compliance','admin','ceo',
  'auditor','lender');
CREATE TYPE invoice_status AS ENUM (
  'draft','awaiting_confirmation','confirmed','on_hold','rejected',
  'ilu_signed','eligible','advance_requested','funded','settled',
  'disputed','cancelled');
CREATE TYPE etims_status AS ENUM ('pending','valid','invalid','unavailable','overridden');
CREATE TYPE advance_status AS ENUM (
  'requested','approved','released','funded','settled',
  'late','recourse','non_performing','written_off',
  'declined','release_failed','cancelled');
CREATE TYPE payout_type AS ENUM ('advance','balance','refund');
CREATE TYPE payout_status AS ENUM ('proposed','approved','released','confirmed','failed','returned','cancelled');
CREATE TYPE approval_status AS ENUM ('pending','approved','rejected','expired','cancelled');
CREATE TYPE approval_action AS ENUM (
  'buyer_programme_approve','supplier_limit_set','limit_config_change',
  'float_change','pricing_version_activate','payout_release',
  'user_role_change','write_off','manual_payment_match',
  'reconciliation_break_close','etims_override','template_publish',
  'bank_account_verify','crb_submission','dispute_close');
CREATE TYPE limit_subject AS ENUM ('buyer','supplier','sector');
CREATE TYPE doc_type AS ENUM (
  'certificate_of_incorporation','cr12','kra_pin_certificate','board_resolution',
  'national_id','passport','selfie','bank_proof','audited_accounts',
  'programme_agreement','master_agreement','deed_of_assignment','ilu',
  'notice_of_assignment','invoice_pdf','invoice_csv','credit_report',
  'demand_letter','receipt','statement','fee_invoice','cbk_approval_letter',
  'audit_export','other');
CREATE TYPE consent_purpose AS ENUM ('crb_enquiry_and_reporting','data_sharing_with_buyer','marketing','cross_border_transfer');
CREATE TYPE pricing_status AS ENUM ('draft','pending_cbk','approved','scheduled','active','retired');
CREATE TYPE match_method AS ENUM ('auto_reference','auto_amount','auto_sum','manual');
CREATE TYPE dsr_type AS ENUM ('access','correction','deletion','objection','portability','restriction');

-- ---------------------------------------------------------------------------
-- Reference & organisations
-- ---------------------------------------------------------------------------
CREATE TABLE sector (
  id            smallserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL
);

CREATE TABLE organisation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type               org_type   NOT NULL,
  legal_name         text       NOT NULL,
  trading_name       text,
  kra_pin            kra_pin    NOT NULL,
  registration_no    text       NOT NULL,
  sector_id          smallint   REFERENCES sector(id),
  status             org_status NOT NULL,
  address            jsonb,
  fineract_client_id bigint,                 -- suppliers only (borrower); Fineract owns balances
  dispute_freeze     boolean    NOT NULL DEFAULT false,  -- buyer: set while any dispute open
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, kra_pin)
);
COMMENT ON COLUMN organisation.fineract_client_id IS 'Fineract client id; loan balances live in Fineract.';

CREATE TABLE person (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organisation(id),
  full_name              text NOT NULL,
  national_id_enc        bytea,          -- [ENCRYPTED] national ID / passport no.
  national_id_bidx       bytea,          -- HMAC blind index for lookup
  id_document_type       text CHECK (id_document_type IN ('national_id','passport','alien_id')),
  date_of_birth_enc      bytea,          -- [ENCRYPTED]
  phone_enc              bytea,          -- [ENCRYPTED] E.164
  phone_bidx             bytea,
  email                  citext,
  is_director            boolean NOT NULL DEFAULT false,
  is_beneficial_owner    boolean NOT NULL DEFAULT false,
  is_authorised_signatory boolean NOT NULL DEFAULT false,
  pep                    boolean,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_org_idx ON person(org_id);
CREATE INDEX person_nid_bidx ON person(national_id_bidx);

CREATE TABLE user_account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid REFERENCES person(id),   -- null for Mapema staff/auditors without org person rows
  idp_subject     text NOT NULL UNIQUE,         -- Keycloak user id
  email           citext NOT NULL UNIQUE,
  display_name    text NOT NULL,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_methods     text[] NOT NULL DEFAULT '{}', -- totp, webauthn, sms
  active          boolean NOT NULL DEFAULT true,
  access_expires_at timestamptz,               -- mandatory for auditor/lender (enforced in service)
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_role_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES user_account(id),
  role         user_role NOT NULL,
  org_id       uuid REFERENCES organisation(id),       -- scope for buyer_/supplier_ roles; null for Mapema roles
  lender_fund_id uuid,                                  -- scope for lender role (Phase 3)
  granted_via_approval uuid,                            -- FK added below
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  UNIQUE (user_id, role, org_id)
);

CREATE TABLE bank_account (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organisation(id),
  bank_code            text NOT NULL,
  branch_code          text,
  account_name         text NOT NULL,
  account_number_enc   bytea NOT NULL,   -- [ENCRYPTED]
  account_number_bidx  bytea NOT NULL,
  account_number_last4 char(4) NOT NULL,
  currency             currency_code NOT NULL,
  is_payout_default    boolean NOT NULL DEFAULT false,
  name_match_result    text,             -- from bank adapter where available
  verified_at          timestamptz,
  verified_by          uuid REFERENCES user_account(id),
  cooling_off_until    timestamptz,      -- payouts blocked until this time (SUP-11)
  created_at           timestamptz NOT NULL DEFAULT now(),
  deactivated_at       timestamptz
);
CREATE UNIQUE INDEX bank_account_one_default ON bank_account(org_id) WHERE is_payout_default AND deactivated_at IS NULL;

-- Virtual collection account per buyer (number from bank adapter)
CREATE TABLE collection_account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id         uuid NOT NULL UNIQUE REFERENCES organisation(id),
  bank_code        text NOT NULL,
  virtual_account_no text NOT NULL UNIQUE,
  currency         currency_code NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Pricing, programmes, limits
-- ---------------------------------------------------------------------------
CREATE TABLE pricing_version (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                       text NOT NULL UNIQUE,         -- e.g. 'STD-2027-01'
  advance_rate_bps           bps  NOT NULL,                -- 8000 = 80%
  discount_rate_bps_per_30d  bps  NOT NULL,                -- 350 = 3.5% per 30 days
  day_basis                  smallint NOT NULL DEFAULT 30 CHECK (day_basis = 30),
  verification_fee_cents     money_cents NOT NULL,         -- 250000 = KES 2,500.00
  rounding_rule              text NOT NULL DEFAULT 'half_up_cent' CHECK (rounding_rule IN ('half_up_cent','half_up_shilling')),
  min_days                   smallint NOT NULL DEFAULT 1,
  max_days                   smallint NOT NULL DEFAULT 120,
  status                     pricing_status NOT NULL DEFAULT 'draft',
  cbk_approval_ref           text,
  cbk_approval_doc_id        uuid,                         -- FK added below
  customer_notice_sent_at    timestamptz,
  effective_from             date,
  created_by                 uuid NOT NULL REFERENCES user_account(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_live_needs_cbk CHECK (
    status NOT IN ('approved','scheduled','active') OR cbk_approval_ref IS NOT NULL),
  CONSTRAINT pricing_live_needs_notice CHECK (
    status NOT IN ('scheduled','active') OR (customer_notice_sent_at IS NOT NULL AND effective_from IS NOT NULL))
);

CREATE TABLE buyer_programme (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id            uuid NOT NULL REFERENCES organisation(id),
  pricing_version_id  uuid NOT NULL REFERENCES pricing_version(id),
  advance_rate_bps    bps  NOT NULL,       -- per-buyer override, must be <= pricing_version.advance_rate_bps (service check)
  limit_cents         money_cents NOT NULL,
  start_date          date NOT NULL,
  review_date         date NOT NULL,
  status              text NOT NULL CHECK (status IN ('proposed','approved','live','suspended','closed')),
  approved_via        uuid,               -- approval_request (CEO four-eyes)
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (review_date > start_date)
);
CREATE UNIQUE INDEX buyer_programme_one_live ON buyer_programme(buyer_id) WHERE status IN ('approved','live');

CREATE TABLE supplier_link (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id           uuid NOT NULL REFERENCES organisation(id),
  supplier_id        uuid NOT NULL REFERENCES organisation(id),
  supplier_limit_cents money_cents,       -- per buyer relationship; global supplier limit in limit_config
  status             text NOT NULL CHECK (status IN ('invited','joined','active','suspended','ended')),
  invited_by         uuid REFERENCES user_account(id),
  invited_at         timestamptz NOT NULL DEFAULT now(),
  joined_at          timestamptz,
  UNIQUE (buyer_id, supplier_id),
  CHECK (buyer_id <> supplier_id)
);

-- Float definition with history (Q-05)
CREATE TABLE lending_float (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_cents   money_cents NOT NULL,
  effective_from timestamptz NOT NULL,
  basis_note     text NOT NULL,           -- e.g. 'equity + drawn facility A'
  approved_via   uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Brief entity "Limit". Exposure ("used") is computed in v_exposure, not stored,
-- to avoid drift; rows are locked FOR UPDATE during release to serialise checks.
CREATE TABLE limit_config (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject          limit_subject NOT NULL,
  subject_org_id   uuid REFERENCES organisation(id),
  subject_sector_id smallint REFERENCES sector(id),
  pct_of_float_bps bps,                    -- default rows: buyer 2500, supplier 1000, sector 3500
  absolute_cap_cents money_cents,
  review_date      date,
  approved_via     uuid,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (pct_of_float_bps IS NOT NULL OR absolute_cap_cents IS NOT NULL),
  CHECK (
    (subject = 'sector' AND subject_sector_id IS NOT NULL AND subject_org_id IS NULL) OR
    (subject IN ('buyer','supplier') AND subject_sector_id IS NULL)   -- null org = default for all
  )
);

-- ---------------------------------------------------------------------------
-- Documents, KYC, CRB, consent
-- ---------------------------------------------------------------------------
CREATE TABLE document (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id   uuid REFERENCES organisation(id),
  owner_person_id uuid REFERENCES person(id),
  type           doc_type NOT NULL,
  file_name      text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  file_sha256    sha256_hex NOT NULL,
  storage_bucket text NOT NULL,             -- WORM bucket for signed docs
  storage_key    text NOT NULL,
  scan_status    text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','error')),
  contains_pii   boolean NOT NULL DEFAULT true,
  signed_at      timestamptz,
  esign_envelope_id text,
  retention_until date,
  uploaded_by    uuid REFERENCES user_account(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_bucket, storage_key)
);

ALTER TABLE pricing_version ADD CONSTRAINT pricing_cbk_doc_fk FOREIGN KEY (cbk_approval_doc_id) REFERENCES document(id);

CREATE TABLE kyc_check (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_org_id uuid REFERENCES organisation(id),
  subject_person_id uuid REFERENCES person(id),
  check_type    text NOT NULL CHECK (check_type IN ('id_verification','liveness','company_registry','sanctions_pep','bank_name_match')),
  provider      text NOT NULL,
  provider_ref  text,
  result        text NOT NULL CHECK (result IN ('pass','fail','review','error')),
  details       jsonb,                      -- PII-minimised; raw report in document
  report_doc_id uuid REFERENCES document(id),
  checked_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz
);

CREATE TABLE consent (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid REFERENCES person(id),
  org_id        uuid REFERENCES organisation(id),
  purpose       consent_purpose NOT NULL,
  text_version  text NOT NULL,              -- version of consent wording shown
  granted_at    timestamptz NOT NULL,
  granted_ip    inet,
  withdrawn_at  timestamptz,
  CHECK (person_id IS NOT NULL OR org_id IS NOT NULL),
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

CREATE TABLE credit_check (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_org_id uuid REFERENCES organisation(id),
  subject_person_id uuid REFERENCES person(id),
  bureau        text NOT NULL,
  consent_id    uuid NOT NULL REFERENCES consent(id),   -- no pull without consent
  score         integer,
  bureau_ref    text,
  report_doc_id uuid REFERENCES document(id),
  pulled_by     uuid NOT NULL REFERENCES user_account(id),
  pulled_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Invoices, confirmations, ILUs
-- ---------------------------------------------------------------------------
CREATE TABLE invoice (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id        uuid NOT NULL REFERENCES organisation(id),
  buyer_id           uuid NOT NULL REFERENCES organisation(id),
  supplier_kra_pin   kra_pin NOT NULL,        -- denormalised for uniqueness
  invoice_number     text NOT NULL,
  invoice_number_norm text NOT NULL,          -- upper, trimmed, no spaces/dashes
  etims_cu_invoice_no text,                   -- KRA control-unit invoice number
  issue_date         date NOT NULL,
  due_date           date NOT NULL,
  amount_cents       money_cents NOT NULL CHECK (amount_cents > 0),
  currency           currency_code NOT NULL,
  po_reference       text,
  etims_status       etims_status NOT NULL DEFAULT 'pending',
  etims_checked_at   timestamptz,
  etims_response     jsonb,
  duplicate_hash     sha256_hex NOT NULL,     -- sha256(pin|number_norm|amount_cents) per brief
  status             invoice_status NOT NULL DEFAULT 'draft',
  uploaded_by        uuid NOT NULL REFERENCES user_account(id),
  source             text NOT NULL CHECK (source IN ('buyer_upload','buyer_csv','supplier_submit','erp')),
  pdf_doc_id         uuid REFERENCES document(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (due_date >= issue_date),
  CONSTRAINT invoice_dup_brief UNIQUE (duplicate_hash),
  -- Stricter rule recommended (Q-06): same supplier PIN + invoice number can never be financed twice
  CONSTRAINT invoice_dup_pin_number UNIQUE (supplier_kra_pin, invoice_number_norm)
);
CREATE INDEX invoice_buyer_due_idx ON invoice(buyer_id, due_date);
CREATE INDEX invoice_fuzzy_dup_idx ON invoice(supplier_kra_pin, amount_cents, issue_date);

CREATE TABLE confirmation (     -- brief entity: buyer's signed undertaking (ILU)
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id           uuid NOT NULL REFERENCES organisation(id),
  confirmed_by       uuid NOT NULL REFERENCES user_account(id),  -- buyer checker
  ilu_document_id    uuid REFERENCES document(id),               -- set when signed
  set_off_waiver     boolean NOT NULL DEFAULT true,
  is_batch           boolean NOT NULL DEFAULT false,
  signed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE confirmation_invoice (
  confirmation_id        uuid NOT NULL REFERENCES confirmation(id),
  invoice_id             uuid NOT NULL REFERENCES invoice(id) UNIQUE,  -- one ILU per invoice
  confirmed_amount_cents money_cents NOT NULL CHECK (confirmed_amount_cents > 0),
  confirmed_due_date     date NOT NULL,
  PRIMARY KEY (confirmation_id, invoice_id)
);

CREATE TABLE invoice_decision (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoice(id),
  decision    text NOT NULL CHECK (decision IN ('approve','reject','hold','release_hold')),
  reason_code text,
  reason_text text,
  decided_by  uuid NOT NULL REFERENCES user_account(id),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (decision = 'approve' OR decision = 'release_hold' OR reason_code IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Approvals (maker-checker)
-- ---------------------------------------------------------------------------
CREATE TABLE approval_request (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action           approval_action NOT NULL,
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  payload          jsonb NOT NULL,          -- proposed change (before/after)
  required_role    user_role NOT NULL,
  maker_id         uuid NOT NULL REFERENCES user_account(id),
  maker_reason     text,
  checker_id       uuid REFERENCES user_account(id),
  checker_reason   text,
  status           approval_status NOT NULL DEFAULT 'pending',
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  decided_at       timestamptz,
  step_up_auth_ref text,                    -- IdP step-up (MFA) evidence for checker
  CONSTRAINT four_eyes CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CONSTRAINT decided_has_checker CHECK (status NOT IN ('approved','rejected') OR (checker_id IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX approval_pending_idx ON approval_request(status, required_role) WHERE status = 'pending';

ALTER TABLE user_role_assignment ADD CONSTRAINT ura_approval_fk FOREIGN KEY (granted_via_approval) REFERENCES approval_request(id);
ALTER TABLE buyer_programme ADD CONSTRAINT bp_approval_fk FOREIGN KEY (approved_via) REFERENCES approval_request(id);
ALTER TABLE lending_float ADD CONSTRAINT lf_approval_fk FOREIGN KEY (approved_via) REFERENCES approval_request(id);
ALTER TABLE limit_config ADD CONSTRAINT lc_approval_fk FOREIGN KEY (approved_via) REFERENCES approval_request(id);

-- ---------------------------------------------------------------------------
-- Price disclosure & advances
-- ---------------------------------------------------------------------------
CREATE TABLE price_disclosure (   -- immutable record of what the supplier accepted (reg. 54 / brief)
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id               uuid NOT NULL REFERENCES invoice(id),
  pricing_version_id       uuid NOT NULL REFERENCES pricing_version(id),
  invoice_amount_cents     money_cents NOT NULL,
  advance_rate_bps         bps NOT NULL,
  discount_rate_bps_per_30d bps NOT NULL,
  quote_date               date NOT NULL,     -- expected disbursement date (EAT)
  due_date                 date NOT NULL,
  days                     integer NOT NULL CHECK (days > 0),
  advance_cents            money_cents NOT NULL,
  discount_fee_cents       money_cents NOT NULL,   -- maximum; actual pro-rated to days outstanding
  verification_fee_cents   money_cents NOT NULL,
  total_cost_cents         money_cents NOT NULL,
  mapema_keeps_cents       money_cents NOT NULL,
  supplier_balance_cents   money_cents NOT NULL,
  apr_bps                  integer NOT NULL,       -- simple APR, display
  terms_version            text NOT NULL,
  kid_version              text NOT NULL,          -- key information document version
  accepted_by              uuid REFERENCES user_account(id),
  accepted_at              timestamptz,
  accepted_ip              inet,
  expires_at               timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (total_cost_cents = discount_fee_cents + verification_fee_cents),
  CHECK (mapema_keeps_cents = advance_cents + discount_fee_cents + verification_fee_cents),
  CHECK (supplier_balance_cents = invoice_amount_cents - mapema_keeps_cents)
);

CREATE TABLE advance (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id             uuid NOT NULL REFERENCES invoice(id),
  supplier_id            uuid NOT NULL REFERENCES organisation(id),
  buyer_id               uuid NOT NULL REFERENCES organisation(id),
  price_disclosure_id    uuid NOT NULL UNIQUE REFERENCES price_disclosure(id),
  principal_cents        money_cents NOT NULL CHECK (principal_cents > 0),
  discount_fee_cents     money_cents NOT NULL,     -- as disclosed (maximum)
  verification_fee_cents money_cents NOT NULL,
  status                 advance_status NOT NULL DEFAULT 'requested',
  approved_by            uuid REFERENCES user_account(id),   -- credit (maker for release)
  approved_at            timestamptz,
  disbursed_at           timestamptz,
  fineract_loan_id       bigint UNIQUE,            -- ledger record lives in Fineract
  funding_source_id      uuid,                     -- Phase 3 tag
  -- mirror_* = cache from Fineract, display/recon only
  mirror_principal_outstanding_cents money_cents,
  mirror_fees_outstanding_cents      money_cents,
  mirror_interest_outstanding_cents  money_cents,
  mirror_refreshed_at    timestamptz,
  decline_reason         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
  -- role-scope rules (e.g. approver must be Mapema credit staff) are enforced in the service layer
);
-- One live advance per invoice
CREATE UNIQUE INDEX advance_one_per_invoice ON advance(invoice_id)
  WHERE status NOT IN ('declined','cancelled','release_failed');

-- ---------------------------------------------------------------------------
-- Payouts (instructions to bank; Fineract books the disbursement)
-- ---------------------------------------------------------------------------
CREATE TABLE payout (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id       uuid NOT NULL REFERENCES advance(id),
  type             payout_type NOT NULL,
  amount_cents     money_cents NOT NULL CHECK (amount_cents > 0),
  currency         currency_code NOT NULL,
  bank_account_id  uuid NOT NULL REFERENCES bank_account(id),
  rail             text CHECK (rail IN ('pesalink','eft','rtgs','internal','mpesa_b2c')),
  status           payout_status NOT NULL DEFAULT 'proposed',
  approval_id      uuid REFERENCES approval_request(id),
  released_by      uuid REFERENCES user_account(id),     -- maker-checker stored (brief)
  approved_by      uuid REFERENCES user_account(id),
  idempotency_key  text NOT NULL UNIQUE,                 -- = payout id string
  bank_ref         text,
  failure_reason   text,
  released_at      timestamptz,
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_four_eyes CHECK (released_by IS NULL OR approved_by IS NULL OR released_by <> approved_by)
);
CREATE UNIQUE INDEX payout_one_advance_payout ON payout(advance_id) WHERE type = 'advance' AND status NOT IN ('failed','returned','cancelled');

-- ---------------------------------------------------------------------------
-- Incoming payments
-- ---------------------------------------------------------------------------
CREATE TABLE bank_transaction (    -- raw incoming credits (webhook or statement line)
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_code          text NOT NULL,
  account_no         text NOT NULL,             -- Mapema collection / virtual account
  bank_ref           text NOT NULL,
  value_date         date NOT NULL,
  amount_cents       money_cents NOT NULL CHECK (amount_cents > 0),
  currency           currency_code NOT NULL,
  payer_name         text,
  payer_account_enc  bytea,                      -- [ENCRYPTED]
  narrative          text,
  source             text NOT NULL CHECK (source IN ('webhook','statement_import','manual')),
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_code, bank_ref)                   -- idempotent ingest
);

CREATE TABLE payment (             -- brief entity Payment: matched receipt
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid NOT NULL REFERENCES bank_transaction(id),
  buyer_id            uuid REFERENCES organisation(id),
  amount_cents        money_cents NOT NULL,
  received_at         timestamptz NOT NULL,
  match_method        match_method,
  matched_by          uuid REFERENCES user_account(id),
  approval_id         uuid REFERENCES approval_request(id),     -- manual matches need checker
  unapplied_cents     money_cents NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Mirror of Fineract's allocation (Fineract is authoritative). One row per advance a payment touches.
CREATE TABLE payment_allocation (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id             uuid NOT NULL REFERENCES payment(id),
  advance_id             uuid NOT NULL REFERENCES advance(id),
  principal_cents        money_cents NOT NULL DEFAULT 0,   -- 1st
  fees_charges_cents     money_cents NOT NULL DEFAULT 0,   -- 2nd
  interest_cents         money_cents NOT NULL DEFAULT 0,   -- 3rd
  supplier_balance_cents money_cents NOT NULL DEFAULT 0,   -- excess due to supplier (not loan repayment)
  fineract_txn_id        bigint,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, advance_id)
);

-- ---------------------------------------------------------------------------
-- Collections, disputes, complaints, DSR, AML
-- ---------------------------------------------------------------------------
CREATE TABLE dispute (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES invoice(id),
  buyer_id     uuid NOT NULL REFERENCES organisation(id),
  raised_by    uuid NOT NULL REFERENCES user_account(id),
  reason_code  text NOT NULL CHECK (reason_code IN ('goods_not_received','quality','pricing','duplicate','other')),
  description  text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','withdrawn')),
  resolution   text,
  closed_via   uuid REFERENCES approval_request(id),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);

CREATE TABLE collection_action (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id  uuid NOT NULL REFERENCES advance(id),
  stage       text NOT NULL CHECK (stage IN ('d1_reminder','d7_call','d14_demand','d30_recourse','npl','write_off','note')),
  channel     text CHECK (channel IN ('email','sms','call','letter','system')),
  performed_by uuid REFERENCES user_account(id),     -- null = system
  outcome     text,
  document_id uuid REFERENCES document(id),
  performed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE complaint (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid REFERENCES organisation(id),
  raised_by     uuid REFERENCES user_account(id),
  category      text NOT NULL,
  description   text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','escalated','closed')),
  acknowledged_at timestamptz,
  ack_due_at    timestamptz NOT NULL,     -- +7 days (reg. 40, counsel to confirm)
  resolve_due_at timestamptz NOT NULL,    -- +30 days
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE data_subject_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid REFERENCES person(id),
  requester_email citext NOT NULL,
  type         dsr_type NOT NULL,
  identity_verified_at timestamptz,
  status       text NOT NULL DEFAULT 'received' CHECK (status IN ('received','verifying','in_progress','completed','refused','partially_completed')),
  due_at       timestamptz NOT NULL,      -- statutory clock (counsel to confirm days)
  outcome_note text,
  handled_by   uuid REFERENCES user_account(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aml_flag (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES organisation(id),
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  rule_code   text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','str_filed')),
  frc_goaml_ref text,
  reviewed_by uuid REFERENCES user_account(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_run (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date            date NOT NULL UNIQUE,
  bank_balance_cents    signed_money_cents NOT NULL,
  fineract_cash_cents   signed_money_cents NOT NULL,
  platform_cash_cents   signed_money_cents NOT NULL,
  status                text NOT NULL CHECK (status IN ('balanced','breaks','error')),
  ran_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_break (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES reconciliation_run(id),
  kind         text NOT NULL,              -- e.g. bank_vs_fineract, fineract_vs_platform, allocation_mismatch, interest_mismatch
  difference_cents signed_money_cents NOT NULL,
  reference    jsonb,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','explained','closed')),
  resolution_note text,
  closed_via   uuid REFERENCES approval_request(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Invitations, leads, notifications, outbox, idempotency
-- ---------------------------------------------------------------------------
CREATE TABLE invitation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('buyer_admin','buyer_user','supplier','supplier_user','staff','auditor')),
  org_id        uuid REFERENCES organisation(id),
  invited_by    uuid NOT NULL REFERENCES user_account(id),
  email         citext,
  phone_enc     bytea,                     -- [ENCRYPTED]
  token_sha256  sha256_hex NOT NULL UNIQUE, -- only the hash of the link token is stored
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  CHECK (email IS NOT NULL OR phone_enc IS NOT NULL)
);

CREATE TABLE lead (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid REFERENCES organisation(id),
  contact_name text NOT NULL,
  email        citext NOT NULL,
  phone_enc    bytea,                       -- [ENCRYPTED]
  spend_band   text,
  consent_id   uuid REFERENCES consent(id),
  crm_ref      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES user_account(id),
  channel     text NOT NULL CHECK (channel IN ('sms','email','in_app')),
  template_key text NOT NULL,
  locale      text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','sw')),
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed')),
  provider_ref text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  topic         text NOT NULL,             -- e.g. fineract.disburse, bank.pay, sms.send
  aggregate_id  uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','done','failed','dead')),
  attempts      integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due_idx ON outbox(status, next_attempt_at) WHERE status IN ('pending','failed');

CREATE TABLE idempotency_key (
  key           text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES user_account(id),
  request_hash  sha256_hex NOT NULL,
  response_code integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retention_policy (
  record_type   text PRIMARY KEY,
  retain_for    interval NOT NULL,         -- counsel to set (Q-16)
  legal_basis   text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash-chained
-- ---------------------------------------------------------------------------
CREATE TABLE audit_event (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id uuid,                      -- null = system
  actor_role  text,
  action      text NOT NULL,               -- e.g. advance.release, user.login.failed
  entity_type text NOT NULL,
  entity_id   text,
  before      jsonb,                       -- PII redacted by service
  after       jsonb,
  ip          inet,
  user_agent  text,
  request_id  text,
  prev_hash   char(64) NOT NULL,
  row_hash    char(64) NOT NULL
);
CREATE INDEX audit_entity_idx ON audit_event(entity_type, entity_id);
CREATE INDEX audit_time_idx ON audit_event(occurred_at);

CREATE OR REPLACE FUNCTION audit_event_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_hash char(64);
BEGIN
  PERFORM pg_advisory_xact_lock(8675309);           -- serialise chain appends
  SELECT row_hash INTO last_hash FROM mapema.audit_event ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.row_hash := encode(public.digest(
      NEW.prev_hash || '|' || NEW.occurred_at::text || '|' || COALESCE(NEW.actor_user_id::text,'') || '|' ||
      NEW.action || '|' || NEW.entity_type || '|' || COALESCE(NEW.entity_id,'') || '|' ||
      COALESCE(NEW.before::text,'') || '|' || COALESCE(NEW.after::text,''), 'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER audit_event_chain_trg BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_chain();

CREATE OR REPLACE FUNCTION audit_event_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% blocked)', TG_OP;
END $$;

CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_block_mutation();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_block_mutation();

-- price_disclosure is immutable once accepted
CREATE OR REPLACE FUNCTION price_disclosure_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'accepted price_disclosure % is immutable', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_disclosure_freeze_trg BEFORE UPDATE OR DELETE ON price_disclosure
  FOR EACH ROW EXECUTE FUNCTION price_disclosure_freeze();

-- ---------------------------------------------------------------------------
-- Exposure view (used by limit checks; principal from Fineract mirror refreshed
-- inside the release transaction by the ledger gateway)
-- ---------------------------------------------------------------------------
CREATE VIEW v_exposure AS
SELECT a.buyer_id,
       a.supplier_id,
       o.sector_id AS buyer_sector_id,
       SUM(CASE WHEN a.status IN ('approved','released') THEN a.principal_cents
                WHEN a.status IN ('funded','late','recourse','non_performing') THEN COALESCE(a.mirror_principal_outstanding_cents, a.principal_cents)
                ELSE 0 END)::bigint AS exposure_cents
FROM advance a
JOIN organisation o ON o.id = a.buyer_id
GROUP BY a.buyer_id, a.supplier_id, o.sector_id;

-- ---------------------------------------------------------------------------
-- Database roles (privileges). Application connects as mapema_app.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapema_app') THEN CREATE ROLE mapema_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapema_readonly') THEN CREATE ROLE mapema_readonly NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA mapema TO mapema_app, mapema_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA mapema TO mapema_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM mapema_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA mapema TO mapema_app;
GRANT SELECT ON ALL TABLES IN SCHEMA mapema TO mapema_readonly;
-- No DELETE granted to the app on any table: records are status-changed, not deleted.
-- DSR deletions run through a separate privileged, audited job role (crypto-shredding of *_enc keys).

-- ---------------------------------------------------------------------------
-- Seed: default limits & pricing placeholders (no CBK ref => cannot go active)
-- ---------------------------------------------------------------------------
INSERT INTO limit_config (subject, pct_of_float_bps) VALUES ('buyer', 2500), ('supplier', 1000);
-- sector defaults (3500 bps) are inserted per sector at setup.

COMMIT;
