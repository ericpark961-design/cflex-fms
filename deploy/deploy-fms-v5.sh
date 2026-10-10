#!/usr/bin/env bash
# Deploy the v5 alarm workbench backend to the cflex-v2 API.
#
#   ./deploy/deploy-fms-v5.sh [--host azureuser@20.25.17.81] [--check-only]
#
# Ships: migration 005, the three new services, the incidents router, the
# updated probe hook, and the one server.js mount line. Backs up every file it
# replaces and the database first, verifies each file parses before the restart,
# and prints the rollback command at the end.
#
# The API is on 20.25.17.81 (cflex.runless.co.uk), NOT on VM1 — nginx on
# fms.runless.co.uk proxies /v1/ there. VM1 has a stale /opt/cflex-fms copy that
# serves nothing; deploying to it would appear to succeed and change nothing.
set -euo pipefail

HOST=azureuser@20.25.17.81
APP=/opt/cflex-v2/cflex-api
PM2_APP=cflex-api-v2
CHECK_ONLY=0
STAMP=$(date +%s)
REPO=$(cd "$(dirname "$0")/.." && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n── %s\n' "$1"; }

SERVICES="fms-incident.js fms-triage.js fms-reeval.js fms-topology.js"
ROUTES="incidents.routes.js probe.routes.js fms.routes.js"
SEEDS="kmx_demo_scenario.js kmx_ccr_topology.json import_topology.js"

# sha256 of probe.routes.js as it stands on the host before this deploy. Pinned
# rather than derived from git, so it stays meaningful as history moves on.
BASE_PROBE_SHA=933d2f3ed05f5602bd10f9db980180ae2558f488419de92fdc220f22c3de4cf3

# ── 1. preflight ────────────────────────────────────────────────────
say "preflight on $HOST"
ssh "$HOST" "sudo test -f $APP/src/server.js" || { echo "no server.js at $APP — wrong host?" >&2; exit 1; }
ssh "$HOST" "sudo test -f $APP/data/cflex.db" || { echo "no database at $APP/data/cflex.db" >&2; exit 1; }
ssh "$HOST" "df -h / | tail -1"      # shared VM: stock + cflex + FMS share this disk

# The live probe.routes.js must match what this deploy was built against, or the
# P1 auto-ticket block we are replacing is not the one that is running.
LIVE_PROBE=$(ssh "$HOST" "sudo sha256sum $APP/src/routes/probe.routes.js" | cut -d' ' -f1)
BASE_PROBE=$BASE_PROBE_SHA
echo "live probe.routes.js : ${LIVE_PROBE:0:16}"
echo "expected (pre-v5)    : ${BASE_PROBE:0:16}"
if [ "$LIVE_PROBE" != "$BASE_PROBE" ]; then
  echo
  echo "  probe.routes.js on the host is not the version this change was written against."
  echo "  Diff it before continuing — the alert-insert block may have moved:"
  echo "    ssh $HOST 'sudo cat $APP/src/routes/probe.routes.js' | diff - $REPO/backend/routes/probe.routes.js"
  echo
  [ "$CHECK_ONLY" = 1 ] || { echo "refusing to overwrite; re-run with --check-only to inspect" >&2; exit 3; }
fi

ALREADY=$(ssh "$HOST" "sudo grep -c 'incidents.routes' $APP/src/server.js || true")
echo "server.js already mounts /v1/incidents: $([ "${ALREADY:-0}" -gt 0 ] && echo yes || echo no)"

if [ "$CHECK_ONLY" = 1 ]; then say "check-only: nothing written"; exit 0; fi

# ── 2. back up ──────────────────────────────────────────────────────
say "backing up (stamp $STAMP)"
ssh "$HOST" "set -e
  sudo cp -a $APP/data/cflex.db $APP/data/cflex.db.bak.$STAMP
  sudo cp -a $APP/src/server.js $APP/src/server.js.bak.$STAMP
  for f in $ROUTES; do [ -f $APP/src/routes/\$f ] && sudo cp -a $APP/src/routes/\$f $APP/src/routes/\$f.bak.$STAMP || true; done
  sudo ls -la $APP/data/cflex.db.bak.$STAMP $APP/src/server.js.bak.$STAMP"

# ── 3. copy ─────────────────────────────────────────────────────────
# Expanded locally: these are this script's variables, not the remote shell's.
TMPLIST=""
for f in $SERVICES $ROUTES $SEEDS; do TMPLIST="$TMPLIST /tmp/$f"; done

say "copying files"
for f in $SERVICES; do scp -q "$REPO/backend/services/$f" "$HOST:/tmp/"; done
for f in $ROUTES;   do scp -q "$REPO/backend/routes/$f"   "$HOST:/tmp/"; done
scp -q "$REPO/backend/migrations/005_fms_s2_workbench.sql" "$REPO/backend/migrations/apply.js" "$HOST:/tmp/"
scp -q "$REPO/backend/triage/rules.json" "$HOST:/tmp/triage-rules.json"
for f in $SEEDS; do scp -q "$REPO/backend/seed/$f" "$HOST:/tmp/"; done
scp -q "$REPO/backend/incident/state_machine.js" "$HOST:/tmp/"

ssh "$HOST" "set -e
  OWNER=\$(stat -c '%U:%G' $APP/src/routes/fms.routes.js)
  U=\${OWNER%%:*}; G=\${OWNER##*:}
  sudo mkdir -p $APP/src/migrations $APP/src/incident $APP/src/triage
  for f in $SERVICES; do sudo install -o \$U -g \$G -m 644 /tmp/\$f $APP/src/services/\$f; done
  for f in $ROUTES;   do sudo install -o \$U -g \$G -m 644 /tmp/\$f $APP/src/routes/\$f;   done
  sudo install -o \$U -g \$G -m 644 /tmp/state_machine.js $APP/src/incident/state_machine.js
  sudo install -o \$U -g \$G -m 644 /tmp/triage-rules.json $APP/src/triage/rules.json
  sudo install -m 644 /tmp/005_fms_s2_workbench.sql $APP/src/migrations/
  sudo install -m 644 /tmp/apply.js $APP/src/migrations/
  sudo mkdir -p $APP/src/seed
  for f in $SEEDS; do sudo install -o \$U -g \$G -m 644 /tmp/\$f $APP/src/seed/\$f; done
  rm -f $TMPLIST /tmp/005_fms_s2_workbench.sql /tmp/apply.js /tmp/triage-rules.json /tmp/state_machine.js
  for f in $SERVICES; do node --check $APP/src/services/\$f; done
  node --check $APP/src/seed/kmx_demo_scenario.js
  node -e \"JSON.parse(require('fs').readFileSync('$APP/src/seed/kmx_ccr_topology.json','utf8')); console.log('ledger JSON parses')\"
  for f in $ROUTES;   do node --check $APP/src/routes/\$f;   done
  node --check $APP/src/incident/state_machine.js
  node -e \"JSON.parse(require('fs').readFileSync('$APP/src/triage/rules.json','utf8')); console.log('rules.json parses')\"
  echo 'every file parses'"

# ── 4. mount /v1/incidents ──────────────────────────────────────────
# Inserted right after the fms.routes mount so it sits inside the same
# verifyToken block. Idempotent: skipped when the line is already there.
say "mounting /v1/incidents"
ssh "$HOST" "set -e
  if sudo grep -q 'incidents.routes' $APP/src/server.js; then
    echo 'already mounted'
  else
    sudo sed -i 's|app.use(\"/v1/fms\", verifyToken, require(\"./routes/fms-push.routes\"));|&\\napp.use(\"/v1/incidents\", verifyToken, require(\"./routes/incidents.routes\"));|' $APP/src/server.js
    sudo grep -n 'incidents.routes' $APP/src/server.js
  fi
  node --check $APP/src/server.js && echo 'server.js parses'"

# ── 5. migrate ──────────────────────────────────────────────────────
say "applying migration 005"
ssh "$HOST" "cd $APP && sudo node src/migrations/apply.js --db $APP/data/cflex.db --only 005"
ssh "$HOST" "sudo sqlite3 -readonly $APP/data/cflex.db \"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fms_insights','fms_oncall','fms_ai_log','fms_dispatch','fms_triage_feedback','incident_alarm_links') ORDER BY name\" | tr '\n' ' '; echo
  echo -n 'tickets triage columns: '
  sudo sqlite3 -readonly $APP/data/cflex.db \"SELECT COUNT(*) FROM pragma_table_info('tickets') WHERE name IN ('triage','triage_at','triage_source','verify_state','dedup_key','severity','ack_at')\"
  echo -n 'dedup index: '
  sudo sqlite3 -readonly $APP/data/cflex.db \"SELECT COUNT(*) FROM sqlite_master WHERE name='uq_tickets_dedup_active'\""

# ── 5b. register the KMX UPS (부록 K1) ──────────────────────────────
# Re-running the import is what moves the ledger's five UPS from fms_devices
# into ups_devices and repairs their power links. It is idempotent.
say "re-importing the KMX ledger so its UPS register in ups_devices"
ssh "$HOST" "cd $APP && sudo node src/seed/import_topology.js src/seed/kmx_ccr_topology.json --tenant 10 --cbu KMX --db $APP/data/cflex.db"
ssh "$HOST" "echo -n 'KMX in ups_devices: '; sudo sqlite3 -readonly $APP/data/cflex.db \"SELECT COUNT(*) FROM ups_devices WHERE cbu='KMX'\"
  echo -n 'KMX left in fms_devices (network/UC only): '; sudo sqlite3 -readonly $APP/data/cflex.db \"SELECT GROUP_CONCAT(kind||'='||n) FROM (SELECT kind, COUNT(*) n FROM fms_devices WHERE cbu='KMX' GROUP BY kind)\"
  echo -n 'dangling power links: '; sudo sqlite3 -readonly $APP/data/cflex.db \"SELECT COUNT(*) FROM fms_power_links WHERE tenant_id=10 AND ((src_type='device' AND src_id NOT IN (SELECT id FROM fms_devices)) OR (dst_type='device' AND dst_id NOT IN (SELECT id FROM fms_devices)) OR (src_type='ups_device' AND src_id NOT IN (SELECT id FROM ups_devices)) OR (dst_type='ups_device' AND dst_id NOT IN (SELECT id FROM ups_devices)))\"
  echo -n 'CBU registry: '; sudo sqlite3 -readonly $APP/data/cflex.db \"SELECT GROUP_CONCAT(cbu||'/'||timezone, ' ') FROM fms_cbu WHERE tenant_id=10\""

# ── 6. restart ──────────────────────────────────────────────────────
say "restarting $PM2_APP"
ssh "$HOST" "sudo -u cflex pm2 restart $PM2_APP --update-env >/dev/null && sleep 4 && sudo -u cflex pm2 list | grep -E 'name|$PM2_APP'"
ssh "$HOST" "sudo -u cflex pm2 logs $PM2_APP --lines 25 --nostream 2>/dev/null | tail -25 || true"

say "smoke test"
ssh "$HOST" "curl -s -o /dev/null -w 'POST /v1/fms/demo/kmx/start -> %{http_code} (401 = mounted)\n' -X POST http://127.0.0.1:3000/v1/fms/demo/kmx/start"
ssh "$HOST" "curl -s -o /dev/null -w 'GET /v1/incidents -> %{http_code} (401 = mounted and auth-guarded, 404 = NOT mounted)\n' http://127.0.0.1:3000/v1/incidents"

say "done"
cat <<EOF

Rollback:
  ssh $HOST "sudo cp -a $APP/src/server.js.bak.$STAMP $APP/src/server.js
             sudo cp -a $APP/src/routes/probe.routes.js.bak.$STAMP $APP/src/routes/probe.routes.js
             sudo rm -f $APP/src/routes/incidents.routes.js
             sudo -u cflex pm2 restart $PM2_APP"

  The database backup is at $APP/data/cflex.db.bak.$STAMP. Migration 005 is
  additive — restoring the DB is only needed if something else went wrong.
EOF
