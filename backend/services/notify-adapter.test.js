// node backend/services/notify-adapter.test.js
//
// The adapter is the only place that knows both sides, so it is the only place
// a translation error can hide. Two things matter: that an FMS alert row maps
// to the same message the production notifier would have produced, and that
// the environment is read HERE and nowhere deeper.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const A = require('./notify-adapter');

const T0 = Date.UTC(2026, 9, 23, 7, 30, 0);
const alert = {
  id: 9001, tenant_id: 10, device_id: 'ups-57', priority: 'P1',
  metric: 'output_source', message: 'UPS on battery', value: 'onBattery',
  threshold: 'onLine', received_at: T0,
};
const asset = { label: 'HMA UPS 2E-A', location: 'HMA', room: 'IDF2', rack: 'Rack 1' };

let fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

(async () => {
  await t('an alert row becomes the same message the old notifier produced', () => {
    const n = A.toNotification(alert, asset);
    const msg = A.notify.formatMessage(n, { productName: 'C-Flex FMS' });
    // alarm-notifier's formatMessage built exactly these four parts.
    assert.equal(msg.head, '[P1] HMA UPS 2E-A');
    assert.equal(msg.where, 'HMA · IDF2 · Rack 1');
    assert.equal(msg.body, 'UPS on battery');
    assert.equal(msg.detail, '· metric: output_source · value: onBattery · threshold: onLine');
    // With no asset it falls back to the device id, as before.
    assert.equal(A.notify.formatMessage(A.toNotification(alert, null), {}).head, '[P1] ups-57');
  });

  await t('the dedup key reuses the incident layer rather than inventing one', () => {
    assert.equal(A.toNotification({ ...alert, dedup_key: 'abc' }, asset).dedupKey, 'abc');
    // Without one, device/metric is a stable fallback — and it must not be a
    // second scheme that disagrees with the first.
    assert.equal(A.toNotification(alert, asset).dedupKey, 'ups-57/output_source');
    assert.equal(A.toNotification({ ...alert, metric: null }, asset).dedupKey, null);
  });

  await t('route rows translate, including a disabled one', () => {
    const r = A.toRoutes([
      { channel: 'email', min_priority: 'P2', target: 'a@b', enabled: 1 },
      { channel: 'sms', min_priority: null, target: '+1555', enabled: 0 },
    ]);
    assert.deepEqual(r[0], { channel: 'email', target: 'a@b', minPriority: 'P2', enabled: true, label: null });
    assert.equal(r[1].minPriority, 'P2', 'a null floor defaults to P2, as the SQL default did');
    assert.equal(r[1].enabled, false);
  });

  await t('the environment is read in the adapter and nowhere deeper', () => {
    const cfg = A.configFromEnv({
      RESEND_API_KEY: 'k', SC_INTERNAL_URL: 'http://sc:3200',
      FMS_DASHBOARD_URL: 'https://fms.haeaus.internal/',
    });
    assert.equal(cfg.email.transport, 'resend');
    assert.equal(cfg.dashboardUrl, 'https://fms.haeaus.internal/');
    // No Resend key means SMTP — which is the on-premises shape.
    assert.equal(A.configFromEnv({}).email.transport, 'smtp');
    // ServiceNow only appears when configured, so plan() can report it as
    // missing rather than half-present.
    assert.equal(A.configFromEnv({}).servicenow, undefined);
    assert.equal(A.configFromEnv({ SNOW_INSTANCE_URL: 'https://x' }).servicenow.instanceUrl, 'https://x');

    // And the package itself still reads nothing.
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    for (const f of ['index.js', 'channels.js', 'message.js', 'http.js']) {
      const src = strip(fs.readFileSync(path.join(__dirname, '..', '..', 'packages', 'notify', 'src', f), 'utf8'));
      assert.ok(!/process\.env/.test(src), `packages/notify/src/${f} reads the environment`);
    }
  });

  await t('dispatchAlert uses the DB routes and hands back log rows to write', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE fms_alarm_routes (tenant_id INTEGER, channel TEXT, min_priority TEXT,
             target TEXT, enabled INTEGER);`);
    db.prepare('INSERT INTO fms_alarm_routes VALUES (?,?,?,?,?)').run(10, 'webhook', 'P2', 'https://x/y', 1);
    db.prepare('INSERT INTO fms_alarm_routes VALUES (?,?,?,?,?)').run(10, 'slack', 'P2', 'https://hooks.slack.com/services/a/b/c', 1);
    db.prepare('INSERT INTO fms_alarm_routes VALUES (?,?,?,?,?)').run(10, 'sms', 'P1', '+1555', 0);
    db.prepare('INSERT INTO fms_alarm_routes VALUES (?,?,?,?,?)').run(99, 'webhook', 'P2', 'https://other/tenant', 1);

    const seen = [];
    const http = async (url, body) => { seen.push(url); return { ok: !url.includes('slack'), json: {}, error: 'HTTP 404' }; };
    const out = await A.dispatchAlert(db, alert, { asset, config: A.configFromEnv({}), deps: { http } });

    assert.ok(!seen.some(u => u.includes('other/tenant')), 'another tenant\'s route is not used');
    assert.equal(out.sent, 1);
    assert.equal(out.failed, 1);
    // The log is the caller's table, so the adapter hands back rows instead of
    // writing them.
    assert.equal(out.logRows.length, 2);
    assert.deepEqual(Object.keys(out.logRows[0]).sort(),
      ['alert_id', 'channel', 'error', 'ok', 'sent_at', 'target', 'tenant_id']);
    assert.equal(out.logRows.find(r => r.channel === 'slack').ok, 0);
    assert.equal(out.logRows[0].alert_id, 9001);

    // No routes at all is not an error, and nothing is attempted.
    const empty = await A.dispatchAlert(db, { ...alert, tenant_id: 42 }, { asset, deps: { http } });
    assert.deepEqual([empty.sent, empty.failed, empty.results.length], [0, 0, 0]);
  });

  console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - the FMS schema stops at the adapter');
  process.exit(fail ? 1 : 0);
})();
