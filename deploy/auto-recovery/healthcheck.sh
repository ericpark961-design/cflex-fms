#!/usr/bin/env bash
# 전 인프라 헬스체크 + 자동복구 — 매 5분 systemd timer로 호출.
# 502/000/timeout 발견 시 대응 서비스 systemctl restart.
# 3회 연속 실패하면 알림(Teams/SMS).
#
# 설치: ./install.sh  (같은 디렉토리)
# 수동 실행: sudo /usr/local/bin/cflex-healthcheck
#
# 로그: /var/log/cflex-healthcheck.log
# 상태: /var/run/cflex-healthcheck-state/<service>.fails  (연속 실패 카운트)

set -u
LOG=/var/log/cflex-healthcheck.log
STATE=/var/run/cflex-healthcheck-state
mkdir -p "$STATE"
touch "$LOG"

# 알림 hooks (선택)
TEAMS_WEBHOOK="${TEAMS_WEBHOOK:-}"     # /etc/cflex-healthcheck.env 에서 export
SMS_WEBHOOK="${SMS_WEBHOOK:-}"
ALERT_THRESHOLD=3                        # 3회 연속 실패 → 알림

# 외부 설정 (있으면 로드)
[ -f /etc/cflex-healthcheck.env ] && . /etc/cflex-healthcheck.env

# ─── 점검 대상 ─────────────────────────────────────────────────────
# 형식: "라벨|URL|기대코드|복구명령(systemctl restart ... 또는 빈문자열=알림만)"
TARGETS=(
  "stock-api|https://stock.runless.co.uk/v1/me|401|systemctl restart stock-sentinel"
  "stock-static|https://stock.runless.co.uk/app/|200|systemctl restart stock-sentinel"
  "cflex-api|https://cflex.runless.co.uk/v1/health|401|systemctl restart pm2-cflex"
  "cflex-static|https://cflex.runless.co.uk/|200|systemctl reload nginx"
  "dev-cflex-api|https://dev.cflex.runless.co.uk/v1/health|401|systemctl restart pm2-cflex"
  "fms-api|https://fms.runless.co.uk/v1/health|401|systemctl restart pm2-cflex"
  "fms-static|https://fms.runless.co.uk/|302|systemctl reload nginx"
  "sentinel-api|https://sentinel.runless.co.uk/v1/health|401|systemctl restart pm2-cflex"
  "sentinel-static|https://sentinel.runless.co.uk/|302|systemctl reload nginx"
  "ringonservice-net|https://ringonservice.net/|200|systemctl reload nginx"
)

now() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(now) $*" >> "$LOG"; }

alert() {
  local label="$1" url="$2" code="$3" fails="$4"
  local msg="🚨 [$label] FAIL ${fails}x — got $code from $url"
  log "ALERT: $msg"
  if [ -n "$TEAMS_WEBHOOK" ]; then
    curl -sS -X POST -H "content-type: application/json" \
         -d "{\"text\":\"$msg\"}" "$TEAMS_WEBHOOK" >/dev/null 2>&1 || true
  fi
  if [ -n "$SMS_WEBHOOK" ]; then
    curl -sS -X POST -H "content-type: application/json" \
         -d "{\"message\":\"$msg\"}" "$SMS_WEBHOOK" >/dev/null 2>&1 || true
  fi
}

check_one() {
  local label="$1" url="$2" want="$3" recover="$4"
  local code
  code=$(curl -sk -o /dev/null -w '%{http_code}' \
              --connect-timeout 5 --max-time 10 "$url" 2>/dev/null || echo "000")

  local fcount_file="$STATE/$label.fails"
  local fails=0
  [ -f "$fcount_file" ] && fails=$(cat "$fcount_file" 2>/dev/null || echo 0)

  if [ "$code" = "$want" ]; then
    # 정상 — 카운터 리셋
    if [ "$fails" != "0" ]; then
      log "[$label] RECOVERED (was ${fails} fails) → got $want"
    fi
    echo 0 > "$fcount_file"
    return 0
  fi

  # 실패
  fails=$((fails + 1))
  echo "$fails" > "$fcount_file"
  log "[$label] FAIL #$fails — want=$want got=$code  url=$url"

  # 1회 실패 즉시 복구 시도 (있으면)
  if [ -n "$recover" ]; then
    log "[$label] recover: $recover"
    eval "$recover" >> "$LOG" 2>&1 || log "[$label] recover cmd failed"
  fi

  # 임계치 도달 → 알림
  if [ "$fails" -ge "$ALERT_THRESHOLD" ]; then
    alert "$label" "$url" "$code" "$fails"
  fi
  return 1
}

log "─── run start ───"
TOTAL=0; FAIL=0
for t in "${TARGETS[@]}"; do
  IFS='|' read -r label url want recover <<< "$t"
  TOTAL=$((TOTAL + 1))
  check_one "$label" "$url" "$want" "$recover" || FAIL=$((FAIL + 1))
done
log "─── run end: $FAIL/$TOTAL failed ───"
exit 0   # systemd timer가 fail로 보지 않도록 항상 0
