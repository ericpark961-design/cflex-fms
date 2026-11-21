#!/usr/bin/env bash
# HAEA mirror lab — SAT 7 upgrade / rollback rehearsal (WO-INT-015). Order = CONTAINER_PROFILE.md §8.
#
#   ./upgrade-lab.sh upgrade  <version>   bundle in → db01 → app02 (standby) → verify → app01 --standby-done → cap01
#   ./upgrade-lab.sh rollback             app02 → app01 → cap01 → db01 (previous tag; images stay loaded)
#   ./upgrade-lab.sh snapshot             data counts for the before/after comparison
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
S=.state/ssh_config
q() { grep -vE 'post-quantum|store now|upgraded|Permanently added' || true; }
on() { local n=$1; shift; ssh -F $S "$n" "$@" 2>&1 | q; }
step() { printf '\n== %s  (%s)\n' "$*" "$(date -u +%H:%M:%SZ)"; }
ver() { on $1 "cd ~/cflex-bundle-* 2>/dev/null; B=\$(ls -d ~/cflex-bundle-* | tail -1); sudo \$B/install/cflex-install verify --role $2 2>&1 | grep -E '^(FAIL|WARN) |^결과'"; }

snapshot() {
  on db01 'U=$(id -u cflex); sudo runuser -u cflex -- env --chdir=/home/cflex XDG_RUNTIME_DIR=/run/user/$U podman exec cflex-postgres psql -d cflex -Atc "
    select '"'"'devices'"'"', count(*) from devices union all
    select '"'"'users'"'"', count(*) from users union all
    select '"'"'open alarms'"'"', count(*) from alarms where state <> '"'"'cleared'"'"' union all
    select '"'"'telemetry rows'"'"', count(*) from telemetry union all
    select '"'"'schema'"'"', max(version)::bigint from schema_migrations"' 2>/dev/null || true
  for n in cap01 app01 app02 db01; do echo "$n $(on $n 'sudo cat /opt/app/cflex/state/deployed.json' | tr -d '\n' | cut -c1-160)"; done
}

case ${1:?upgrade|rollback|snapshot} in
upgrade)
  VER=${2:?version}; B="cflex-bundle-$VER"
  step "0. 번들 반입 (빌드 호스트 → svc → 4노드, 노드에는 tar 를 남기지 않고 바로 풀기), 체크섬"
  # BUNDLE_TAR=<local path>: scp it (resumable, checked). Otherwise relay from the build host — a
  # 2.4 GB pipe through this Mac once stalled at 2.0 GB, so a local copy is the default for big bundles.
  if [ -n "${BUNDLE_TAR:-}" ]; then
    scp -q -F $S "$BUNDLE_TAR" svc:~/$B.tar && ssh -F $S svc "sha256sum ~/$B.tar" 2>&1 | q
  else
    src=$(ssh vm1 "ls /opt/cflex-build/out*/$B.tar | head -1")
    ssh vm1 "cat $src" | ssh -F $S svc "cat > ~/$B.tar && sha256sum ~/$B.tar" 2>&1 | q
  fi
  ssh-add -q ~/.ssh/cflex_haea_lab_ed25519 2>/dev/null || true
  ssh -A -F $S svc "for ip in 10.138.14.66 10.138.14.67 10.138.14.68 10.138.14.69; do ( ssh \$ip 'tar -xf - -C ~' < ~/$B.tar && ssh \$ip 'cd ~/$B && sha256sum -c --quiet SHA256SUMS && echo \"\$(hostname) SHA256SUMS OK\"' ) & done; wait; rm -f ~/$B.tar" 2>&1 | q
  up() { on $1 "cd ~/$B && sudo install/cflex-install upgrade --role $2 --bundle ~/$B ${3:-} --yes 2>&1 | grep -E '^(FAIL|OK) |upgrade|upgraded|rolled|결과|Error|refus' | tail -4"; }
  step "1. db01";              up db01 db
  step "2. app02 (Standby)";   up app02 app;  ver app02 app
  step "3. app01 (Active) — --standby-done 없이는 거부되는지 먼저"
  on app01 "cd ~/$B && sudo install/cflex-install upgrade --role app --bundle ~/$B --yes 2>&1 | grep -iE 'ACTIVE|standby' | head -1"
  up app01 app --standby-done
  step "4. cap01";             up cap01 collector
  step "5. verify (4노드)"
  for n in "db01 db" "app01 app" "app02 app" "cap01 collector"; do set -- $n; echo "-- $1"; ver $1 $2; done ;;
rollback)
  rb() { on $1 "B=\$(ls -d ~/cflex-bundle-* | tail -1); sudo \$B/install/cflex-install rollback --role $2 --yes 2>&1 | grep -E 'rollback|rolled|FAIL|Error' | tail -2"; }
  step "rollback app02"; rb app02 app
  step "rollback app01"; rb app01 app
  step "rollback cap01"; rb cap01 collector
  step "rollback db01";  rb db01 db
  step "verify"
  for n in "db01 db" "app01 app" "app02 app" "cap01 collector"; do set -- $n; echo "-- $1"; ver $1 $2; done ;;
snapshot) snapshot ;;
esac
