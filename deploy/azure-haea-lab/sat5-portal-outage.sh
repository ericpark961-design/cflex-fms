#!/usr/bin/env bash
# HAEA mirror lab — SAT 5: cut the Portal link, keep collecting, restore, nothing lost (WO-INT-015).
#
#   ./sat5-portal-outage.sh [minutes=10]
#
# Cut = the proxy refuses cflex.fms.support (what a firewall/proxy change at HAEA looks like).
# Halfway through, the sender node's console restarts — the buffer is db01's portal_outbox, not memory.
# Pass: outbox drains to 0 after restore; every telemetry point the FMS stored for the outage window
# reached the Portal mock exactly once (unique = stored, duplicates 0).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
S=.state/ssh_config; MIN=${1:-10}
q() { grep -vE 'post-quantum|store now|upgraded|Permanently added' || true; }
psql() { ssh -F $S db01 "U=\$(id -u cflex); sudo runuser -u cflex -- env --chdir=/home/cflex XDG_RUNTIME_DIR=/run/user/\$U podman exec cflex-postgres psql -d cflex -Atc \"$1\"" 2>/dev/null; }
stats() { ssh -F $S nmcsim "curl -s '127.0.0.1:9180/stats?from=$1&to=$2'" 2>/dev/null; }
pending() { psql "select count(*) from portal_outbox"; }
iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z; }
say() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

say "before: outbox $(pending) pending · mock $(stats '' 9999)"
until [ "$(pending)" -le 2 ]; do sleep 15; done

t0=$(date +%s)
ssh -F $S svc "sudo sed -i 's/^cflex.fms.support/#cflex.fms.support/' /etc/squid/lab-allow.txt && sudo squid -k reconfigure" 2>&1 | q
say "CUT  proxy refuses cflex.fms.support"
sleep $((MIN * 30))
sender=$(psql "select 1" >/dev/null; for n in app01 app02; do ssh -F $S $n "sudo journalctl --since '-2h' -o cat CONTAINER_NAME=cflex-console | grep -c 'holds the sender lock'" 2>/dev/null | tr -d '\n'; echo " $n"; done | sort -n | tail -1 | awk '{print $2}')
ssh -F $S "$sender" 'U=$(id -u cflex); sudo runuser -u cflex -- env --chdir=/home/cflex XDG_RUNTIME_DIR=/run/user/$U systemctl --user restart cflex-console' 2>&1 | q
say "mid-outage: restarted cflex-console on $sender (sender) · outbox $(pending) pending"
sleep $((MIN * 30))
t1=$(date +%s)
say "outage end: outbox $(pending) pending · last attempt error: $(psql "select left(last_error,80) from portal_outbox where last_error is not null order by id limit 1")"

ssh -F $S svc "sudo sed -i 's/^#cflex.fms.support/cflex.fms.support/' /etc/squid/lab-allow.txt && sudo squid -k reconfigure" 2>&1 | q
say "RESTORE"
n=0; until [ "$(pending)" -le 2 ] || [ $n -ge 60 ]; do sleep 10; n=$((n+1)); done
tr=$(date +%s)
say "drained in $((tr - t1))s · outbox $(pending) pending"
sleep 20

F=$(iso $t0); T=$(iso $t1)
stored=$(psql "select count(*) from telemetry where ts >= ${t0}000 and ts < ${t1}000")
got=$(stats "$F" "$T")
echo "window   $F … $T  ($(( (t1 - t0) / 60 )) min)"
echo "FMS stored points in window : $stored"
echo "Portal mock                 : $got"
python3 - "$stored" "$got" <<'PY'
import json, sys
stored = int(sys.argv[1]); s = json.loads(sys.argv[2])
ok = s["points_in_window"] >= stored and s["duplicate_points"] == 0
print("SAT 5:", "PASS" if ok else "FAIL", "— in window %d / stored %d, duplicates %d" % (s["points_in_window"], stored, s["duplicate_points"]))
PY
