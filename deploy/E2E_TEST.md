# End-to-End Push + Ack Test (real device)

Verifies the full chain: probe → alert → alarm-notifier → Expo Push → phone notification → tap → app opens alarm detail → ack → DB updated.

Pre-req: `deploy-push-ack.sh` ran successfully on the cflex-v2 VM and `pm2 status cflex-api-v2` is online.

## Part A — VM side (you, in SSH)

### A1. Verify deploy state

```bash
cd /path/to/cflex-fms/deploy
./test-push-ack.sh
```

Expected:
- ✓ `fms_push_subscriptions` table exists
- ✓ `alerts.acked_at` / `acked_by` columns exist
- ✓ POST `/v1/fms/devices/push-token` mounted (401 unauthenticated = good)
- ✓ POST `/v1/fms/alerts/:id/ack` mounted (401 unauthenticated = good)

If any ✘ — re-run `deploy-push-ack.sh` and inspect output.

### A2. Tail logs in a separate window

```bash
pm2 logs cflex-api-v2 | grep -E 'expo-push|alarm-notifier|fms-push'
```

Keep this open for the duration of the test.

## Part B — Phone side (Eric, with real device)

### B1. Install Expo Go

- iOS: https://apps.apple.com/app/expo-go/id982107779
- Android: https://play.google.com/store/apps/details?id=host.exp.exponent

### B2. Start Metro dev server

On the Mac:

```bash
cd /Users/macstudio/work/cflex-mobile
npm run fms                # or:  cd apps/fms && npx expo start --tunnel
```

If phone and Mac are on different networks, use `--tunnel`.

Scan the QR with Expo Go (iOS camera → tap banner, Android → Expo Go app).

### B3. Log in

Use any real FMS account (e.g. `htl-admin@hyundai.com`). Demo mode will NOT register a push token, so it must be a real account to test the full chain.

### B4. Enable push

- Bottom tab → **Settings**
- Toggle **푸시 알림 / Push notifications** ON
- iOS will ask for permission → Allow
- A toast/confirmation should appear; if not, check the toggle stayed ON

### B5. Confirm token was registered (on VM)

```bash
sqlite3 /opt/cflex-v2/cflex-api/cflex.db \
  "SELECT id, tenant_id, user_id, platform, device_name, min_severity,
          datetime(last_seen_at/1000,'unixepoch','localtime') AS last_seen
   FROM fms_push_subscriptions ORDER BY last_seen_at DESC LIMIT 5;"
```

You should see one row with your `tenant_id` and a recent `last_seen` timestamp.

## Part C — Trigger an alarm

### C1. Real route — make a probe POST (recommended, exercises full `notify()` path)

This is the path the real probe uses. It runs every other event through the normal pipeline (dedup, ticket, RCA, all channels including the new Expo push).

```bash
# On the VM (uses internal probe key from .env)
curl -X POST http://localhost:3000/v1/probe/event \
  -H "Content-Type: application/json" \
  -H "X-Probe-Key: $PROBE_KEY" \
  -d '{
    "tenant_id": 1,
    "device_id": "ups-1",
    "priority": "P1",
    "metric": "manual_test",
    "message": "TEST: end-to-end push fan-out",
    "value": 0, "threshold": 0,
    "received_at": '"$(date +%s%3N)"'
  }'
```

Replace `tenant_id`, `device_id`, `PROBE_KEY` with your environment's values.

### C2. Fallback — insert directly into `alerts` table

⚠ This **bypasses** `notify()` so it will NOT push. Useful only for testing the `ack` endpoint, not push.

```bash
sqlite3 /opt/cflex-v2/cflex-api/cflex.db \
  "INSERT INTO alerts (tenant_id, device_id, priority, metric, message, value, threshold, received_at)
   VALUES (1, 'ups-1', 'P1', 'manual', 'TEST ack only', 0, 0, $(date +%s%3N));
   SELECT last_insert_rowid();"
```

## Part D — Verify push arrived

### D1. Logs (VM)

```
[alarm-notifier] 12345 line → OK
[alarm-notifier] 12345 sms → OK
[expo-push] 12345 → 1/1 delivered
```

If you see `0/1 delivered` — check the Expo response in logs; common causes:
- `DeviceNotRegistered` — token is stale, auto-pruned. Re-enable push from Settings.
- `MessageRateExceeded` — too many sends; back off.

### D2. Phone

- Lock screen / notification banner appears with `[P1] <device label>`
- **Tap the notification** → app opens to `/alarm/{id}` automatically (cold-start or warm)

### D3. From the alarm detail screen

- **Acknowledge** button → press
- Card now shows `Acked by: <your email>` and relative time
- **Unacknowledge** button replaces it for a roundtrip

### D4. Verify ack landed in DB

```bash
sqlite3 /opt/cflex-v2/cflex-api/cflex.db \
  "SELECT id, device_id, priority, acked_at, acked_by
   FROM alerts WHERE id = <YOUR_ALERT_ID>;"
```

`acked_at` and `acked_by` should now be populated.

## Part E — Optional: device mute round-trip

- App → Devices → tap the test device
- **Mute 1h** button → press
- Card flips to yellow "Muted" with relative end time
- VM:
  ```bash
  sqlite3 /opt/cflex-v2/cflex-api/cflex.db \
    "SELECT id, label, muted_until, muted_reason FROM ups_devices WHERE id = 1;"
  ```
- App → **Unmute** → mute fields clear on next refresh

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Toggle reverts to OFF immediately | Permission denied | Device Settings → C-Flex FMS → Notifications |
| Toggle ON, no DB row | Network/auth fail; check `fms.registerPushToken` request | `pm2 logs` for `/devices/push-token` errors |
| Probe event fires but no `[expo-push]` log | alarm-notifier.js not patched | Re-run `deploy-push-ack.sh` (it's idempotent) |
| `[expo-push] 0/1 delivered` (DeviceNotRegistered) | Token went stale (app reinstall) | Re-toggle push in Settings |
| Notification arrives but tap doesn't open alarm | `data.alertId` missing from push payload | Check `expo-push-notifier.js` line ~80 (`data:` field) |
| Ack POST returns 404 | `fms-ack.routes` not mounted | Grep bootstrap; re-run deploy |
| Ack returns 200 but DB unchanged | Tenant mismatch on alert | Check alert's `tenant_id` matches token's `tenantId` |

## Rollback (if something explodes)

```bash
./rollback-push-ack.sh /opt/cflex-v2/cflex-api/.backups/push-ack-<timestamp>
```

Restores DB, alarm-notifier.js, and bootstrap from the snapshot taken at deploy time.
