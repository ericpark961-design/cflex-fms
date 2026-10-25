# cflex.fms.support 에서 구성해야 할 것 — Probe 연동 요구사항

- 문서번호: INT-CFLEX-2026-1025 v1.0 · 작성 2026-10-25 · Claude Code (내부 Probe)
- 수신: Codex (외부 포털) · 관리자
- 기준: `docs/spec/00_INTERFACE_CONTRACT_Probe-Portal_v1.md` (계약 v1.1)
- 재현: `cd probe-agent && node bin/cflex-portal-check.js`

Probe 쪽은 붙을 준비가 끝났다. 이 문서는 **포털이 무엇을 켜야 Probe 가 붙는지**를
의존 순서대로 적은 것이다. 각 항목에 지금 상태와 확인 방법을 붙였다.

---

## 0. 현재 실측 — 2026-10-25

```
  ok   DNS      cflex.fms.support → 40.114.79.164        계약 §1 지정 IP 일치
  ok   TCP      40.114.79.164:443                        open
  ok   TLS      TLSv1.3  CN=cflex.fms.support
                Let's Encrypt, 만료 2027-01-10 (76일)
  ok   CLOCK    +1s                                      계약 §1 (60초 이내)

 FAIL  MTLS     클라이언트 인증서 없이 핸드셰이크 성립     → §1
 FAIL  CERT     이 노드의 장치 인증서 없음                 → §6-1
 FAIL  API      §3 의 7개 경로 전부 303 → /login          → §3
 warn  VERSION  X-CFlex-API-Version 헤더 없음              → §1
 warn  MOCK     /api/v1/_mock 없음                         → §7
```

현재 `cflex.fms.support` 에는 **"C-Flex FMS Review Login"** 세션 앱이 떠 있고,
`/api/v1/*` 는 구현되지 않았다. 전송 계층(DNS·TCP·TLS·시계)은 전부 정상이므로
막혀 있는 것은 네트워크가 아니라 **포털 구성 3개**다.

---

## 1. nginx — mTLS 를 켠다 (가장 먼저)

계약 §1 의 인증은 **mTLS 장치 인증서**다. 지금은 아무 클라이언트나 TLS 를 맺을 수 있다.

### 1.1 주의 — 리뷰 로그인 앱과 같은 호스트다

계약 §1 이 목적지를 `cflex.fms.support` 하나로 고정했고, 그 이름에 세션 로그인
웹앱이 이미 붙어 있다. `ssl_verify_client on` 을 server 레벨에 걸면 **브라우저
접속이 전부 깨진다**(사람은 장치 인증서가 없다).

해법은 `optional` + 경로별 강제다:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name cflex.fms.support;

    ssl_certificate     /etc/letsencrypt/live/cflex.fms.support/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cflex.fms.support/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;          # 계약 §1: 1.2+

    # RingOn 사설 CA (오프라인 루트 + 중간). 체인 검증 깊이 2.
    ssl_client_certificate /etc/pki/cflex/ringon-ca-chain.pem;
    ssl_verify_client      optional;               # ← on 이면 브라우저가 깨진다
    ssl_verify_depth       2;
    ssl_crl                /etc/pki/cflex/ringon-ca.crl;   # §6-2 폐기 즉시 401

    keepalive_timeout 15s;                         # 계약 §1: Keep-Alive 짧게
    client_max_body_size 5m;                       # 계약 §1: 요청당 ≤ 5 MB

    location /api/v1/files {
        client_max_body_size 25m;                  # 계약 §3.5
        include /etc/nginx/snippets/cflex-mtls.conf;
        proxy_pass http://127.0.0.1:3000;
    }

    location /api/v1/ {
        include /etc/nginx/snippets/cflex-mtls.conf;
        proxy_pass http://127.0.0.1:3000;
    }

    location / {                                   # 리뷰 로그인 앱 — 그대로
        proxy_pass http://127.0.0.1:8080;
    }
}
```

`snippets/cflex-mtls.conf`:

```nginx
if ($ssl_client_verify != SUCCESS) { return 401; }

# ⚠ 스푸핑 차단. 클라이언트가 보낸 동명 헤더를 반드시 먼저 비운다 —
#   안 하면 아무 노드나 X-Client-Cert-DN 을 조작해 다른 테넌트를 주장할 수 있다.
proxy_set_header X-Client-Cert-DN          "";
proxy_set_header X-Client-Cert-Serial      "";
proxy_set_header X-Client-Cert-Fingerprint "";
proxy_set_header X-Client-Cert-Verify      "";

proxy_set_header X-Client-Cert-DN          $ssl_client_s_dn;
proxy_set_header X-Client-Cert-Serial      $ssl_client_serial;
proxy_set_header X-Client-Cert-Fingerprint $ssl_client_fingerprint;
proxy_set_header X-Client-Cert-Verify      $ssl_client_verify;

proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Proto https;
proxy_http_version 1.1;                            # 계약 §1: HTTP/1.1 (프록시 호환)
```

### 1.2 확인

```sh
# 포털 쪽에서
nginx -t && systemctl reload nginx

# Probe 쪽에서 (인증서 없이 → 401 이어야 한다)
curl -sS -o /dev/null -w '%{http_code}\n' https://cflex.fms.support/api/v1/heartbeat -X POST -d '{}'
```

`node bin/cflex-portal-check.js` 의 `MTLS` 가 PASS 로 바뀐다.

> **IP 핀 주의.** 계약 §1 과 `site.yaml` 의 `ip_pin` 이 `40.114.79.164` 고정이다.
> 앞에 Cloudflare·로드밸런서를 넣으면 IP 가 바뀌어 HAEA 방화벽 요청서와 어긋난다.
> 바꿔야 하면 코드가 아니라 `DECISIONS.md` 에 먼저 올린다.

---

## 2. 사설 CA 와 인증서 발급 (WO-PTL-002)

### 2.1 CA 구조

| 항목 | 값 | 근거 |
|---|---|---|
| 루트 | **오프라인** 보관, 중간 CA 1장 서명 | 계약 §6, spec 01 §4 |
| 중간 | 온라인, 노드 인증서 서명 | |
| 노드 CN | **`<tenant>.<node-id>`** — `HAEA.cap01`, `HAEA.app01`, `HAEA.app02` | 계약 §1 |
| 유효기간 | **2년** | 계약 §1 |
| EKU | `clientAuth` (필수) | |
| SAN | `DNS:<tenant>.<node-id>`, `DNS:<node-id>` | Probe CSR 이 둘 다 넣는다 |
| 폐기 | CRL 또는 OCSP — **폐기 시 즉시 401** | 계약 §6-2 |
| 갱신 | 만료 **60일 전** 포털이 `cert_renew` 명령 발행 | 계약 §1, §3.6 |

### 2.2 Probe 쪽 CSR 은 이미 만들었다

```sh
cd probe-agent
node bin/cflex-csr.js --dir /opt/app/cflex/certs
cat /opt/app/cflex/certs/cap01.csr        # ← 이것만 포털로 보낸다
```

생성 확인된 내용:

```
subject  C=US, O=RingOn Service Corp, OU=C-Flex FMS Probe, CN=HAEA.cap01
SAN      DNS:HAEA.cap01, DNS:cap01
EKU      TLS Web Client Authentication
key      prime256v1 (P-256), ecdsa-with-SHA256, 파일 0600
```

**개인키는 노드를 떠나지 않는다**(계약 §6-1). 포털이 요구할 것은 CSR 뿐이다.
포털은 공개키 SHA-256 을 기록해 두면 등록된 CSR 과 실제 접속 노드를 대조할 수 있다.

### 2.3 발급 경로 두 가지

1. **오프라인** — 설치 엔지니어가 CSR 을 포털에 등록, 서명된 `cap01.pem` 과
   `ringon-ca.pem` 을 설치기에 투입. HAEA 1차 설치는 이 경로다.
2. **온라인** — `cert_renew` 명령(§3.6)으로 교체. 갱신용.

Probe 쪽 설정은 파일 경로 3개뿐이다:

```
CFLEX_TLS_CERT=/opt/app/cflex/certs/cap01.pem
CFLEX_TLS_KEY=/opt/app/cflex/certs/cap01.key
CFLEX_TLS_CA=/opt/app/cflex/certs/ringon-ca.pem
```

---

## 3. 계약 엔드포인트 7개 (WO-PTL-001)

`/api/v1` prefix. 스키마 정본은 **`docs/spec/schemas/*.json`** (D-08) — 8종이
이미 저장소에 있고 Probe 는 전송 전에 그걸로 검증한다. 포털은 같은 파일로 수신
검증하면 계약 테스트가 양쪽에서 맞는다.

| 경로 | 메서드 | 주기 | 비고 |
|---|---|---|---|
| `/api/v1/heartbeat` | POST | **60초**/노드 | 응답에 `commands_pending`, `config_version` |
| `/api/v1/inventory` | PUT | 변경 시 + 일 1회 전체 | `provisional`·`id_basis`·`replaced_by` 필드 있음 (Q-05) |
| `/api/v1/telemetry` | POST | 60초 또는 500포인트 | 미등록 메트릭 키는 `m_ext` 보관 + 경고 |
| `/api/v1/events` | POST | 즉시 | `local_notified` 가 중복 발송 억제 입력 |
| `/api/v1/files` | POST | — | multipart, ≤ 25 MB |
| `/api/v1/commands` | GET | `commands_pending>0` 일 때 | **허용 명령 6종 고정** |
| `/api/v1/config` | GET | — | 선택. 로컬 `site.yaml` 이 우선 |

### 3.1 전송 계층 요구 (계약 §1) — 전부 미구현

| 항목 | 요구 | 지금 |
|---|---|---|
| 응답 헤더 | `X-CFlex-API-Version: 1.1` | 없음 |
| 멱등성 | `Idempotency-Key` UUIDv4 필수, **24시간 내 동일 키 → 200 + 동일 응답** | 없음 |
| 레이트 | 노드당 **60 req/min**, 초과 시 `429` + `Retry-After` | 없음 |
| 오류 포맷 | `{"error":{"code","message","details"}}` | 리뷰 앱 포맷 |
| `Date` 헤더 | Probe 가 시계 차를 재는 기준 | 있음 ✓ |
| gzip | `Content-Encoding: gzip` 요청 본문 허용 | 미확인 |

Probe 쪽 동작(이미 구현·테스트됨)이라 포털이 이걸 지키면 바로 맞물린다:
`Idempotency-Key` 는 **큐에 적재할 때 고정**되므로 재전송에도 같은 값이 온다.
`429` 는 `Retry-After` 를 따르고, `409` 는 재시도하고, 그 외 4xx 는 폐기한다.
5xx·네트워크 오류는 1s→5분 지수 백오프 ±20% 지터.

### 3.2 ⚠ 테넌트 격리는 인증서로 한다, 헤더로 하지 않는다

`X-CFlex-Tenant: HAEA` 는 **힌트**다. 권위는 **클라이언트 인증서 CN** 이다.
헤더만 신뢰하면 어느 노드든 다른 테넌트를 주장할 수 있다.

```
CN = HAEA.cap01  →  tenant=HAEA, node=cap01   ← 이것이 신원
X-CFlex-Tenant   →  CN 과 불일치하면 401
```

멀티테넌트가 §0 의 포털 범위이므로 이 지점이 그 전체의 기반이다.

---

## 4. 목 서버 `/api/v1/_mock` (계약 §7)

테넌트 `TEST` 로, Probe 개발·SAT 용. 없으면 Probe 가 자체 목에만 의존하게 되고,
그러면 "양쪽이 같은 계약을 구현했는지"를 아무도 확인하지 못한다.

Probe 쪽에는 이미 계약을 지키는 목이 있다 — `probe-agent/test/support/mock-portal.js`
(`requestCert: true`, 버전 헤더, 스키마 검증). 포털 `/_mock` 의 레퍼런스로 쓸 수 있다.

---

## 5. 이미지 레지스트리 (WO-PTL-005)

D-04: 업그레이드는 **아웃바운드 풀**, 목적지는 `cflex.fms.support:443` **뒤**.
별도 호스트를 열지 않는다 — HAEA 방화벽 요청서의 아웃바운드 목적지 1개를 그대로 쓴다.

| 항목 | 요구 |
|---|---|
| 경로 | `/v2/` (OCI Distribution API), 같은 mTLS 뒤 |
| 이미지 | `cflex/collector`, `cflex/app`, `cflex/web`, `cflex/redis`, `cflex/postgres` |
| 서명 | cosign 또는 GPG. Probe 쪽은 `podman image trust` 로 검증 |
| 태그 | 고정 태그 (latest 금지) |
| 적용 | **무인 자동 적용 아님** — 승인된 유지보수 창에서 `cflex-install upgrade` (D-04) |

---

## 6. HAEA 방화벽에 올릴 것 — 포털 쪽 확정 필요

방화벽 요청서 v3 의 아웃바운드는 **목적지 1개**다:

```
collector/app (10.138.14.66–68) → 40.114.79.164 : TCP 443 out
```

이 한 줄이 heartbeat·inventory·telemetry·events·files·commands·config·
**이미지 풀**까지 전부 덮는다. 포털이 다른 호스트나 포트를 추가하면 요청서를
다시 돌려야 하고, 그게 이 프로젝트에서 가장 느린 절차다.

---

## 7. 순서와 차단 관계

```
1. nginx mTLS 켜기          ──┐
2. 사설 CA + cap01.pem 발급  ──┼─→ Probe 가 TLS 로 붙는다
                              │
3. /api/v1 7개 구현          ──┴─→ Probe 가 데이터를 보낸다
4. 멱등·429·버전 헤더        ─────→ 재전송·레이트가 계약대로 동작
5. /_mock                    ─────→ 양쪽 계약 테스트가 맞물린다
6. 레지스트리                 ─────→ 업그레이드 (D-04)
```

**1 과 2 가 끝나면 그날 바로 확인 가능하다.** Probe 쪽은 대기 상태다:

```sh
cd probe-agent
node bin/cflex-portal-check.js        # 3 FAIL → 0 FAIL 로 바뀌는지
node --test test/*.test.js            # 58/58, 계약 스키마·프록시·E2E 포함
```

---

## 8. Probe 쪽 상태 (참고 — 포털이 할 일 없음)

| | |
|---|---|
| Forwarder | 계약 §3 로 교체 완료 (WO-INT-002, PR #1 머지). mTLS·멱등·백오프·429·프록시·heartbeat 60s·스키마 화이트리스트 |
| 알람 1차 분류 | 부록 B 코드 사전, 중복 억제·플래핑·유지보수 모드 (WO-INT-003, PR #2 머지) |
| 로컬 알림 | SMTP·Teams·ServiceNow, 결과를 `local_notified` 로 전달 (WO-INT-003) |
| 장치 CSR | `bin/cflex-csr.js` — `HAEA.cap01` 생성 확인 |
| 연동 점검 | `bin/cflex-portal-check.js` — 이 문서 §0 의 출처 |
| 프록시 | `HTTPS_PROXY` Basic 지원 (Q-04=(A), NTLM 제외) |
| 테스트 | 58/58 |

남은 미확정은 HAEA 회신 대기분이고 포털과 무관하다 — 프록시 주소·SMTP 릴레이·
ServiceNow 엔드포인트 (spec 01 §6-3), NMC VLAN 라우팅 (§6-1), keepalived VIP (§6-2).
