// portal-link.js — "포털이 안 보인다" 를 알람으로 바꾸는 상태기계.
//
// WHY. 지금까지 포털 연결이 끊기면 아무 일도 일어나지 않았다. 큐에 쌓이고,
// 로그에 한 줄 남고, 누군가 콘솔을 열어볼 때까지 조용하다. 7일 버퍼(D-07)가
// 차오르는 동안 아무도 모르는 상태가 가능하다는 뜻이다.
//
// 코드는 새로 만들지 않는다. 계약 부록 B 에 `PORTAL_LINK_DOWN` (P3) 이 이미
// 있고 schemas/events 의 enum 과 alarms/codes.js 에도 들어 있다 — 올리는
// 쪽이 없었을 뿐이다.
//
// 두 알람은 중복이 아니다. 청중과 조치가 다르다:
//
//   PROBE_OFFLINE   포털이 감지. 프로브가 조용하다. 청중 = C-Flex NOC.
//                   조치: 고객망이 죽었나, VM 이 죽었나.
//   PORTAL_LINK_DOWN 프로브가 감지. 내가 포털에 못 닿는다. 청중 = HAEA IT.
//                   조치: 프록시 규칙, 방화벽, DNS, 인증서 — 거의 항상
//                   HAEA 경계 안쪽이다. NOC 은 HAEA 프록시를 고칠 수 없다.
//
// 그래서 억제(dedup)가 아니라 상호참조가 필요하다. 각자 자기 청중에게 가고,
// 링크가 돌아오면 큐에 있던 raise/clear 가 포털에 도착해 NOC 이 프로브
// 쪽 시각을 뒤늦게 본다.
//
// 임계값을 왜 이렇게 잡았는지:
//   down   = 300 s 무성공 AND 실패 3회 이상.
//            300 s 는 포털의 PROBE_OFFLINE 과 같은 지평이다 — 한쪽은 끊겼다고
//            하고 다른 쪽은 괜찮다고 하는 창을 만들지 않는다. 백오프가 재시도
//            간격을 5분까지 늘리므로(D-07) 횟수만으로는 시간을 못 재고,
//            반대로 시간만 쓰면 한 번의 긴 멈춤에 떠버린다. 둘 다 본다.
//   clear  = 첫 성공 즉시. 복구는 빨리 알려야 한다.
//   재발   = clear 후 600 s 는 다시 올리지 않는다. 90초마다 끊기는 링크가
//            알람 폭풍이 되는 걸 막는 건 clear 를 늦추는 게 아니라 raise 를
//            무는 것이다.
//   update = 보내지 않는다. 끊긴 동안 포털엔 어차피 안 가고, 로컬 메일을
//            반복하면 사람이 필터를 만든다. raise 하나, clear 하나.
//
// 한 번도 연결된 적 없는 노드는 올리지 않는다. 설치 중에는 링크가 정의상
// 끊겨 있고, 설치할 때마다 호출기가 울리면 사람은 이 알람을 무시하게 된다.
// 콘솔 단계 사다리가 '연결 실패' 로 이미 보여준다. 다만 인증서가 설치된 뒤
// 24시간이 지나도 한 번도 못 붙었으면 그건 설치 중이 아니라 실패한 설치다 —
// 그때 한 번 올린다.
'use strict';
const crypto = require('node:crypto');
const { SEVERITY } = require('./codes');

const CODE = 'PORTAL_LINK_DOWN';

/** 끊긴 이유를 HAEA IT 가 바로 손댈 수 있는 말로 분류한다. */
function causeOf(status, error) {
  const e = String(error || '');
  if (status === 407 || /proxy/i.test(e)) return 'proxy';
  if (status === 401 || status === 403) {
    return /mtls|client[ _-]?cert|certificate|ssl_client/i.test(e) ? 'cert' : 'auth';
  }
  if (status === 429) return 'throttled';
  if (status >= 500) return 'portal';
  if (status > 0) return 'portal';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(e)) return 'dns';
  if (/CERT_|certificate|self.signed|ERR_TLS|SSL|alert/i.test(e)) return 'tls';
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|socket hang up|timeout/i.test(e)) return 'network';
  return 'unknown';
}

const HINT = Object.freeze({
  proxy: '프록시 인증/허용 목록을 확인하라 (D-09: Basic 만)',
  cert: '장비 인증서가 폐기·만료·CN 불일치일 수 있다 — 콘솔 "포털 연동" 의 신원 표를 보라',
  auth: '테넌트·노드 헤더나 등록 상태를 확인하라',
  throttled: '분당 60요청 한도에 걸렸다 — 큐가 빠질 때까지 기다린다',
  portal: '포털 쪽 응답이다 — C-Flex 에 문의',
  dns: 'DNS 가 포털 이름을 못 푼다',
  tls: '서버 인증서 검증에 실패했다 — 중간 검사 장비(TLS 가로채기)를 의심하라',
  network: '아웃바운드 443 경로가 막혔다 (방화벽 규칙)',
  unknown: '',
});

/**
 * @param {object} o
 * @param {string} o.endpoint        포털 주소 (알람 본문에 들어간다)
 * @param {string} [o.siteId]
 * @param {number} [o.downAfterMs]   무성공 지속 시간 임계
 * @param {number} [o.minFailures]   실패 횟수 하한
 * @param {number} [o.reraiseMs]     clear 후 재발 억제
 * @param {number} [o.neverUpMs]     설치됐으나 한 번도 못 붙은 경우의 백스톱
 * @param {Function} [o.now]
 * @param {Function} [o.uuid]
 */
function createPortalLink({
  endpoint, siteId = null,
  downAfterMs = 300_000,
  minFailures = 3,
  reraiseMs = 600_000,
  neverUpMs = 24 * 3600_000,
  now = Date.now,
  uuid = () => crypto.randomUUID(),
} = {}) {
  let lastSuccess = null;       // 마지막으로 포털이 응답한 시각
  let firstFailure = null;      // 끊김이 시작된 시각
  let failures = 0;
  let everUp = false;
  let alarm = null;             // { alarm_id, since, cause } — 떠 있는 동안
  let clearedAt = null;         // 재발 억제 기준
  let last = { status: null, error: null, cause: null };
  let neverUpRaised = false;

  /** 포털 호출 한 번의 결과. forwarder.call() 이 매번 알려준다. */
  function record({ ok, status = null, error = null }) {
    last = { status, error, cause: ok ? null : causeOf(status, error) };
    if (ok) {
      lastSuccess = now();
      everUp = true;
      firstFailure = null;
      failures = 0;
      return;
    }
    failures += 1;
    if (firstFailure == null) firstFailure = now();
  }

  function event(kind, extra) {
    return {
      event_id: uuid(),
      device_id: null,               // 노드 알람 — 장비에 매달지 않는다
      site_id: siteId,
      ts: new Date(now()).toISOString(),
      severity: SEVERITY[CODE],      // 계약 부록 B = P3
      code: CODE,
      source: 'system',
      kind,
      ...extra,
    };
  }

  /**
   * 허트비트마다 한 번. 올릴 게 있으면 emit() 에 넣을 item 을 돌려준다.
   * emit() 이어야 한다 — postEvents() 는 포털 큐만 타므로 끊긴 동안 아무에게도
   * 안 가고 복구된 뒤에야 도착한다. 이 알람에선 그게 무의미하다.
   *
   * @param {object} o
   * @param {number} [o.queueDepth]  버퍼에 남은 건수 — 데이터가 위험한지를 말해준다
   * @param {number} [o.installedAt] 인증서 설치 시각 (ms). 백스톱 판정용
   */
  function assess({ queueDepth = 0, installedAt = null } = {}) {
    const t = now();
    const items = [];

    // 복구: 성공이 들어왔고 알람이 떠 있으면 바로 내린다.
    if (alarm && lastSuccess != null && lastSuccess > alarm.since) {
      const a = alarm;
      alarm = null;
      clearedAt = t;
      items.push({
        notifyAs: 'clear',
        alarm: { title: `포털 연결 끊김 (${endpoint})`, label: '포털 연결' },
        event: event('alarm_clear', {
          alarm_id: a.alarm_id,
          title: `포털 연결 복구 (${endpoint})`,
          detail: {
            endpoint,
            down_s: Math.round((lastSuccess - a.since) / 1000),
            cause_was: a.cause,
            queued_while_down: queueDepth,
          },
        }),
      });
      return { items, state: state() };
    }

    if (alarm) return { items, state: state() };                 // 떠 있는 동안은 조용히
    if (clearedAt != null && t - clearedAt < reraiseMs) return { items, state: state() };

    // 한 번도 붙은 적 없는 노드: 설치 중이다. 백스톱만 본다.
    if (!everUp) {
      const stale = installedAt != null && t - installedAt >= neverUpMs;
      if (!stale || neverUpRaised || failures === 0) return { items, state: state() };
      neverUpRaised = true;
      alarm = { alarm_id: uuid(), since: installedAt, cause: last.cause };
      items.push(raise({ t, queueDepth, never: true }));
      return { items, state: state() };
    }

    const downFor = firstFailure == null ? 0 : t - firstFailure;
    const quietFor = lastSuccess == null ? downFor : t - lastSuccess;
    if (failures < minFailures || quietFor < downAfterMs) return { items, state: state() };

    alarm = { alarm_id: uuid(), since: firstFailure, cause: last.cause };
    items.push(raise({ t, queueDepth, never: false }));
    return { items, state: state() };
  }

  function raise({ t, queueDepth, never }) {
    const cause = last.cause || 'unknown';
    return {
      notifyAs: 'raise',
      alarm: { title: `포털 연결 끊김 (${endpoint})`, label: '포털 연결' },
      event: event('alarm_raise', {
        alarm_id: alarm.alarm_id,
        title: never
          ? `포털에 한 번도 연결되지 않았다 (${endpoint})`
          : `포털 연결 끊김 ${Math.round((t - alarm.since) / 1000)} s (${endpoint})`,
        detail: {
          endpoint,
          cause,
          hint: HINT[cause] || '',
          never_connected: never,
          down_since: new Date(alarm.since).toISOString(),
          last_success: lastSuccess == null ? null : new Date(lastSuccess).toISOString(),
          attempts: failures,
          last_status: last.status,
          // 7일 버퍼(D-07)가 얼마나 찼는지 — 데이터 손실이 임박한지를 말해준다
          queue_depth: queueDepth,
        },
      }),
    };
  }

  /** 콘솔이 보여줄 상태. 알람과 같은 판단을 쓴다 — 화면과 알람이 갈리지 않도록. */
  function state() {
    const t = now();
    return {
      link: alarm ? 'down' : (everUp && failures === 0 ? 'up' : (everUp ? 'degraded' : 'never')),
      ever_up: everUp,
      last_success: lastSuccess == null ? null : new Date(lastSuccess).toISOString(),
      quiet_s: lastSuccess == null ? null : Math.round((t - lastSuccess) / 1000),
      failures,
      last_status: last.status,
      cause: alarm ? alarm.cause : last.cause,
      hint: last.cause ? (HINT[last.cause] || '') : '',
      alarm_id: alarm ? alarm.alarm_id : null,
      down_since: alarm ? new Date(alarm.since).toISOString() : null,
      thresholds: { down_after_s: downAfterMs / 1000, min_failures: minFailures, reraise_s: reraiseMs / 1000 },
    };
  }

  return { record, assess, state, CODE };
}

module.exports = { createPortalLink, causeOf, CODE, HINT };
