#!/usr/bin/env bash
#
# Dumps the database to ./backups, keeping the 14 most recent (spec 64).
# Run nightly from cron:
#
#   0 3 * * * /home/worldforge/worldforge/deploy/backup.sh >> /var/log/wf-backup.log 2>&1
set -Eeuo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env missing" >&2; exit 1; }

DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"
[ -n "$DATABASE_URL" ] || { echo "DATABASE_URL not set in .env" >&2; exit 1; }

DIR="${WF_BACKUP_DIR:-./backups}"
mkdir -p "$DIR"
FILE="$DIR/worldforge-$(date +%Y%m%d-%H%M%S).sql.gz"

# --no-owner keeps the dump restorable under a different role.
pg_dump --no-owner --clean --if-exists "$DATABASE_URL" | gzip > "$FILE"
echo "Wrote $FILE ($(du -h "$FILE" | cut -f1))"

# Keep the 14 newest.
ls -1t "$DIR"/worldforge-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm --
