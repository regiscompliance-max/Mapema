-- [Security Engineer + DevOps] Phase 1b: rate-limit counters shared by all API instances.
-- UNLOGGED: counters are disposable (lost on a Postgres crash, which only resets the windows) and
-- skip the WAL, so the cost is one small upsert per request. Not business data, so DELETE is granted
-- for pruning expired rows.
SET search_path = mapema, public;
CREATE UNLOGGED TABLE rate_limit_hit (
  key           text PRIMARY KEY,
  hits          integer NOT NULL,
  expires_at    timestamptz NOT NULL,
  blocked_until timestamptz
);
CREATE INDEX rate_limit_hit_expires ON rate_limit_hit (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_hit TO mapema_app;
