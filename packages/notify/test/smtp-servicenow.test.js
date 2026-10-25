// node --test packages/notify/test/smtp-servicenow.test.js
//
// The two lifecycle pieces against local dummies on 127.0.0.1: the SMTP
// client (what a relay actually sees on the wire) and the ServiceNow
// create → update → resolve calls (what an instance actually receives).
const test = require('node:test');
const assert = require('node:assert');
const notify = require('../src');
const { startDummySmtp, decode } = require('./support/dummy-smtp');
const { startDummyServiceNow } = require('./support/dummy-servicenow');

test('smtp: AUTH PLAIN, multipart body, UTF-8 subject, dot-stuffing — and it is the email channel\'s sender', async () => {
  const relay = await startDummySmtp({ user: 'fms', pass: 'pw' });
  try {
    const smtpSend = notify.smtpSender({ host: relay.host, port: relay.port, auth: { user: 'fms', pass: 'pw' }, timeoutMs: 5000 });
    const out = await notify.send(
      { priority: 'P1', title: 'UPS on battery\n.leading dot line', where: 'HMA · IDF2', deviceLabel: 'UPS 2E-A', id: 'a1' },
      [{ channel: 'email', target: 'noc@haeaus.com, it@haeaus.com', minPriority: 'P2' }],
      { email: { transport: 'smtp', from: 'C-Flex FMS <fms-noreply@haeaus.com>' } },
      { smtpSend },
    );
    assert.strictEqual(out.sent, 1, JSON.stringify(out));
    assert.match(out.results[0].id, /^<[0-9a-f-]{36}@haeaus\.com>$/);
    const [m] = relay.state.messages;
    assert.strictEqual(m.from, 'fms-noreply@haeaus.com');
    assert.deepStrictEqual(m.to, ['noc@haeaus.com', 'it@haeaus.com']);
    const d = decode(m.raw);
    assert.match(d.subject, /\[P1\] UPS 2E-A — HMA · IDF2/);
    assert.match(d.text, /\n\.leading dot line/);
    assert.match(d.html, /UPS on battery/);
    assert.ok(relay.state.commands.includes('AUTH'));
    // Bodies are base64, so no line starts with '.'; the stuffing is still applied to whatever is.
    assert.strictEqual(require('../src/smtp').dataBody('a\n.b\r\n..c'), 'a\r\n..b\r\n...c');
  } finally { await relay.close(); }
});

test('smtp: AUTH LOGIN when that is all the relay offers; bad credentials and a refused recipient fail cleanly', async () => {
  const relay = await startDummySmtp({ user: 'fms', pass: 'pw', mechs: 'LOGIN' });
  try {
    const good = notify.smtpSender({ host: relay.host, port: relay.port, auth: { user: 'fms', pass: 'pw' } });
    await good({ to: 'a@b.c', from: 'x@y.z', subject: 's', text: 't' });
    assert.strictEqual(relay.state.messages.length, 1);

    const bad = notify.smtpSender({ host: relay.host, port: relay.port, auth: { user: 'fms', pass: 'nope' } });
    await assert.rejects(bad({ to: 'a@b.c', from: 'x@y.z', subject: 's', text: 't' }), /AUTH: 535/);

    relay.state.rejectRcpt = true;
    const out = await notify.send({ priority: 'P1', title: 't' }, [{ channel: 'email', target: 'a@b.c' }],
      { email: { transport: 'smtp', from: 'x@y.z' } }, { smtpSend: good });
    assert.strictEqual(out.sent, 0);
    assert.match(out.results[0].error, /RCPT TO: 550/);
  } finally { await relay.close(); }
});

test('smtp: an unreachable relay is an error within the timeout, not a hang', async () => {
  const send = notify.smtpSender({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
  await assert.rejects(send({ to: 'a@b.c', from: 'x@y.z', subject: 's', text: 't' }), /ECONNREFUSED|timeout/);
});

test('servicenow: create → update → resolve on one sys_id; P1 maps to impact/urgency 1', async () => {
  const sn = await startDummyServiceNow();
  try {
    const cfg = { productName: 'C-Flex FMS', servicenow: { instanceUrl: sn.url + '/', auth: sn.auth, category: 'Hardware' } };
    const c = await notify.servicenow.create({ priority: 'P1', title: 'UPS on battery', deviceLabel: 'UPS 2E-A', id: 'alarm-1', dedupKey: 'alarm-1' }, cfg);
    assert.ok(c.ok, c.error);
    assert.match(c.number, /^INC\d+$/);
    const rec = sn.state.incidents.get(c.sys_id);
    assert.deepStrictEqual([rec.impact, rec.urgency, rec.category, rec.correlation_id], ['1', '1', 'Hardware', 'alarm-1']);

    const u = await notify.servicenow.update(c.sys_id, { note: 'still on battery', priority: 'P2' }, cfg);
    assert.ok(u.ok, u.error);
    assert.deepStrictEqual(rec.work_notes_log, ['still on battery']);
    assert.strictEqual(rec.impact, '2');

    const r = await notify.servicenow.resolve(c.sys_id, { note: 'back on line' }, cfg);
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual([rec.state, rec.close_code, rec.close_notes], ['6', 'Solved Remotely (Permanently)', 'back on line']);
    assert.deepStrictEqual(sn.state.requests.map(x => x.method), ['POST', 'PATCH', 'PATCH']);
  } finally { await sn.close(); }
});

test('servicenow: wrong credentials and missing config are results, not throws', async () => {
  const sn = await startDummyServiceNow();
  try {
    const r = await notify.servicenow.create({ priority: 'P2', title: 't' }, { servicenow: { instanceUrl: sn.url, auth: 'Basic bad' } });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /HTTP 401: User Not Authenticated/);
    const m = await notify.servicenow.resolve('abc', {}, {});
    assert.strictEqual(m.ok, false);
    assert.match(m.error, /config missing/);
  } finally { await sn.close(); }
});
