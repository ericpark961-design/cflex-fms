# C-Flex 온프레미스 설치 — 컨테이너 프로파일 (WO-INT-005)

기준: `docs/spec/01` §1(네트워크 = 방화벽 요청서 v3), §3.1(컨테이너), §3.2(베어), §3.3(설치기).
대상: RHEL 8.10 (RHEL 9 호환), SELinux Enforcing, firewalld, 인터넷 없음, HAEA Satellite AppStream만.

## 1. 구성

| 호스트 | 컨테이너 (rootless, 사용자 `cflex`) | 호스트에 열리는 포트 |
|---|---|---|
| cap01 (Collector) | `cflex-collector` (cflex/collector) | UDP 162 (trap, FW-2) |
| app01 (Active) | `cflex-web` (nginx) + `cflex-console` (API) + `cflex-redis` (primary) | TCP 443 (FW-5), TCP 6379 (app02에서만, FW-7) |
| app02 (Standby) | `cflex-web` + `cflex-console` + `cflex-redis` (app01의 replica) | TCP 443, TCP 6379 (app01에서만, FW-7) |
| db01 | `cflex-postgres` | TCP 5432 (app01/02에서만, FW-7) |

- 이미지 5개, 전부 Red Hat 베이스: `cflex/collector`·`cflex/app`(ubi8/nodejs-20), `cflex/web`(ubi8/nginx-122),
  `cflex/redis`(rhel8/redis-6), `cflex/postgres`(rhel8/postgresql-16). redis/postgres는 **Red Hat 이미지를 수정 없이** 태그만 붙여 번들에 넣는다.
- 모든 컨테이너: UID 1001(postgres는 이미지 기본 26), `ReadOnly=true`(쓰기는 볼륨과 /tmp tmpfs만), `NoNewPrivileges`,
  `DropCapability=ALL`, `Pull=never`, 로그 journald, HEALTHCHECK. 특권·host network 없음.
- `UserNS=keep-id:uid=1001` — 컨테이너 1001 = 호스트 `cflex`. 볼륨 파일이 호스트에서 `cflex` 소유로 보인다(백업·점검이 쉽다).
- 볼륨(전부 `:Z`): `/opt/app/cflex/{config,certs,secrets,queue,data,redis}` 하위 디렉터리를 컨테이너별로 나눠 마운트한다.
  `:Z`는 컨테이너 전용 라벨이므로 **한 디렉터리를 두 컨테이너가 공유하지 않게** 나눴다. DB: `/opt/data/pgsql`, `/opt/data/backup`.
- 앱 노드의 web·console·redis는 **하나의 네트워크 네임스페이스**를 쓴다. console은 그 안의 `127.0.0.1:8080`에만 붙고,
  nginx만 그것을 부른다. 그래서 호스트 방화벽을 넘는 것은 443과 피어 앱 노드와의 6379뿐이다.
- Redis는 두 앱 노드에 다 있다(Q-2026-10-25-11 (A)). `install.redis_host`(기본 app01)가 primary이고 두 콘솔이 모두 그것을 쓴다.
  다른 노드는 replica로 복제만 한다. primary의 VM이 죽으면 `cflex-install promote --role app`으로 replica를 승격한다
  (수동 — 자동 failover 없음). 절차: `docs/install/REDIS_FAILOVER.md`.
- Collector는 장비 목록을 Local Console에서 받고 telemetry·이벤트를 콘솔로 보낸다(FW-7 cap01 → app 443). `collector.env`의
  `CFLEX_CONSOLE_URL`에 두 앱 노드가 Active 먼저 들어가며, 한쪽에 접속이 안 되면 다른 쪽으로 넘어간다.
  로컬 알림(SMTP·Teams·ServiceNow)은 **콘솔이 보낸다**(Q-2026-10-25-10 (A)). Collector에는 알림 채널이 없다.

### 1.1 Podman 4.9(RHEL 8.10) vs 5.x
Quadlet `.pod` 유닛은 **Podman 5.0부터**다. RHEL 8.10 AppStream의 Podman은 4.9이므로 설치기가 버전을 보고 고른다.

| | Podman ≥ 5 | Podman 4.9 (RHEL 8.10) |
|---|---|---|
| 앱 노드 묶음 | `cflex-app.pod` + 각 `.container`에 `Pod=` | `cflex-web`이 네임스페이스·포트를 소유, console·redis는 `Network=container:cflex-web` + `BindsTo=`, web은 `Wants=`로 다시 띄움 |
| 포트 전달 | `pasta` | `slirp4netns:port_handler=slirp4netns` |

두 방식 모두 **접속한 쪽의 원래 IP를 보존**한다. trap의 출발지 IP가 NMC를 식별하고, 콘솔 감사로그가 사용자 IP를 남기기 때문이다.
Podman 4의 기본(rootlesskit)은 모든 패킷이 10.0.2.2에서 온 것처럼 보이므로 쓰지 않는다.

### 1.2 Node.js 20과 네이티브 모듈(better-sqlite3) — 번들은 NODE_MODULE_VERSION 115 (WO-INT-007)
네이티브 모듈은 `better-sqlite3` 하나다(Collector 버퍼·알람 상태, Local Console 저장소). 바이너리는 **만들 때의 Node ABI에서만** 로드된다.

| | Node | ABI (`process.versions.modules`) |
|---|---|---|
| 컨테이너 `cflex/collector`·`cflex/app` | `ubi8/nodejs-20` | **115** |
| 베어 프로파일 | AppStream `dnf module nodejs:20` | **115** |
| (참고) Node 22 | — | 127 — **번들 바이너리가 로드되지 않는다** |

- 번들의 `app/{collector,console}`(베어용 트리)는 이미지의 `/opt/cflex`를 그대로 복사한 것이다. 그래서 두 프로파일이 **같은 115 바이너리**를 쓴다.
  베어 `preflight`는 nodejs가 **정확히 20**이 아니면 FAIL이다(22가 깔린 호스트에서 트리가 기동 직후 죽지 않도록).
- **prebuild는 쓰지 않고 이미지 안에서 소스 빌드한다.** better-sqlite3가 GitHub에 올리는 linux-x64 prebuild는
  9.6·10.1·11.0·11.10, ABI 115·127 모두 `GLIBC_2.29`를 요구한다. RHEL 8 / UBI8의 glibc는 2.28이므로 받아도 로드되지 않는다
  (2026-10-25 실측). 그래서 Containerfile의 deps 단계가 `npm_config_build_from_source=true`로 node-gyp 빌드를 강제한다.
  `ubi8/nodejs-20` 베이스에는 `make gcc gcc-c++`가 있고, `python3`는 platform-python(3.6)에 링크되어 있다(이미지 history 확인).
  빌드 직후 `require('better-sqlite3')(':memory:')`를 열어 보고, 실패하면 이미지 빌드가 멈춘다.
- `install/build-bundle`은 `podman save` 전에 두 이미지마다 `podman run --network=none --entrypoint node`를 돌린다. 각 트리에서
  better-sqlite3가 로드되는지, `process.versions.modules`가 **115**인지 확인한다. 아니면 번들을 만들지 않는다.
  결과는 `MANIFEST.json`에 남는다: `node: {major: 20, abi: "115"}`, 이미지마다 `node: {version, abi}`.
- 개발 Mac(arm64)의 `npm install`은 Node 20(v115)·22(v127) 모두 darwin prebuild를 받는다(소스 빌드 아님). 이 바이너리는 번들에 들어가지 않는다.
- **미검증(SAT/빌드 호스트):** Podman이 없어 UBI8 안의 node-gyp 빌드를 실제로 돌려 보지 못했다. 특히 RHEL npm에 딸린 node-gyp가
  platform-python 3.6을 받아들이는지는 확인하지 못했다. 이 Mac에서는 `--build-from-source` + Node 20.20.2로 소스 빌드하고 로드까지 확인했다.

## 2. 특권 포트(trap UDP 162, 콘솔 TCP 443) — 설치기 선택 규칙 (§3.1)

rootless 컨테이너는 1024 미만 포트를 직접 열 수 없다. 두 방법 중 설치기가 고른다(`site.yaml` `install.privileged_ports`).

| 모드 | 동작 | 장점 | 단점 |
|---|---|---|---|
| **forward** (기본) | firewalld `forward-port` 162→1162/udp, 443→8443/tcp. 컨테이너는 1162/8443을 연다 | 호스트의 특권 포트 경계를 바꾸지 않는다 | firewalld가 돌아야 한다. 호스트 자신이 보내는 트래픽(localhost→162)은 전달되지 않는다(점검 시 다른 호스트에서 보낼 것) |
| **sysctl** | `/etc/sysctl.d/90-cflex-unprivileged-ports.conf`: `net.ipv4.ip_unprivileged_port_start=161` | firewalld가 없어도 된다 | **호스트 전체**에서 아무 사용자나 161–1023을 열 수 있게 된다 |

- `auto`(기본값): firewalld가 active면 **forward**, 아니면 **sysctl**. 선택 결과는 `preflight`에 표시되고 `state/deployed.json`에 남는다.
- forward를 기본으로 한 이유: HAEA 보안 검토에서 "호스트 커널 파라미터 변경"보다 "방화벽 규칙 1줄"이 설명하기 쉽고 되돌리기 쉽다.
  sysctl은 VM 전체의 보안 경계를 바꾼다.
- forward 모드에서 1162/8443은 **직접 열지 않는다**(전달된 연결은 firewalld의 conntrack 규칙이 받는다). 그래서 `netcheck`에는
  "firewalld 162→1162, 1162 리스닝"으로 표시되고 v3 FW-2/FW-5와 1:1로 맞는다.
- 출발지 제한(`install.user_sources`)이 있으면 zone 전체 forward 대신 **출발지별 rich rule forward-port**를 넣는다
  (zone 전체 forward가 있으면 출발지 제한을 우회한다).
- 베어 프로파일은 이 문제가 없다: systemd 유닛의 `AmbientCapabilities=CAP_NET_BIND_SERVICE`로 162를 직접 연다.

## 3. SELinux
- `setenforce 0` 금지. preflight가 Enforcing이 아니면 WARN(Permissive)/FAIL(Disabled).
- 컨테이너: 모든 볼륨 `:Z`(container_file_t, 컨테이너별 MCS). `container-selinux` 패키지 필수(preflight 검사).
- 베어(앱): nginx → 127.0.0.1:8080, 피어 443 연결에 `setsebool -P httpd_can_network_connect 1`.
- 베어 전용 SELinux 정책 모듈(.pp)은 이 WO에 포함되지 않았다(§3.2 항목, 후속).

## 4. firewalld
설치기는 **v3에 있는 것만** 연다. SSH(FW-6)는 HAEA 기본 이미지 소관이라 건드리지 않는다.

| 역할 | 규칙 (forward 모드) |
|---|---|
| collector | `forward-port port=162:proto=udp:toport=1162` |
| app | `forward-port port=443:proto=tcp:toport=8443` (출발지 지정 시 출발지별 rich rule, 피어 앱 /32 포함) · 두 노드 모두: 피어 /32 → 6379 (복제, 승격 후 역방향) |
| db | app01/32, app02/32 → 5432 |

## 5. 비밀정보
`/opt/app/cflex/secrets/<역할>/` (0700 디렉터리, 0600 파일, 소유 cflex). 값은 설치기 출력·로그에 나오지 않는다.
- `app/redis.pass`, `app/console.key`: Active 노드에서 설치기가 생성. **Standby에는 같은 값을 복사해야 한다**(없으면 설치 중단).
  메일·메신저로 옮기지 말 것.
- `redis/auth.conf`: `requirepass` + `masterauth`(같은 값 — replica가 primary에 인증할 때 쓰고, 승격 후에는 반대쪽이 쓴다).
  Redis는 이 파일을 `include`한다(argv·환경변수에 비밀번호 없음). 두 앱 노드 모두에 생긴다.
- `collector/collector.key`: Local Console의 collector 키. 콘솔에서 `node src/cli.js collector-key cap01`로 발급(한 번만 출력)하고,
  cap01의 `/opt/app/cflex/secrets/collector/collector.key`(0600, cflex)로 옮긴다. 없으면 `verify --role collector`가 FAIL.
  컨테이너: `podman exec -i cflex-console node /opt/cflex/apps/console/src/cli.js collector-key cap01` (app 노드, cflex 사용자).
- `db/pg.pass`, `db/pg-admin.pass`: db01에서 설치기가 생성, Podman secret(`type=env`)으로 컨테이너에 전달.
  **`db/pg.pass`는 app01·app02의 `app/pg.pass`로 같은 값을 복사한다**(콘솔이 db01에 접속하는 비밀번호, app.env `CFLEX_DB_PASSWORD_FILE`).
  없으면 app 설치가 멈춘다. 그래서 순서는 db01 → (복사) → app01 → app02이다(WO-INT-008).
- 인증서: `certs/console.crt|key`(HAEA 내부 CA — 없으면 설치 중단, 스테이징만 `--self-signed-console-cert`),
  `certs/console-ca.pem`(피어 443 검증), `certs/device.pem|key` + `portal-ca.pem`(포털 mTLS, 키는 노드 밖으로 나가지 않음).

## 6. 설치 절차 (요약 MOP)
```
# 0) 번들을 VM에 복사 (RingOn 점프). 체크섬·서명 확인
cd cflex-bundle-<ver> && sha256sum -c SHA256SUMS && gpg --verify SHA256SUMS.asc   # 서명본일 때
# 1) site.yaml, nmc-targets.txt 배치
sudo install -d -m 750 /opt/app/cflex/config
sudo cp config/site.example.yaml /opt/app/cflex/config/site.yaml   # 편집
sudo cp config/nmc-targets.example.txt /opt/app/cflex/config/nmc-targets.txt
# 2) 점검 (네트워크 호출 0건) → 계획 출력
sudo install/cflex-install preflight --role app
sudo install/cflex-install install   --role app            # 계획만 출력, 변경 없음
sudo install/cflex-install install   --role app --yes      # 적용 (멱등)
# 3) 확인
sudo install/cflex-install verify    --role app [--send-test]    # --send-test: 콘솔의 ServiceNow 테스트 티켓 (app 노드에서만)
sudo install/cflex-install netcheck  --role app [--format json]
```
순서: db01 → app01(Active, Redis) → app02 → cap01. 로그: `/opt/app/cflex/log/install-<ts>-<명령>.log`.
`--role`은 역할, 어느 호스트인지는 이 VM의 IP로 `site.yaml`에서 찾는다(`--host-id`로 지정 가능).
rootless `podman load`는 `cflex`가 읽을 수 있어야 하므로 설치기가 이미지 tar를 `/opt/app/cflex/bundles/<ver>/`로 복사한 뒤 체크섬을 다시 확인하고 적재한다.

## 7. netcheck 출력
방향·포트·용도 열은 `install/netmatrix.json`에 §1 표를 **글자 그대로** 옮긴 것이다(정적 테스트가 §1과 대조).
```
| ID | 방향 | 포트 | 용도 | 판정 |
|---|---|---|---|---|
| FW-1 | collector → NMC 41대(부록 B) | UDP 161 | SNMP v3 RO 폴링 (v2c 폴백) | PASS |
| FW-2 | NMC → collector | UDP 162 | trap | PASS |
...
FW-2  PASS listen udp/162   firewalld udp 162→1162, 10.138.14.66:1162 (slirp4netns) 리스닝
FW-4  PASS out tcp/[443]    cflex.fms.support (40.114.79.164) — 연결 1건 (40.114.79.164:443)
## v3에 없는 리스너/연결
EXTRA WARN listen tcp 0.0.0.0:9090 systemd  C-Flex 외 서비스(HAEA 기본 이미지) — 기록용
결과: PASS — PASS 6 · FAIL 0 · WARN 1 · N/A 1
```
- 리스너: `ss -lntup`의 비-loopback 소켓. 아웃바운드: `ss -nt state established` + `site.yaml`의 목적지.
- v3에 없는 것: C-Flex 프로세스(podman/slirp4netns/pasta/node/nginx/redis/postgres)면 **FAIL**, 그 밖(HAEA 기본 서비스)은 **WARN**(기록용).
- UDP 161 폴링은 연결이 없는 소켓이라 관측되지 않는다 → FW-1은 `nmc-targets.txt`의 대수(41)로 판정한다.
- cap01에서 FW-8(SMTP 릴레이, 프록시 → Teams/ServiceNow)은 **N/A "해당 없음 — 로컬 알림은 Local Console(app)이 발송"** 으로 나온다.
  cap01의 프록시 사용은 FW-4(포털)뿐이다. cap01에서 SMTP·ServiceNow 연결이 관측되면 v3 밖(EXTRA FAIL)이다.

## 8. 업그레이드 / 롤백 (§3.3)
```
sudo install/cflex-install upgrade --role app --bundle /path/cflex-bundle-<new> --yes                # app02(Standby) 먼저
sudo install/cflex-install verify  --role app
sudo install/cflex-install upgrade --role app --bundle /path/cflex-bundle-<new> --yes --standby-done # 그다음 app01
sudo install/cflex-install rollback --role app --yes
```
- 이미지 태그만 바꿔 다시 렌더링 → 재시작 → HEALTHCHECK 대기(최대 300초). 실패하면 **자동으로 이전 태그로 되돌린다**(exit 3).
  이전 이미지는 지우지 않으므로 롤백에 번들이 필요 없다.
- Active 노드는 `--standby-done` 없이는 업그레이드를 거부한다.
- DB 스키마: 번들 `db/migrations/`(= 이미지 안 `apps/console/migrations/`)를 **cflex-app이 기동할 때** 적용한다.
  `schema_migrations`에 기록하고, 두 노드에서 advisory lock으로 한 번만 돈다. 마이그레이션은 추가만 하므로
  롤백해도 이전 콘솔이 새 스키마에서 그대로 돈다. 스키마까지 되돌리려면 복구한다(`PG_BACKUP_RESTORE.md` §3).
- **SQLite 콘솔(WO-INT-008 이전)에서 올릴 때 1회:** app01에서
  `podman exec cflex-console node /opt/cflex/apps/console/bin/cflex-migrate-sqlite.js --dry-run`으로 행 수를 확인한다.
  그다음 같은 명령을 `--dry-run` 없이 돌린다(멱등). 상세: `PG_BACKUP_RESTORE.md` §5.

## 9. 번들 빌드 (RingOn, 빌드 호스트)
```
podman login registry.redhat.io        # rhel8/redis-6, rhel8/postgresql-16
install/build-bundle --version 2.0.0 --out /srv/bundles --gpg-key <KEYID> --tar
```
- `git archive <ref>`로 빌드한다(작업 트리의 미추적·수정 파일은 이미지에 들어가지 않는다). 베이스는 다이제스트로 고정해 빌드하고 MANIFEST에 기록.
- `podman build --format docker`: OCI 포맷은 HEALTHCHECK를 버린다. Quadlet 유닛에도 `Health*`를 같이 넣었다.
- 산출물: `MANIFEST.json`, `SHA256SUMS`(+`.asc`), `images/*.tar`(podman save), `app/{collector,console}`(이미지에서 꺼낸 같은 트리 — 베어용),
  `sbom/*.cdx.json`(**스텁**: package.json의 선언 범위 + 베이스 이미지만. 납품 전 syft/cdxgen 등으로 교체), `sbom/VULN-SCAN.txt`(**미수행** 표시),
  `install/`, `config/`, `db/migrations/`(콘솔 스키마 `NNNN_*.sql`, MANIFEST `migrations`에 sha256), `docs/`.
- app 이미지 검사에서는 better-sqlite3와 함께 `require('pg')`도 확인한다(PostgreSQL 드라이버, 순수 JS — 네이티브 빌드 없음).

## 10. 이미지 내부 패치 (§3.1)
RingOn 월 1회 + CVE 발생 시: 베이스 다이제스트 갱신 → `build-bundle` → 서명 → 업그레이드 절차(8장)로 배포. 현장은 `podman load`만 한다(`Pull=never`).

## 11. 알려진 한계 (이 버전)
- 이 저장소의 Mac에는 Podman이 없어 **`podman build`·컨테이너 기동·`podman healthcheck`는 수행하지 않았다**. 첫 UBI8/RHEL 빌드 호스트에서 확인 필요.
- 설치기(Python) 단위 테스트(`python3 -m unittest discover -s install/test`)는 관리자 재실행(WO-INT-005)과 WO-INT-004c에서 통과.
- PostgreSQL(WO-INT-008): 개발 Mac에서는 embedded-postgres(PG 16)로 콘솔 통합 테스트를 했다. 다음은 미확인이다.
  rhel8/postgresql-16 이미지가 `postgresql-cfg/` 조각을 읽는지, 컨테이너 안 `pg_basebackup`이 로컬 소켓으로 replication에 붙는지,
  백업·복구의 실제 실행. 모두 SAT 7 항목이다(`PG_BACKUP_RESTORE.md` §6).
- 읽기 전용 루트에서 rhel8/redis-6·rhel8/postgresql-16의 기동은 미확인(redis는 이미지의 실행 스크립트 대신 `redis-server <conf>`로 띄운다).
  Redis 복제(`replicaof`)·`promote`의 실제 동작도 Podman이 있는 호스트에서 확인 필요(단위 테스트는 명령·파일·상태만 검사).
- trap 리스너 자체는 WO-INT-006. 포트·방화벽·전달은 이 WO에서 준비했다.
- 베어 프로파일의 Redis는 설치기가 설정하지 않는다(AppStream 패키지만 설치). replica·승격은 `REDIS_FAILOVER.md` §5대로 손으로 한다.
- (해결) Collector 장비 목록 pull·로컬 알림 위치·Redis 단일 노드는 WO-INT-004c에서 바뀌었다(위 §1, Q-2026-10-25-10/11).
