#!/usr/bin/env bash
# HAEA 미러 랩 — 설치 직후 콘솔에 운영자 계정·사이트 3개·장비 41대(sim/fleet.csv)를 넣는다 (WO-INT-015).
# 현장에서는 사람이 Settings 화면(또는 같은 API)으로 하는 일이다. 비밀번호는 .state/ (git 밖) 에만 남긴다.
#
#   ./bootstrap-console.sh            SSH 터널(127.0.0.1:8443 → app01:443)을 열고 진행
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
S=.state/ssh_config; B=https://127.0.0.1:8443; J=.state/labops.cookies; umask 077
pgrep -f "8443:10.138.14.67:443" >/dev/null || { ssh -F $S -o ExitOnForwardFailure=yes -f -N -L 127.0.0.1:8443:10.138.14.67:443 svc; sleep 2; }

mkuser() {  # name role → prints initial password
  local pw="Lab-$(openssl rand -hex 8)"
  printf '%s\n' "$pw" | ssh -F $S app01 "U=\$(id -u cflex); sudo runuser -u cflex -- env --chdir=/home/cflex XDG_RUNTIME_DIR=/run/user/\$U podman exec -i cflex-console node /opt/cflex/apps/console/src/cli.js create-user $1 $2" >/dev/null 2>&1
  echo "$pw"
}

# automation admin (password changed right away so the API answers)
p1=$(mkuser labops admin); p2="Lab-$(openssl rand -hex 8)"; rm -f $J
curl -sk -c $J -b $J -o /dev/null -H 'Content-Type: application/json' -d "{\"username\":\"labops\",\"password\":\"$p1\"}" $B/v1/auth/login
curl -sk -c $J -b $J -o /dev/null -H 'Content-Type: application/json' -d "{\"current\":\"$p1\",\"next\":\"$p2\"}" $B/v1/auth/password
printf 'labops %s\n' "$p2" > .state/labops.txt

# the person's own login — must change at first sign-in
pe=$(mkuser eric admin); printf 'eric %s (first login: change)\n' "$pe" > .state/console-admin.txt

for s in "HMA-FV|HMA Fountain Valley|HMA" "KUS-IRV|KIA US Irvine|KUS" "HAEA-HQ|HAEA HQ|HAEA_HQ"; do
  IFS='|' read -r id name co <<< "$s"
  curl -sk -b $J -o /dev/null -w "site $id %{http_code}\n" -X PUT -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"company\":\"$co\",\"timezone\":\"America/Los_Angeles\"}" $B/v1/console/sites/$id
done
curl -sk -b $J -H 'Content-Type: text/csv' --data-binary @sim/fleet.csv $B/v1/console/import \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('import', {k: d[k] for k in ('created','updated','failed')})"
echo "eric 초기 비밀번호: .state/console-admin.txt"
