// node --test probe-agent/test/portal-link.test.js
//
// 링크 알람의 판단을 고정한다. 여기서 검증하는 건 "언제 울리고 언제 안
// 울리는가" 다 — 임계값을 잘못 잡으면 한 번 끊길 때마다 호출기가 울거나,
// 7일 버퍼가 차는 동안 아무도 모른다.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPortalLink, causeOf } = require('../src/alarms/portal-link');

/** 시계를 손으로 돌린다. 실제 대기 없이 임계값을 넘길 수 있어야 한다. */
function rig(opts = {}) {
  let t = 1_000_000;
  let n = 0;
  const l = createPortalLink({
    endpoint: 'https://cflex.fms.support', siteId: 'HAEA-HQ',
    now: () => t, uuid: () => `id-${++n}`, ...opts,
  });
  return {
    link: l,
    at: (ms) => { t = ms; },
    adv: (ms) => { t += ms; },
    now: () => t,
    fail: (k = 1, status = 0, error = 'ETIMEDOUT') => { for (let i = 0; i < k; i++) l.record({ ok: false, status, error }); },
    ok: () => l.record({ ok: true, status: 200 }),
  };
}

test('한 번 끊긴 것으로는 울리지 않는다', () => {
  const r = rig();
  r.ok();
  r.adv(60_000); r.fail(1);
  assert.strictEqual(r.link.assess().items.length, 0);
  // 실패는 3회를 넘겼지만 아직 5분이 안 됐다
  r.adv(60_000); r.fail(3);
  assert.strictEqual(r.link.assess().items.length, 0, '시간 임계를 넘기지 않았는데 울렸다');
});

test('시간만 지났고 시도는 한 번뿐이면 올리지 않는다', () => {
  // 백오프가 재시도 간격을 5분까지 늘린다(D-07). 그래서 "무성공 5분" 만 보면
  // 한 번의 긴 멈춤에도 떠버린다 — 실패 횟수 하한이 그걸 막는다.
  const r = rig();
  r.ok();
  r.adv(1000); r.fail(1);
  r.adv(400_000);
  assert.strictEqual(r.link.state().failures, 1);
  assert.ok(r.link.state().quiet_s > 300, '무성공 시간은 이미 임계를 넘었다');
  assert.strictEqual(r.link.assess().items.length, 0,
    '시도 한 번으로 올리면 재시도가 드문 구간마다 울린다');
});

test('5분 무성공 + 실패 3회에서 P3 로 올린다', () => {
  const r = rig();
  r.ok();
  const downFrom = r.now();
  r.adv(1000); r.fail(3);
  r.adv(300_000);
  const { items } = r.link.assess({ queueDepth: 412 });
  assert.strictEqual(items.length, 1);
  const ev = items[0].event;
  assert.strictEqual(ev.code, 'PORTAL_LINK_DOWN');
  assert.strictEqual(ev.severity, 'P3', '계약 부록 B 는 P3 다');
  assert.strictEqual(ev.kind, 'alarm_raise');
  assert.strictEqual(ev.device_id, null, '노드 알람은 장비에 매달지 않는다');
  assert.strictEqual(ev.site_id, 'HAEA-HQ');
  assert.strictEqual(ev.source, 'system');
  assert.strictEqual(items[0].notifyAs, 'raise');
  // 데이터가 위험한지를 말해주는 값
  assert.strictEqual(ev.detail.queue_depth, 412);
  assert.strictEqual(ev.detail.never_connected, false);
  assert.ok(ev.detail.down_since >= new Date(downFrom).toISOString());
  assert.strictEqual(ev.detail.cause, 'network');
  assert.ok(ev.detail.hint.length > 0, '사람이 손댈 곳을 알려줘야 한다');
});

test('떠 있는 동안에는 반복해서 올리지 않는다 (update 없음)', () => {
  const r = rig();
  r.ok(); r.adv(1000); r.fail(3); r.adv(300_000);
  assert.strictEqual(r.link.assess().items.length, 1);
  for (let i = 0; i < 10; i++) { r.adv(60_000); r.fail(1); assert.strictEqual(r.link.assess().items.length, 0); }
});

test('첫 성공에 즉시 내린다', () => {
  const r = rig();
  r.ok(); r.adv(1000); r.fail(3); r.adv(300_000);
  const raised = r.link.assess().items[0].event;
  r.adv(60_000); r.ok();
  const { items } = r.link.assess({ queueDepth: 7 });
  assert.strictEqual(items.length, 1);
  const ev = items[0].event;
  assert.strictEqual(ev.kind, 'alarm_clear');
  assert.strictEqual(ev.alarm_id, raised.alarm_id, 'clear 가 raise 와 같은 alarm_id 여야 티켓이 닫힌다');
  assert.strictEqual(items[0].notifyAs, 'clear');
  assert.ok(ev.detail.down_s >= 360, `끊긴 시간이 들어가야 한다: ${ev.detail.down_s}`);
  assert.strictEqual(ev.detail.cause_was, 'network');
  assert.strictEqual(ev.detail.queued_while_down, 7);
});

test('깜빡이는 링크는 10분에 한 번만 울린다', () => {
  const r = rig();
  r.ok(); r.adv(1000); r.fail(3); r.adv(300_000);
  assert.strictEqual(r.link.assess().items.length, 1, 'raise');
  r.adv(1000); r.ok();
  assert.strictEqual(r.link.assess().items.length, 1, 'clear');
  // 바로 다시 끊긴다 — 억제창 안이므로 조용해야 한다
  r.adv(1000); r.fail(5); r.adv(300_000);
  assert.strictEqual(r.link.assess().items.length, 0, '억제창 안에서 재발했다');
  // 억제창이 지나면 다시 올린다
  r.adv(600_000); r.fail(1);
  assert.strictEqual(r.link.assess().items.length, 1, '억제창이 지났는데 울리지 않았다');
});

test('한 번도 연결된 적 없으면 올리지 않는다 — 설치 중이다', () => {
  const r = rig();
  const installedAt = r.now();
  r.adv(1000); r.fail(20); r.adv(3_600_000);     // 한 시간 내내 실패
  assert.strictEqual(r.link.assess({ installedAt }).items.length, 0,
    '설치 중에 울리면 사람은 이 알람을 무시하게 된다');
  assert.strictEqual(r.link.state().link, 'never');
});

test('설치 후 24시간이 지나도 못 붙으면 한 번 올린다', () => {
  const r = rig();
  const installedAt = r.now();
  r.adv(1000); r.fail(5);
  r.adv(24 * 3600_000);
  const { items } = r.link.assess({ installedAt });
  assert.strictEqual(items.length, 1, '실패한 설치가 영원히 조용할 수는 없다');
  assert.strictEqual(items[0].event.detail.never_connected, true);
  assert.match(items[0].event.title, /한 번도 연결되지 않았다/);
  // 백스톱은 한 번뿐이다
  r.adv(24 * 3600_000); r.fail(1);
  assert.strictEqual(r.link.assess({ installedAt }).items.length, 0);
});

test('mTLS 거절은 토큰 문제와 다르게 분류한다', () => {
  const r = rig();
  r.ok(); r.adv(1000);
  r.fail(3, 401, 'HTTP 401 mtls_certificate_required');
  r.adv(300_000);
  const ev = r.link.assess().items[0].event;
  assert.strictEqual(ev.detail.cause, 'cert', '인증서 거절을 auth 로 분류하면 엉뚱한 곳을 보게 된다');
  assert.match(ev.detail.hint, /인증서/);
});

test('원인 분류', () => {
  assert.strictEqual(causeOf(407, 'proxy authentication required'), 'proxy');
  assert.strictEqual(causeOf(403, 'ssl_client_verify failed'), 'cert');
  assert.strictEqual(causeOf(401, 'invalid bearer'), 'auth');
  assert.strictEqual(causeOf(429, 'slow down'), 'throttled');
  assert.strictEqual(causeOf(502, ''), 'portal');
  assert.strictEqual(causeOf(0, 'getaddrinfo ENOTFOUND cflex.fms.support'), 'dns');
  assert.strictEqual(causeOf(0, 'unable to verify the first certificate'), 'tls');
  assert.strictEqual(causeOf(0, 'connect ECONNREFUSED'), 'network');
  assert.strictEqual(causeOf(0, 'something odd'), 'unknown');
});

test('state() 가 화면과 알람에 같은 판단을 준다', () => {
  const r = rig();
  assert.strictEqual(r.link.state().link, 'never');
  r.ok();
  assert.strictEqual(r.link.state().link, 'up');
  r.adv(1000); r.fail(1);
  assert.strictEqual(r.link.state().link, 'degraded', '한 번 실패는 끊김이 아니라 흔들림이다');
  r.fail(2); r.adv(300_000); r.link.assess();
  const st = r.link.state();
  assert.strictEqual(st.link, 'down');
  assert.ok(st.alarm_id, '떠 있는 알람의 id 를 화면이 알아야 티켓과 연결된다');
  assert.strictEqual(st.thresholds.down_after_s, 300);
  assert.strictEqual(st.failures, 3);
});
