#!/usr/bin/env bash
# [QA] Fresh local stack for scripts/ui-smoke.mjs: new database, migrations + roles + staff, API, demo world, web.
# Usage: ENV_FILE=/path/to/env scripts/smoke-stack.sh   (env file as in .env.example, DATABASE_* pointing at a throw-away DB)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . "${ENV_FILE:?set ENV_FILE}"; set +a
DB=$(node -e "console.log(new URL(process.env.DATABASE_ADMIN_URL).pathname.slice(1))")
ROOT=$(node -e "const u=new URL(process.env.DATABASE_ADMIN_URL);u.pathname='/postgres';console.log(u.toString())")
pkill -f "apps/api/dist/main|node --enable-source-maps dist/main.js" || true
pkill -f "next start|next-server" || true
psql "$ROOT" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
npm run db:seed >/tmp/smoke-seed.log
nohup npm run start -w @mapema/api >/tmp/api-smoke.log 2>&1 &
for i in $(seq 1 30); do curl -sf "http://localhost:${PORT:-4000}/v1/public/cbk-status" >/dev/null && break; sleep 1; done
SEED_API_URL="http://localhost:${PORT:-4000}" npm run db:seed >>/tmp/smoke-seed.log
nohup npm run start -w @mapema/web >/tmp/web-smoke.log 2>&1 &
for i in $(seq 1 30); do curl -sf http://localhost:3000/signin >/dev/null && break; sleep 1; done
echo "stack ready on :4000 / :3000"
