#!/usr/bin/env bash
#
# Deploys the current main branch. This is the everyday command:
#
#   ./deploy/update.sh
#
# Safe to re-run. It refuses to deploy a dirty tree, builds before touching the
# running processes, and reloads rather than restarting so requests in flight
# are not dropped.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BRANCH="${WF_BRANCH:-main}"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f .env ] || fail ".env is missing. Copy .env.example and fill it in first."

if [ -n "$(git status --porcelain)" ]; then
  fail "Working tree has uncommitted changes. Commit or stash them, then retry."
fi

PREVIOUS="$(git rev-parse HEAD)"

log "Fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"

if [ "$PREVIOUS" = "$(git rev-parse "origin/$BRANCH")" ]; then
  log "Already up to date at ${PREVIOUS:0:8}. Rebuilding anyway."
else
  git merge --ff-only "origin/$BRANCH"
fi

log "Installing dependencies"
pnpm install --frozen-lockfile --prod=false

# Build before stopping anything: a compile error must not take the site down.
log "Building"
pnpm build

log "Running migrations"
pnpm migrate

# Nginx runs as www-data and cannot read a checkout under /root, so the built
# frontend is published to a directory it can serve from instead of being
# served out of the repository in place.
WEB_ROOT="${WF_WEB_ROOT:-/var/www/worldforge}"
if [ -d "$WEB_ROOT" ]; then
  log "Publishing the frontend to $WEB_ROOT"
  rm -rf "${WEB_ROOT:?}/"*
  cp -r packages/web/dist/. "$WEB_ROOT/"
fi

log "Reloading processes"
if pm2 describe wf-api >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save --force >/dev/null

log "Waiting for health check"
PORT="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-3001}"

for attempt in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log "Healthy. Deployed $(git rev-parse --short HEAD)."
    exit 0
  fi
  sleep 2
done

printf '\033[31mHealth check never passed.\033[0m Recent logs:\n' >&2
pm2 logs wf-api --lines 40 --nostream >&2 || true
fail "Deploy finished but the API is not healthy. Roll back with: ./deploy/rollback.sh $PREVIOUS"
