-- 0002_portal_outbox — the Portal sender moves from the Collector to the FMS (WO-INT-012, D-13).
-- Additive only (Q-2026-10-26-12): three new tables and one new column; nothing existing changes.
--
-- Collectors (cap01, cap02 …) send only to the FMS. The FMS sends to the Portal (contract 00 v1.2),
-- from whichever app node holds the sender lock (portal.js). What it has not delivered yet waits
-- here, in order, with its Idempotency-Key fixed at enqueue time — the 7-day buffer (contract §1,
-- D-07) that used to be the Collector's SQLite file.

CREATE TABLE portal_outbox (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts          BIGINT NOT NULL,                -- enqueued at (epoch ms); purged after CFLEX_PORTAL_BUFFER_DAYS
  name        TEXT NOT NULL,                  -- inventory | telemetry | events
  method      TEXT NOT NULL,
  idem_key    TEXT NOT NULL,                  -- Idempotency-Key, the same on every retry
  body        TEXT NOT NULL,                  -- the contract payload (JSON), already whitelisted and validated
  not_before  BIGINT NOT NULL DEFAULT 0,      -- events wait here while the console notifies (local_notified)
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
CREATE INDEX idx_portal_outbox_ts ON portal_outbox(ts);

-- Several collectors can see the same device and raise the same fault, each with its own
-- alarm_id. The FMS keeps one alarm (the first one opened) and maps every collector's alarm_id
-- onto it; the alarm clears when the last collector that raised it clears it.
CREATE TABLE alarm_sources (
  source_alarm_id TEXT PRIMARY KEY,           -- the alarm_id the collector's engine gave it
  alarm_id        TEXT NOT NULL,              -- the FMS alarm (alarms.alarm_id) it belongs to
  collector_id    TEXT,
  state           TEXT NOT NULL CHECK (state IN ('open', 'cleared')),
  updated_at      BIGINT NOT NULL
);
CREATE INDEX idx_alarm_sources_alarm ON alarm_sources(alarm_id, state);

-- Which collector reported each event (history only; NULL for rows from before 0002).
ALTER TABLE alarm_events ADD COLUMN collector_id TEXT;

-- A device whose contract ID changed (its serial became known, Q-2026-10-25-05): the old ID is
-- sent once more in the next inventory, with replaced_by (contract §2).
CREATE TABLE device_replaced (
  device_id    TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL,
  replaced_by  TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  sent_at      BIGINT
);
