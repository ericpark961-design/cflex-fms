#!/usr/bin/env bash
#
# deploy-push-ack.sh — idempotent install of Expo push + alert ack into a
# running cflex-v2 deployment.
#
# Usage:
#   ./deploy-push-ack.sh             # interactive (asks before each patch)
#   ./deploy-push-ack.sh --yes       # non-interactive (CI / scripted)
#   ./deploy-push-ack.sh --dry-run   # show what would happen, change nothing
#
# Env overrides:
#   CFLEX_API_DIR  default: /opt/cflex-v2/cflex-api
#   DB_PATH        default: $CFLEX_API_DIR/cflex.db
#   PM2_PROCESS    default: cflex-api-v2

set -euo pipefail

# ─────────────────────────── config ────────────────────────────
CFLEX_API_DIR="${CFLEX_API_DIR:-/opt/cflex-v2/cflex-api}"
DB_PATH="${DB_PATH:-$CFLEX_API_DIR/cflex.db}"
PM2_PROCESS="${PM2_PROCESS:-cflex-api-v2}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$CFLEX_API_DIR/.backups/push-ack-$TS"

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    *) echo "unknown arg: $arg"; exit 64 ;;
  esac
done

c_red()   { printf "\033[31m%s\033[0m" "$*"; }
c_grn()   { printf "\033[32m%s\033[0m" "$*"; }
c_ylw()   { printf "\033[33m%s\033[0m" "$*"; }
c_dim()   { printf "\033[2m%s\033[0m"  "$*"; }

step() { echo; echo "→ $(c_grn "$*")"; }
warn() { echo "$(c_ylw "⚠ $*")"; }
fail() { echo "$(c_red "✘ $*")" >&2; exit 1; }

ask() {
  local prompt="$1"
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

do_or_show() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "  $(c_dim "[dry-run] $*")"
  else
    eval "$@"
  fi
}

# ─────────────────────────── pre-flight ────────────────────────────
step "Pre-flight"
[ -f "$DB_PATH" ]                        || fail "DB not found: $DB_PATH (set DB_PATH=)"
[ -d "$CFLEX_API_DIR/src/services" ]     || fail "services dir not found under $CFLEX_API_DIR/src"
[ -d "$CFLEX_API_DIR/src/routes" ]       || fail "routes dir not found under $CFLEX_API_DIR/src"
command -v sqlite3 >/dev/null            || fail "sqlite3 not installed"
command -v pm2     >/dev/null            || warn "pm2 not on PATH — restart step will be skipped"
command -v node    >/dev/null            || warn "node not on PATH"

ALARM_NOTIFIER="$CFLEX_API_DIR/src/services/alarm-notifier.js"
[ -f "$ALARM_NOTIFIER" ] || fail "alarm-notifier.js missing at $ALARM_NOTIFIER"

# Locate bootstrap file (where fms.routes is mounted)
BOOT_FILE="$(grep -rl --include='*.js' "require.*['\"]\./routes/fms\.routes['\"]" "$CFLEX_API_DIR/src" 2>/dev/null | head -n1 || true)"
if [ -z "$BOOT_FILE" ]; then
  # Try a broader search
  BOOT_FILE="$(grep -rl --include='*.js' "fms\.routes" "$CFLEX_API_DIR/src" 2>/dev/null | head -n1 || true)"
fi
[ -n "$BOOT_FILE" ] || fail "Could not locate the file that mounts fms.routes. Set BOOT_FILE= manually."
echo "  $(c_dim "DB:        ") $DB_PATH"
echo "  $(c_dim "API dir:   ") $CFLEX_API_DIR"
echo "  $(c_dim "Bootstrap: ") $BOOT_FILE"
echo "  $(c_dim "Notifier:  ") $ALARM_NOTIFIER"
echo "  $(c_dim "PM2 proc:  ") $PM2_PROCESS"
echo "  $(c_dim "Backups:   ") $BACKUP_DIR"

# ─────────────────────────── backups ────────────────────────────
step "Backups"
do_or_show "mkdir -p '$BACKUP_DIR'"
do_or_show "sqlite3 '$DB_PATH' \".backup '$BACKUP_DIR/cflex.db'\""
do_or_show "cp '$BOOT_FILE' '$BACKUP_DIR/$(basename "$BOOT_FILE")'"
do_or_show "cp '$ALARM_NOTIFIER' '$BACKUP_DIR/alarm-notifier.js'"

# ─────────────────────────── migrations ────────────────────────────
step "Migrations (idempotent)"

# 002 — push_subscriptions
HAS_PUSH_TABLE="$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='fms_push_subscriptions';" || true)"
if [ -z "$HAS_PUSH_TABLE" ]; then
  echo "  applying 002_fms_push_subscriptions.sql"
  do_or_show "sqlite3 '$DB_PATH' < '$DEPLOY_DIR/backend/migrations/002_fms_push_subscriptions.sql'"
else
  echo "  $(c_dim "002 already applied — skip")"
fi

# 003 — alerts.acked_at, acked_by
HAS_ACKED="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('alerts') WHERE name='acked_at';")"
if [ "$HAS_ACKED" = "0" ]; then
  echo "  applying 003_alerts_ack.sql"
  do_or_show "sqlite3 '$DB_PATH' < '$DEPLOY_DIR/backend/migrations/003_alerts_ack.sql'"
else
  echo "  $(c_dim "003 already applied — skip")"
fi

# ─────────────────────────── new files ────────────────────────────
step "Copy new service + route files"
for f in expo-push-notifier.js; do
  do_or_show "cp '$DEPLOY_DIR/backend/services/$f' '$CFLEX_API_DIR/src/services/'"
done
for f in fms-push.routes.js fms-ack.routes.js; do
  do_or_show "cp '$DEPLOY_DIR/backend/routes/$f' '$CFLEX_API_DIR/src/routes/'"
done

# ─────────────────────────── patch bootstrap ────────────────────────────
step "Mount new routes in bootstrap"

mount_line() {
  local route_file="$1"
  echo "app.use('/v1/fms', require('./routes/${route_file}'));"
}

patch_mount() {
  local route_file="$1"
  local marker="$2"
  if grep -q "$marker" "$BOOT_FILE"; then
    echo "  $(c_dim "${route_file} already mounted — skip")"
    return 0
  fi
  if ! ask "  Insert mount for ${route_file} into $(basename "$BOOT_FILE")?"; then
    warn "  Skipped ${route_file} mount — you must add manually before push/ack work"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  $(c_dim "[dry-run] would insert: $(mount_line "$route_file")")"
    return 0
  fi
  # Insert AFTER the line that mounts fms.routes
  local mount
  mount="$(mount_line "$route_file")"
  # Use a portable awk that inserts immediately after the first matching line
  awk -v insert="$mount" '
    BEGIN { done=0 }
    { print }
    !done && /require.*\.\/routes\/fms\.routes/ { print insert; done=1 }
  ' "$BOOT_FILE" > "$BOOT_FILE.tmp" && mv "$BOOT_FILE.tmp" "$BOOT_FILE"
  echo "  $(c_grn "added") $mount"
}

patch_mount "fms-push.routes" "fms-push.routes"
patch_mount "fms-ack.routes"  "fms-ack.routes"

# ─────────────────────────── patch alarm-notifier ────────────────────────────
step "Patch alarm-notifier.js to fan out to Expo push"

if grep -q "expo-push-notifier" "$ALARM_NOTIFIER"; then
  echo "  $(c_dim "already patched — skip")"
else
  if ask "  Apply alarm-notifier.js patch (adds require + dispatch call)?"; then
    if [ "$DRY_RUN" = "1" ]; then
      echo "  $(c_dim "[dry-run] would insert require line + dispatch call")"
    else
      # 1. Add require near top — after the first `const ` line
      awk '
        BEGIN { inserted=0 }
        /^const / && !inserted {
          print "const expoPush = require(\"./expo-push-notifier\");";
          inserted=1
        }
        { print }
      ' "$ALARM_NOTIFIER" > "$ALARM_NOTIFIER.tmp" && mv "$ALARM_NOTIFIER.tmp" "$ALARM_NOTIFIER"

      # 2. Insert dispatch call before `return results;`
      awk '
        BEGIN { inserted=0 }
        /return results;/ && !inserted {
          print "    try { await expoPush.dispatch(alert, asset); } catch (e) { console.error(\"[alarm-notifier] expo-push fan-out failed:\", e.message); }";
          inserted=1
        }
        { print }
      ' "$ALARM_NOTIFIER" > "$ALARM_NOTIFIER.tmp" && mv "$ALARM_NOTIFIER.tmp" "$ALARM_NOTIFIER"

      echo "  $(c_grn "patched")"
    fi
  else
    warn "  Skipped alarm-notifier patch — push fan-out will NOT work"
  fi
fi

# ─────────────────────────── syntax check ────────────────────────────
step "Syntax check (node -c)"
if command -v node >/dev/null; then
  for f in "$CFLEX_API_DIR/src/services/expo-push-notifier.js" \
           "$CFLEX_API_DIR/src/services/alarm-notifier.js" \
           "$CFLEX_API_DIR/src/routes/fms-push.routes.js" \
           "$CFLEX_API_DIR/src/routes/fms-ack.routes.js" \
           "$BOOT_FILE"; do
    if [ -f "$f" ]; then
      if node --check "$f" 2>/tmp/node-check-err; then
        echo "  $(c_grn "ok") $(c_dim "$f")"
      else
        cat /tmp/node-check-err
        fail "syntax error in $f — restore from $BACKUP_DIR before retry"
      fi
    fi
  done
else
  warn "  node not available — skipping syntax checks"
fi

# ─────────────────────────── restart ────────────────────────────
step "Restart $PM2_PROCESS"
if command -v pm2 >/dev/null && [ "$DRY_RUN" = "0" ]; then
  pm2 restart "$PM2_PROCESS"
  sleep 2
  pm2 status "$PM2_PROCESS" || true
else
  echo "  $(c_dim "(skipped — restart manually with: pm2 restart $PM2_PROCESS)")"
fi

# ─────────────────────────── summary ────────────────────────────
echo
echo "$(c_grn "✅ Deploy complete.")"
echo "  Backups: $BACKUP_DIR"
echo "  Rollback: $DEPLOY_DIR/rollback-push-ack.sh $BACKUP_DIR"
echo "  Test:     $DEPLOY_DIR/test-push-ack.sh"
echo
echo "Next:"
echo "  1. Log in to the FMS mobile app on a real device"
echo "  2. Settings → enable 'Push notifications'"
echo "  3. Confirm token row appears: $(c_dim "sqlite3 $DB_PATH \"SELECT id, platform, device_name FROM fms_push_subscriptions ORDER BY id DESC LIMIT 5;\"")"
echo "  4. Trigger a test alarm and watch logs: $(c_dim "pm2 logs $PM2_PROCESS | grep expo-push")"
