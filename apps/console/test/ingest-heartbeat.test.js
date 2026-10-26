// node --test apps/console/test/ingest-heartbeat.test.js
//
// 허트비트 화이트리스트가 프로브의 자기보고를 조용히 버리지 않는지.
//
// WHY. 화이트리스트는 옳은 설계다 — 프로브가 보내는 아무 필드나 DB 에
// 들어가서는 안 된다. 문제는 조용히 버린다는 것이다. 이걸로 두 번 당했다:
// cert 블록이 한 번, link 블록이 한 번. 둘 다 프로브 쪽은 보내고 있었고
// 화면만 빈 채였다. 그 상태는 "보내지 않았다" 와 구분되지 않는다.
//
// 그래서 화면이 쓰는 필드를 여기 적어 둔다. 필드를 하나 늘리면 이 시험이
// 먼저 깨진다.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbmod = require('../src/db');
const { createIngest } = require('../src/ingest');

function rig() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-ing-'));
  const db = dbmod.open(path.join(tmp, 'c.db'));
  const settings = require('../src/settings');
  const s = settings.createSettings ? settings.createSettings(db) : null;
  return { db, ingest: createIngest(db, { now: () => 1_700_000_000_000 }), tmp, settings: s };
}

/** 프로브가 실제로 보내는 모양 (forwarder.js 의 consoleLink.heartbeat 호출부). */
const BODY = {
  version: '0.1.0', uptime_s: 300, queue_depth: 0,
  last_poll_ok_ratio: null, devices_total: 2, devices_unreachable: 0,
  clock: '2026-10-26T05:44:00.344Z', profile: 'bare', os: 'Linux 6.17',
  portal: {
    enabled: true, last_reachable: 1_699_999_000_000, last_error: null,
    sent: 3, rejected: 0, queued: 0,
    endpoint: 'https://cflex.fms.support', tenant: 'HAEA', site_id: 'HAEA-HQ',
    api_version: '1.1', api_version_seen: '1.1', last_status: 200, proxy: null,
    link: {
      link: 'up', ever_up: true, last_success: '2026-10-26T05:43:00.000Z',
      quiet_s: 60, failures: 0, last_status: 200, cause: null, hint: '',
      alarm_id: null, down_since: null,
      thresholds: { down_after_s: 300, min_failures: 3, reraise_s: 600 },
    },
  },
  cert: {
    state: 'signed', from: 'Oct 26 05:03:33 2026 GMT', to: 'Nov 25 05:03:33 2026 GMT',
    days_left: 30, renew_due: true, in_use: true,
    cn: 'HAEA.cap01', issuer: 'C-Flex Development TEST Issuer 2026',
    serial: '0A1B', fingerprint: 'ab'.repeat(32), pubkey_sha256: '7e'.repeat(32),
  },
};

function stored(node = 'cap01') {
  const r = rig();
  r.db.prepare('insert into collectors (node_id, created_at, key_hash) values (?, ?, ?)').run(node, 1, 'test-key-hash');
  r.ingest.heartbeat(node, BODY);
  const row = r.db.prepare('select heartbeat from collectors where node_id = ?').get(node);
  fs.rmSync(r.tmp, { recursive: true, force: true });
  return JSON.parse(row.heartbeat);
}

test('연동 신원이 보존된다 — 어느 서버에 누구로 붙었는가', () => {
  const h = stored();
  // 이게 없으면 잘못된 URL 을 가리킨 노드와 인증서가 거절된 노드가 똑같이 보인다.
  for (const k of ['endpoint', 'tenant', 'site_id', 'api_version', 'api_version_seen', 'last_status']) {
    assert.strictEqual(h.portal[k], BODY.portal[k], `portal.${k} 가 버려졌다`);
  }
});

test('연결 상태가 보존된다 — 화면이 알람과 같은 판단을 쓰도록', () => {
  const h = stored();
  assert.ok(h.portal.link, 'portal.link 가 통째로 버려졌다');
  assert.strictEqual(h.portal.link.link, 'up');
  assert.strictEqual(h.portal.link.ever_up, true);
  assert.strictEqual(h.portal.link.quiet_s, 60);
  assert.strictEqual(h.portal.link.failures, 0);
  // 임계값도 보존한다 — 화면이 "왜 아직 알람이 아닌지" 를 말할 수 있어야 한다.
  assert.deepStrictEqual(h.portal.link.thresholds, BODY.portal.link.thresholds);
});

test('끊긴 상태의 근거가 보존된다', () => {
  const r = rig();
  r.db.prepare('insert into collectors (node_id, created_at, key_hash) values (?, ?, ?)').run('cap02', 1, 'test-key-hash');
  r.ingest.heartbeat('cap02', {
    ...BODY,
    portal: {
      ...BODY.portal, last_error: 'heartbeat → HTTP 407',
      link: {
        ...BODY.portal.link, link: 'down', quiet_s: 420, failures: 7,
        cause: 'proxy', hint: '프록시 인증/허용 목록을 확인하라',
        alarm_id: 'a-1', down_since: '2026-10-26T05:30:00.000Z',
      },
    },
  });
  const h = JSON.parse(r.db.prepare("select heartbeat from collectors where node_id='cap02'").get().heartbeat);
  assert.strictEqual(h.portal.link.link, 'down');
  assert.strictEqual(h.portal.link.cause, 'proxy');
  assert.ok(h.portal.link.hint, '손댈 곳을 가리키는 문구가 버려졌다');
  assert.strictEqual(h.portal.link.alarm_id, 'a-1', '티켓과 연결할 id 가 버려졌다');
  assert.strictEqual(h.portal.link.down_since, '2026-10-26T05:30:00.000Z');
  fs.rmSync(r.tmp, { recursive: true, force: true });
});

test('인증서 자기보고가 보존된다', () => {
  const h = stored();
  assert.ok(h.cert, 'cert 블록이 버려졌다 — 전에 실제로 그랬다');
  assert.strictEqual(h.cert.cn, 'HAEA.cap01');
  assert.strictEqual(h.cert.issuer, BODY.cert.issuer, '누가 서명했는지가 신원의 절반이다');
  assert.strictEqual(h.cert.in_use, true);
  assert.strictEqual(h.cert.pubkey_sha256, BODY.cert.pubkey_sha256);
});

test('모르는 필드는 들어오지 않는다 — 화이트리스트는 유지된다', () => {
  const r = rig();
  r.db.prepare('insert into collectors (node_id, created_at, key_hash) values (?, ?, ?)').run('cap03', 1, 'test-key-hash');
  r.ingest.heartbeat('cap03', {
    ...BODY,
    secret_token: 'should-not-be-stored',
    portal: { ...BODY.portal, private_key: 'nope', link: { ...BODY.portal.link, injected: 'nope' } },
  });
  const raw = r.db.prepare("select heartbeat from collectors where node_id='cap03'").get().heartbeat;
  assert.ok(!raw.includes('should-not-be-stored'), '프로브가 보낸 아무 필드나 저장됐다');
  assert.ok(!raw.includes('nope'), '중첩된 모르는 필드가 저장됐다');
  fs.rmSync(r.tmp, { recursive: true, force: true });
});
