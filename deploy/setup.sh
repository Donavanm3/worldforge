#!/usr/bin/env bash
#
# One-time provisioning for a fresh Debian or Ubuntu VPS.
#
#   sudo ./deploy/setup.sh
#
# Installs Node 22, pnpm, PostgreSQL 16 + PostGIS, Redis, Nginx and PM2, then
# creates the database role and schema. Idempotent: re-running skips whatever
# is already present.
set -Eeuo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }

DB_NAME="${WF_DB_NAME:-worldforge}"
DB_USER="${WF_DB_USER:-worldforge}"
DB_PASS="${WF_DB_PASS:-}"
PG_VERSION="${WF_PG_VERSION:-16}"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -r /etc/os-release ] || fail "Cannot read /etc/os-release. This script targets Debian and Ubuntu."
# shellcheck disable=SC1091
. /etc/os-release
CODENAME="${VERSION_CODENAME:-}"

case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) ;;
  *) fail "Unsupported distribution: ${PRETTY_NAME:-unknown}. This script targets Debian and Ubuntu." ;;
esac
[ -n "$CODENAME" ] || fail "Could not determine the release codename from /etc/os-release."

log "Detected ${PRETTY_NAME:-unknown} (${CODENAME})"

if [ -z "$DB_PASS" ]; then
  DB_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  GENERATED_PASS=1
fi

export DEBIAN_FRONTEND=noninteractive

log "Updating package lists"
apt-get update -qq

log "Installing prerequisites"
apt-get install -y -qq curl ca-certificates gnupg lsb-release git ufw openssl

# PostgreSQL 16 and a matching PostGIS are not in every release's own repos —
# Ubuntu 22.04 ships 14, for instance. The PostgreSQL project's own repository
# carries the same versions for every supported release, so the setup does not
# depend on which Ubuntu the VPS happens to have.
if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
  log "Adding the PostgreSQL package repository"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
fi

log "Installing PostgreSQL ${PG_VERSION}, PostGIS, Redis, Nginx"
apt-get install -y -qq \
  "postgresql-${PG_VERSION}" "postgresql-${PG_VERSION}-postgis-3" \
  redis-server nginx certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 22 ]; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

log "Enabling corepack and pnpm"
corepack enable
corepack prepare pnpm@9 --activate

command -v pm2 >/dev/null 2>&1 || { log "Installing PM2"; npm install -g pm2; }

log "Starting PostgreSQL and Redis"
systemctl enable --now redis-server postgresql

log "Configuring the database"
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -qc "create role ${DB_USER} login password '${DB_PASS}'"

sudo -u postgres psql -tAc "select 1 from pg_database where datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"

# PostGIS must be enabled by a superuser; the app role cannot do it itself.
sudo -u postgres psql -d "${DB_NAME}" -qc "create extension if not exists postgis"
sudo -u postgres psql -d "${DB_NAME}" -qc "create extension if not exists pgcrypto"

log "Configuring the firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
# Postgres and Redis stay on loopback only; nothing needs them from outside.
ufw --force enable >/dev/null

POSTGIS_VERSION="$(sudo -u postgres psql -d "${DB_NAME}" -tAc 'select postgis_version()' 2>/dev/null || echo 'unknown')"

cat <<SUMMARY

Provisioning complete.
  PostgreSQL : $(sudo -u postgres psql -tAc 'show server_version' | tr -d '[:space:]')
  PostGIS    : ${POSTGIS_VERSION}
  Node       : $(node -v)

Put these in .env:

  DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
  REDIS_URL=redis://localhost:6379

SUMMARY

if [ "${GENERATED_PASS:-0}" = "1" ]; then
  echo "The database password above was generated. Copy it into .env now — it is not stored anywhere else."
fi
