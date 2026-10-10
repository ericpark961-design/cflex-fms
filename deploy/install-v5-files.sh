#!/usr/bin/env bash
# Install the v5 backend files on the cflex-v2 API host.
#
# Run ON the API host (20.25.17.81) as:   sudo bash /tmp/install-v5-files.sh
# The source files are already staged in /tmp by the workstation.
#
# Migration 005 and the KMX CBU registration are ALREADY APPLIED to the
# database — this script only replaces code and mounts /v1/incidents. It backs
# up every file it touches and parses all of them before anything restarts, so
# a syntax error cannot take the API down.
set -euo pipefail

APP=/opt/cflex-v2/cflex-api
PM2_APP=cflex-api-v2
STAMP=$(date +%s)

OWNER=$(stat -c '%U:%G' "$APP/src/routes/fms.routes.js"); U=${OWNER%%:*}; G=${OWNER##*:}
echo "owner: $U:$G   stamp: $STAMP"

echo
echo "── 0. the staged files must all be present before we touch anything"
for f in fms-incident.js fms-triage.js fms-reeval.js fms-topology.js \
         incidents.routes.js probe.routes.js fms.routes.js state_machine.js \
         triage-rules.json kmx_demo_scenario.js kmx_ccr_topology.json; do
  [ -f "/tmp/$f" ] || { echo "   MISSING /tmp/$f — re-stage from the workstation" >&2; exit 1; }
done
echo "   all 11 staged"

echo
echo "── 1. backup"
for f in src/routes/fms.routes.js src/routes/probe.routes.js \
         src/services/fms-topology.js src/server.js; do
  if [ -f "$APP/$f" ]; then
    cp -a "$APP/$f" "$APP/$f.bak.$STAMP"
    echo "   $f.bak.$STAMP"
  fi
done

echo
echo "── 2. install"
mkdir -p "$APP/src/incident" "$APP/src/triage" "$APP/src/seed"
inst() { install -o "$U" -g "$G" -m 644 "/tmp/$1" "$APP/$2"; echo "   $2"; }
inst fms-incident.js       src/services/fms-incident.js
inst fms-triage.js         src/services/fms-triage.js
inst fms-reeval.js         src/services/fms-reeval.js
inst fms-topology.js       src/services/fms-topology.js
inst incidents.routes.js   src/routes/incidents.routes.js
inst probe.routes.js       src/routes/probe.routes.js
inst fms.routes.js         src/routes/fms.routes.js
inst state_machine.js      src/incident/state_machine.js
inst triage-rules.json     src/triage/rules.json
inst kmx_demo_scenario.js  src/seed/kmx_demo_scenario.js
inst kmx_ccr_topology.json src/seed/kmx_ccr_topology.json

echo
echo "── 3. parse check — nothing restarts unless every one of these passes"
for f in src/services/fms-incident.js src/services/fms-triage.js \
         src/services/fms-reeval.js src/services/fms-topology.js \
         src/routes/incidents.routes.js src/routes/probe.routes.js \
         src/routes/fms.routes.js src/incident/state_machine.js \
         src/seed/kmx_demo_scenario.js; do
  node --check "$APP/$f" && echo "   ok  $f"
done
node -e "JSON.parse(require('fs').readFileSync('$APP/src/triage/rules.json','utf8'))" \
  && echo "   ok  src/triage/rules.json"
node -e "JSON.parse(require('fs').readFileSync('$APP/src/seed/kmx_ccr_topology.json','utf8'))" \
  && echo "   ok  src/seed/kmx_ccr_topology.json"

echo
echo "── 4. mount /v1/incidents (idempotent)"
if grep -q 'incidents.routes' "$APP/src/server.js"; then
  echo "   already mounted"
else
  sed -i 's|app.use("/v1/fms", verifyToken, require("./routes/fms-push.routes"));|&\napp.use("/v1/incidents", verifyToken, require("./routes/incidents.routes"));|' "$APP/src/server.js"
  grep -n 'incidents.routes' "$APP/src/server.js" | sed 's/^/   /'
fi
node --check "$APP/src/server.js" && echo "   ok  src/server.js"

echo
echo "── 5. restart"
sudo -u cflex pm2 restart "$PM2_APP" --update-env >/dev/null
sleep 5
sudo -u cflex pm2 list | grep -E "name|$PM2_APP"

echo
echo "── 6. verify"
printf '   GET /v1/incidents   -> %s   (401 = mounted and auth-guarded, 404 = NOT mounted)\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/v1/incidents)"
printf '   GET /v1/fms/summary -> %s   (401 expected)\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/v1/fms/summary)"
echo -n '   CBU registry: '
sqlite3 -readonly "$APP/data/cflex.db" \
  "SELECT GROUP_CONCAT(cbu || '/' || timezone, '  ') FROM fms_cbu WHERE tenant_id=10;"
echo -n '   KMX in ups_devices: '
sqlite3 -readonly "$APP/data/cflex.db" "SELECT COUNT(*) FROM ups_devices WHERE cbu='KMX';"
echo "   recent API log:"
sudo -u cflex pm2 logs "$PM2_APP" --lines 12 --nostream 2>/dev/null | tail -12 | sed 's/^/     /'

echo
echo "── cleanup"
rm -f /tmp/fms-incident.js /tmp/fms-triage.js /tmp/fms-reeval.js /tmp/fms-topology.js \
      /tmp/incidents.routes.js /tmp/probe.routes.js /tmp/fms.routes.js /tmp/state_machine.js \
      /tmp/triage-rules.json /tmp/kmx_demo_scenario.js /tmp/kmx_ccr_topology.json
echo "   staged files removed"

cat <<ROLLBACK

rollback (code only — the database change is additive and stays):
  sudo cp -a $APP/src/server.js.bak.$STAMP               $APP/src/server.js
  sudo cp -a $APP/src/routes/fms.routes.js.bak.$STAMP    $APP/src/routes/fms.routes.js
  sudo cp -a $APP/src/routes/probe.routes.js.bak.$STAMP  $APP/src/routes/probe.routes.js
  sudo cp -a $APP/src/services/fms-topology.js.bak.$STAMP $APP/src/services/fms-topology.js
  sudo rm -f $APP/src/routes/incidents.routes.js
  sudo -u cflex pm2 restart $PM2_APP
ROLLBACK
