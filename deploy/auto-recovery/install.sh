#!/usr/bin/env bash
# 자동복구 인프라 설치 — sudo로 1회만 실행.
#
# 설치 후:
#  - 매 5분 모든 도메인 헬스체크 → 502/000 발견 시 즉시 systemctl restart
#  - 3회 연속 실패 → Teams/SMS 알림
#  - VM reboot 시 boot-recover.service가 모든 백엔드 강제 기동
#  - pm2-cflex.service가 disabled여도 enable + start 보장
#
# 사용:
#   cd cflex-fms/deploy/auto-recovery && sudo bash install.sh
#
# 알림 webhook 설정 (선택):
#   sudo tee /etc/cflex-healthcheck.env <<'EOF'
#   TEAMS_WEBHOOK=https://outlook.office.com/webhook/...
#   SMS_WEBHOOK=https://your-twilio-relay/...
#   EOF

set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "sudo로 실행하세요"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
echo "→ source: $HERE"

# 1) 스크립트 → /usr/local/bin (실행 권한)
install -m 0755 "$HERE/healthcheck.sh"          /usr/local/bin/cflex-healthcheck
install -m 0755 "$HERE/cflex-boot-recover.sh"   /usr/local/bin/cflex-boot-recover
echo "✓ scripts → /usr/local/bin/"

# 2) systemd units → /etc/systemd/system
install -m 0644 "$HERE/cflex-healthcheck.service"    /etc/systemd/system/cflex-healthcheck.service
install -m 0644 "$HERE/cflex-healthcheck.timer"      /etc/systemd/system/cflex-healthcheck.timer
install -m 0644 "$HERE/cflex-boot-recover.service"   /etc/systemd/system/cflex-boot-recover.service
echo "✓ units → /etc/systemd/system/"

# 3) reload + enable + start
systemctl daemon-reload

systemctl enable cflex-healthcheck.timer
systemctl start  cflex-healthcheck.timer
echo "✓ healthcheck timer enabled (5분 간격)"

systemctl enable cflex-boot-recover.service
echo "✓ boot-recover service enabled (다음 reboot 시 자동)"

# 4) pm2-cflex.service가 있으면 enable (현재 disabled 상태일 가능성 큼 — 그게 root cause)
if systemctl list-unit-files pm2-cflex.service >/dev/null 2>&1; then
  if ! systemctl is-enabled --quiet pm2-cflex; then
    systemctl enable pm2-cflex
    echo "✓ pm2-cflex.service ENABLED (was disabled — reboot 후 자동기동 안 되던 root cause)"
  else
    echo "  pm2-cflex.service already enabled"
  fi
fi

# 5) 첫 실행 — 지금 죽어 있는 거 즉시 살리기
echo ""
echo "→ 즉시 헬스체크 1회 (현재 다운된 서비스 자동복구 시도)…"
/usr/local/bin/cflex-healthcheck
echo ""
echo "로그: tail -f /var/log/cflex-healthcheck.log"
echo ""
echo "검증:"
echo "  systemctl status cflex-healthcheck.timer  # 활성 + 다음 실행 시각"
echo "  systemctl list-timers cflex-healthcheck   # 5분 간격 확인"
echo "  cat /var/log/cflex-healthcheck.log         # 점검 이력"
echo ""
echo "수동 점검:"
echo "  sudo /usr/local/bin/cflex-healthcheck"
echo ""
echo "Reboot 시뮬레이션 (실제 reboot 없이):"
echo "  sudo /usr/local/bin/cflex-boot-recover"
