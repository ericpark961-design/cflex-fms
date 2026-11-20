#!/usr/bin/env bash
# 랩 켜기. svc(프록시·점프)를 먼저 올린다 — 나머지가 부팅 중 프록시를 찾는다.
# 일부만: ./up.sh svc cap01
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lab.env"
az() { command az "$@" --subscription "$SUB" --only-show-errors; }
all=$(echo "$NODES" | awk 'NF{print $1}')
want=${*:-$all}
case " $want " in *" svc "*) az vm start -g "$RG" -n svc -o none; echo "svc started";; esac
for n in $want; do [ "$n" = svc ] && continue; az vm start -g "$RG" -n "$n" --no-wait -o none; echo "$n starting"; done
echo "자동 종료: 매일 ${SHUTDOWN_UTC} UTC. 끝나면 ./down.sh"
