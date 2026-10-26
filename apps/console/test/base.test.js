// node --test apps/console/test/base.test.js
//
// 접두사 계산. 이게 틀리면 로그인이 무한히 돈다 — 2026-10-26 에 실제로
// 그랬다. 콘솔을 fms.runless.co.uk 에 붙일 때 /v1/auth/ 아래로 끼워 넣었더니
// 기존 FMS SPA 의 M365 SSO 콜백까지 삼켜 NOC 로그인이 막혔고, 로그인 후
// 착지가 /twin/ 이라 기존 SPA 로 튀어 로그인이 반복됐다.
//
// 결론은 하나다: 콘솔은 자기 접두사 하나만 쓰고 남의 이름공간에 들어가지
// 않는다. 그 접두사를 UI 가 스스로 알아내야 두 배포(어플라이언스 / 공유
// 호스트)가 같은 소스로 돌아간다.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { baseOf } = require('../public/base.js');

test('호스트를 독차지하는 배포 — 접두사 없음', () => {
  assert.strictEqual(baseOf('/settings'), '');
  assert.strictEqual(baseOf('/login'), '');
});

test('호스트를 공유하는 배포 — 접두사를 떼어낸다', () => {
  assert.strictEqual(baseOf('/console/settings'), '/console');
  assert.strictEqual(baseOf('/console/login'), '/console');
});

test('깊이를 가리지 않는다 — 접두사를 바꿔도 코드를 고칠 일이 없다', () => {
  assert.strictEqual(baseOf('/a/b/settings'), '/a/b');
  assert.strictEqual(baseOf('/fms-console/login'), '/fms-console');
});

test('뒤 슬래시를 견딘다', () => {
  assert.strictEqual(baseOf('/console/settings/'), '/console');
  assert.strictEqual(baseOf('/settings/'), '');
});

test('콘솔 화면이 아니면 접두사가 없다', () => {
  // 여기서 접두사를 추측하면 엉뚱한 곳으로 리다이렉트한다.
  for (const p of ['/', '/fms', '/twin/', '/v1/console/status', '']) {
    assert.strictEqual(baseOf(p), '', p);
  }
});

test('입력이 없어도 던지지 않는다', () => {
  assert.strictEqual(baseOf(undefined), '');
  assert.strictEqual(baseOf(null), '');
});

test('settings 나 login 을 품은 다른 경로를 접두사로 오인하지 않는다', () => {
  // /fms/settings-export 는 콘솔 화면이 아니다.
  assert.strictEqual(baseOf('/fms/settings-export'), '');
  assert.strictEqual(baseOf('/loginhelp'), '');
});

test('UI 가 만드는 URL 이 두 배포에서 모두 맞다', () => {
  for (const [path, want] of [['/settings', ''], ['/console/settings', '/console']]) {
    const B = baseOf(path);
    assert.strictEqual(B, want);
    assert.strictEqual(`${B}/v1/console/status`, `${want}/v1/console/status`);
    assert.strictEqual(`${B}/login?next=${encodeURIComponent(`${B}/settings`)}`,
      `${want}/login?next=${encodeURIComponent(`${want}/settings`)}`);
  }
});

// ── 세션 쿠키의 Path ─────────────────────────────────────────────────────
//
// Path=/ 로 두면 콘솔 세션 토큰이 같은 호스트의 다른 앱 요청에도 실린다.
// fms.runless.co.uk 에서 /v1/fms/... 는 nginx 가 클라우드로 프록시하므로
// 콘솔 세션이 제3 시스템으로 전송되고 있었다.
//
// 접두사는 역프록시가 X-Forwarded-Prefix 로 알려준다. 헤더 하나로 쿠키
// 경로가 정해지는 자리이므로 검사를 시험으로 고정한다.
const { cookiePathFor } = require('../src/cookie-path');

test('접두사를 받으면 쿠키를 그 아래로 좁힌다', () => {
  assert.strictEqual(cookiePathFor('/console', true), '/console/');
  assert.strictEqual(cookiePathFor('/console/', true), '/console/');
  assert.strictEqual(cookiePathFor('/a/b', true), '/a/b/');
});

test('접두사가 없으면 루트', () => {
  for (const v of [undefined, null, '', '/']) assert.strictEqual(cookiePathFor(v, true), '/');
});

test('프록시를 신뢰하지 않으면 헤더를 보지 않는다', () => {
  assert.strictEqual(cookiePathFor('/console', false), '/');
});

test('이상한 값은 루트로 떨어진다 — 쿠키 경로를 주입당하지 않는다', () => {
  for (const bad of [
    'console',            // 선행 슬래시 없음
    '//evil.example',     // 스킴 상대 URL
    '/con sole',          // 공백
    '/console;Path=/',    // 쿠키 속성 주입
    '/console\r\nSet-Cookie: x=1', // 헤더 주입
    '/../etc',            // 경로 탈출
    '/console?a=1',
  ]) {
    assert.strictEqual(cookiePathFor(bad, true), '/', JSON.stringify(bad));
  }
});
