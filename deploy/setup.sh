#!/usr/bin/env bash
#
# One-time provisioning for a fresh Ubuntu 22.04/24.04 VPS.
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

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }

if [ -z "$DB_PASS" ]; then
  DB_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  GENERATED_PASS=1
fi

log "Updating package lists"
apt-get update -qq

log "Installing base packages"
apt-get install -y -qq curl ca-certificates gnupg git ufw nginx \
  postgresql-16 postgresql-16-postgis-3 redis-server certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 22 ]; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

log "Enabling corepack and pnpm"
corepack enable
corepack prepare pnpm@9 --activate

command -v pm2 >/dev/null 2>&1 || { log "Installing PM2"; npm install -g pm2; }

log "Configuring PostgreSQL"
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -qc "create role ${DB_USER} login password '${DB_PASS}'"

sudo -u postgres psql -tAc "select 1 from pg_database where datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"

# PostGIS must be enabled by a superuser; the app role cannot do it itself.
sudo -u postgres psql -d "${DB_NAME}" -qc "create extension if not exists postgis"
sudo -u postgres psql -d "${DB_NAME}" -qc "create extension if not exists pgcrypto"

log "Enabling Redis and PostgreSQL at boot"
systemctl enable --now redis-server postgresql

log "Configuring the firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
# Postgres and Redis stay on loopback only; nothing needs them from outside.
ufw --force enable >/dev/null

cat <<SUMMARY

Provisioning complete.

  DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
  REDIS_URL=redis://localhost:6379

SUMMARY

if [ "${GENERATED_PASS:-0}" = "1" ]; then
  echo "The database password above was generated. Copy it into .env now — it is not stored anywhere else."
fi
