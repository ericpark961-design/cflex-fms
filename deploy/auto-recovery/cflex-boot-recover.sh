#!/usr/bin/env bash
# VM 부팅 직후 1회 — 모든 백엔드/pm2 강제 기동.
# disabled 상태의 pm2-cflex.service도 enable 후 start. 멱등.
#
# 핵심 원칙: "VM이 죽었다 살아도 모든 서비스가 자동으로 올라온다."
# /etc/systemd/system/cflex-boot-recover.service 가 multi-user.target에 wire됨.

set -u
LOG=/var/log/cflex-boot-recover.log
exec >> "$LOG" 2>&1
echo "═══ boot-recover $(date '+%F %T') ═══"

# 1) systemd 등록된 메인 서비스들 — start + enable
SERVICES=(
  nginx
  postgresql            # cflex DB
  stock-sentinel        # FastAPI on this VM
  pm2-cflex             # cflex-api / cflex-shell / dev-cflex-api 컨테이너
)

for svc in "${SERVICES[@]}"; do
  if systemctl list-unit-files "${svc}.service" >/dev/null 2>&1; then
    if ! systemctl is-enabled --quiet "$svc"; then
      echo "[$svc] enable (was disabled)"
      systemctl enable "$svc" 2>&1 | sed 's/^/  /'
    fi
    if ! systemctl is-active --quiet "$svc"; then
      echo "[$svc] start (was inactive)"
      systemctl start "$svc" 2>&1 | sed 's/^/  /'
    else
      echo "[$svc] already running"
    fi
  else
    echo "[$svc] not installed — skip"
  fi
done

# 2) pm2 saved process list 재기동
if id cflex >/dev/null 2>&1; then
  echo "[pm2-cflex] resurrect saved processes"
  sudo -u cflex bash -lc 'pm2 resurrect 2>&1' | sed 's/^/  /' || echo "  (resurrect 실패 — pm2 list 비어있을 수 있음)"
fi

# 3) 부팅 직후 헬스체크 1회 (timer는 60초 뒤 자동 실행)
if [ -x /usr/local/bin/cflex-healthcheck ]; then
  echo "[healthcheck] first run"
  /usr/local/bin/cflex-healthcheck
fi

echo "═══ done ═══"
