#!/usr/bin/env bash
#
# test-push-ack.sh — verify the push + ack deploy worked, end-to-end.
#
# Steps:
#   1. Confirms tables/columns exist.
#   2. Confirms routes respond (401 expected without auth — proves they're mounted).
#   3. Lists currently-registered push tokens.
#   4. (Optional) Sends a manual test alarm if --send-test-alarm is passed.
#
# Usage:
#   ./test-push-ack.sh
#   ./test-push-ack.sh --token "$TOKEN" --tenant 1     # uses auth, exercises endpoints
#   ./test-push-ack.sh --token "$TOKEN" --send-test-alarm --device-id ups-1

set -euo pipefail

CFLEX_API_DIR="${CFLEX_API_DIR:-/opt/cflex-v2/cflex-api}"
DB_PATH="${DB_PATH:-$CFLEX_API_DIR/cflex.db}"
BASE_URL="${BASE_URL:-https://cflex.runless.co.uk}"

TOKEN=""
TENANT=""
DEVICE_ID=""
SEND_TEST=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)              TOKEN="$2"; shift 2 ;;
    --tenant)             TENANT="$2"; shift 2 ;;
    --device-id)          DEVICE_ID="$2"; shift 2 ;;
    --send-test-alarm)    SEND_TEST=1; shift ;;
    *) echo "unknown arg: $1"; exit 64 ;;
  esac
done

c_grn() { printf "\033[32m%s\033[0m" "$*"; }
c_red() { printf "\033[31m%s\033[0m" "$*"; }
c_dim() { printf "\033[2m%s\033[0m"  "$*"; }
ok()    { echo "  $(c_grn '✓') $*"; }
ko()    { echo "  $(c_red '✘') $*"; }

echo "→ Database checks"
HAS_PUSH_TABLE="$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='fms_push_subscriptions';" || true)"
[ -n "$HAS_PUSH_TABLE" ] && ok "fms_push_subscriptions table exists" || ko "fms_push_subscriptions MISSING"

HAS_ACKED="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('alerts') WHERE name='acked_at';")"
[ "$HAS_ACKED" = "1" ] && ok "alerts.acked_at column exists" || ko "alerts.acked_at MISSING"

HAS_ACKED_BY="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('alerts') WHERE name='acked_by';")"
[ "$HAS_ACKED_BY" = "1" ] && ok "alerts.acked_by column exists" || ko "alerts.acked_by MISSING"

SUB_COUNT="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM fms_push_subscriptions;" 2>/dev/null || echo 0)"
echo "  $(c_dim "Subscriptions registered: $SUB_COUNT")"

if [ "$SUB_COUNT" -gt 0 ]; then
  echo "  $(c_dim 'Recent subscriptions:')"
  sqlite3 -column -header "$DB_PATH" \
    "SELECT id, tenant_id, user_id, platform, device_name, min_severity, datetime(last_seen_at/1000,'unixepoch','localtime') AS last_seen FROM fms_push_subscriptions ORDER BY last_seen_at DESC LIMIT 5;" \
    | sed 's/^/    /'
fi

echo
echo "→ Endpoint mount checks"
status() { curl -s -o /dev/null -w "%{http_code}" -X "$1" "${BASE_URL}$2" -H 'Content-Type: application/json' --data-raw "${3:-}"; }

# Unauthenticated calls — expect 401 if route is mounted and auth-protected.
PUSH_POST_STATUS=$(status POST /v1/fms/devices/push-token '{}')
ACK_POST_STATUS=$(status POST /v1/fms/alerts/0/ack '{}')

if [ "$PUSH_POST_STATUS" = "401" ] || [ "$PUSH_POST_STATUS" = "403" ]; then
  ok "POST /v1/fms/devices/push-token mounted (status $PUSH_POST_STATUS)"
elif [ "$PUSH_POST_STATUS" = "404" ]; then
  ko "POST /v1/fms/devices/push-token NOT mounted (404) — bootstrap edit missing"
else
  ok "POST /v1/fms/devices/push-token responded $PUSH_POST_STATUS"
fi

if [ "$ACK_POST_STATUS" = "401" ] || [ "$ACK_POST_STATUS" = "403" ]; then
  ok "POST /v1/fms/alerts/:id/ack mounted (status $ACK_POST_STATUS)"
elif [ "$ACK_POST_STATUS" = "404" ]; then
  ko "POST /v1/fms/alerts/:id/ack NOT mounted (404) — bootstrap edit missing"
else
  ok "POST /v1/fms/alerts/:id/ack responded $ACK_POST_STATUS"
fi

# Authenticated calls
if [ -n "$TOKEN" ]; then
  echo
  echo "→ Authenticated round-trip (with --token)"
  # List subscriptions
  R=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" "${BASE_URL}/v1/fms/devices/push-subscriptions")
  HTTP=$(echo "$R" | tail -1); BODY=$(echo "$R" | head -n -1)
  if [ "$HTTP" = "200" ]; then
    ok "GET /v1/fms/devices/push-subscriptions → 200"
    echo "    $BODY" | head -200
  else
    ko "GET /v1/fms/devices/push-subscriptions → $HTTP"
  fi
fi

# Send test alarm to trigger push fan-out
if [ "$SEND_TEST" = "1" ]; then
  echo
  echo "→ Sending synthetic test alarm"
  [ -n "$DEVICE_ID" ] || ko "  --device-id required for --send-test-alarm"
  [ -n "$TENANT" ] || ko "  --tenant required for --send-test-alarm"

  if [ -n "$DEVICE_ID" ] && [ -n "$TENANT" ]; then
    ALERT_ID=$(sqlite3 "$DB_PATH" "INSERT INTO alerts (tenant_id, device_id, priority, metric, message, value, threshold, received_at) VALUES ($TENANT, '$DEVICE_ID', 'P1', 'manual_test', 'TEST: push fan-out check', 0, 0, $(date +%s%3N)); SELECT last_insert_rowid();")
    ok "alert inserted (id=$ALERT_ID)"
    echo "  $(c_dim 'NOTE: alarm-notifier.notify() is called when probe writes alerts via /v1/probe/event;')"
    echo "  $(c_dim 'inserting directly into alerts table will NOT trigger notify(). Use the probe endpoint instead for a real fan-out test.')"
  fi
fi

echo
echo "→ Watch live push fan-out logs:"
echo "  $(c_dim "pm2 logs ${PM2_PROCESS:-cflex-api-v2} | grep -E 'expo-push|alarm-notifier'")"
