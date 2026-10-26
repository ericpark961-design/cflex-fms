// node --test probe-agent/test/portal-link.e2e.test.js
//
// 링크 알람의 배선을 끝까지 확인한다: call() 이 실패를 기록하고 →
// heartbeat() 가 평가하고 → emit() 이 로컬 통지(실제 SMTP·ServiceNow)를 하고
// → 같은 이벤트가 포털 큐로 들어가는지.
//
// 상태기계만 단위 시험하면 "언제 울릴지" 는 고정되지만 "울린 게 실제로
// 누구에게 가는지" 는 비어 있다. 끊긴 동안 로컬로 전달되지 않으면 이 알람은
// 쓸모가 없는데, 그 경로가 바로 이 파일이 지키는 것이다.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createForwarder } = require('../src/forwarder');
const { createLocalNotifier } = require('../src/alarms/local-notify');
const { jsonStore } = require('../src/alarms/store');
const { memQueue } = require('./support/memqueue');
const { httpVia } = require('../src/alarms/local-notify');
const { startDummySmtp, decode } = require('../../packages/notify/test/support/dummy-smtp');
const { startDummyServiceNow } = require('../../packages/notify/test/support/dummy-servicenow');

const quiet = { log() {}, warn() {}, error() {} };

let relay, sn, tmp;
test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-link-'));
  relay = await startDummySmtp({ user: 'fms', pass: 'relay-pw' });
  sn = await startDummyServiceNow();
});
test.after(async () => {
  await relay.close(); await sn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
test.beforeEach(() => {
  relay.state.messages.length = 0;
  sn.state.incidents.clear(); sn.state.requests.length = 0;
});

const realHttp = httpVia({});

/**
 * @param {object} o
 * @param {string} o.emailMin  통지 임계값. 계약은 PORTAL_LINK_DOWN 을 P3 로
 *   정했고 local-notify 기본값은 P2 라 그대로면 아무에게도 가지 않는다
 *   (정의서 §5 / Q-2026-10-25-12). 둘 다 시험한다.
 */
function rig({ emailMin = 'P3' } = {}) {
  fs.writeFileSync(path.join(tmp, 'sn-pass'), 'secret\n', { mode: 0o600 });
  fs.writeFileSync(path.join(tmp, 'smtp-pass'), 'relay-pw\n', { mode: 0o600 });
  const notifier = createLocalNotifier({
    config: {
      productName: 'C-Flex FMS', siteName: 'HAEA',
      policy: { email_min: emailMin, teams_min: 'P1', itsm_min: emailMin, notify_clear: true },
      email: {
        to: ['idc-noc@haeaus.com'], from: 'C-Flex FMS <fms-noreply@haeaus.com>',
        smtp: { host: relay.host, port: relay.port, starttls: 'never', auth: { user: 'fms', passFile: path.join(tmp, 'smtp-pass') } },
      },
      servicenow: { instanceUrl: sn.url, user: 'svc', passFile: path.join(tmp, 'sn-pass'), category: 'Hardware' },
    },
    store: jsonStore(path.join(tmp, `itsm-${emailMin}-${Math.random()}.json`)),
    deps: { http: realHttp }, log: quiet,
  });

  let t = Date.parse('2026-10-26T00:00:00Z');
  // 포털 응답을 손으로 만든다. 끊김을 흉내내려고 닫힌 포트를 쓰면 오류
  // 문구가 OS 마다 달라 원인 분류가 흔들린다.
  let mode = 'ok';
  const request = async () => {
    if (mode === 'throw') { const e = new Error('connect ECONNREFUSED 10.0.0.1:443'); throw e; }
    if (mode === 'proxy') return { status: 407, json: { error: { code: 'proxy_auth_required' } }, headers: {} };
    return { status: 200, json: { ack: true, commands_pending: 0 }, headers: { date: new Date(t).toUTCString(), 'x-cflex-api-version': '1.1' } };
  };
  const queue = memQueue();
  const f = createForwarder({
    portal: { enabled: true, url: 'https://cflex.fms.support', tenant: 'TEST', nodeId: 'cap01', role: 'collector', siteId: 'HAEA-HQ', tls: {}, timeoutMs: 5000 },
    queue, now: () => t, random: () => 0.5, log: quiet, version: '2.1.0',
    notifier, request,
    alarms: { updateEveryMs: 0 },
  });
  return {
    f, queue,
    set: (m) => { mode = m; },
    adv: (ms) => { t += ms; },
    /** 포털 큐에 들어간 events 항목 */
    queued: () => queue.rows.filter(r => String(r.kind).includes('events') || String(r.payload).includes('PORTAL_LINK_DOWN')),
  };
}

const beat = (r) => r.f.heartbeat({ devices_total: 0, devices_unreachable: 0, last_poll_ok_ratio: null });

test('E2E: 끊기면 P3 알람이 메일과 ServiceNow 로 간다 — 포털을 거치지 않고', async () => {
  const r = rig({ emailMin: 'P3' });
  await beat(r);                                   // 한 번 붙는다
  assert.strictEqual(r.f.link().link, 'up');

  r.set('throw');
  for (let i = 0; i < 3; i++) { r.adv(60_000); await beat(r); }
  assert.strictEqual(relay.state.messages.length, 0, '아직 5분이 안 됐는데 울렸다');

  r.adv(180_000); await beat(r);                   // 누적 5분 초과
  assert.strictEqual(r.f.link().link, 'down');

  // 로컬로 갔다 — 포털이 안 보이는 상태에서.
  assert.strictEqual(relay.state.messages.length, 1, '메일이 안 갔다');
  const mail = decode(relay.state.messages[0].raw);
  assert.match(mail.subject, /^\[P3\]/, `심각도가 제목에 없다: ${mail.subject}`);
  assert.match(mail.text, /cflex\.fms\.support/, '어느 서버인지가 본문에 없다');
  assert.strictEqual(sn.state.incidents.size, 1, 'ServiceNow 티켓이 안 열렸다');

  // 같은 이벤트가 포털 큐에도 들어가 복구 뒤 NOC 이 본다 (정의서 §1 상호참조).
  const q = r.queued();
  assert.ok(q.length >= 1, '포털 큐에 들어가지 않았다 — NOC 이 영원히 모른다');
});

test('E2E: 복구되면 같은 alarm_id 로 clear 가 가고 티켓이 닫힌다', async () => {
  const r = rig({ emailMin: 'P3' });
  await beat(r);
  r.set('throw');
  for (let i = 0; i < 3; i++) { r.adv(60_000); await beat(r); }
  r.adv(180_000); await beat(r);
  assert.strictEqual(sn.state.incidents.size, 1);
  const incNum = [...sn.state.incidents.keys()][0];

  r.set('ok');
  r.adv(60_000); await beat(r);
  assert.strictEqual(r.f.link().link, 'up');
  assert.strictEqual(relay.state.messages.length, 2, '복구 통지가 안 갔다');
  const mail = decode(relay.state.messages[1].raw);
  assert.match(mail.subject, /CLEARED/, `복구가 raise 와 구분되지 않는다: ${mail.subject}`);
  // 같은 티켓에 닫힘이 기록된다 — 새 티켓을 열지 않는다.
  assert.strictEqual(sn.state.incidents.size, 1, '복구가 새 티켓을 열었다');
  assert.ok(incNum);
});

test('E2E: 기본 임계값(P2)이면 아무에게도 가지 않는다 — 정의서 §5 의 충돌', async () => {
  // 이게 Q-2026-10-25-12 를 올린 이유다. 계약은 P3 로 정했고 통지 기본값은
  // P2 다. 코드로 고정해 둔다 — 답이 (B) 로 오면 이 시험이 기대값이 된다.
  const r = rig({ emailMin: 'P2' });
  await beat(r);
  r.set('throw');
  for (let i = 0; i < 3; i++) { r.adv(60_000); await beat(r); }
  r.adv(180_000); await beat(r);
  assert.strictEqual(r.f.link().link, 'down', '알람 자체는 떴어야 한다');
  assert.strictEqual(relay.state.messages.length, 0, 'P2 임계값인데 메일이 갔다');
  assert.strictEqual(sn.state.incidents.size, 0, 'P2 임계값인데 티켓이 열렸다');
});

test('E2E: 프록시 거절은 원인이 proxy 로 잡히고 조치 문구가 붙는다', async () => {
  const r = rig({ emailMin: 'P3' });
  await beat(r);
  r.set('proxy');
  for (let i = 0; i < 3; i++) { r.adv(60_000); await beat(r); }
  r.adv(180_000); await beat(r);
  const st = r.f.link();
  assert.strictEqual(st.link, 'down');
  assert.strictEqual(st.cause, 'proxy', `407 이 proxy 로 분류되지 않았다: ${st.cause}`);
  assert.match(st.hint, /프록시/);
  const mail = decode(relay.state.messages[0].raw);
  assert.match(mail.text, /프록시/, '사람이 손댈 곳이 메일에 없다');
});

test('E2E: 알람 통지가 실패해도 허트비트는 계속된다', async () => {
  const r = rig({ emailMin: 'P3' });
  await beat(r);
  relay.state.rejectRcpt = true;                   // 메일 서버가 거부한다
  r.set('throw');
  for (let i = 0; i < 4; i++) { r.adv(90_000); await beat(r); }
  relay.state.rejectRcpt = false;
  // 알람이 수집·전송을 멈추게 할 수는 없다.
  r.set('ok');
  r.adv(60_000);
  const res = await beat(r);
  assert.strictEqual(res.ok, true, '통지 실패가 허트비트를 깨뜨렸다');
});
