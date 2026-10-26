// node --test probe-agent/test/local-notify.e2e.test.js
//
// WO-INT-003 end to end: a poller alert goes through the alarm engine, out to
// a dummy SMTP relay and a dummy ServiceNow, and the event comes out carrying
// `local_notified` — which must say what was delivered, not what was
// configured. Plus the SOW test ticket, as a function and as the CLI.
// Everything on 127.0.0.1.
//
// The notifier (alarms/local-notify.js) runs on the Local Console since
// Q-2026-10-25-10, and the Portal sender on the FMS since D-13 (WO-INT-012):
// the collector itself has neither. These tests drive the same engine →
// notifier pair the console runs, without the Portal (apps/console/test/portal.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createAlarmEngine } = require('../src/alarms/engine');
const { createLocalNotifier, httpVia } = require('../src/alarms/local-notify');
const { jsonStore } = require('../src/alarms/store');
const schema = require('../src/contract/schema');
const { startDummySmtp, decode } = require('../../packages/notify/test/support/dummy-smtp');
const { startDummyServiceNow } = require('../../packages/notify/test/support/dummy-servicenow');

const skip = false;
const quiet = { log() {}, warn() {}, error() {} };
const MIN = 60 * 1000;
const TEAMS = 'https://haea.webhook.office.com/webhookb2/test';

let relay, sn, tmp;
let sent = [];
test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-notify-'));
  relay = await startDummySmtp({ user: 'fms', pass: 'relay-pw' });
  sn = await startDummyServiceNow();
});
test.after(async () => {
  await relay.close(); await sn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
test.beforeEach(() => {
  relay.state.messages.length = 0; relay.state.rejectRcpt = false;
  sn.state.incidents.clear(); sn.state.requests.length = 0; sn.state.faults.length = 0;
  teamsPosts.length = 0;
  sent = [];
});

// Teams needs a *.webhook.office.com URL, which cannot be a local server; its
// posts are recorded at the http slot. SMTP and ServiceNow are real sockets.
const teamsPosts = [];
const realHttp = httpVia({});
const http = async (url, body, opts) => {
  if (url.startsWith(TEAMS)) { teamsPosts.push(body); return { ok: true, status: 200, json: null, text: '1' }; }
  return realHttp(url, body, opts);
};

function notifyConfig(over = {}) {
  fs.writeFileSync(path.join(tmp, 'sn-pass'), 'secret\n', { mode: 0o600 });
  fs.writeFileSync(path.join(tmp, 'smtp-pass'), 'relay-pw\n', { mode: 0o600 });
  return {
    productName: 'C-Flex FMS', siteName: 'HAEA', dashboardUrl: 'https://fms.haeaus.internal/',
    policy: { email_min: 'P2', teams_min: 'P1', itsm_min: 'P2', ...(over.policy || {}) },
    email: { to: ['idc-noc@haeaus.com'], from: 'C-Flex FMS <fms-noreply@haeaus.com>',
      smtp: { host: relay.host, port: relay.port, starttls: 'never', auth: { user: 'fms', passFile: path.join(tmp, 'smtp-pass') } } },
    teams: { webhook: TEAMS },
    servicenow: { instanceUrl: sn.url, user: 'svc', passFile: path.join(tmp, 'sn-pass'), category: 'Hardware' },
    ...over.top,
  };
}

function rig({ config = notifyConfig(), store, alarms = {}, notifier } = {}) {
  let t = Date.now();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const n = notifier === null ? null : notifier || createLocalNotifier({ config, store: store || jsonStore(null), deps: { http }, log: quiet });
  const engine = createAlarmEngine({ ctx: { tenant: 'TEST', siteId: 'HAEA-HQ' }, now: clock.now, opts: alarms, maintenance: alarms.maintenance, log: quiet });
  const ledger = new Map();
  // Each engine item → the notifier → the event, with what was delivered (as the console does it).
  const emit = async (items) => {
    for (const it of items) {
      if (n) { const ln = await n.handle(it); if (ln) it.event.local_notified = ln; }
      sent.push(it.event);
    }
  };
  // The collector's way into the engine (forwarder.js sendEvent), for the two kinds used here.
  const f = {
    syncInventory: async (list) => { for (const d of list) ledger.set(String(d.id), d); },
    sendEvent: async (kind, p) => {
      const d = ledger.get(String(p.device_id));
      if (kind === 'telemetry' && p.kind === 'ups') {
        const items = engine.commStatus(d, p.ok !== false, p.ts, p.error);
        if (p.ok !== false) items.push(...engine.beginCycle(d, p.ts));
        await emit(items);
      } else if (kind === 'alert') {
        const r = engine.fromAlert(d, p);
        if (r.code) await emit(r.items);
      }
    },
  };
  return { f, n, clock };
}

const UPS = { id: 41, name: 'MPOE UPS 1E-A', site_id: 'HMA-FV', serial: 'AD2248220154', kind: 'ups' };
const onBattery = (ts) => ({ device_id: 41, severity: 'P2', metric: 'output_source', value: 'onBattery', message: 'Output source: onBattery', ts });
const okPoll = (ts) => ({ device_id: 41, kind: 'ups', ts, ok: true, took_ms: 500, metrics: { battery_pct: 90, output_source: 'onLine' } });
const events = () => sent;

test('E2E: raise → SMTP + Teams + ServiceNow INC, and the event says so in local_notified', { skip }, async () => {
  const store = jsonStore(path.join(tmp, 'itsm-a.json'));
  const { f, clock } = rig({ store, alarms: { updateEveryMs: 0 } });
  await f.syncInventory([UPS]);
  await f.sendEvent('alert', onBattery(clock.now()));

  // SMTP relay got the mail, authenticated, to the configured address.
  assert.strictEqual(relay.state.messages.length, 1);
  const mail = decode(relay.state.messages[0].raw);
  assert.deepStrictEqual(relay.state.messages[0].to, ['idc-noc@haeaus.com']);
  assert.match(mail.subject, /^\[P1\] MPOE UPS 1E-A/);
  assert.match(mail.text, /Output source: onBattery/);
  // Teams got an Adaptive Card.
  assert.strictEqual(teamsPosts.length, 1);
  assert.strictEqual(teamsPosts[0].attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  // ServiceNow got one incident, P1 → impact/urgency 1, correlated on the alarm_id.
  assert.strictEqual(sn.state.incidents.size, 1);
  const [inc] = [...sn.state.incidents.values()];
  assert.deepStrictEqual([inc.impact, inc.urgency, inc.category], ['1', '1', 'Hardware']);

  const [ev] = events();
  assert.strictEqual(ev.kind, 'alarm_raise');
  assert.strictEqual(inc.correlation_id, ev.alarm_id);
  assert.deepStrictEqual(ev.local_notified, { email: true, teams: true, itsm: inc.number });
  assert.ok(schema.validate('events', { events: [ev] }).ok);
  // alarm_id ↔ INC is on disk.
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'itsm-a.json'), 'utf8'));
  assert.strictEqual(disk[ev.alarm_id].number, inc.number);
  assert.strictEqual(disk[ev.alarm_id].sys_id, inc.sys_id);
  assert.strictEqual(fs.statSync(path.join(tmp, 'itsm-a.json')).mode & 0o777, 0o600);

  // Update: a work note on the same INC, no second mail.
  clock.advance(MIN);
  await f.sendEvent('telemetry', okPoll(clock.now()));
  await f.sendEvent('alert', onBattery(clock.now()));
  assert.deepStrictEqual(inc.work_notes_log.length, 1);
  assert.strictEqual(relay.state.messages.length, 1);
  const upd = events().find(e => e.kind === 'alarm_update');
  assert.deepStrictEqual(upd.local_notified, { email: false, teams: false, itsm: inc.number });

  // Clear: two quiet cycles → INC resolved, a "cleared" mail.
  clock.advance(MIN); await f.sendEvent('telemetry', okPoll(clock.now()));
  clock.advance(MIN); await f.sendEvent('telemetry', okPoll(clock.now()));
  const clr = events().find(e => e.kind === 'alarm_clear');
  assert.ok(clr, 'cleared');
  assert.strictEqual(inc.state, '6');
  assert.strictEqual(sn.state.incidents.size, 1, 'no second incident');
  assert.strictEqual(relay.state.messages.length, 2);
  assert.match(decode(relay.state.messages[1].raw).subject, /^\[P1\] CLEARED MPOE UPS 1E-A/);
  assert.strictEqual(teamsPosts.length, 2);
  assert.deepStrictEqual(clr.local_notified, { email: true, teams: true, itsm: inc.number });
  for (const e of sent) assert.ok(schema.validate('events', { events: [e] }).ok, e.kind);
});

test('E2E: a refused mail and a failing ServiceNow report false/null — the Portal must not be told HAEA was', { skip }, async () => {
  const { f, clock } = rig();
  await f.syncInventory([UPS]);
  relay.state.rejectRcpt = true;
  sn.state.faults.push({ status: 503, message: 'instance hibernating' });
  await f.sendEvent('alert', onBattery(clock.now()));
  const [ev] = events();
  assert.strictEqual(ev.kind, 'alarm_raise', 'the event still goes on');
  assert.deepStrictEqual(ev.local_notified, { email: false, teams: true, itsm: null });
  assert.strictEqual(sn.state.incidents.size, 0);
});

test('E2E: severity floors — a P3 comm loss mails nobody and opens no INC under P2 floors', { skip }, async () => {
  const { f, clock } = rig();
  await f.syncInventory([UPS]);
  const down = (ts) => ({ device_id: 41, kind: 'ups', ts, ok: false, error: 'timeout', took_ms: 3000 });
  await f.sendEvent('telemetry', down(clock.now()));
  clock.advance(31 * MIN);
  await f.sendEvent('telemetry', down(clock.now()));
  const [ev] = events();
  assert.deepStrictEqual([ev.code, ev.severity, ev.kind], ['UPS_COMM_LOST', 'P3', 'alarm_raise']);
  assert.deepStrictEqual(ev.local_notified, { email: false, teams: false, itsm: null });
  assert.strictEqual(relay.state.messages.length + sn.state.requests.length + teamsPosts.length, 0);
});

test('E2E: maintenance window — the alarm goes on (marked), nothing is sent locally', { skip }, async () => {
  const { f, clock } = rig({ alarms: { maintenance: [{ ledger_id: 41, until: Date.now() + 60 * MIN }] } });
  await f.syncInventory([UPS]);
  await f.sendEvent('alert', onBattery(clock.now()));
  const [ev] = events();
  assert.strictEqual(ev.detail.maintenance, true);
  assert.deepStrictEqual(ev.local_notified, { email: false, teams: false, itsm: null });
  assert.strictEqual(relay.state.messages.length + sn.state.requests.length + teamsPosts.length, 0);
});

test('E2E: the alarm_id ↔ INC map survives a restart — the clear resolves the ticket the raise opened', { skip }, async () => {
  const file = path.join(tmp, 'itsm-b.json');
  const config = notifyConfig();
  const first = createLocalNotifier({ config, store: jsonStore(file), deps: { http }, log: quiet });
  const engineItem = (kind, alarmId) => ({
    event: { event_id: 'e', alarm_id: alarmId, device_id: '0123456789abcdef', site_id: 'HMA-FV', ts: new Date().toISOString(),
      kind, severity: 'P1', code: 'UPS_ON_BATTERY', title: 'on battery', detail: {}, source: 'rule' },
    suppressed: null, alarm: { title: 'on battery', label: 'UPS' },
  });
  const raised = await first.handle(engineItem('alarm_raise', 'a-1'));
  // "Restart": a new notifier, same file.
  const second = createLocalNotifier({ config, store: jsonStore(file), deps: { http }, log: quiet });
  const cleared = await second.handle(engineItem('alarm_clear', 'a-1'));
  assert.strictEqual(cleared.itsm, raised.itsm);
  const [inc] = [...sn.state.incidents.values()];
  assert.strictEqual(inc.state, '6');
});

test('E2E: without local notification configured, events carry no local_notified at all', { skip }, async () => {
  const { f, clock } = rig({ notifier: null });
  await f.syncInventory([UPS]);
  await f.sendEvent('alert', onBattery(clock.now()));
  const [ev] = events();
  assert.ok(!('local_notified' in ev));
});

test('test ticket: create → work note → resolve, as a function', async () => {
  const n = createLocalNotifier({ config: notifyConfig(), deps: { http }, log: quiet });
  const r = await n.testTicket();
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.number, /^INC\d+$/);
  const inc = sn.state.incidents.get(r.sys_id);
  assert.deepStrictEqual([inc.state, inc.work_notes_log.length, inc.impact], ['6', 1, '3']);
  assert.match(inc.short_description, /test ticket/);

  const open = await n.testTicket({ resolve: false });
  assert.strictEqual(sn.state.incidents.get(open.sys_id).state, '1');

  const bad = createLocalNotifier({ config: { ...notifyConfig(), servicenow: { instanceUrl: sn.url, user: 'svc', pass: 'wrong' } }, deps: { http }, log: quiet });
  const f = await bad.testTicket();
  assert.deepStrictEqual([f.ok, f.step], [false, 'create']);
  assert.match(f.error, /401/);
});

test('test ticket: the cflex-test-ticket command prints the INC and exits 0; bad credentials exit 1', async () => {
  const file = path.join(tmp, 'notify.json');
  fs.writeFileSync(file, JSON.stringify(notifyConfig()), { mode: 0o600 });
  const bin = path.join(__dirname, '..', 'bin', 'cflex-test-ticket.js');
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  const ok = await run(['--config', file, '--json']);
  assert.strictEqual(ok.code, 0, ok.stderr);
  const r = JSON.parse(ok.stdout);
  assert.ok(r.ok && r.resolved);
  assert.strictEqual(sn.state.incidents.get(r.sys_id).state, '6');
  assert.ok(!ok.stdout.includes('secret'), 'no credential in the output');

  const cfgBad = notifyConfig(); // writes the good pass file — so the bad one goes after
  fs.writeFileSync(path.join(tmp, 'sn-pass'), 'wrong\n', { mode: 0o600 });
  fs.writeFileSync(file, JSON.stringify(cfgBad), { mode: 0o600 });
  const fail = await run(['--config', file]);
  assert.strictEqual(fail.code, 1);
  assert.match(fail.stdout, /FAIL at create: HTTP 401/);
  const usage = await run([]);
  assert.strictEqual(usage.code, 2);
});
