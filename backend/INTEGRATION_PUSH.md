# Push integration — drop into running cflex-v2

Adds Expo push fan-out for the C-Flex FMS mobile app
(`/Users/macstudio/work/cflex-mobile/apps/fms`).

## 1. Run migration

```bash
sqlite3 /opt/cflex-v2/cflex-api/cflex.db < backend/migrations/002_fms_push_subscriptions.sql
```

Idempotent — safe to re-run.

## 2. Drop new files

```bash
cp backend/services/expo-push-notifier.js  /opt/cflex-v2/cflex-api/src/services/
cp backend/routes/fms-push.routes.js       /opt/cflex-v2/cflex-api/src/routes/
```

## 3. Mount the push router (one line in app bootstrap)

In the file that mounts `fms.routes.js` (e.g. `src/app.js` or `src/index.js`),
add the push router on the same `/v1/fms` base:

```js
app.use('/v1/fms', require('./routes/fms.routes'));
app.use('/v1/fms', require('./routes/fms-push.routes'));   // ← add this line
```

The router declares: `POST /devices/push-token`, `DELETE /devices/push-token`,
`GET /devices/push-subscriptions`.

## 4. Patch `alarm-notifier.js` (one require + one call)

Open `src/services/alarm-notifier.js`. Two minimal edits:

### 4a. Add require near the top

```js
const expoPush = require('./expo-push-notifier');
```

### 4b. Call `expoPush.dispatch(...)` at the end of `notify()`

Inside `async function notify(alert)`, after the `for (const rule of rules)` loop
but before `return results;`, add:

```js
    // Fan out to Expo push subscribers (FMS mobile app). Independent of
    // fms_alarm_routes — uses per-user subscription filter.
    try {
      await expoPush.dispatch(alert, asset);
    } catch (e) {
      console.error('[alarm-notifier] expo-push fan-out failed:', e.message);
    }
```

That's it. `expo-push-notifier.js` reads `fms_push_subscriptions` directly,
applies each subscriber's `min_severity`, batches in 100s to Expo, and
prunes `DeviceNotRegistered` tokens automatically.

## 5. Restart

```bash
pm2 restart cflex-api-v2
```

## 6. Verify

```bash
# Logs should show successful registration on first mobile app push toggle:
pm2 logs cflex-api-v2 | grep expo-push

# On a real alarm firing:
# [expo-push] 12345 → 1/1 delivered
```

## Notes

- No Expo credentials are required for the **server-side** call (Expo Push
  service handles APNs/FCM cert internally for tokens belonging to apps built
  via EAS or Expo Go).
- For **production iOS push delivery via APNs**, the mobile app needs to be
  built via `eas build` with the project's iOS push key uploaded
  (`eas credentials` handles this on first build).
- Per-subscriber `min_severity` defaults to `warn` — `ok` info-level events
  do not push by default. Adjust per-subscription via the
  `UPDATE fms_push_subscriptions SET min_severity = …` SQL or by extending
  the route.
