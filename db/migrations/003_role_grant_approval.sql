-- [Security Engineer] ADM-01: staff and auditor role grants are maker-checker.
-- The invitation is created but cannot be accepted (and is not sent) until a second person approves.
SET search_path = mapema, public;
ALTER TABLE invitation ADD COLUMN requires_approval boolean NOT NULL DEFAULT false;
ALTER TABLE invitation ADD COLUMN approved_via uuid REFERENCES approval_request(id);
ALTER TABLE invitation ADD COLUMN link_enc bytea;  -- [ENCRYPTED] held only until approval, then moved to the outbox and cleared
