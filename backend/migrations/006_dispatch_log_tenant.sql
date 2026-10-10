-- fms_alarm_dispatch_log.tenant_id — the column /v1/fms/channels/health has
-- always queried and never had.
--
-- 001 created the table as (id, alert_id, channel, target, ok, error, sent_at).
-- channels/health filters `WHERE tenant_id=?`, so that endpoint has returned
-- 500 "no such column: tenant_id" since it was written — the channel-status
-- panel (v5 §8: 미설정 / 정상 / 오류 를 구분해 노출) has never worked, and the
-- API log fills with the error every 30 seconds as the screen polls it.
--
-- Backfill cannot go through alert_id: 1,163 of 1,164 rows have alert_id = 0,
-- because alarm-notifier passes `id: 0` for probe-raised alarms. The route's
-- target is the usable key — a dispatch went to a target that belongs to one
-- tenant's fms_alarm_routes row — so that is what the UPDATE below matches on.
-- Rows whose target no longer exists in any route stay NULL and are excluded
-- from the per-tenant view rather than shown to everyone.
--
-- Additive. apply.js swallows exactly "duplicate column name", so re-running is
-- safe; the backfill is idempotent because it only fills NULLs.

ALTER TABLE fms_alarm_dispatch_log ADD COLUMN tenant_id INTEGER;

UPDATE fms_alarm_dispatch_log
   SET tenant_id = (
         SELECT r.tenant_id FROM fms_alarm_routes r
          WHERE r.target = fms_alarm_dispatch_log.target
          ORDER BY r.id LIMIT 1)
 WHERE tenant_id IS NULL
   AND target IS NOT NULL;

UPDATE fms_alarm_dispatch_log
   SET tenant_id = (
         SELECT a.tenant_id FROM alerts a
          WHERE a.id = fms_alarm_dispatch_log.alert_id)
 WHERE tenant_id IS NULL
   AND alert_id IS NOT NULL
   AND alert_id <> 0;

CREATE INDEX IF NOT EXISTS idx_dispatch_log_tenant
  ON fms_alarm_dispatch_log(tenant_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_log_channel
  ON fms_alarm_dispatch_log(channel, sent_at);
