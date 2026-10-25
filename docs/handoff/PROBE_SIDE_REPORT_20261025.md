# Probe 쪽 회신 — 다중 Probe 연동 준비

- 수신: Portal 팀(Codex) · 관리자 · 작성 2026-10-25 · Claude Code (내부 Probe)
- 근거: 인계 가이드 `PROBE_INTEGRATION_GUIDE_KO.md`, 계약 IFC-CFLEX-2026-1023 v1.1
- 재현: `cd probe-agent && node bin/cflex-sat.js` · `node bin/cflex-portal-check.js`

요청 1~3은 완료했습니다. **4~5는 Portal의 CA·mTLS 수신 활성화 전까지 실 포털로는
수행할 수 없어**, 계약을 동일하게 강제하는 로컬 목으로 전 항목을 통과시키고 그
결과를 §4·§5에 올렸습니다. 활성화되면 같은 명령이 실 포털을 가리킵니다.

가이드 §3의 지시대로 **기존 전송 경로는 전환하지 않았습니다.** 운영 서버·고객 VM에
접속하지 않았고, 실 장비 제어와 이메일 발송은 없습니다.

---

## 1. Probe 목록

### 1.1 SAT용 — KMX / TEST (격리, 합성 데이터)

가이드가 "먼저 KMX 격리 노드로 시험한다"고 했고 TEST 테넌트는 KMX만 허용하므로,
인수 시험은 이 둘로 합니다.

| 항목 | cap01 | cap02 |
|---|---|---|
| CBU | KMX (DEMO) | KMX (DEMO) |
| Tenant ID | `TEST` | `TEST` |
| Node ID | `cap01` | `cap02` |
| Site ID | `TEST-SITE` | `TEST-SITE` |
| 역할 | `collector` | `collector` |
| 버전 | 0.1.0 | 0.1.0 |
| 실행 방식 | bare (localhost SAT) | bare (localhost SAT) |
| 프록시 | 없음 | 없음 |
| 인증서 CN | `TEST.cap01` | `TEST.cap02` |

### 1.2 실 노드 — HAEA (등록만, 전환은 활성화 후)

`docs/spec/01` §1의 HAEA 제공 호스트입니다. **지금 등록해도 전환하지 않습니다.**

| 항목 | cap01 | app01 | app02 |
|---|---|---|---|
| CBU | HAEA_HQ | HAEA_HQ | HAEA_HQ |
| Tenant ID | `HAEA` | `HAEA` | `HAEA` |
| Node ID | `cap01` | `app01` | `app02` |
| Site ID | 아래 주의 | `HAEA-HQ` | `HAEA-HQ` |
| 역할 | `collector` | `app` | `app` |
| 호스트 | haeipfmscap01v 10.138.14.66 | haeipfmsapp01v .67 (Active) | haeipfmsapp02v .68 (Standby) |
| 버전 | 0.1.0 | 0.1.0 | 0.1.0 |
| 실행 방식 | bare (systemd `cflex-probe.service`, `User=cflex`), 컨테이너 프로파일은 WO-INT-005 진행 중 | 동일 | 동일 |
| 프록시 | **미확정** — HAEA 회신 대기 (spec 01 §6-3) | 동일 | 동일 |
| 인증서 CN | `HAEA.cap01` | `HAEA.app01` | `HAEA.app02` |

**Site ID 주의 — 결정 필요.** Collector 1대가 세 사이트(`HMA-FV`, `KUS-IRV`,
`HAEA-HQ`)를 담당합니다. 가이드는 노드 등록에 Site ID 하나를 요구하고
"site_id는 등록 Site와 같아야" 한다고 했는데, 이 collector의 장비는 **세 사이트에
걸쳐 있습니다.** 두 가지 중 하나가 필요합니다:

- **(A)** 사이트별로 노드를 나눈다 — `cap01-hma`, `cap01-kus`, `cap01-haea`.
  spec 01 §6-1(NMC VLAN 라우팅 불가 시 사이트당 collector 1대)과도 맞습니다.
- **(B)** 노드 등록 Site를 대표값으로 두고 inventory·telemetry의 `site_id`는
  장비별 실제 값을 허용한다.

**(A)를 권합니다** — VLAN 라우팅 결과(§6-1)와 무관하게 성립하고, 사이트 격리가
등록 단위로 보장됩니다. 포털 쪽 확인을 부탁드립니다.

또한 spec 01 §1은 `/opt/data`를 쓰는 `db01v`도 있지만 Probe가 아니라 PostgreSQL
노드이므로 등록 대상이 아닙니다.

---

## 2. 키·CSR

### 2.1 SAT 노드 — 생성 완료

`probe-agent/bin/cflex-csr.js`로 각 노드 안에서 생성했습니다.

| 노드 | CN | SAN | 공개키 SHA-256 (앞 32자) |
|---|---|---|---|
| cap01 | `TEST.cap01` | `DNS:TEST.cap01, DNS:cap01` | `15cd4fb5758e520c41f47fb7ae4bb597…` |
| cap02 | `TEST.cap02` | `DNS:TEST.cap02, DNS:cap02` | `2212fe095f213c7d3b22e8ebeb63caa3…` |

전부 P-256 / `ecdsa-with-SHA256`, EKU `clientAuth`, 개인키 `0600`.
`openssl req -verify` 자기서명 검증 통과. **CSR에 개인키가 섞이지 않았음을
확인했습니다**(grep `PRIVATE KEY` → 0건).

전달물은 **CSR 2개 + 위 식별자뿐**입니다. 개인키·SNMP 암호·토큰·프록시 암호는
가이드·채팅·저장소에 넣지 않았습니다. 공개키 SHA-256을 함께 적었으니 포털의
등록 기록과 대조하면 뒤바뀐 등록을 잡을 수 있습니다.

### 2.2 실 노드 — 명령만 전달, 생성하지 않음

**이 Mac에서 생성하면 개인키가 노드 밖에서 만들어지므로 하지 않았습니다**(계약 §6).
각 호스트에서 실행할 명령입니다:

```sh
# 각 Probe 호스트 안에서. 기존 키가 있으면 거부되며 --force 를 쓰지 않는다.
TENANT_ID=HAEA CFLEX_NODE_ID=cap01 node /opt/cflex-probe/bin/cflex-csr.js --dir /etc/cflex/pki
cat /etc/cflex/pki/cap01.csr        # ← 이것만 포털로
```

`--help`와 기존 키 존재 여부를 먼저 확인하도록 되어 있고, 키가 이미 있으면
`--force` 없이는 거부합니다 — 포털이 그 키로 서명한 인증서를 들고 있는 동안
조용히 회전시키면 다음 폴링에서 노드가 죽기 때문입니다.

### 2.3 발급 CA — 이쪽에 없습니다

"CSR과 발급 CA의 공개 인증서/체인만 전달"하라고 하셨는데, **발급 CA는 Probe 쪽
산출물이 아닙니다.** 가이드 §2-4도 "기존 승인된 발급 CA 담당자가 서명한다"로
적고 있습니다. CA 공개 인증서와 체인은 그 담당자 → 서버 담당자
(`config/probe-client-ca.pem`) 경로로 가야 하고, Probe는 **서명된 노드 인증서만**
받습니다.

Probe의 `CFLEX_TLS_CA`는 **서버 TLS 검증용**이며 클라이언트 발급 CA와 다릅니다.
`cflex.fms.support`는 Let's Encrypt 공인 인증서이므로 OS 신뢰 저장소로 충분하고,
이 값은 비워 둡니다.

---

## 3. 기존 자산 보존 — 확인

| 항목 | 상태 |
|---|---|
| 수집기 | 변경 없음. 폴러·SNMP 읽기 경로 그대로 |
| 설정 | 운영 `.env` 미접촉. 이 세션에서 운영 서버·고객 VM에 접속하지 않음 |
| 로컬 버퍼 | `./data/buffer.db` 경로·보존 7일 그대로 |
| 구 전송 경로 | `CFLEX_LEGACY_FORWARD` 기본 **false**. 전환하지 않았고 SAT에서 구 경로 유입 **0건** 확인 |
| 전환 조건 | 포털 화면의 **수신 활성화** 확인 후에만. 현재 `/api/v1/*`는 503 + Retry-After이므로 큐가 보존됩니다 |

503 동작은 확인했습니다 — 포워더가 5xx를 1초~5분 지수 백오프로 재시도하고 큐를
버리지 않습니다(§4-3).

---

## 4. 인수 시험 — 로컬 목 기준 전 항목 통과

실 포털은 아직 수신이 닫혀 있어, 계약을 동일하게 강제하는 목
(`test/support/mock-portal.js` — mTLS 필수, CN=tenant.node 검사, Idempotency-Key
캐시, 스키마 검증)으로 수행했습니다.

```
node bin/cflex-sat.js        실패 0건 · 확인 불가 1건
```

| § | 시험 | 결과 |
|---|---|---|
| 7.2 | cap01 heartbeat → inventory → telemetry → events | 전부 **HTTP 200** |
| 7.2 | cap02 동일 순서, **별도 인증서** | 전부 **HTTP 200** |
| 7.2 | inventory `rejected` 확인 | `accepted=1 rejected=0` (2xx만 보지 않음) |
| 7.1 | 서로의 Tenant/Node 교차 요청 | **HTTP 401** 거부 — 인증서 CN ≠ `X-CFlex-Node` |
| 7.3 | 단절(503) 중 전송 | 큐에 적재, 잔량 2 |
| 7.3 | 복구 후 재전송 | 큐 2 → **0**, 서버 수신 8 → 10 |
| 7.3 | 중복 저장 | 같은 키 1회 재전송, 저장 중복 **0** |
| 7.4 | 인증서 교체 후 전송 | 같은 CA의 새 인증서로 **HTTP 200** |
| 7.4 | 옛 인증서 차단 | **확인 불가** — 아래 |

**옛 인증서 차단은 이쪽에서 증명할 수 없습니다.** 로컬 목은 CA 서명만 보므로 같은
CA가 서명한 옛 인증서도 통과시킵니다. 차단은 포털이 **등록 인증서 SHA-256**으로
하는 일입니다(가이드 §2-6). 포털에서 교체 후 옛 인증서가 거부되는지 확인해
주시면 이 칸이 닫힙니다.

`node --test test/sat.test.js`가 이 SAT를 CI에서 고정합니다 — 네 경로가 두 노드
모두에서 서버에 도달했는지, 큐가 0인지, 중복 저장이 0인지, 구 경로 유입이 0인지,
그리고 "확인 불가"가 조용히 통과로 바뀌지 않는지까지 검사합니다.

### 발송하지 않은 것

알림기(`notifier`)를 연결하지 않았으므로 **이메일·Teams·ServiceNow 발송 0건**입니다.
Probe에는 SNMP SET 경로가 없고(`snmp-read.js`만), 장비 쓰기는 `88870a7`에서
자동화에 대해 영구 차단되어 있습니다(D-05). 합성 식별자는 `TEST`/`TEST-SITE`만
사용했습니다.

---

## 5. 노드별 보고

### 5.1 로컬 목 기준 (SAT 실행 결과)

| | cap01 | cap02 |
|---|---|---|
| 응답 코드 | `200×6`, `503×1` (주입한 단절) | `200×4` |
| 마지막 응답 | SAT 실행 시각 | SAT 실행 시각 |
| 큐 잔량 | **0** (누적 5) | **0** (누적 3) |
| 전송 / 거부 / 재시도 | 5 / 0 / 1 | 3 / 0 / 0 |
| 남은 오류 | `telemetry → HTTP 503 fault` (주입분, 복구 후 재전송 완료) | 없음 |

서버 측: 저장 `heartbeat ×3` `inventory ×2` `telemetry ×4` `events ×2`,
요청 총계 13, **중복 저장 0**, **구 경로 유입 0**.

### 5.2 실 포털 기준 (`cflex.fms.support`, 같은 날 실측)

```
 ok   DNS      40.114.79.164 — 계약 §1 지정 IP 일치
 ok   TCP      443 open
 ok   TLS      TLSv1.3, Let's Encrypt, 만료 2027-01-10 (76일)
 ok   VERSION  X-CFlex-API-Version: 1.1
 ok   CLOCK    +1s
warn  API      7/7 구현, 전부 503 게이트 — mtls_ingress_not_activated
warn  MOCK     /api/v1/_mock 503 (미활성)
FAIL  MTLS     클라이언트 인증서 없이 응답을 받는다 — mTLS 미강제
FAIL  CERT     장치 인증서 없음 (발급 CA 부재)
```

7개 경로가 전부 구현되어 계약 오류 포맷으로 응답하는 것을 확인했습니다. 503이므로
Probe는 백오프로 재시도하고 큐를 유지합니다 — 가이드가 의도한 동작입니다.

### 5.3 남은 오류·차단 요인

| # | 항목 | 담당 |
|---|---|---|
| 1 | nginx `ssl_verify_client` 미설정 — 인증서 없이 `/api/v1`에 응답 | 서버 (가이드 §6-2·3) |
| 2 | 발급 CA 공개 인증서 미제공 → 노드 인증서 발급 불가 | CA 담당자 → 서버 §2-5 |
| 3 | `/api/v1/_mock` 미활성 — Probe는 자체 목으로 대체 중 | 포털 §7 |
| 4 | **Collector의 Site ID 다중 사이트 문제** — §1.2 (A)/(B) 결정 | 양측 |
| 5 | 옛 인증서 차단 미검증 | 포털 §2-6 |
| 6 | HAEA 프록시 주소·인증 방식 미확정. NTLM은 미구현(Q-04=(A) Basic만) | HAEA 회신 |
| 7 | 실 노드 CSR 미생성 — 각 호스트 접속 시 생성 | 현장 |

**1·2가 풀리면 그날 바로 §4를 실 포털로 재실행합니다.**

---

## 6. 받은 ZIP 확인

`CFLEX_PROBE_HANDOFF_20261025.zip` (14개 파일). 안에 든 계약서와 스키마 8종이
이쪽 `docs/spec/schemas/*.json`(D-08 정본)과 같은 출처인지 SHA 대조가 필요합니다 —
`contract/SOURCE.json`에 고정 SHA가 있으니 다음 세션에서 대조해 보고하겠습니다.

가이드에 적힌 미활성 항목은 이쪽 전제와 일치합니다: 파일 업로드·원격 명령·config
동기화·mock namespace 미활성, `commands` GET은 빈 배열, 장비 제어·원격 shell 없음.
`notified:0` / `capture_only_noc_not_connected`는 보관만 된 것으로 이해했고,
기존 운영 알림 경로는 교체하지 않습니다.
