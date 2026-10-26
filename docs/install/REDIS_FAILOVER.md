# Local Console 세션 저장소(Redis) — replica와 승격 운영 절차 (WO-INT-004c)

근거: DECISIONS Q-2026-10-25-11 → **(A)** app02에 Redis replica(6379, 방화벽 요청서 v3 FW-7 범위),
승격은 `cflex-install promote --role app` **수동** 명령. 자동 failover는 넣지 않는다 — 노드가 둘뿐이고 제3의 판정자가 없어,
자동으로 하면 네트워크가 갈라졌을 때 양쪽이 모두 primary가 된다(split brain).

Redis에는 **콘솔 로그인 세션과 로그인 실패 카운터**만 있다. 장비·알람·설정은 DB에 있다(SQLite → WO-INT-008에서 PostgreSQL).
그래서 Redis를 잃어도 데이터 손실은 없고, 잃는 것은 "로그인 상태"다. replica의 목적은 app01 VM이 죽어도
**사용자가 다시 로그인하지 않고** app02로 계속 쓰게 하는 것이다(SAT 6).

## 1. 평상시 구성

| | app01 (`install.redis_host`, 기본 Active) | app02 |
|---|---|---|
| Redis | **primary** | **replica** (`replicaof app01 6379`, 읽기 전용) |
| 콘솔이 쓰는 Redis | 자기 것(127.0.0.1) | app01의 것(10.138.14.67:6379) |
| 6379 방화벽 | app02 /32에서만 | app01 /32에서만(승격 후 app01이 replica로 붙을 때 씀) |

- 비밀번호: 두 노드 모두 `/opt/app/cflex/secrets/redis/auth.conf`에 `requirepass`와 `masterauth`(같은 값, `app/redis.pass`).
  설정 파일·argv·로그에는 나오지 않는다.
- 확인: `sudo install/cflex-install verify --role app`
  - app01: `redis replication  PASS  primary, 1 replica(s) connected`
  - app02: `redis replication  PASS  replica of app01, link up, last sync 0s ago`
  - app01에서 replica 0개면 WARN(app02가 꺼져 있거나 아직 설치 전).

## 2. app01 VM 장애 → app02 승격 (SAT 6)

증상: app02로 접속해도 `503 session_store_unavailable`(app02 콘솔이 app01의 Redis를 못 씀). Collector는 이미 app02로
넘어가 있다(`CFLEX_CONSOLE_URL`의 두 번째 주소) — 수집·알림은 끊기지 않지만 사용자 로그인이 안 된다.

```
# app02에서 (root)
sudo install/cflex-install promote --role app            # 계획만 출력, 변경 없음
sudo install/cflex-install promote --role app --yes      # 적용
sudo install/cflex-install verify  --role app            # redis replication: "this node was promoted" WARN = 정상(아래 3절 전)
```

`promote`가 하는 일(계획 출력과 같다):
1. app01의 6379가 **아직 응답하면 거부**한다(primary가 둘이 되는 것을 막는다). app01이 살아 있지만 고장이 확실할 때만 `--force`.
2. app02 Redis에 `REPLICAOF NO ONE` — 복제받은 세션을 그대로 가진 채 primary가 된다.
3. app02의 `redis.conf`(replicaof 없음)와 `app.env`(`REDIS_URL=redis://127.0.0.1:6379/0`)를 다시 렌더링한다 — 재시작해도 primary로 남는다.
4. `cflex-console`만 재시작한다(Redis는 재시작하지 않는다).
5. `/opt/app/cflex/state/deployed.json`에 승격을 기록한다. 이후 `install`/`upgrade`/`rollback`은 3절이 끝날 때까지 **거부**한다
   (그대로 두면 app02를 다시 app01의 replica로 렌더링해, app01이 돌아왔을 때 지금 세션을 지우고 옛 세션을 복사하게 된다).

결과: 장애 전에 로그인한 사용자는 app02 주소로 **다시 로그인 없이** 계속 쓴다. 장애 직전 몇 초 안에 만든 세션은
복제가 안 됐을 수 있다(`last sync`에 표시) — 그 사용자만 다시 로그인한다.

### SAT 6 판정 절차
1. 관리자 계정으로 app01에 로그인, `/twin/` 화면 확인. 같은 쿠키로 app02(`https://10.138.14.68/twin/`)도 열리는지 확인.
2. app01 **VM 정지**(하이퍼바이저에서 전원 끄기 — 컨테이너만 멈추는 것이 아니다).
3. app02에서 화면 새로고침 → `503`(세션 저장소 없음)을 확인 — 승격 전 상태.
4. app02에서 `cflex-install promote --role app --yes`.
5. app02 새로고침 → **로그인 화면 없이** 대시보드가 열리면 통과. 알람 목록·ACK가 되는지, Collector의 telemetry가
   계속 들어오는지(`/v1/console/status`의 collector `last_seen`) 확인.
6. 결과·시각을 SAT 기록에 남긴다(승격에 걸린 시간 포함).

## 3. 승격 후 정리 — site.yaml

승격은 app02 한 대에만 기록된다. `site.yaml`(네 VM 모두 같은 파일)을 맞춰야 한다:

```yaml
install:
  redis_host: app02
```

1. 네 VM의 `/opt/app/cflex/config/site.yaml`에서 `install.redis_host: app02`로 바꾼다.
2. **app01을 다시 켜기 전에** 위를 마친다. app01은 부팅하면 예전 설정대로 primary로 뜨고, 콘솔이 자기 Redis(오래된 세션)를 쓴다.
   app01을 켠 직후, 사용자가 app01로 들어오기 전에:
   ```
   # app01에서 (root) — 같은 번들
   sudo install/cflex-install install --role app --bundle <현재 번들> --yes
   ```
   app01이 app02의 replica로 렌더링되고 재시작된다(app01의 옛 세션은 버려지고 app02에서 전체 복제).
3. app02에서 `install`/`upgrade`를 한 번 돌리면(또는 다음 업그레이드 때) 승격 기록이 정리된다 — `site.yaml`이 이제 같은 말을 한다.
4. `verify --role app` 양쪽: app02 `primary, 1 replica(s) connected`, app01 `replica of app02, link up`.

사용자에게는 app01이 돌아올 때까지 app02 주소를 안내한다(VIP는 HAEA 회신 대기 — spec 01 §6-2).

## 4. 원래대로(app01을 primary로) 되돌리기 — 선택

급하지 않다. 유지보수 창에서:
1. app02가 primary, app01이 replica로 `link up`인지 `verify`로 확인.
2. app02의 콘솔 사용을 멈춘다(유지보수 공지). app01에서 `cflex-install promote --role app --force --yes`
   (app02가 아직 응답하므로 `--force`가 필요하다 — 이 경우는 의도된 전환이다).
3. 네 VM의 `site.yaml`을 `install.redis_host: app01`로 되돌린다.
4. app02에서 `cflex-install install --role app --bundle <현재 번들> --yes` → app02가 다시 replica가 된다.
5. app01에서 `install`(또는 다음 업그레이드)로 승격 기록 정리. 양쪽 `verify`.

## 5. 베어 프로파일

베어 프로파일의 Redis는 AppStream `redis:6` 패키지로 설치만 되고, 설정은 설치기가 하지 않는다(WO-INT-005 범위).
같은 구성을 손으로 만든다:
- 두 노드 `/etc/redis.conf`: `bind 0.0.0.0`, `protected-mode yes`, `include /opt/app/cflex/secrets/redis/auth.conf`.
- replica 노드에만 `replicaof <primary IP> 6379`, `replica-read-only yes`.
- 승격: `REDISCLI_AUTH="$(sed -n 's/^requirepass //p' /opt/app/cflex/secrets/redis/auth.conf)" redis-cli REPLICAOF NO ONE`,
  `/etc/redis.conf`에서 `replicaof` 줄 삭제, `/opt/app/cflex/config/app/app.env`의 `REDIS_URL`을 127.0.0.1로, `systemctl restart cflex-app`.
- `cflex-install promote`는 베어에서 이 절을 안내하고 아무것도 바꾸지 않는다.

## 6. 하지 않는 것
- 자동 failover(Sentinel, keepalived 스크립트 등) — 위 이유. VIP(keepalived)는 HAEA 회신 뒤 별도 결정(spec §6-2).
- Redis를 db01에 두기 — v3에 app → db 6379가 없다(Q-2026-10-25-11 (C) 기각).
- 세션 영속화(appendonly) — 세션은 12시간 한도이고, 복제가 이미 VM 장애를 넘긴다. RDB 스냅숏(`save 900 1`)만 둔다.
