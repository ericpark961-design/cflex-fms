// node test/notify.test.js
//
// No network. The HTTP client is injected, so every dispatcher is exercised
// against a recorder that captures the URL, headers and body it would have
// sent — which is the part another codebase has to trust.
const assert = require('node:assert');
const notify = require('../src');
const { CHANNELS, dispatchers, adaptiveCard } = require('../src/channels');

const T0 = Date.UTC(2026, 9, 23, 7, 30, 0);

/** Records calls and answers however the test says. */
function recorder(reply = { ok: true, status: 200, json: {} }) {
  const calls = [];
  const http = async (url, body, opts = {}) => {
    calls.push({ url, body, headers: opts.headers || {} });
    return typeof reply === 'function' ? reply(url, body) : reply;
  };
  return { http, calls };
}

const alarm = {
  priority: 'P1', title: 'UPS on battery', where: 'HMA · IDF2 · Rack 1',
  deviceId: 'ups-57', deviceLabel: 'HMA UPS 2E-A', metric: 'output_source',
  value: 'onBattery', threshold: 'onLine', id: 'alarm-9001', at: T0,
};
const cfg = {
  productName: 'C-Flex FMS', dashboardUrl: 'https://fms.internal/haea',
  fromName: 'RingOn FMS', fromAddress: 'fms-noreply@haeaus.com',
  sentinelConnect: { url: 'http://sc.internal:3200/', apiKey: 'k' },
  runlessUc: { url: 'http://uc.internal:3100', apiKey: 'k' },
  email: { transport: 'resend', resendKey: 'key' },
  servicenow: { instanceUrl: 'https://haea.service-now.com', auth: 'Basic x' },
};

let fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

(async () => {
  await t('nine channels, and the list is the contract', () => {
    assert.deepEqual(CHANNELS.sort(), ['discord', 'email', 'line', 'pagerduty', 'servicenow', 'slack', 'sms', 'teams', 'webhook']);
    for (const c of CHANNELS) {
      assert.equal(typeof dispatchers[c].send, 'function', `${c} has a send`);
      assert.ok(Array.isArray(dispatchers[c].requires), `${c} declares what it requires`);
    }
  });

  await t('a route below its priority floor does not fire', () => {
    const routes = [
      { channel: 'slack', target: 'https://hooks.slack.com/services/a/b/c', minPriority: 'P1' },
      { channel: 'webhook', target: 'https://x/y', minPriority: 'P3' },
    ];
    const p1 = notify.plan({ priority: 'P1' }, routes, cfg);
    assert.equal(p1.willSend.length, 2, 'a P1 reaches both');
    const p2 = notify.plan({ priority: 'P2' }, routes, cfg);
    assert.deepEqual(p2.willSend.map(r => r.channel), ['webhook']);
    assert.match(p2.skipped[0].why, /below P1/);
    // An unknown priority must not pass every filter.
    assert.equal(notify.plan({ priority: 'P9' }, routes, cfg).willSend.length, 0);
  });

  await t('a route that cannot run says why BEFORE anything is sent', () => {
    // This is the failure people lose an afternoon to: a channel is configured
    // in the routes table and the service it needs is not configured at all.
    const { willSend, skipped } = notify.plan({ priority: 'P1' },
      [{ channel: 'sms', target: '+15550000' }, { channel: 'servicenow', target: 'incident' }],
      { productName: 'x' });
    assert.equal(willSend.length, 0);
    assert.match(skipped[0].why, /sentinelConnect\.url/);
    assert.match(skipped[1].why, /servicenow\.(instanceUrl|auth)/);
    // Disabled, unknown and targetless routes are each reported distinctly.
    const s2 = notify.plan({ priority: 'P1' }, [
      { channel: 'slack', target: 'x', enabled: false },
      { channel: 'carrier-pigeon', target: 'x' },
      { channel: 'slack' },
    ], cfg).skipped;
    assert.deepEqual(s2.map(x => x.why), ['disabled', 'unknown channel "carrier-pigeon"', 'no target']);
  });

  await t('SMS is one line, capped, and a DRY_RUN is not a delivery', async () => {
    const { http, calls } = recorder({ ok: true, json: { result: { sid: 'SM1', dryRun: true } } });
    const out = await notify.send(alarm, [{ channel: 'sms', target: '+15551234567' }], cfg, { http, now: () => T0 });
    assert.equal(calls[0].url, 'http://sc.internal:3200/webhook/sms/send', 'trailing slash trimmed');
    assert.equal(calls[0].headers['X-Internal-Key'], 'k');
    assert.ok(calls[0].body.body.length <= 320);
    assert.match(calls[0].body.body, /\[P1\] HMA UPS 2E-A/);
    assert.ok(!calls[0].body.body.includes('\n'), 'one line');
    // The gateway did not actually send. Reporting this as delivered is how a
    // quiet DRY_RUN becomes "we definitely paged someone".
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[0].dryRun, true);
  });

  await t('Teams picks webhook or Graph by the shape of the target', async () => {
    const wh = recorder();
    await notify.send(alarm, [{ channel: 'teams', target: 'https://ringon.webhook.office.com/webhookb2/abc' }], cfg, { http: wh.http });
    assert.equal(wh.calls[0].body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.equal(wh.calls[0].body.attachments[0].content.actions[0].url, 'https://fms.internal/haea',
      'the deep link is config, not a hard-coded hosted URL');

    const gr = recorder({ ok: true, json: { id: 'm1' } });
    const out = await notify.send(alarm, [{ channel: 'teams', target: 'team-1/channel-2' }], cfg, { http: gr.http });
    assert.equal(gr.calls[0].url, 'http://uc.internal:3100/internal/teams/send');
    assert.equal(out.results[0].mode, 'graph');

    // Graph mode with no runless-uc configured is reported, not attempted.
    const bare = await notify.send(alarm, [{ channel: 'teams', target: 'team/chan' }], { productName: 'x' }, { http: recorder().http });
    assert.equal(bare.results[0].ok, false);
    assert.match(bare.results[0].error, /runlessUc\.url/);
  });

  await t('email has an SMTP transport, because HAEA has no internet', async () => {
    // The hosted service uses Resend. An air-gapped customer uses its own
    // relay, and this package carries no mail dependency — so the sender is
    // injected.
    const sentMail = [];
    const out = await notify.send(alarm, [{ channel: 'email', target: 'noc@haeaus.com' }],
      { ...cfg, email: { transport: 'smtp', from: 'FMS <fms@haeaus.com>' } },
      { http: recorder().http, smtpSend: async (m) => { sentMail.push(m); return { messageId: 'smtp-1' }; } });
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[0].transport, 'smtp');
    assert.equal(sentMail[0].to, 'noc@haeaus.com');
    assert.equal(sentMail[0].from, 'FMS <fms@haeaus.com>');
    assert.match(sentMail[0].subject, /^\[P1\] HMA UPS 2E-A — HMA · IDF2/);
    assert.match(sentMail[0].html, /HMA UPS 2E-A/);

    // smtp with no sender is a configuration error, named as one.
    const noSender = await notify.send(alarm, [{ channel: 'email', target: 'a@b' }],
      { ...cfg, email: { transport: 'smtp' } }, { http: recorder().http });
    assert.equal(noSender.results[0].ok, false);
    assert.match(noSender.results[0].error, /injected sender/);

    // Resend still works and is still the default when a key is present.
    const rs = recorder({ ok: true, json: { id: 're_1' } });
    const r2 = await notify.send(alarm, [{ channel: 'email', target: 'a@b' }], cfg, { http: rs.http });
    assert.equal(rs.calls[0].url, 'https://api.resend.com/emails');
    assert.equal(rs.calls[0].headers.Authorization, 'Bearer key');
    assert.equal(r2.results[0].id, 're_1');
  });

  await t('email HTML escapes the alarm text', async () => {
    const sent = [];
    await notify.send({ ...alarm, title: '<script>alert(1)</script> & "quoted"' },
      [{ channel: 'email', target: 'a@b' }],
      { ...cfg, email: { transport: 'smtp' } },
      { http: recorder().http, smtpSend: async (m) => { sent.push(m); return {}; } });
    assert.ok(!sent[0].html.includes('<script>'), 'alarm text is not injected into the HTML');
    assert.ok(sent[0].html.includes('&lt;script&gt;'));
    assert.ok(sent[0].html.includes('&amp;') && sent[0].html.includes('&quot;'));
  });

  await t('Slack and Discord reject a target that is not their webhook', async () => {
    for (const [channel, bad] of [['slack', 'https://evil.example/x'], ['discord', 'https://hooks.slack.com/services/a/b/c']]) {
      const out = await notify.send(alarm, [{ channel, target: bad }], cfg, { http: recorder().http });
      assert.equal(out.results[0].ok, false, `${channel} accepted a foreign URL`);
      assert.match(out.results[0].error, /webhook/i);
    }
    const ok = recorder();
    await notify.send(alarm, [{ channel: 'slack', target: 'https://hooks.slack.com/services/T/B/x' }], cfg, { http: ok.http });
    assert.equal(ok.calls[0].body.blocks[0].type, 'header');
    assert.ok(ok.calls[0].body.text.length <= 300, 'the fallback text is capped');
  });

  await t('PagerDuty and ServiceNow carry a dedup key so a repeat does not double up', async () => {
    const pd = recorder({ ok: true, json: { dedup_key: 'alarm-9001' } });
    await notify.send({ ...alarm, dedupKey: 'ups-57/on-battery' }, [{ channel: 'pagerduty', target: 'routing-key' }], cfg, { http: pd.http });
    assert.equal(pd.calls[0].body.dedup_key, 'ups-57/on-battery');
    assert.equal(pd.calls[0].body.payload.severity, 'critical', 'P1 → critical');

    const sn = recorder({ ok: true, json: { result: { sys_id: 'sys1', number: 'INC0012345' } } });
    const out = await notify.send({ ...alarm, dedupKey: 'ups-57/on-battery' },
      [{ channel: 'servicenow', target: 'incident' }], cfg, { http: sn.http });
    assert.equal(sn.calls[0].url, 'https://haea.service-now.com/api/now/table/incident');
    assert.equal(sn.calls[0].headers.Authorization, 'Basic x');
    assert.equal(sn.calls[0].body.impact, '1');
    assert.equal(sn.calls[0].body.urgency, '1');
    assert.equal(sn.calls[0].body.correlation_id, 'ups-57/on-battery');
    // The caller needs the INC number to put on the alarm.
    assert.equal(out.results[0].number, 'INC0012345');
    assert.equal(out.results[0].id, 'sys1');
  });

  await t('the generic webhook envelope is stable', async () => {
    const { http, calls } = recorder();
    await notify.send(alarm, [{ channel: 'webhook', target: 'https://itsm.internal/hook' }],
      { ...cfg, webhook: { headers: { 'X-Token': 't' } } }, { http });
    assert.equal(calls[0].headers['X-Token'], 't');
    assert.deepEqual(Object.keys(calls[0].body).sort(),
      ['at', 'detail', 'device', 'id', 'message', 'metric', 'priority', 'source', 'threshold', 'title', 'url', 'value', 'where']);
    assert.equal(calls[0].body.device.label, 'HMA UPS 2E-A');
    assert.equal(calls[0].body.at, new Date(T0).toISOString());
  });

  await t('one failing channel does not stop the others', async () => {
    let n = 0;
    const http = async (url) => { n++; return url.includes('slack') ? { ok: false, error: 'HTTP 404: no_service' } : { ok: true, json: {} }; };
    const out = await notify.send(alarm, [
      { channel: 'slack', target: 'https://hooks.slack.com/services/a/b/c' },
      { channel: 'webhook', target: 'https://x/y' },
      { channel: 'teams', target: 'https://x.webhook.office.com/webhookb2/z' },
    ], cfg, { http });
    assert.equal(out.sent, 2);
    assert.equal(out.failed, 1);
    assert.equal(n, 3, 'all three were attempted');
    assert.match(out.results.find(r => r.channel === 'slack').error, /no_service/);
  });

  await t('a dispatcher that throws is caught and named', async () => {
    const http = async () => { throw new Error('socket exploded'); };
    const out = await notify.send(alarm, [{ channel: 'webhook', target: 'https://x/y' }], cfg, { http });
    assert.equal(out.results[0].ok, false);
    assert.match(out.results[0].error, /dispatcher threw: socket exploded/);
  });

  await t('test() checks configuration without sending, and sends on request', async () => {
    const check = await notify.test('slack', 'https://hooks.slack.com/services/a/b/c', cfg, {});
    assert.deepEqual([check.ok, check.checked, check.delivered], [true, true, false]);

    const { http, calls } = recorder();
    const sentOne = await notify.test('slack', 'https://hooks.slack.com/services/a/b/c', cfg, { deliver: true, http });
    assert.equal(sentOne.delivered, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body.blocks[1].text.text, /connectivity test/);

    // An unconfigured channel fails the check and sends nothing.
    const bad = await notify.test('sms', '+1555', { productName: 'x' }, { deliver: true, http });
    assert.equal(bad.ok, false);
    assert.equal(bad.delivered, false);
    assert.equal(calls.length, 1, 'nothing more was sent');
  });

  await t('nothing reads the environment or a database', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    for (const f of ['index.js', 'channels.js', 'message.js', 'http.js', 'smtp.js', 'servicenow.js']) {
      const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'));
      assert.ok(!/process\.env/.test(src), `${f} reads process.env — config must be passed in`);
      assert.ok(!/require\(['"].*config\/database/.test(src), `${f} imports a database`);
      assert.ok(!/require\(['"](axios|nodemailer|pg|better-sqlite3)/.test(src), `${f} has a runtime dependency`);
    }
    const pkg = require('../package.json');
    assert.deepEqual(pkg.dependencies, {}, 'no runtime dependencies at all');
    assert.equal(pkg.engines.node, '>=20');
  });

  console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - nine channels, no database, no environment, no network');
  process.exit(fail ? 1 : 0);
})();
