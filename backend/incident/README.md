# cflex Incident Layer — 상품화 단일 모델

> 스펙: `../../../stock-sentinel/cflex_응대레이어_스펙.md`
> 정체: AI 옴니채널 컨택센터의 **단일 진실원천**.
> 1 알람 = 1 인시던트 = N 채널 뷰(Teams/LINE/WhatsApp/SMS/Email/SNOW).

## 방향
**기존 자산을 폐기하지 않고 확장한다.** cflex_tickets + _notes + _rca가 이미 80% 완성 —
갭(severity·dedup_key·channels·cbu·ack 상태·alarm_link)만 채우고 외부 API를 `/v1/incidents`로 통일한다.

## 갭 분석 → 패치

| 스펙 §1 필드 | 기존 컬럼 | 패치 |
|---|---|---|
| id | `cflex_tickets.id` (UUID) | 그대로 |
| tenant_id, site, asset | 있음 | 그대로 |
| cbu | 없음 | `ADD COLUMN cbu` |
| severity (alarm) | `priority` (P1~P4) | `ADD COLUMN severity` (critical/warn/info) + 매핑 |
| state | `status` (open/in_progress/resolved/closed) | `ADD ack` (5단계로) |
| source_alarm_id | `alert_metric`만 | **`cflex_incident_alarm_links`** 신규 (다대일) |
| dedup_key | 없음 | `ADD COLUMN dedup_key` + **활성 partial unique index** |
| channels[] | 없음 | `ADD COLUMN channels JSONB` (Phase 2 옴니채널 통지 기록) |
| snow_ticket_id | `snow_incident` | 그대로 |
| rca{draft,final,by} | `cflex_ticket_rca` | 그대로 (Phase 4 confidence/actions 이미 있음) |
| timeline | `cflex_ticket_notes` | `ADD kind + body_json` (state_change/channel_send/comment) |
| state machine | status 단순 update | **명시적 5상태 + 전이 가드** (이 디렉토리) |

## 파일
- `state_machine.js` — 순수 로직: 전이 가드, dedup_key 생성, severity↔priority 매핑.
- `state_machine.test.js` — 14 passed (`node --test`).
- `../migrations/0010_incidents_layer.sql` — PG ALTER + 신규 인덱스/링크 테이블.
- `../routes/incidents.routes.js` — `/v1/incidents` 외부 API (cflex_tickets 위 매핑).

## API (상품화 외부 명명)

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/v1/incidents?state=open,ack&severity=critical&cbu=HMA` | 리스트·필터 |
| GET | `/v1/incidents/:id` | 상세 + timeline + linked_alarms |
| POST | `/v1/incidents` | 생성 (dedup 1단계, 활성 동일 키 있으면 attach만) |
| PATCH | `/v1/incidents/:id/state` | 상태 전이 (`{from→to}` 가드) |
| POST | `/v1/incidents/:id/timeline` | 코멘트·이벤트 append (kind 지정) |
| POST | `/v1/incidents/:id/rca/draft` | AI RCA 초안 저장 (사람 게이트 — 고객 발송 별도) |

## 상태머신

```
       ┌──── reopen ────┐
       ▼                │
[open] → [ack] → [in_progress] → [resolved] → [closed]
   │       │           │              │
   └───────┴───────────┴──────────────┴── 직행 닫기 가능 (잘못 생성 등)
```

활성(dedup 대상): `open`, `ack`, `in_progress`.

## 상품화 단계

- ✅ **Phase 1**: 단일 모델 (이 차수) — 컬럼·인덱스·dedup·상태머신·외부 API.
- ⏳ Phase 2: 옴니채널 1~2개 (Teams + Email 또는 LINE). `channels[]` 채우기 + 채널 어댑터.
- ⏳ Phase 3: ServiceNow **양방향** 동기화.
- ⏳ Phase 4: AI 트리아지(상관·dedup 2단계·자동 라우팅) + RCA 초안 + 메시지 초안. **사람 게이트**.
- ⏳ Phase 5: 나머지 채널 + 에스컬레이션 체인 + RCA → 예지 피드백.

## 검증 (스펙 §9)
1. 같은 알람이 5분 간격으로 N회 와도 인시던트 1개 (dedup_key 활성 unique).
2. 상태 전이는 `canTransition` 가드 통과해야 함 — 409 Conflict 반환.
3. Phase 2 채널 발송은 `channels[]` append + timeline `channel_send` 행.
4. Phase 3 SNOW 상태 변경 → cflex `state` 동기 (양방향).
5. AI RCA는 `draft`로 저장. 고객 발송은 별도 `/finalize` 엔드포인트 (사람 승인).
