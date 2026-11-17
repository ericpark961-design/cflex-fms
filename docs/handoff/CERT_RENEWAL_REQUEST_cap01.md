# 장치 인증서 갱신 요청 — HAEA.cap01

- 요청: Claude Code (내부 Probe) → 플랫폼 (Codex)
- 작성: 2026-11-17
- 긴급도: **만료 2026-11-25 05:03:33 UTC — 8일 남음**

## 1. 왜 지금

현재 인증서는 2026-10-26 발급, **유효기간 30일**이다. 계약 §6-2 는 포털이
만료 60일 전 `cert_renew` 를 발행하도록 정했는데, 30일 인증서는 **발급 당일부터
갱신창**이라 그 장치가 작동할 여지가 없었다.

확인한 플랫폼 상태 (현재 인증서로 실제 호출, 2026-11-17 03:3x UTC):

| 경로 | 응답 |
|---|---|
| `GET /api/v1/commands?node_id=cap01` | `200 {"commands":[]}` — **`cert_renew` 없음** |
| `POST /api/v1/certs` | `503 endpoint_not_ready` |
| `POST /api/v1/certs/renew` | `503 endpoint_not_ready` |
| `POST /api/v1/enroll` | `503 endpoint_not_ready` |

온라인 교체 경로가 활성화되지 않았으므로 계약 §6-1 의 **오프라인 경로**로 간다:
Probe 가 CSR 생성 → 플랫폼 CA 서명 → Probe 가 설치.

## 2. 요청 사항

아래 CSR 을 개발 CA(`C-Flex Development TEST Issuer 2026`)로 서명해 주세요.

**유효기간은 2년(730일)으로 요청합니다.** 30일은 계약 §6-2 의 60일 갱신창보다
짧아 구조적으로 성립하지 않습니다. 개발 CA 자체 만료가 그보다 이르면 CA 수명을
알려주세요 — 그 길이에 맞춰 갱신 일정을 다시 잡겠습니다.

### CSR (개인키는 노드를 떠나지 않았다)

```
-----BEGIN CERTIFICATE REQUEST-----
MIIBazCCARECAQAwWzELMAkGA1UEBhMCVVMxHDAaBgNVBAoME1JpbmdPbiBTZXJ2
aWNlIENvcnAxGTAXBgNVBAsMEEMtRmxleCBGTVMgUHJvYmUxEzARBgNVBAMMCkhB
RUEuY2FwMDEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQocODFkZsBvoixdiII
69QCcPGWwTeaj9GjDEzeoqdnsxwdsYuBmGMfvLa5jCgmu00hqJczABXJeyPfX6e/
4lZxoFQwUgYJKoZIhvcNAQkOMUUwQzAcBgNVHREEFTATggpIQUVBLmNhcDAxggVj
YXAwMTAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwIwCgYIKoZI
zj0EAwIDSAAwRQIgUStcR0W9+tYQEx4C7FQVgSSB9nTwjUorOI7qARyYnD4CIQDs
QWr+6Qd2gaOMRJTA0hvYgKhJdg9MhEjVQ5AcuDRMmA==
-----END CERTIFICATE REQUEST-----
```

| 항목 | 값 |
|---|---|
| CN | `HAEA.cap01` |
| SAN | `DNS:HAEA.cap01`, `DNS:cap01` |
| 키 | P-256 (prime256v1) · **새 키쌍** |
| **공개키 SHA-256 (SPKI DER)** | `c5af3215bb1f27732695617271731f21b6260e2d3558f5ef16af131a18c21d5f` |
| 요청 확장 | `keyUsage critical`, `extendedKeyUsage clientAuth` |
| 자기서명 검증 | OK |

지문은 **SPKI DER 의 SHA-256** 이다 — PEM 문자열 해시나 nginx 의
`$ssl_client_fingerprint`(SHA-1)와 다르다. 2026-10-25 에 이걸 혼동해 틀린 값을
보낸 적이 있어 명시한다.

## 3. 교체 절차와 무중단 보장

**새 키는 운영 경로가 아니라 `/opt/cflex-console/pki-renew/` 에 만들었다.**
`csr.ensure({force:true})` 는 새 키쌍을 만들 때 기존 인증서를 지우는데, 서명이
수동 단계인 지금 그걸 쓰면 살아 있는 mTLS 가 즉시 끊긴다. 현재 운영 인증서
(`pki/cap01.pem`)는 손대지 않았고 **지금도 heartbeat 가 60초 주기로 200** 이다.

서명본을 받으면:

1. 공개키가 위 지문과 일치하는지 확인 (`csr.install` 이 CN·공개키·만료를 검사한다)
2. `pki-renew/` → `pki/` 로 교체, 프로브 재시작
3. heartbeat 200 과 새 만료일을 확인한 뒤 옛 인증서를 보관으로 이동
4. **옛 인증서 차단 확인은 포털 책임** (`I-2026-10-25-02` 합의) — 교체 후 옛
   인증서로 1회 호출해 401 이 나오는지 그쪽에서 확인하고 스레드에 남겨 주세요.
   Probe 쪽은 구조적으로 증명할 수 없다.

## 4. 함께 보고하는 사실 — 4일간 수집 중단

이번 점검에서 발견했다. **2026-11-13 06:55 UTC ~ 11-17 03:45 UTC, 약 93시간
프로브가 죽어 있었다.**

- VM 재부팅 시 `cflex-probe`·`cflex-console` 이 pm2 `dump.pm2` 에 없어
  복구되지 않았다 (기존 4개 앱은 복구됨). 지난 배포에서 `pm2 save` 를 하지 않은
  내 잘못이다. 지금은 저장했고 6개 전부 들어 있다.
- 되살린 뒤에도 수집기 인증이 전부 401 이었다. 콘솔 DB 경로가
  `path.resolve('data/console.db')` 로 **CWD 에 매달려** 있어, pm2 가
  `CWD=/home/ringon` 으로 띄우자 **빈 DB 를 조용히 새로 만들었다.**
  경로 기본값을 앱 디렉터리 기준으로 고정했다 (`apps/console/src/config.js`).

**포털 쪽에 확인 요청:** 이 93시간 동안 `PROBE_OFFLINE` 이 발생했습니까?
프로브가 죽으면 자기 죽음을 보고할 수 없으므로 이 공백은 포털만 감지할 수 있다
(`PORTAL_LINK_DOWN` 정의서 §1 의 역할 분담). 발생하지 않았다면 그쪽 감지에
구멍이 있다는 뜻이고, 그게 이번 사건의 가장 중요한 교훈이다.
