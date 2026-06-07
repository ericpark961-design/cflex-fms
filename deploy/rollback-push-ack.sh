#!/usr/bin/env bash
#
# rollback-push-ack.sh — restore alarm-notifier.js + bootstrap + DB from backup
# produced by deploy-push-ack.sh.
#
# Usage:
#   ./rollback-push-ack.sh <BACKUP_DIR>
#
# Optionally drops the new files (push notifier + routes).
#
# Env overrides:
#   CFLEX_API_DIR  default: /opt/cflex-v2/cflex-api
#   DB_PATH        default: $CFLEX_API_DIR/cflex.db
#   PM2_PROCESS    default: cflex-api-v2

set -euo pipefail

BACKUP_DIR="${1:-}"
[ -n "$BACKUP_DIR" ] || { echo "usage: $0 <BACKUP_DIR>"; exit 64; }
[ -d "$BACKUP_DIR" ] || { echo "✘ backup dir not found: $BACKUP_DIR"; exit 1; }

CFLEX_API_DIR="${CFLEX_API_DIR:-/opt/cflex-v2/cflex-api}"
DB_PATH="${DB_PATH:-$CFLEX_API_DIR/cflex.db}"
PM2_PROCESS="${PM2_PROCESS:-cflex-api-v2}"

read -r -p "Restore from $BACKUP_DIR to $CFLEX_API_DIR ? [y/N] " ans
[[ "$ans" =~ ^[Yy]$ ]] || { echo "aborted"; exit 0; }

echo "→ Stopping $PM2_PROCESS"
command -v pm2 >/dev/null && pm2 stop "$PM2_PROCESS" || true

echo "→ Restoring DB"
cp "$BACKUP_DIR/cflex.db" "$DB_PATH"

echo "→ Restoring alarm-notifier.js"
cp "$BACKUP_DIR/alarm-notifier.js" "$CFLEX_API_DIR/src/services/alarm-notifier.js"

# Bootstrap backup name varies — find any .js file other than alarm-notifier
for f in "$BACKUP_DIR"/*.js; do
  base="$(basename "$f")"
  [ "$base" = "alarm-notifier.js" ] && continue
  # Find target by name under src/
  target="$(find "$CFLEX_API_DIR/src" -maxdepth 3 -name "$base" | head -n 1)"
  if [ -n "$target" ]; then
    echo "→ Restoring $base → $target"
    cp "$f" "$target"
  fi
done

read -r -p "Also remove new files (expo-push-notifier.js / fms-push.routes.js / fms-ack.routes.js)? [y/N] " ans2
if [[ "$ans2" =~ ^[Yy]$ ]]; then
  rm -f "$CFLEX_API_DIR/src/services/expo-push-notifier.js"
  rm -f "$CFLEX_API_DIR/src/routes/fms-push.routes.js"
  rm -f "$CFLEX_API_DIR/src/routes/fms-ack.routes.js"
fi

echo "→ Restarting $PM2_PROCESS"
command -v pm2 >/dev/null && pm2 restart "$PM2_PROCESS" || true

echo "✅ Rollback complete."
echo "NOTE: SQLite migrations (002, 003) are NOT auto-reverted by this script — restored DB file replaces the schema."
