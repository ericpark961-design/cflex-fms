#!/usr/bin/env bash
# 전원 상태와 이번 달 랩 비용.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lab.env"
az() { command az "$@" --subscription "$SUB" --only-show-errors; }
az vm list -g "$RG" -d --query '[].{name:name,size:hardwareProfile.vmSize,power:powerState,ip:privateIps}' -o table
from=$(date -u +%Y-%m-01); to=$(date -u +%Y-%m-%d)
body=$(printf '{"type":"ActualCost","timeframe":"Custom","timePeriod":{"from":"%s","to":"%s"},"dataset":{"granularity":"None","aggregation":{"c":{"name":"Cost","function":"Sum"}}}}' "$from" "$to")
az rest --method post --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.CostManagement/query?api-version=2023-03-01" \
  --body "$body" --query 'properties.rows[0]' -o tsv 2>/dev/null | awk -v f="$from" '{printf "이번 달 비용 (%s~): %s %s\n", f, $1, $2}' || echo "비용 조회 실패(데이터 지연 가능)"
