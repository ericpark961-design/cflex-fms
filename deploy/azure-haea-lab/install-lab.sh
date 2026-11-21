#!/usr/bin/env bash
# HAEA 미러 랩 — 번들 하나로 4노드를 처음부터 설치하고 verify 까지 (WO-INT-015).
# 현장 MOP(docs/install/CONTAINER_PROFILE.md §6) 순서를 그대로 따른다. # LAB 표시 단계만 랩 전용.
#
#   ./install-lab.sh <version>          예: ./install-lab.sh 2.0.0-lab.2
#
# 전제: create.sh 로 VM 이 있고, 번들 tar 가 빌드 호스트(vm1 = probe-01)의 /opt/cflex-build/out*/ 에 있다.
# 비밀값은 노드 사이에서 파이프로만 옮기고 화면·파일에 남기지 않는다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
VER=${1:?version}; B="cflex-bundle-$VER"
S=.state/ssh_config
q() { grep -vE 'post-quantum|store now|upgraded|Permanently added' || true; }
on() { local n=$1; shift; ssh -F $S "$n" "$@" 2>&1 | q; }
asc() { local n=$1; shift; ssh -F $S "$n" "U=\$(id -u cflex); sudo runuser -u cflex -- env --chdir=/home/cflex XDG_RUNTIME_DIR=/run/user/\$U $*" 2>/dev/null; }
step() { printf '\n== %s\n' "$*"; }

step "0. 번들 반입 — 빌드 호스트 → svc(점프) → 4노드, 체크섬 재확인"
src=$(ssh vm1 "ls /opt/cflex-build/out*/$B.tar | head -1")
ssh vm1 "cat $src" | ssh -F $S svc "cat > ~/$B.tar && sha256sum ~/$B.tar" 2>&1 | q
scp -q -F $S site.lab.yaml svc:~/site.yaml
ssh-add -q ~/.ssh/cflex_haea_lab_ed25519 2>/dev/null || true
# VMs may have been recreated: forget the old host keys on the jump host first (# LAB)
ssh -F $S svc 'for ip in 10.138.14.66 10.138.14.67 10.138.14.68 10.138.14.69; do ssh-keygen -R $ip >/dev/null 2>&1; done' 2>&1 | q
ssh -A -F $S svc "for ip in 10.138.14.66 10.138.14.67 10.138.14.68 10.138.14.69; do ( scp -q -o StrictHostKeyChecking=accept-new ~/$B.tar ~/site.yaml \$ip:~/ && ssh \$ip 'tar -xf ~/$B.tar -C ~ && rm ~/$B.tar && cd ~/$B && sha256sum -c --quiet SHA256SUMS && echo \"\$(hostname) SHA256SUMS OK\"' ) & done; wait" 2>&1 | q

step "1. Satellite 대용: container-tools (# LAB — HAEA 는 ITOM 이 Satellite 로 설치)"
for n in cap01 app01 app02 db01; do on $n 'sudo dnf -y -q module install container-tools:rhel8 >/dev/null 2>&1; echo "$(hostname) $(podman --version)"' & done; wait

step "2. site.yaml · nmc-targets 배치 (4노드 동일)"
for n in cap01 app01 app02 db01; do on $n "sudo install -d -m 750 /opt/app/cflex/config && sudo cp ~/site.yaml /opt/app/cflex/config/site.yaml && sudo cp ~/$B/config/nmc-targets.example.txt /opt/app/cflex/config/nmc-targets.txt && echo \$(hostname) ok" & done; wait

inst() {  # node role [extra]
  on $1 "cd ~/$B && sudo install/cflex-install install --role $2 ${3:-} --yes 2>&1 | grep -E '^(FAIL) |^결과|^OK|FAILED'"
}
ver() { on $1 "cd ~/$B && sudo install/cflex-install verify --role $2 2>&1 | grep -E '^(FAIL|WARN) |^결과'"; }
pipe_secret() {  # from-node from-path to-node to-path
  ssh -F $S $1 "sudo cat $2" 2>/dev/null | ssh -F $S $3 "sudo install -d -m 700 \$(dirname $4) && sudo sh -c 'cat > $4 && chmod 600 $4' && echo '$3: $(basename $4) placed'" 2>&1 | q
}

step "3. db01"
inst db01 db
on db01 'U=$(id -u cflex); sudo runuser -u cflex -- env --chdir=/home/cflex XDG_RUNTIME_DIR=/run/user/$U DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U/bus systemctl --user start cflex-pg-backup && echo "base backup ok"'
pipe_secret db01 /opt/app/cflex/secrets/db/pg.pass app01 /opt/app/cflex/secrets/app/pg.pass
pipe_secret db01 /opt/app/cflex/secrets/db/pg.pass app02 /opt/app/cflex/secrets/app/pg.pass

step "4. app01 (Active) — # LAB: --self-signed-console-cert (HAEA 는 내부 CA 인증서)"
inst app01 app --self-signed-console-cert
pipe_secret app01 /opt/app/cflex/secrets/app/redis.pass app02 /opt/app/cflex/secrets/app/redis.pass
pipe_secret app01 /opt/app/cflex/secrets/app/console.key app02 /opt/app/cflex/secrets/app/console.key

step "5. app02 (Standby)"
inst app02 app --self-signed-console-cert

step "6. # LAB: 두 자체서명 인증서를 서로 신뢰 (HAEA 는 같은 내부 CA 라 불필요)"
pem=$(for n in app01 app02; do ssh -F $S $n 'sudo cat /opt/app/cflex/certs/console.crt' 2>/dev/null; done)
for n in app01 app02 cap01; do printf '%s\n' "$pem" | ssh -F $S $n 'sudo install -d -m 755 /opt/app/cflex/certs && sudo sh -c "cat > /opt/app/cflex/certs/console-ca.pem"' 2>&1 | q; done
echo "console-ca.pem: $(printf '%s\n' "$pem" | grep -c BEGIN) certs → app01, app02, cap01"

step "7. cap01 — collector key 는 콘솔이 발급(한 번만 출력), 파이프로 바로 cap01 에"
asc app01 podman exec cflex-console node /opt/cflex/apps/console/src/cli.js collector-key cap01 | tr -d '\r\n' \
  | ssh -F $S cap01 'sudo install -d -m 700 /opt/app/cflex/secrets/collector && sudo sh -c "cat > /opt/app/cflex/secrets/collector/collector.key && chmod 600 /opt/app/cflex/secrets/collector/collector.key" && echo "cap01: collector.key placed"' 2>&1 | q
inst cap01 collector

step "8. verify (4노드)"
for n in "db01 db" "app01 app" "app02 app" "cap01 collector"; do set -- $n; echo "-- $1"; ver $1 $2; done
