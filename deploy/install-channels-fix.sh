#!/usr/bin/env bash
# Install the channels/health fix. Migration 006 is already applied.
#
#   sudo bash /tmp/install-channels-fix.sh
#
# Three files: the rewritten endpoint, and the two notifiers that now record
# which tenant a dispatch belonged to. Backs each up, parses all three before
# restarting, then asks the running API whether the endpoint still 500s.
set -euo pipefail
APP=/opt/cflex-v2/cflex-api
PM2_APP=cflex-api-v2
STAMP=$(date +%s)
OWNER=$(stat -c '%U:%G' "$APP/src/routes/fms.routes.js"); U=${OWNER%%:*}; G=${OWNER##*:}

for f in fms.routes.js alarm-notifier.js expo-push-notifier.js; do
  [ -f "/tmp/$f" ] || { echo "MISSING /tmp/$f" >&2; exit 1; }
done

echo "── backup"
cp -a "$APP/src/routes/fms.routes.js"            "$APP/src/routes/fms.routes.js.bak.$STAMP"
cp -a "$APP/src/services/alarm-notifier.js"      "$APP/src/services/alarm-notifier.js.bak.$STAMP"
cp -a "$APP/src/services/expo-push-notifier.js"  "$APP/src/services/expo-push-notifier.js.bak.$STAMP"
echo "   stamp $STAMP"

echo "── install"
install -o "$U" -g "$G" -m 644 /tmp/fms.routes.js           "$APP/src/routes/fms.routes.js"
install -o "$U" -g "$G" -m 644 /tmp/alarm-notifier.js       "$APP/src/services/alarm-notifier.js"
install -o "$U" -g "$G" -m 644 /tmp/expo-push-notifier.js   "$APP/src/services/expo-push-notifier.js"
for f in src/routes/fms.routes.js src/services/alarm-notifier.js src/services/expo-push-notifier.js; do
  node --check "$APP/$f" && echo "   ok  $f"
done

echo "── restart"
sudo -u cflex pm2 restart "$PM2_APP" --update-env >/dev/null
sleep 5
sudo -u cflex pm2 list | grep -E "name|$PM2_APP"

echo "── verify: the error that used to repeat every 30 s"
sleep 35
if sudo -u cflex pm2 logs "$PM2_APP" --lines 200 --nostream --err 2>/dev/null \
     | grep -q "channels/health: no such column"; then
  echo "   STILL FAILING — check the log" >&2
else
  echo "   no 'channels/health: no such column' in the last 200 error lines"
fi
sudo -u cflex pm2 logs "$PM2_APP" --lines 60 --nostream --err 2>/dev/null \
  | grep -i "channels/health" | tail -3 | sed 's/^/   /' || echo "   (no channels/health errors at all)"

rm -f /tmp/fms.routes.js /tmp/alarm-notifier.js /tmp/expo-push-notifier.js /tmp/006_dispatch_log_tenant.sql
cat <<ROLLBACK

rollback:
  sudo cp -a $APP/src/routes/fms.routes.js.bak.$STAMP           $APP/src/routes/fms.routes.js
  sudo cp -a $APP/src/services/alarm-notifier.js.bak.$STAMP     $APP/src/services/alarm-notifier.js
  sudo cp -a $APP/src/services/expo-push-notifier.js.bak.$STAMP $APP/src/services/expo-push-notifier.js
  sudo -u cflex pm2 restart $PM2_APP
ROLLBACK
