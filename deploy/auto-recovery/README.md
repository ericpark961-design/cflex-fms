# 자동복구 인프라 — "VM이 죽었다 살아도 모든 서비스가 정상으로 올라온다"

## 문제 (2026-06-18 시점)
- 5월 채굴기 침해 청소 + Azure VM 재기동 후 `cflex-api`/`cflex-shell`/`dev-cflex-api`가 자동 기동 안 됨
- `pm2-cflex.service`가 `disabled` 상태라 reboot 후 pm2 자체가 안 올라옴 → 모든 cflex 도메인 502
- `stock-sentinel.service`는 systemd `.service`로 등록 + enabled라 살아남음 ← 이 패턴이 정답

## 설계 — 3겹 안전망

### 1겹: pm2-cflex.service `enabled` (즉시)
- root cause 직접 해결
- `install.sh`가 자동 처리

### 2겹: `cflex-boot-recover.service` (oneshot, reboot마다)
- VM 부팅 → nginx + postgres 올라오면 → 모든 등록된 서비스 강제 `start`
- `pm2 resurrect`로 saved process list 복구
- 부팅 직후 헬스체크 1회

### 3겹: `cflex-healthcheck.timer` (매 5분)
- 모든 도메인 HTTP 응답 확인
- 502/000/timeout → 즉시 `systemctl restart <대응 서비스>`
- 3회 연속 실패 → Teams/SMS 알림 (webhook 설정 시)
- 복구되면 자동 카운터 리셋

## 점검 대상 (`healthcheck.sh` 안)
| 라벨 | URL | 기대 | 복구 명령 |
|---|---|---|---|
| stock-api | `/v1/me` | 401 | `systemctl restart stock-sentinel` |
| stock-static | `/app/` | 200 | `systemctl restart stock-sentinel` |
| cflex-api | `/v1/health` | 200 | `systemctl restart pm2-cflex` |
| cflex-static | `/` | 200 | `systemctl reload nginx` |
| dev-cflex-api | `/v1/health` | 200 | `systemctl restart pm2-cflex` |
| fms-static | `/` | 302 | `systemctl reload nginx` |
| sentinel-static | `/` | 302 | `systemctl reload nginx` |
| ringonservice-net | `/` | 200 | `systemctl reload nginx` |

새 도메인 추가는 `healthcheck.sh`의 `TARGETS=()` 배열에 한 줄 추가만.

## 설치

```bash
# VM에 sync
rsync -avz auto-recovery/ azureuser@20.25.17.81:/tmp/auto-recovery/
ssh azureuser@20.25.17.81

# 적용
cd /tmp/auto-recovery && sudo bash install.sh
```

설치 후 즉시:
- 죽어 있던 백엔드 1회 자동복구 시도
- 매 5분 헬스체크 시작
- 다음 reboot 시 boot-recover.service가 모든 백엔드 강제 기동

## 알림 webhook (선택)

```bash
sudo tee /etc/cflex-healthcheck.env <<'EOF'
TEAMS_WEBHOOK=https://outlook.office.com/webhook/...
SMS_WEBHOOK=https://ringonservice.net/webhook/sms-relay
EOF
```

알림 임계치: 3회 연속 실패 (`ALERT_THRESHOLD=3`). 한 도메인이 정확히 5분×3 = 15분 다운 시 알림.

## 검증

```bash
# timer 활성 확인
systemctl status cflex-healthcheck.timer
systemctl list-timers cflex-healthcheck

# boot-recover enabled 확인
systemctl is-enabled cflex-boot-recover

# 로그
tail -f /var/log/cflex-healthcheck.log
tail -f /var/log/cflex-boot-recover.log

# 수동 점검
sudo /usr/local/bin/cflex-healthcheck

# reboot 없이 boot-recover 시뮬
sudo /usr/local/bin/cflex-boot-recover
```

## 향후

- VM1 (172.172.161.236, fms/sentinel standalone backend) 에도 같은 인프라 적용 — `healthcheck.sh` 그대로 + 점검 대상만 VM1 로컬 포트로 교체
- 알림에 어떤 서비스가, 몇 분 동안, 몇 번 실패했는지 상세 포함
- 매일 09:00 KST 헬스 요약 리포트 (어제 다운타임 합계)
