# Probe 개발 호스트 배치안 — 기존 서비스 보존

- 작성 2026-10-25 · Claude Code (내부 Probe) · 조사 방식 **읽기전용 SSH**
- 대상: `fms.runless.co.uk` = `172.172.161.236` = `vm-cflex-probe-01` (Azure, Ubuntu 24.04.4, 131일 가동)
- 용도 구분: **이 호스트는 Probe 개발 측 주소다.** 원격 플랫폼 수신 주소는
  `https://cflex.fms.support`(Codex 담당)이며 혼용하지 않는다.

> nginx 전체 출력은 비밀값을 담을 수 있으므로 공유하지 않았다. 아래는 구조만
> 추출한 것이다 — `server_name` / `listen` / `location` / `proxy_pass` / 파일 배치.

---

## 1. 현재 무엇이 돌고 있는가

### 1.1 프로세스 (pm2, 사용자 `ringon`, 유닛 `pm2-ringon.service`)

| id | 이름 | 스크립트 | 포트 | 가동 |
|---|---|---|---|---|
| 2 | `cflex-fms-api` | `/opt/cflex-fms/backend/src/server.js` | **3000** | 43일 |
| 3 | `cflex-sentinel-api` | `/opt/cflex-sentinel-api/server.js` | **4000** | 43일 |
| 1 | `runless-uc` | `/home/ringon/runless-uc/server.js` | **3100** | 43일 |
| 0 | `snow-demo` | `/home/ringon/snow-demo/snow-server.js` | **8080** | 43일 |

`cflex-anti-miner` · `cflex-fms-watchdog` · `cflex-threat-scan` 유닛은 존재하나
**inactive(dead)** 다. (2026-05 채굴기 침해 때 넣은 워치독 — 지금 꺼져 있다는 사실만
기록한다. 켜는 것은 이 작업 범위가 아니다.)

### 1.2 nginx — vhost 2개가 **한 호스트를 공유**

`sites-enabled/cflex-fms` → `fms.runless.co.uk`, `172.172.161.236`, `_`(기본)

| location | 대상 |
|---|---|
| `= /` | `302 → /fms` |
| `/` | static `root /opt/cflex-fms/frontend-dist` |
| `^~ /twin/`, `^~ /twin/assets/` | `alias /opt/cflex-fms/twin-dist/…` |
| `/v1/` | **`proxy_pass https://cflex.runless.co.uk`** ← 구 클라우드로 프록시 |
| `/.well-known/acme-challenge/` | certbot |
| `= /sw.js`, `~* \.(html\|json)$`, `/assets/` | 캐시 헤더 |

`sites-enabled/sentinel-runless` → `sentinel.runless.co.uk`

| location | 대상 |
|---|---|
| `/v1/agent/` | `http://127.0.0.1:4000` |
| `/v1/` | `proxy_pass https://cflex.runless.co.uk` |
| `/assets/` | static `/opt/cflex-fms/frontend-dist` |

**이것이 `/healthz` 가 HTML 을 돌려준 이유다.** `location /` 가 SPA 를 서브하므로
모르는 경로는 전부 `index.html` 로 떨어진다. `apps/console` 은 이 호스트에 **없다.**

### 1.3 데이터·인증·용량

| | |
|---|---|
| 저장소 | **SQLite만.** `/opt/cflex-fms/data/fms.db`, `/opt/cflex-sentinel-api/data/sentinel.db` |
| PostgreSQL | **미설치·미가동** |
| Redis | **미설치** (`redis-server` 없음) |
| 인증서 | certbot: `fms.runless.co.uk`, `sentinel.runless.co.uk` |
| node | v20.20.2 (시스템·`ringon` 동일) — `apps/console` 요구 ≥20 충족 |
| 디스크 | `/` 29 G, 11 G 사용, **18 G 여유** |
| 로컬 방화벽 | `ufw inactive`, iptables 규칙 5개(도커/LXD 기본). **포트 차단은 Azure NSG 가 한다** |
| 잔존물 | `/opt/_wiped_1780874999*`, `/opt/_wiped_1780875071-cflex` — 2026-05 정리 흔적. 건드리지 않는다 |

---

## 2. 배치안 — 전부 **추가**, 기존 파일 무수정

원칙 세 가지:

1. **기존 파일을 고치지 않는다.** `sites-available/cflex-fms` 와
   `sites-available/sentinel-runless` 는 열지 않는다. `conf.d/` 가 비어 있으므로
   거기에 새 파일을 하나 넣는다 (`nginx.conf` 가 `conf.d/*.conf` 를 include 한다).
2. **포트를 새로 쓴다.** 3000·3100·4000·8080·443·80 을 건드리지 않는다.
3. **pm2 를 쓰되 기존 4개를 재시작하지 않는다.** `pm2 start` 로 5번째만 올린다.

### 2.1 추가하는 것

| 항목 | 값 | 비고 |
|---|---|---|
| 콘솔 프로세스 | `cflex-console`, **`127.0.0.1:3300`** | 루프백만. nginx 가 앞에 선다 |
| 코드 위치 | `/opt/cflex-console/` | `/opt/cflex-fms` 와 **분리**. 기존 트리 안에 넣지 않는다 |
| 세션 저장소 | `redis-server`, **`127.0.0.1:6379`** | apt 설치. 콘솔이 요구함 |
| DB | `/opt/cflex-console/data/console.db` (SQLite) | 기존 `fms.db` 와 **다른 파일** |
| 비밀키 | `/opt/cflex-console/secret.key` 0600 | 32바이트. git 에 올리지 않는다 |
| 외부 노출 | **`listen 8443 ssl`**, `server_name fms.runless.co.uk` | 기존 인증서 재사용 |
| nginx 파일 | `/etc/nginx/conf.d/cflex-console.conf` (신규) | 기존 vhost 파일 무수정 |

### 2.2 왜 8443 인가 — 선택지 셋 중

| 안 | 장점 | 문제 |
|---|---|---|
| (A) 기존 `fms.runless.co.uk` 에 `location /console/` 추가 | DNS·인증서 불필요 | **기존 vhost 파일을 수정한다.** 운영 중 사이트를 건드리고, 되돌릴 때도 그 파일을 다시 만져야 한다 |
| (B) 새 이름 `probe-console.runless.co.uk` + 새 인증서 | 가장 깔끔 | DNS 레코드 + certbot 발급 필요 → 외부 의존, 당장 못 한다 |
| **(C) 같은 이름, 새 포트 8443** ← **권고** | 기존 파일·DNS·인증서 그대로. 추가 파일 1개, 복구는 삭제 | **Azure NSG 에 8443 인바운드 1개 필요** |

(C) 를 고른 이유: 기존 서비스를 **한 바이트도 고치지 않는다.** 복구가 "파일 지우고
reload" 로 끝난다. NSG 규칙 1개는 제가 못 하는 일이므로 승인 요청으로 남긴다 —
그게 유일한 외부 의존이다.

NSG 가 거절되면 **차선은 (A)** 가 아니라 **SSH 터널**이다: `ssh -L 8443:127.0.0.1:3300`
로 운영자만 접속. 개발 환경이므로 그걸로도 충분하고, 기존 사이트는 여전히 무수정이다.

### 2.3 nginx 추가 파일 (`/etc/nginx/conf.d/cflex-console.conf`)

```nginx
# Probe 등록 콘솔. 기존 fms.runless.co.uk / sentinel.runless.co.uk vhost 를
# 수정하지 않는다 — 별도 포트의 별도 server 블록이다.
server {
    listen 8443 ssl;
    listen [::]:8443 ssl;
    server_name fms.runless.co.uk 172.172.161.236;

    # 기존 certbot 인증서 재사용. 갱신은 기존 certbot 훅이 그대로 처리한다.
    ssl_certificate     /etc/letsencrypt/live/fms.runless.co.uk/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fms.runless.co.uk/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # 콘솔은 등록 토큰·collector key 를 다룬다. 로그에 쿼리스트링을 남기지 않는다.
    access_log /var/log/nginx/cflex-console.access.log;
    error_log  /var/log/nginx/cflex-console.error.log warn;

    client_max_body_size 2m;      # 인증서 PEM 붙여넣기면 충분하다

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For   $remote_addr;
        # 클라이언트가 보낸 신뢰 헤더를 그대로 넘기지 않는다.
        proxy_set_header X-Collector-Key   "";
    }
}
```

### 2.4 설치 순서 (각 단계가 되돌릴 수 있어야 한다)

```
0. 백업        sudo tar czf /root/preinstall-$(date +%s).tgz \
                 /etc/nginx/sites-available /etc/nginx/conf.d \
                 /etc/nginx/nginx.conf
               sudo -u ringon pm2 save            # 기존 4개 프로세스 목록
               sha256sum /opt/cflex-fms/data/fms.db > /root/fms.db.sha256

1. redis       sudo apt-get install -y redis-server
               # bind 127.0.0.1 확인, protected-mode yes 유지
               sudo systemctl enable --now redis-server

2. 코드        sudo mkdir -p /opt/cflex-console && sudo chown ringon: /opt/cflex-console
               # apps/console 을 거기로 배치 (rsync 또는 번들)
               # 의존성: better-sqlite3 는 optional — 없으면 node:sqlite 로 떨어진다

3. 비밀키      head -c 32 /dev/urandom | xxd -p -c 32 > /opt/cflex-console/secret.key
               chmod 600 /opt/cflex-console/secret.key

4. 기동        sudo -u ringon pm2 start /opt/cflex-console/src/server.js \
                 --name cflex-console --cwd /opt/cflex-console
               sudo -u ringon pm2 save
               # 3300 에서 /healthz 가 JSON 을 돌려주는지 확인

5. nginx       sudo cp cflex-console.conf /etc/nginx/conf.d/
               sudo nginx -t            # ← 통과 못 하면 여기서 중단, 파일 삭제
               sudo systemctl reload nginx

6. 회귀        기존 사이트가 그대로인지 먼저 확인한다:
                 curl -sI https://fms.runless.co.uk/        → 302 /fms
                 curl -s  https://fms.runless.co.uk/fms     → SPA
                 curl -sI https://sentinel.runless.co.uk/   → 기존대로
               그 다음 콘솔:
                 curl -sk https://127.0.0.1:8443/healthz    → JSON

7. NSG         8443 인바운드 1개 — 승인 필요. 거절 시 SSH 터널로 대체.
```

### 2.5 환경 변수 (콘솔)

`/opt/cflex-console/.env`, 0600, **git 에 올리지 않는다**:

```
CONSOLE_PROFILE=internal              # origin/main WO-INT-004c (Q-09 B)
CONSOLE_PORT=3300
CONSOLE_BIND=127.0.0.1                # nginx 가 앞에 선다
CONSOLE_DB_PATH=/opt/cflex-console/data/console.db
CONSOLE_SECRET_KEY_FILE=/opt/cflex-console/secret.key
REDIS_URL=redis://127.0.0.1:6379
CONSOLE_COOKIE_SECURE=1
CONSOLE_TENANT=HAEA
```

> `CFLEX_CONSOLE_URL` 은 **collector 가 이 콘솔을 찾는 주소**이고
> `CFLEX_PORTAL_URL`(`https://cflex.fms.support`)은 **원격 플랫폼 수신 주소**다.
> 용도가 다르므로 설정을 섞지 않는다. 이 호스트에서 collector 와 콘솔이 같이
> 돌면 `CFLEX_CONSOLE_URL=http://127.0.0.1:3300` 이고, 평문이 허용되는 것은
> 루프백이기 때문이다(그 외 평문은 transport 가 거부한다).

---

## 3. 복구 절차

추가만 했으므로 복구는 **삭제**다. 기존 파일을 고치지 않았으니 되돌릴 것이 없다.

```
1. sudo rm /etc/nginx/conf.d/cflex-console.conf
2. sudo nginx -t && sudo systemctl reload nginx
3. sudo -u ringon pm2 delete cflex-console && sudo -u ringon pm2 save
4. (선택) sudo systemctl disable --now redis-server
5. (선택) sudo rm -rf /opt/cflex-console        # 데이터까지 지울 때만
6. 확인:  기존 4개 pm2 프로세스 online, 두 사이트 응답 정상,
          sha256sum -c /root/fms.db.sha256
```

`nginx -t` 가 5단계에서 실패하면 그 자리에서 파일만 지우고 reload 한다 — 기존
설정이 로드된 상태가 유지되므로 서비스 중단이 없다.

최악의 경우 0단계 백업으로 `/etc/nginx` 를 통째로 되돌린다. 기존 pm2 목록은
`pm2 resurrect` 로 복원된다.

---

## 4. 개발 배치와 고객망 설치의 구분

| | Azure Probe 개발 배치 (이 문서) | 현대 내부망 설치 |
|---|---|---|
| 호스트 | `vm-cflex-probe-01` (Ubuntu 24.04, 공인 IP) | `haeipfms{cap01,app01,app02,db01}v` (RHEL 8.10, 사설) |
| 설치 방식 | pm2 + nginx conf.d 추가 | `cflex-install --role --profile container\|bare` (WO-INT-005) |
| 컨테이너 | 없음 (pm2 직접) | **Podman + Quadlet, UBI8** (D-03) |
| 저장소 | SQLite | **PostgreSQL 16** (WO-INT-008, 미구현) |
| 세션 | Redis 단일 | Redis + app02 replica (Q-11 A) |
| 인증서 | certbot 공인 | HAEA 내부 CA |
| 인터넷 | 있음 | **없음.** Satellite AppStream 만 |
| 노출 | 8443 + NSG 1개 | 사용자 VLAN/VPN → app 443 |
| 목적 | **등록·mTLS·heartbeat 경로 시험** | 운영 |

이 배치안은 **개발 시험용이다.** 여기서 통과한 것이 고객망에서 통과한다는 뜻이
아니다 — 컨테이너·PostgreSQL·오프라인·SELinux 가 전부 다르다. 고객망 설치는
`cflex-install` 이 담당하고 그 검증은 SAT 항목이다 (`docs/spec/01` §5).

---

## 5. 이 조사로 확인된 제약

| # | 사실 | 영향 |
|---|---|---|
| 1 | Redis 미설치 | 콘솔 세션 저장소. apt 설치가 전제 조건 |
| 2 | PostgreSQL 미설치, SQLite만 | 개발 배치는 SQLite 로 간다. WO-INT-008 과 무관하게 진행 가능 |
| 3 | `sentinel.runless.co.uk` 가 같은 호스트 | nginx reload 가 그쪽에도 영향. 회귀 확인에 포함함 |
| 4 | `/v1/` 이 `cflex.runless.co.uk` 로 프록시 | **구 클라우드 경로가 살아 있다.** 콘솔은 별도 포트이므로 충돌하지 않지만, `CFLEX_LEGACY_FORWARD` 와 혼동하지 않도록 기록 |
| 5 | 워치독 3개 inactive | 2026-05 침해 후 넣은 것이 꺼져 있다. 범위 외지만 보고한다 |
| 6 | 디스크 18 G 여유 | 콘솔 + Redis 에 충분 |
| 7 | Azure NSG 8443 | **유일한 외부 의존.** 승인 전까지 SSH 터널로 진행 |
