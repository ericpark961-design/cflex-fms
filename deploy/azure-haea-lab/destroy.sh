#!/usr/bin/env bash
# 랩 전체 삭제 (복구 불가). 리소스 그룹째 지운다 — 다른 RG 는 건드리지 않는다.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lab.env"
read -r -p "정말 $RG 를 삭제합니까? 그룹 이름을 입력: " ans
[ "$ans" = "$RG" ] || { echo "취소"; exit 1; }
command az group delete --subscription "$SUB" -n "$RG" --yes --no-wait && echo "삭제 요청됨"
