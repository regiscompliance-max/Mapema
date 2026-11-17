-- [Security Engineer] Phase 1b: browser sessions are server-side. The browser holds only an opaque,
-- random session id in an httpOnly Secure SameSite=Strict cookie; we store its SHA-256 (never the id).
-- The IdP access token is verified once at sign-in and then discarded (not stored anywhere).
SET search_path = mapema, public;
CREATE TABLE web_session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sid_sha256     bytea NOT NULL UNIQUE CHECK (octet_length(sid_sha256) = 32),
  user_id        uuid NOT NULL REFERENCES user_account(id),
  idp_subject    text NOT NULL,
  amr            text[] NOT NULL,
  auth_time      bigint NOT NULL,            -- epoch seconds of the IdP authentication (step-up checks)
  created_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,       -- absolute lifetime
  revoked_at     timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('logout','rotated','admin')),
  ip             inet,
  user_agent     text
);
CREATE INDEX web_session_user ON web_session (user_id) WHERE revoked_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON web_session TO mapema_app;
GRANT SELECT ON web_session TO mapema_readonly;
