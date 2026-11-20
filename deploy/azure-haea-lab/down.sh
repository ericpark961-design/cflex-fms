#!/usr/bin/env bash
# 랩 끄기 (deallocate — 컴퓨트 과금 중지, 디스크·IP 만 남는다).
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lab.env"
az() { command az "$@" --subscription "$SUB" --only-show-errors; }
for n in ${*:-$(echo "$NODES" | awk 'NF{print $1}')}; do
  az vm deallocate -g "$RG" -n "$n" --no-wait -o none; echo "$n deallocating"
done
