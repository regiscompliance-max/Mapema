-- [Backend Engineer] D-82 bank-billed fee structure (model A): pricing profiles per programme
-- (direct-legacy preserved; bank-funded-A is the default for new programmes), revenue-split
-- config with maker-checker, and quote/advance snapshots of the bank / Mapema share.
SET search_path = mapema, public;

ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'programme_pricing_profile_change';
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'revenue_split_change';

CREATE TABLE pricing_profile (
  code                         text PRIMARY KEY CHECK (code IN ('direct-legacy', 'bank-funded-A')),
  display_name                 text NOT NULL,
  billed_by                    text NOT NULL CHECK (billed_by IN ('mapema', 'funding_bank')),
  discount_rate_bps_per_30d    bps  NOT NULL,
  verification_fee_cents       money_cents NOT NULL DEFAULT 0,
  processing_fee_bps           bps,
  processing_fee_min_cents     money_cents,
  processing_fee_max_cents     money_cents,
  is_default_for_new_programmes boolean NOT NULL DEFAULT false
);

INSERT INTO pricing_profile (
  code, display_name, billed_by, discount_rate_bps_per_30d, verification_fee_cents,
  processing_fee_bps, processing_fee_min_cents, processing_fee_max_cents, is_default_for_new_programmes
) VALUES
  ('direct-legacy', 'Direct lending (legacy)', 'mapema', 350, 250000, NULL, NULL, NULL, false),
  ('bank-funded-A', 'Bank-funded white-label (model A)', 'funding_bank', 150, 0, 50, 150000, 500000, true);

-- Existing programmes keep direct-legacy so the Phase 0 worked example still holds.
ALTER TABLE buyer_programme
  ADD COLUMN IF NOT EXISTS pricing_profile_code text NOT NULL DEFAULT 'direct-legacy' REFERENCES pricing_profile(code),
  ADD COLUMN IF NOT EXISTS processing_fee_payer text NOT NULL DEFAULT 'supplier'
    CHECK (processing_fee_payer IN ('supplier', 'buyer')),
  ADD COLUMN IF NOT EXISTS lender_display_name text;

CREATE TABLE revenue_split_config (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_of_funds_annual_ppm   integer NOT NULL CHECK (cost_of_funds_annual_ppm BETWEEN 0 AND 1000000),
  bank_margin_share_bps      bps  NOT NULL,
  vat_rate_bps               bps  NOT NULL DEFAULT 1600,
  vat_pending_counsel        boolean NOT NULL DEFAULT true,
  excise_on_processing_fee   boolean NOT NULL DEFAULT false,
  excise_rate_bps            bps  NOT NULL DEFAULT 2000,
  excise_pending_counsel     boolean NOT NULL DEFAULT true,
  approved_via               uuid REFERENCES approval_request(id),
  effective_from             timestamptz NOT NULL DEFAULT now(),
  created_at                 timestamptz NOT NULL DEFAULT now()
);

INSERT INTO revenue_split_config (
  cost_of_funds_annual_ppm, bank_margin_share_bps, vat_rate_bps, vat_pending_counsel,
  excise_on_processing_fee, excise_rate_bps, excise_pending_counsel
) VALUES (87450, 5000, 1600, true, false, 2000, true);

ALTER TABLE price_disclosure
  ADD COLUMN IF NOT EXISTS pricing_profile_code text REFERENCES pricing_profile(code),
  ADD COLUMN IF NOT EXISTS processing_fee_cents money_cents,
  ADD COLUMN IF NOT EXISTS processing_fee_payer text CHECK (processing_fee_payer IS NULL OR processing_fee_payer IN ('supplier', 'buyer')),
  ADD COLUMN IF NOT EXISTS billed_by text CHECK (billed_by IS NULL OR billed_by IN ('mapema', 'funding_bank')),
  ADD COLUMN IF NOT EXISTS excise_cents money_cents NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lender_display_name text,
  ADD COLUMN IF NOT EXISTS cost_of_funds_cents money_cents,
  ADD COLUMN IF NOT EXISTS bank_share_cents money_cents,
  ADD COLUMN IF NOT EXISTS mapema_platform_fee_cents money_cents,
  ADD COLUMN IF NOT EXISTS mapema_vat_cents money_cents;

UPDATE price_disclosure SET
  pricing_profile_code = COALESCE(pricing_profile_code, 'direct-legacy'),
  processing_fee_cents = COALESCE(processing_fee_cents, verification_fee_cents),
  processing_fee_payer = COALESCE(processing_fee_payer, 'supplier'),
  billed_by = COALESCE(billed_by, 'mapema')
WHERE pricing_profile_code IS NULL OR processing_fee_cents IS NULL;

ALTER TABLE advance
  ADD COLUMN IF NOT EXISTS pricing_profile_code text REFERENCES pricing_profile(code),
  ADD COLUMN IF NOT EXISTS processing_fee_payer text CHECK (processing_fee_payer IS NULL OR processing_fee_payer IN ('supplier', 'buyer')),
  ADD COLUMN IF NOT EXISTS billed_by text CHECK (billed_by IS NULL OR billed_by IN ('mapema', 'funding_bank')),
  ADD COLUMN IF NOT EXISTS excise_cents money_cents NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_of_funds_cents money_cents,
  ADD COLUMN IF NOT EXISTS bank_share_cents money_cents,
  ADD COLUMN IF NOT EXISTS mapema_platform_fee_cents money_cents,
  ADD COLUMN IF NOT EXISTS mapema_vat_cents money_cents;

UPDATE advance a SET
  pricing_profile_code = d.pricing_profile_code,
  processing_fee_payer = d.processing_fee_payer,
  billed_by = d.billed_by,
  excise_cents = COALESCE(d.excise_cents, 0),
  cost_of_funds_cents = d.cost_of_funds_cents,
  bank_share_cents = d.bank_share_cents,
  mapema_platform_fee_cents = d.mapema_platform_fee_cents,
  mapema_vat_cents = d.mapema_vat_cents
FROM price_disclosure d
WHERE d.id = a.price_disclosure_id AND a.pricing_profile_code IS NULL;

GRANT SELECT, INSERT, UPDATE ON pricing_profile, revenue_split_config TO mapema_app;
GRANT SELECT ON pricing_profile, revenue_split_config TO mapema_readonly;
