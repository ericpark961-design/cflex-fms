# HAEA 미러 랩 (Azure westus2)

HAEA 온프레미스(docs/spec/01 §1)를 Azure 에 같은 주소·같은 제약으로 세운 시험장이다.
목적: `cflex-install` 번들을 SAT 전에 실제로 설치해 보고, 통과한 번들을 HAEA 에 넘긴다.
기간: 2026-11 ~ 2027-01 (약 2개월). 끝나면 `./destroy.sh`.

## 구성

| VM | 사양 | IP | HAEA 대응 |
|---|---|---|---|
| cap01 | B2s RHEL 8.10 | 10.138.14.66 | haeipfmscap01v (Collector) |
| app01 | B2ms RHEL 8.10, `/opt/app` 64 GB | 10.138.14.67 | haeipfmsapp01v (Active) |
| app02 | B2ms RHEL 8.10, `/opt/app` 64 GB | 10.138.14.68 | haeipfmsapp02v (Standby) |
| db01 | B2ms RHEL 8.10, `/opt/data` 128 GB | 10.138.14.69 | haeipfmsdb01v (PostgreSQL 16) |
| svc | B1s Ubuntu, 공인 IP | 10.138.15.10 | HAEA 프록시·SMTP·ServiceNow·포털 목 + 점프 |
| nmcsim | B1s Ubuntu | 10.138.16.20 | NMC 41대 (부록 B IP 그대로, UDR 로 라우팅) |

사양은 HAEA 보다 작다(4/16 → 2/8). 기능 시험용이지 부하 시험용이 아니다.

## 제약 (HAEA 와 같게 만든 것)

- 4 VM 에 공인 IP 없음, NSG 가 인터넷 아웃바운드 차단.
  밖으로 가는 길은 svc 의 squid(:3128) 하나 — 허용목록 `/etc/squid/lab-allow.txt`.
  dnf 는 이 프록시로 RHUI 에 닿는다(= Satellite 대용).
- SELinux Enforcing, firewalld — RHEL 이미지 기본값 그대로.
- NMC 대역(10.112/16, 10.119/16, 10.189.193/24)은 VNet 밖. `rt-fms` 경로를 지우면
  "collector → NMC 라우팅 불가"(spec 01 §6-1)가 재현된다.

## 랩이 대신하지 못하는 것 (SAT 몫)

EDR, HAEA 내부 CA, 실 NMC 장비, 실 포털(`cflex.fms.support` — WO-PTL-001/002 미착수, 랩은 목).

## 사용

```
./create.sh            # 최초 1회 (다시 돌려도 안전)
./up.sh                # 시험 시작 — 전부 켜기 (일부만: ./up.sh svc cap01)
./down.sh              # 시험 끝 — 전부 deallocate
./status.sh            # 전원 상태 + 이번 달 비용
ssh -F .state/ssh_config cap01     # svc 를 거쳐 접속
./destroy.sh           # 랩 전체 삭제 (그룹 이름 입력 확인)
```

- **매일 03:00 UTC(19:00 PST) 자동 종료.** 켜둔 채 잊어도 하루치만 과금된다.
- 자동 시작은 없다. 시험할 때만 `./up.sh`.
- SSH 는 `create.sh` 를 실행한 머신의 공인 IP 에서만 svc 로 들어온다. IP 가 바뀌면
  `./create.sh` 를 다시 돌리면 지금 IP 로 NSG 규칙이 갱신된다.

## 비용 (정가, 세금 별도)

| 상태 | 월 |
|---|---|
| 전부 켜둠 24h | ~$446 |
| 하루 10h × 22일 | ~$167 |
| 전부 꺼둠 (디스크·IP) | ~$47 |

RHEL 은 시간당 라이선스+지원료 $0.0588/VM 이 VM 요금에 더해진다.
