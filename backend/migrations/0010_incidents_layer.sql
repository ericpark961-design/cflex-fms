-- cflex_응대레이어_스펙 Phase 1 — Incident 단일 진실원천 상품화.
--
-- 기존 cflex_tickets/notes/rca를 폐기하지 않고 **확장**한다.
-- 외부 API는 /v1/incidents 로 일관 노출 (내부 테이블은 그대로 cflex_tickets).
--
-- 갭:
--   1. severity (priority와 별도 — alarm severity)
--   2. dedup_key + 활성 인시던트 unique partial index
--   3. channels JSONB (Phase 2 옴니채널 통지 기록)
--   4. cbu (HMA/KUS/HAEA 같은 조직 단위)
--   5. source (alarm | manual | snow_callback)
--   6. 'ack' state 추가
--   7. incident_alarm_links — 한 인시던트에 여러 후속 알람 attach.

BEGIN;

ALTER TABLE cflex_tickets
  ADD COLUMN IF NOT EXISTS severity   VARCHAR(16),                          -- critical | warn | info
  ADD COLUMN IF NOT EXISTS cbu        VARCHAR(32),
  ADD COLUMN IF NOT EXISTS source     VARCHAR(16) DEFAULT 'manual',         -- alarm | manual | snow_callback
  ADD COLUMN IF NOT EXISTS dedup_key  VARCHAR(160),                         -- tenant+asset+severity+symptom
  ADD COLUMN IF NOT EXISTS channels   JSONB DEFAULT '[]'::jsonb,            -- ["teams","line","email"] Phase 2+
  ADD COLUMN IF NOT EXISTS ack_at     TIMESTAMPTZ,                          -- 'ack' state 진입 시각
  ADD COLUMN IF NOT EXISTS ack_by     VARCHAR(128);

-- state machine 확장: open → ack → in_progress → resolved → closed.
-- 기존 status 컬럼 재사용. CHECK 제약 (있는 row에 ack가 없어도 OK — 빈 값은 open으로 처리).
ALTER TABLE cflex_tickets
  DROP CONSTRAINT IF EXISTS ck_tickets_status;
ALTER TABLE cflex_tickets
  ADD CONSTRAINT ck_tickets_status
  CHECK (status IN ('open', 'ack', 'in_progress', 'resolved', 'closed'));

-- 활성 인시던트 dedup — 같은 (tenant, dedup_key, 미해결 상태) 에 1건만.
-- 같은 알람이 5분 간격으로 재발해도 인시던트는 1개로 유지(타임라인만 append).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_dedup_active
  ON cflex_tickets(tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL
    AND status IN ('open', 'ack', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_tickets_severity ON cflex_tickets(severity, status);
CREATE INDEX IF NOT EXISTS idx_tickets_cbu      ON cflex_tickets(cbu, status);
CREATE INDEX IF NOT EXISTS idx_tickets_dedup    ON cflex_tickets(tenant_id, dedup_key);


-- 알람 ↔ 인시던트 다대일 링크 (한 인시던트에 여러 알람 attach).
-- 같은 인시던트에 후속 알람이 들어오면 새 인시던트 만들지 않고 여기 append.
CREATE TABLE IF NOT EXISTS cflex_incident_alarm_links (
  ticket_id    UUID NOT NULL REFERENCES cflex_tickets(id) ON DELETE CASCADE,
  alarm_id     BIGINT NOT NULL,                       -- 외부 알람 ID (alerts.id 등)
  alarm_source VARCHAR(32) NOT NULL DEFAULT 'fms',    -- fms | network | sbc | manual
  attached_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, alarm_source, alarm_id)
);
CREATE INDEX IF NOT EXISTS idx_inc_links_alarm ON cflex_incident_alarm_links(alarm_source, alarm_id);


-- timeline 확장: cflex_ticket_notes에 kind 추가.
-- state_change | channel_send | channel_inbound | snow_sync | comment | assign | rca | alarm_attach
ALTER TABLE cflex_ticket_notes
  ADD COLUMN IF NOT EXISTS kind       VARCHAR(32) DEFAULT 'comment',
  ADD COLUMN IF NOT EXISTS body_json  JSONB;                              -- 구조화 페이로드 (state from→to 등)

CREATE INDEX IF NOT EXISTS idx_notes_kind ON cflex_ticket_notes(ticket_id, kind);


COMMIT;
