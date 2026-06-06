# Alert ack — drop into running cflex-v2

Adds acknowledge/unacknowledge endpoints used by the FMS mobile app's alarm detail screen.

## 1. Migration

```bash
sqlite3 /opt/cflex-v2/cflex-api/cflex.db < backend/migrations/003_alerts_ack.sql
```

⚠ Will error harmlessly on re-run (`duplicate column name`). That's expected — `ALTER TABLE` is the only way SQLite adds a column.

## 2. Drop in route file

```bash
cp backend/routes/fms-ack.routes.js /opt/cflex-v2/cflex-api/src/routes/
```

## 3. Mount the router (1 line)

In your app bootstrap, after the existing fms routes:

```js
app.use('/v1/fms', require('./routes/fms.routes'));
app.use('/v1/fms', require('./routes/fms-push.routes'));
app.use('/v1/fms', require('./routes/fms-ack.routes'));   // ← add this
```

## 4. Surface `acked_at` / `acked_by` in `/alerts` SELECT (optional but recommended)

Open `src/routes/fms.routes.js`, find the `GET /alerts` handler (around line 193), and extend the SELECT list:

```diff
-  const rows = db.prepare(`SELECT a.*,
-                                  d.label AS device_label, d.room, d.rack, d.muted_until
-                           FROM alerts a
+  const rows = db.prepare(`SELECT a.*, a.acked_at, a.acked_by,
+                                  d.label AS device_label, d.room, d.rack, d.muted_until
+                           FROM alerts a
```

(`a.*` already includes the new columns post-migration, so the explicit listing is just for clarity. No code change strictly required.)

## 5. Restart

```bash
pm2 restart cflex-api-v2
```

## Verify

```bash
# As an authenticated FMS user:
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://cflex.runless.co.uk/v1/fms/alerts/123/ack
# {"ok":true,"id":123,"acked_at":1717631100000,"acked_by":"eric@runless.co.uk"}

curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://cflex.runless.co.uk/v1/fms/alerts/123/unack
# {"ok":true,"id":123}
```

## Mobile UI

`apps/fms/app/alarm/[id].tsx` shows an "Acknowledge" button that flips on the alert's `acked` flag, and "Unacknowledge" when already acked. Audit (`acked_by`) is rendered on the detail screen.
