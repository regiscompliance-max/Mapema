-- =============================================================================
-- Mapema go-live hardening migration [Backend Engineer + Security Engineer + Compliance]
--  - S-09  report artefacts encrypted at rest at the application level (flag + plaintext size)
--  - S-14  integration (service) users flagged and kept out of staff lists / access reviews
--  - D-32  server-side OIDC (BFF) login state: PKCE verifier + nonce never reach the browser
--  - D-66  Kenyan public-holiday calendar: gazetted / ad-hoc holidays (maker-checker), seeded
-- The Schedule Part I holidays are computed in @mapema/pricing (Public Holidays Act, Cap. 110);
-- only days that need a Gazette notice live in this table.
-- =============================================================================
ALTER TYPE mapema.approval_action ADD VALUE IF NOT EXISTS 'holiday_gazette';

BEGIN;
SET search_path = mapema, public;

-- ---------------------------------------------------------------- S-09
ALTER TABLE report_artifact ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE report_artifact ADD COLUMN plain_bytes int;
COMMENT ON COLUMN report_artifact.content IS 'encrypted=true: AES-256-GCM envelope "MRA1"|iv|tag|ct (key derived from STORAGE_ENCRYPTION_KEY, AAD = snapshot/template/filename); sha256 is over the PLAINTEXT';

-- ---------------------------------------------------------------- S-14
ALTER TABLE user_account ADD COLUMN is_integration boolean NOT NULL DEFAULT false;
UPDATE user_account SET is_integration = true WHERE idp_subject LIKE 'erp-integration:%';
-- an integration user can never become an interactive, MFA-less active account
ALTER TABLE user_account ADD CONSTRAINT integration_user_inactive CHECK (NOT is_integration OR (active = false AND mfa_enabled = false));

-- ---------------------------------------------------------------- D-32 BFF login state
CREATE TABLE oidc_login_state (
  state_sha256    bytea PRIMARY KEY CHECK (octet_length(state_sha256) = 32),
  binding_sha256  bytea NOT NULL CHECK (octet_length(binding_sha256) = 32),  -- hash of the HttpOnly mapema_oidc cookie
  verifier_enc    bytea NOT NULL,       -- PKCE code_verifier, field-encrypted
  nonce           text NOT NULL,
  return_to       text NOT NULL CHECK (return_to ~ '^/[^/\\]'  OR return_to = '/'),
  step_up         boolean NOT NULL DEFAULT false,
  join_enc        bytea,                -- invitation details (name, phone) for the join flow, encrypted
  mfa_retry       boolean NOT NULL DEFAULT false,  -- this login is the one automatic re-prompt after a password-only login
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz
);
CREATE INDEX oidc_login_state_expiry ON oidc_login_state (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON oidc_login_state TO mapema_app;  -- transient, not a record

-- ---------------------------------------------------------------- D-66 public holidays
CREATE TABLE public_holiday (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date     date NOT NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 3 AND 120),
  kind             text NOT NULL DEFAULT 'gazetted' CHECK (kind IN ('gazetted')),
  gazette_ref      text NOT NULL CHECK (length(gazette_ref) BETWEEN 3 AND 200),   -- e.g. "Gazette Notice No. 3955 of 18 March 2026"
  substitutes_date date,                 -- s.3 substitution: the Schedule day that stops being a holiday
  approval_id      uuid REFERENCES approval_request(id),  -- null only for the migration seed
  created_by       uuid REFERENCES user_account(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (holiday_date)
);
GRANT SELECT, INSERT ON public_holiday TO mapema_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public_holiday FROM mapema_app;
GRANT SELECT ON public_holiday, oidc_login_state TO mapema_readonly;

-- Seed: Idd-ul-Fitr 2026 (Schedule Part I; date fixed by Gazette Notice No. 3955 of 18 March 2026,
-- Cabinet Secretary for Interior and National Administration). Future Idd-ul-Fitr dates, election
-- days and ad-hoc holidays are proposed by ops and approved by a second ops user.
INSERT INTO public_holiday (holiday_date, name, gazette_ref) VALUES
  ('2026-03-20', 'Idd-ul-Fitr', 'Gazette Notice No. 3955 of 18 March 2026 (Public Holidays Act, Cap. 110)')
ON CONFLICT (holiday_date) DO NOTHING;
COMMIT;
