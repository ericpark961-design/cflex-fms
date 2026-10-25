# C-Flex 온프레미스 설치 — 컨테이너 프로파일 (WO-INT-005)

기준: `docs/spec/01` §1(네트워크 = 방화벽 요청서 v3), §3.1(컨테이너), §3.2(베어), §3.3(설치기).
대상: RHEL 8.10 (RHEL 9 호환), SELinux Enforcing, firewalld, 인터넷 없음, HAEA Satellite AppStream만.

## 1. 구성

| 호스트 | 컨테이너 (rootless, 사용자 `cflex`) | 호스트에 열리는 포트 |
|---|---|---|
| cap01 (Collector) | `cflex-collector` (cflex/collector) | UDP 162 (trap, FW-2) |
| app01 (Active) | `cflex-web` (nginx) + `cflex-console` (API) + `cflex-redis` | TCP 443 (FW-5), TCP 6379 (app02에서만, FW-7) |
| app02 (Standby) | `cflex-web` + `cflex-console` | TCP 443 |
| db01 | `cflex-postgres` | TCP 5432 (app01/02에서만, FW-7) |

- 이미지 5개, 전부 Red Hat 베이스: `cflex/collector`·`cflex/app`(ubi8/nodejs-20), `cflex/web`(ubi8/nginx-122),
  `cflex/redis`(rhel8/redis-6), `cflex/postgres`(rhel8/postgresql-16). redis/postgres는 **Red Hat 이미지를 수정 없이** 태그만 붙여 번들에 넣는다.
- 모든 컨테이너: UID 1001(postgres는 이미지 기본 26), `ReadOnly=true`(쓰기는 볼륨과 /tmp tmpfs만), `NoNewPrivileges`,
  `DropCapability=ALL`, `Pull=never`, 로그 journald, HEALTHCHECK. 특권·host network 없음.
- `UserNS=keep-id:uid=1001` — 컨테이너 1001 = 호스트 `cflex`. 볼륨 파일이 호스트에서 `cflex` 소유로 보인다(백업·점검이 쉽다).
- 볼륨(전부 `:Z`): `/opt/app/cflex/{config,certs,secrets,queue,data,redis}` 하위 디렉터리를 컨테이너별로 나눠 마운트한다.
  `:Z`는 컨테이너 전용 라벨이므로 **한 디렉터리를 두 컨테이너가 공유하지 않게** 나눴다. DB: `/opt/data/pgsql`, `/opt/data/backup`.
- 앱 노드의 web·console·redis는 **하나의 네트워크 네임스페이스**를 쓴다. console은 그 안의 `127.0.0.1:8080`에만 붙고,
  nginx만 그것을 부른다. 그래서 호스트 방화벽을 넘는 것은 443(과 Redis 노드의 6379)뿐이다.

### 1.1 Podman 4.9(RHEL 8.10) vs 5.x
Quadlet `.pod` 유닛은 **Podman 5.0부터**다. RHEL 8.10 AppStream의 Podman은 4.9이므로 설치기가 버전을 보고 고른다.

| | Podman ≥ 5 | Podman 4.9 (RHEL 8.10) |
|---|---|---|
| 앱 노드 묶음 | `cflex-app.pod` + 각 `.container`에 `Pod=` | `cflex-web`이 네임스페이스·포트를 소유, console·redis는 `Network=container:cflex-web` + `BindsTo=`, web은 `Wants=`로 다시 띄움 |
| 포트 전달 | `pasta` | `slirp4netns:port_handler=slirp4netns` |

두 방식 모두 **접속한 쪽의 원래 IP를 보존**한다. trap의 출발지 IP가 NMC를 식별하고, 콘솔 감사로그가 사용자 IP를 남기기 때문이다.
Podman 4의 기본(rootlesskit)은 모든 패킷이 10.0.2.2에서 온 것처럼 보이므로 쓰지 않는다.

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
| app | `forward-port port=443:proto=tcp:toport=8443` (출발지 지정 시 출발지별 rich rule, 피어 앱 /32 포함) · Redis 노드: 피어 /32 → 6379 |
| db | app01/32, app02/32 → 5432 |

## 5. 비밀정보
`/opt/app/cflex/secrets/<역할>/` (0700 디렉터리, 0600 파일, 소유 cflex). 값은 설치기 출력·로그에 나오지 않는다.
- `app/redis.pass`, `app/console.key`: Active 노드에서 설치기가 생성. **Standby에는 같은 값을 복사해야 한다**(없으면 설치 중단).
  메일·메신저로 옮기지 말 것.
- `redis/auth.conf`: `requirepass`. Redis는 이 파일을 `include`한다(argv·환경변수에 비밀번호 없음).
- `db/pg.pass`, `db/pg-admin.pass`: Podman secret(`type=env`)으로 컨테이너에 전달.
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
sudo install/cflex-install verify    --role app [--send-test]
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
- DB 마이그레이션 훅은 자리만 있다(번들 `db/migrations/`, 현재 0개 — WO-INT-008).

## 9. 번들 빌드 (RingOn, 빌드 호스트)
```
podman login registry.redhat.io        # rhel8/redis-6, rhel8/postgresql-16
install/build-bundle --version 2.0.0 --out /srv/bundles --gpg-key <KEYID> --tar
```
- `git archive <ref>`로 빌드한다(작업 트리의 미추적·수정 파일은 이미지에 들어가지 않는다). 베이스는 다이제스트로 고정해 빌드하고 MANIFEST에 기록.
- `podman build --format docker`: OCI 포맷은 HEALTHCHECK를 버린다. Quadlet 유닛에도 `Health*`를 같이 넣었다.
- 산출물: `MANIFEST.json`, `SHA256SUMS`(+`.asc`), `images/*.tar`(podman save), `app/{collector,console}`(이미지에서 꺼낸 같은 트리 — 베어용),
  `sbom/*.cdx.json`(**스텁**: package.json의 선언 범위 + 베이스 이미지만. 납품 전 syft/cdxgen 등으로 교체), `sbom/VULN-SCAN.txt`(**미수행** 표시),
  `install/`, `config/`, `db/migrations/`, `docs/`.

## 10. 이미지 내부 패치 (§3.1)
RingOn 월 1회 + CVE 발생 시: 베이스 다이제스트 갱신 → `build-bundle` → 서명 → 업그레이드 절차(8장)로 배포. 현장은 `podman load`만 한다(`Pull=never`).

## 11. 알려진 한계 (이 버전)
- 이 저장소의 Mac에는 Podman이 없어 **`podman build`·컨테이너 기동·`podman healthcheck`는 수행하지 않았다**. 첫 UBI8/RHEL 빌드 호스트에서 확인 필요.
- 설치기(Python) 단위 테스트(`python3 -m unittest discover -s install/test`)는 작성 세션에서 Python 실행 권한이 없어 **실행하지 못했다**.
  Node 정적 테스트(`node --test install/test/static.test.js`)만 실행했다.
- 읽기 전용 루트에서 rhel8/redis-6·rhel8/postgresql-16의 기동은 미확인(redis는 이미지의 실행 스크립트 대신 `redis-server <conf>`로 띄운다).
- Collector의 장비 목록 pull은 아직 구 클라우드 경로다(WO-INT-004c). 온프레미스에서는 `CFLEX_URL=https://<active app>`으로 두어 v3 밖으로 나가지 않게만 했다.
- trap 리스너 자체는 WO-INT-006. 포트·방화벽·전달은 이 WO에서 준비했다.
- 로컬 알림(SMTP/ServiceNow)은 현재 Collector의 알람 엔진이 보낸다(WO-INT-003). v3 FW-8은 app에서 나가는 것으로 되어 있어,
  Collector에 알림 채널을 설정하면 `netcheck`가 Collector의 SMTP/ServiceNow 연결을 **v3 밖(FAIL)** 으로 표시한다 — 의도된 표시다(Q-2026-10-25-10).
- Redis가 app01에만 있으므로 app01 VM 장애 시 app02도 로그인을 처리하지 못한다(Q-2026-10-25-11).
