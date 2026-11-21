# C-Flex PostgreSQL 16 (db01) — 구성 · 백업 · 복구 리허설 (WO-INT-008)

기준: 명세 01 §2.3 — PostgreSQL 16, 데이터 `/opt/data`, 텔레메트리 **월 파티션(네이티브 선언적 파티셔닝, pg_partman 없음)**,
앱 스케줄러가 파티션을 미리 만들고 보존 기간이 지나면 드롭, 보존 raw 3년 / 집계 10년 / 이벤트·감사 10년,
**일 1회 `pg_basebackup` + WAL, 14일, `/opt/data/backup`**, `wal_level=replica`, repmgr 없음.

백업·복구 절차는 **HAEA 미러 랩(Azure, RHEL 8.10 4노드, 번들 2.0.0-lab.4)에서 SAT 7로 실제 실행했다** — 결과는 §6 표와
`deploy/azure-haea-lab/sat7-backup.sh`(재실행 가능한 리허설 스크립트). 판정표는 §6이다.

---

## 1. 구성 — 무엇이 어디에 있나

| 항목 | 위치 | 누가 만드나 |
|---|---|---|
| 데이터 디렉터리 | `/opt/data/pgsql` (0700, cflex — 컨테이너 안 postgres UID 26으로 매핑) | `cflex-install install --role db` |
| 설정 조각 | `/opt/app/cflex/config/db/postgresql-cfg/cflex-postgresql.conf` → 컨테이너 `/opt/app-root/src/postgresql-cfg/` | 설치기 render (rhel8/postgresql-16 이미지가 그 디렉터리의 `*.conf`를 `postgresql.conf` 끝에 포함) |
| `wal_level` / `archive_mode` / `archive_command` | 위 조각: `replica` / `on` / `test ! -f /opt/data/backup/wal/%f && cp %p /opt/data/backup/wal/%f`, `archive_timeout = 900` | 〃 |
| 베이스 백업 | `/opt/data/backup/base-YYYYMMDD/` (`base.tar.gz`, `pg_wal.tar.gz`, `backup_manifest`, `CFLEX_BACKUP_OK`, `CFLEX_BACKUP_STARTED`) | `cflex-pg-backup.sh` |
| WAL 아카이브 | `/opt/data/backup/wal/` | PostgreSQL `archive_command` |
| 백업 스크립트 | `/opt/app/cflex/bin/cflex-pg-backup.sh` (저장소 `install/scripts/`) | 설치기 render |
| 타이머 | 컨테이너: `~cflex/.config/systemd/user/cflex-pg-backup.{service,timer}` (user 유닛). 베어: `/etc/systemd/system/` (User=postgres) | 설치기 render + `systemctl --user enable --now` |
| 로그 | `journalctl --user -u cflex-pg-backup` (cflex로) + `/opt/data/backup/backup.log` | — |
| 스키마 | 콘솔 `apps/console/migrations/NNNN_*.sql`, 번들 `db/migrations/` | **cflex-app이 기동할 때 적용**(아래) |
| 비밀번호 | db01 `/opt/app/cflex/secrets/db/pg.pass`(앱 계정 `cflex`), `pg-admin.pass` → Podman secret | 설치기(db01에서 생성). **app01·app02의 `/opt/app/cflex/secrets/app/pg.pass`로 같은 값을 복사**(0600, cflex). 메일·메신저 금지 |

- **스키마와 파티션은 콘솔이 맡는다.** cflex-app은 기동하면 advisory lock을 잡고 `schema_migrations`에 없는 파일을 번호 순으로 하나씩 적용한다.
  app01과 app02가 동시에 기동해도 각 파일은 한 번만 적용된다. 이미 적용된 파일의 내용이 바뀌었으면 기동을 거부한다(`migration_changed`).
- **월 파티션:** 대상은 `telemetry`, `alarm_events`, `audit_log`이다. 이름은 `<표>_pYYYYMM`이고 경계는 UTC 월초 epoch ms다.
  기동할 때와 6시간마다(`CFLEX_PARTITION_INTERVAL_H`) 이번 달부터 **3개월 앞까지**(`CFLEX_PARTITION_AHEAD_MONTHS`) 만든다.
  보존 기간을 넘긴 달은 `DETACH` 한 다음 `DROP` 한다. 두 노드 중 lock을 잡은 쪽만 이 일을 하고, 다른 쪽은 그 회차를 건너뛴다.
- 아직 파티션이 없는 달의 행(시계 오차, 오래된 재전송)은 `<표>_default`에 들어간다. 그 달 파티션을 만들 때 같은 트랜잭션 안에서 옮긴다.
- **보존:** `site.yaml retention` → app.env `CFLEX_RETENTION_*`. 기본은 raw 3년, 집계 10년, 이벤트·감사 10년이다.
  집계 표는 아직 없다. 설정값만 자리를 잡아 두었다(DECISIONS Q-2026-10-26-08).
- 확장(extension)은 쓰지 않는다(`plpgsql` 기본만). `citext` 대신 `lower(username)` 유니크 인덱스를 쓴다. pg_partman·repmgr·pgcrypto도 없다.

### 1.1 베어 프로파일 (폴백) — 손으로 할 것
설치기는 AppStream `postgresql:16`을 설치한다. 또 위의 조각·스크립트·타이머와 `postgresql.service.d/cflex.conf`(`PGDATA=/opt/data/pgsql/data`)를 렌더한다.
**initdb, 앱 계정·DB 생성, 조각 include는 아직 자동화하지 않았다**(DECISIONS Q-2026-10-26-10):
```
sudo chown postgres:postgres /opt/data/pgsql /opt/data/backup /opt/data/backup/wal && sudo chmod 700 /opt/data/pgsql
sudo systemctl daemon-reload && sudo PGSETUP_INITDB_OPTIONS="--encoding=UTF8" postgresql-setup --initdb
echo "include_if_exists = '/opt/data/pgsql/cflex-postgresql.conf'" | sudo tee -a /opt/data/pgsql/data/postgresql.conf
sudo install -o postgres -m 0644 /opt/app/cflex/config/db/postgresql-cfg/cflex-postgresql.conf /opt/data/pgsql/
sudo -u postgres psql -c "CREATE ROLE cflex LOGIN PASSWORD '…pg.pass의 값…'" -c "CREATE DATABASE cflex OWNER cflex"
# pg_hba.conf: host cflex cflex 10.138.14.67/32 scram-sha-256 / 10.138.14.68/32 (app 노드만) + listen_addresses
sudo systemctl enable --now postgresql cflex-pg-backup.timer
```

## 2. 백업 — 매일 확인하는 것

```
sudo install/cflex-install verify --role db     # last base backup: PASS(≤1일) / WARN(≤14일) / FAIL(없음·14일 초과)
                                                # db wal_level / archive_mode: "replica on"
sudo install/cflex-install verify --role app    # app → db, schema_migrations 버전, 이번·다음 달 파티션, WAL 아카이브 실패 수
```
수동으로 백업 1회 (cflex 사용자로 — 번들 디렉터리에서 `sudo install/cflex-as <명령>`. cflex 는 nologin 이라 `sudo -iu cflex` 는 안 된다):
```
sudo install/cflex-as systemctl --user start cflex-pg-backup     # 끝까지 기다린다 (oneshot)
sudo install/cflex-as journalctl --user -u cflex-pg-backup -n 20
ls -l /opt/data/backup/base-$(date -u +%Y%m%d)/            # base.tar.gz, pg_wal.tar.gz, backup_manifest, CFLEX_BACKUP_OK
```
- 종료 코드: 0 = 성공(오늘 세트가 이미 완성돼 있어도 0), 1 = `pg_basebackup` 실패(이전 세트는 그대로 둔다), 2 = 설정 문제(디렉터리 없음·쓰기 불가, 날짜·보존일 값 오류).
- 완성 표시(`CFLEX_BACKUP_OK`)가 없는 세트는 중단된 실행이다. 같은 날 다시 돌리면 지우고 새로 만든다.
- 보존: 날짜(세트 이름)가 오늘보다 14일 넘게 이전이면 지운다. **가장 최근의 완성 세트는 어떤 경우에도 지우지 않는다.**
  WAL은 남아 있는 가장 오래된 세트가 시작되기 전에 아카이브된 파일만 지운다.
- 용량: 베이스 세트 15개 + WAL 14일분. `/opt/data`(500 GB)의 사용률은 SAT 때 실측해 기록한다.

## 3. 기준 복구 — 마지막 베이스 백업 시점으로

**언제:** db01의 데이터 디렉터리가 손상·삭제됐을 때. 또는 업그레이드 롤백에 스키마까지 되돌려야 할 때(마이그레이션은 추가만 하므로 보통은 필요 없다).
**리허설은 운영 db01이 아니라 같은 이미지를 쓰는 별도 VM(또는 db01의 다른 데이터 경로)에서 한다.**

**손으로 하지 말고 `install/cflex-pg-recover`를 쓴다(컨테이너 프로파일).** rhel8/postgresql-16 이미지의 기동 스크립트는 서버가 연결을 받자마자
`ALTER USER … PASSWORD`를 실행한다. 복구 중에는 서버가 읽기 전용이라 이 명령이 실패하고, 컨테이너가 죽고, systemd가 다시 띄우고,
복구가 처음부터 다시 시작된다 — 끝나지 않는다(HAEA 랩 SAT 7에서 확인). 스크립트는 같은 이미지·같은 볼륨으로 **일회용 컨테이너**를 띄워
`postgres`만 직접 실행하고(네트워크 없음), 승격(promote)이 끝나면 내리고 평소 유닛(cflex-postgres)을 기동한다.
기준 복구도 `recovery_target = 'immediate'` + 승격으로 **새 타임라인**을 만든다 — 그래야 복구 뒤에 쓰는 WAL이 아카이브에 이미 있는 세그먼트 이름과 겹치지 않는다
(같은 타임라인으로 올리면 `archive_command`가 "이미 있음"으로 계속 실패한다).

```
# 0) 앱 정지 (두 노드) — 복구 중 쓰기 금지
sudo install/cflex-as systemctl --user stop cflex-console                        # app01, app02
# 1) db01: 세트 하나를 골라 복구 (현재 데이터는 /opt/data/pgsql.broken-<시각>으로 옮겨질 뿐 지우지 않는다)
sudo install/cflex-pg-recover --set /opt/data/backup/base-20261026 --immediate --yes
#    → "promoted after Ns (timeline N)", "cflex-postgres ready — schema N"
# 2) 앱 기동 → 새 타임라인에서 베이스 백업 1회(§4 끝) → verify
sudo install/cflex-as systemctl --user start cflex-console                       # app01, app02
sudo install/cflex-install verify --role db && sudo install/cflex-install verify --role app
```
- 랩 실측(2.0.0-lab.4, 세트 4.4 MB): 복구 3~5초, 기동 포함 전체 10초 안쪽. 장비·사용자·열린 알람 수가 세트 시점과 일치.
- 베어 프로파일은 이미지 기동 스크립트가 없으므로 아래 수동 절차(§3.1)를 그대로 쓴다.

### 3.1 베어 프로파일 — 수동 절차
```
sudo systemctl stop postgresql
sudo mv /opt/data/pgsql/data /opt/data/pgsql/data.broken-$(date +%Y%m%d%H%M) && sudo install -d -o postgres -g postgres -m 700 /opt/data/pgsql/data
S=/opt/data/backup/base-20261026
sudo -u postgres tar -xzf $S/base.tar.gz -C /opt/data/pgsql/data
sudo -u postgres install -d -m 700 /opt/data/pgsql/data/pg_wal && sudo -u postgres tar -xzf $S/pg_wal.tar.gz -C /opt/data/pgsql/data/pg_wal
printf '%s\n' "restore_command = 'cp /opt/data/backup/wal/%f %p'" "recovery_target = 'immediate'" "recovery_target_action = 'promote'" \
  | sudo -u postgres tee -a /opt/data/pgsql/data/postgresql.auto.conf && sudo -u postgres touch /opt/data/pgsql/data/recovery.signal
sudo systemctl start postgresql      # 승격 후 postgresql.auto.conf 에서 위 세 줄을 지운다
```

## 4. 시점 복구(PITR) — 특정 시각 직전으로

예: 2026-10-26 14:05 UTC에 잘못된 대량 삭제가 있었다 → 14:04로 되돌린다.
그 시각 **이전에 시작된** 가장 최근 세트(`base-20261026`이 02:30에 시작)와, 그 뒤의 WAL(`/opt/data/backup/wal/`)을 쓴다.

```
sudo install/cflex-as systemctl --user stop cflex-console                        # app01, app02
sudo install/cflex-pg-recover --set /opt/data/backup/base-20261026 --time '2026-10-26 14:04:00+00' --yes
#    → "recovery stopping before commit of transaction …, time …", "selected new timeline ID: N"
sudo install/cflex-as systemctl --user start cflex-console                       # app01, app02
```
- 랩 실측(SAT 7 B7): 표식 테이블 생성 → 시각 T → 표식 삭제 → T로 복구 → 표식 1행 존재, 복구 5초.
- `recovery_target_time`이 마지막으로 아카이브된 WAL보다 뒤면, 복구는 거기까지만 진행한다. `archive_timeout = 900`이라 잃는 양은 최대 15분이다.
- 복구하면 새 타임라인이 생긴다. **복구 직후 수동 백업 1회**(§2)를 해야 그 뒤의 PITR이 가능하다.
  같은 날 이미 완성된 `base-<오늘>`이 있으면 스크립트는 "already complete"로 아무것도 하지 않는다(랩 SAT 7에서 확인).
  그 세트를 먼저 옆으로 옮긴다 — 지우지 않는다(보존 정리 대상 이름이 아니므로 14일 뒤 손으로 지운다):
  ```
  sudo mv /opt/data/backup/base-$(date -u +%Y%m%d) /opt/data/backup/base-$(date -u +%Y%m%d).pre-restore
  sudo install/cflex-as systemctl --user start cflex-pg-backup
  ```
- `pg_basebackup`은 `-X stream`으로 백업 중의 WAL을 세트 안(`pg_wal.tar.gz`)에 함께 담는다. 그래서 WAL 아카이브가 없어도 §3 기준 복구는 된다.

## 5. 업그레이드 — SQLite 콘솔에서 PostgreSQL로 (WO-INT-008 이전 → 이후 1회)

`CONTAINER_PROFILE.md` §8 업그레이드 순서에 **1줄**이 추가된다. db01을 먼저 설치·verify하고, `pg.pass`를 두 앱 노드에 복사하고, app02 → app01 순서로 업그레이드한다.
그다음 **app01에서 한 번** 실행한다.
```
sudo install/cflex-as podman exec cflex-console node /opt/cflex/apps/console/bin/cflex-migrate-sqlite.js --dry-run   # 표별 행 수, 쓰기 없음
sudo install/cflex-as podman exec cflex-console node /opt/cflex/apps/console/bin/cflex-migrate-sqlite.js             # 실행 (다시 돌려도 0건 추가)
```
- 원본: `CONSOLE_DB`(= `/opt/app/cflex/data/console.db`, 데이터 볼륨에 그대로 있다). 대상: app.env의 db01.
- 옮기는 것: 사이트, 사용자(id·비밀번호 해시 유지), 설정(임계치·알림 채널 — 같은 `console.key`로 봉인된 채), collector 키 해시,
  장비(id 유지), SNMP 크리덴셜(봉인), 진행 중 유지보수 창, **열린 알람**과 그 코멘트·ServiceNow 매핑, **최근 90일 알람 이벤트**(+ 열린 알람의 이벤트), 감사로그 전부.
- 옮기지 않는 것: 텔레메트리(트렌드는 새로 쌓인다), 닫힌 알람.
- 원본 SQLite 파일은 지우지 않는다. SAT가 끝날 때까지 롤백용으로 둔다.

## 6. SAT 판정 항목 (SAT 7 — 백업/복구 리허설)

| # | 항목 | 판정 기준 | 결과 |
|---|---|---|---|
| B1 | 설정 반영 | `verify --role db`: `db wal_level / archive_mode` = `replica on` | PASS — `replica on` (랩 2026-11-21) |
| B2 | 일일 백업 | 타이머 1회 이상 실행. `base-YYYYMMDD/`에 `CFLEX_BACKUP_OK`, `verify` last base backup PASS | PASS — 타이머 실행, `base-20261121` + `CFLEX_BACKUP_OK`, verify PASS |
| B3 | WAL 아카이브 | `/opt/data/backup/wal/`에 세그먼트가 쌓임, `verify --role app` db WAL archiving failed 0 | PASS — 세그먼트 누적, `pg_stat_archiver` failed 0 (타임라인 1→4 전부) |
| B4 | 실패 처리 | DB 정지 상태에서 수동 실행 → exit 1, 이전 세트 보존, 로그에 원인 | PASS — exit 1, 원인 로그(`pg_basebackup failed (exit 125)`), 세트 수 그대로, 부분 세트 없음 |
| B5 | 보존 14일 | 날짜를 바꾼 시험 세트(`CFLEX_BACKUP_DATE`)로 15일째 삭제·최신 보존 확인 (또는 14일 운영 후 실측) | PASS — 20일 전 날짜 세트 삭제(`1 set(s) removed`), 최신 세트 보존 |
| B6 | 기준 복구 | §3을 리허설 VM에서 수행. 복구 후 사용자 로그인, 장비 수(HAEA 44 — SOW), 열린 알람 수가 백업 시점과 일치 | PASS — `cflex-pg-recover --immediate` 3초, devices 41·users 2·open alarms 3 일치(랩 41대 시뮬). 수동 절차는 이미지 기동 스크립트 때문에 불가 → §3 |
| B7 | PITR | §4: 표식 행 삽입 → 시각 T 기록 → 표식 삭제 → T로 복구 → 표식 행 존재 | PASS — 표식 → T → 삭제 → T 복구 → 표식 1행, 5초, 타임라인 3 |
| B8 | 소요 시간 | 백업 시간·세트 크기·복구 시간 기록 (RTO/RPO 근거) | PASS(랩 규모) — 백업 1.4~3.5초 / 세트 4.4 MB / 복구 3~5초. 운영 규모 RTO는 HAEA SAT에서 실측 |
| B9 | 앱 연속성 | 복구 후 `verify --role app` 전부 PASS(schema_migrations 최신, 이번·다음 달 파티션) | PASS — 복구 후 verify db/app PASS, schema 2, 새 타임라인 아카이브 충돌 없음 |
| B10 | 비밀정보 | 백업 로그·journal에 비밀번호 없음. 세트·WAL 디렉터리 권한 0750 cflex | PASS — backup.log·journal·서버 로그 pg.pass 0 (verify `secrets in logs`), 디렉터리 0750/0700 cflex. **주의:** 이미지의 ALTER USER가 실패하면 서버 로그에 평문이 남았다 → `log_min_error_statement = panic` |
| B11 | 로컬 replication 연결 | 컨테이너 안 `pg_basebackup`이 로컬 소켓으로 붙는지(이미지 pg_hba의 `local replication`) — 안 붙으면 Q로 보고 | PASS — 컨테이너 안 `pg_basebackup`이 로컬 소켓 replication 으로 붙음 |

수량 표기는 SOW 44대 기준이다(방화벽 41 NMC IP, 실사 48대와 혼용하지 않는다).
