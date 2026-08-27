#!/usr/bin/env bash
#
# Rolls the checkout back to a specific commit and redeploys:
#
#   ./deploy/rollback.sh <commit-sha>
#
# Note this does NOT reverse database migrations. If the bad deploy migrated,
# check whether the old code still works against the new schema before relying
# on this.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: ./deploy/rollback.sh <commit-sha>" >&2; exit 1; }

printf '\033[36m==>\033[0m Rolling back to %s\n' "$TARGET"
git checkout --quiet "$TARGET"

pnpm install --frozen-lockfile --prod=false
pnpm build
pm2 reload ecosystem.config.cjs --update-env
pm2 save --force >/dev/null

printf '\033[33mReminder:\033[0m migrations were not reversed.\n'
