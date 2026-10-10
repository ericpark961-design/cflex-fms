#!/usr/bin/env bash
# Deploy the FMS backend additions (v3 ledger + AI copilot) to the cflex-v2 API.
#
#   ./deploy/deploy-fms-backend.sh --tenant 10 [--host azureuser@20.25.17.81] [--cbu KMX] [--no-seed] [--check-only]
#
# What it does, in order:
#   1. verifies the live fms.routes.js is the file this repo expects to replace
#   2. backs up every file it will touch
#   3. copies services + routes + migration + seed
#   4. applies migration 004 (idempotent)
#   5. imports the KMX ledger for the given tenant (idempotent, merge)
#   6. restarts the API and checks it came back
#
# Rollback is printed at the end and is a single command.
#
# The API tree on the server is NOT under version control, which is why this
# script checks before it writes and keeps timestamped backups.
set -euo pipefail

HOST=azureuser@20.25.17.81
APP=/opt/cflex-v2/cflex-api
PM2_APP=cflex-api-v2
TENANT=""
CBU=KMX
SEED=1
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --tenant) TENANT="$2"; shift 2 ;;
    --cbu) CBU="$2"; shift 2 ;;
    --no-seed) SEED=0; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STAMP=$(date +%s)

say() { printf '\n==> %s\n' "$1"; }

# ── 1. is the live tree what we think it is? ────────────────────────
say "checking the live tree"
ssh "$HOST" "sudo test -f $APP/src/routes/fms.routes.js" || { echo "no fms.routes.js on $HOST:$APP" >&2; exit 1; }
LIVE_SHA=$(ssh "$HOST" "sudo sha256sum $APP/src/routes/fms.routes.js" | cut -d' ' -f1)
# The repo file is the live file plus our additions, so compare against the
# committed ancestor rather than the working copy.
BASE_SHA=$(git -C "$REPO" show "$(git -C "$REPO" rev-parse feat/twin-3d-app~2):backend/routes/fms.routes.js" 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || echo "")
if [ -n "$BASE_SHA" ] && [ "$LIVE_SHA" != "$BASE_SHA" ]; then
  echo "WARNING: live fms.routes.js does not match the expected baseline." >&2
  echo "  live: $LIVE_SHA" >&2
  echo "  base: $BASE_SHA" >&2
  echo "  Someone edited the server directly. Diff before continuing:" >&2
  echo "    ssh $HOST 'sudo cat $APP/src/routes/fms.routes.js' | diff - <(git show <base>:backend/routes/fms.routes.js)" >&2
  [ "$CHECK_ONLY" = 1 ] || exit 1
fi
echo "live routes sha: $LIVE_SHA"

DB=$(ssh "$HOST" "sudo ls $APP/data/cflex.db" 2>/dev/null || true)
[ -n "$DB" ] || { echo "database not found at $APP/data/cflex.db" >&2; exit 1; }
echo "database       : $DB"
ssh "$HOST" "df -h / | tail -1"          # shared VM — check disk before writing

if [ "$CHECK_ONLY" = 1 ]; then say "check-only: nothing written"; exit 0; fi
[ -n "$TENANT" ] || { echo "--tenant is required (which tenant owns the ledger)" >&2; exit 2; }

# ── 2. back up ──────────────────────────────────────────────────────
say "backing up"
ssh "$HOST" "set -e
  sudo cp -a $APP/src/routes/fms.routes.js $APP/src/routes/fms.routes.js.bak.$STAMP
  sudo cp -a $APP/data/cflex.db $APP/data/cflex.db.bak.$STAMP
  sudo ls -la $APP/src/routes/fms.routes.js.bak.$STAMP $APP/data/cflex.db.bak.$STAMP"

# ── 3. copy ─────────────────────────────────────────────────────────
say "copying files"
scp -q "$REPO/backend/services/fms-topology.js" "$REPO/backend/services/fms-copilot.js" "$HOST:/tmp/"
scp -q "$REPO/backend/routes/fms.routes.js" "$HOST:/tmp/fms.routes.js"
scp -q "$REPO/backend/migrations/004_fms_topology.sql" "$REPO/backend/migrations/apply.js" "$HOST:/tmp/"
scp -q "$REPO/backend/seed/kmx_ccr_topology.json" "$REPO/backend/seed/import_topology.js" "$HOST:/tmp/"
ssh "$HOST" "set -e
  OWNER=\$(stat -c '%U:%G' $APP/src/routes/fms.routes.js)
  sudo install -o \${OWNER%%:*} -g \${OWNER##*:} -m 644 /tmp/fms-topology.js $APP/src/services/fms-topology.js
  sudo install -o \${OWNER%%:*} -g \${OWNER##*:} -m 644 /tmp/fms-copilot.js   $APP/src/services/fms-copilot.js
  sudo install -o \${OWNER%%:*} -g \${OWNER##*:} -m 644 /tmp/fms.routes.js    $APP/src/routes/fms.routes.js
  sudo mkdir -p $APP/src/migrations $APP/src/seed
  sudo install -m 644 /tmp/004_fms_topology.sql $APP/src/migrations/
  sudo install -m 644 /tmp/apply.js $APP/src/migrations/
  sudo install -m 644 /tmp/kmx_ccr_topology.json $APP/src/seed/
  sudo install -m 644 /tmp/import_topology.js $APP/src/seed/
  rm -f /tmp/fms-topology.js /tmp/fms-copilot.js /tmp/fms.routes.js /tmp/004_fms_topology.sql /tmp/apply.js /tmp/kmx_ccr_topology.json /tmp/import_topology.js
  node --check $APP/src/routes/fms.routes.js
  node --check $APP/src/services/fms-topology.js
  node --check $APP/src/services/fms-copilot.js
  echo 'all three parse'"

# ── 4. migrate ──────────────────────────────────────────────────────
say "applying migration 004"
ssh "$HOST" "cd $APP && sudo node src/migrations/apply.js --db $APP/data/cflex.db --only 004"
ssh "$HOST" "sudo sqlite3 -readonly $APP/data/cflex.db \"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fms_%' ORDER BY name\" | tr '\n' ' '; echo"

# ── 5. seed ─────────────────────────────────────────────────────────
if [ "$SEED" = 1 ]; then
  say "importing the KMX ledger for tenant $TENANT"
  ssh "$HOST" "cd $APP && sudo node src/seed/import_topology.js src/seed/kmx_ccr_topology.json --tenant $TENANT --cbu $CBU --db $APP/data/cflex.db"
fi

# ── 6. restart ──────────────────────────────────────────────────────
say "restarting $PM2_APP"
ssh "$HOST" "sudo -u cflex pm2 restart $PM2_APP --update-env >/dev/null && sleep 3 && sudo -u cflex pm2 list | grep -E 'name|$PM2_APP'"
ssh "$HOST" "sudo -u cflex pm2 logs $PM2_APP --lines 15 --nostream 2>/dev/null | tail -15 || true"

say "done"
cat <<EOF
Verify (needs a real token):
  curl -s https://cflex.runless.co.uk/v1/fms/topology -H "Authorization: Bearer \$TOKEN" | head -c 300

Rollback:
  ssh $HOST "sudo cp -a $APP/src/routes/fms.routes.js.bak.$STAMP $APP/src/routes/fms.routes.js \\
    && sudo cp -a $APP/data/cflex.db.bak.$STAMP $APP/data/cflex.db \\
    && sudo -u cflex pm2 restart $PM2_APP"
EOF
