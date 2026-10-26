// base.js — 콘솔이 어느 접두사 아래 붙어 있는지 스스로 알아낸다.
//
// WHY. 콘솔은 두 가지로 돈다:
//   1) 어플라이언스에서 호스트를 독차지한다        → /settings, /login
//   2) 다른 앱과 호스트를 공유한다                 → /console/settings, ...
//
// (2) 를 /v1/ 아래에 끼워 넣으려다 사고가 났다. fms.runless.co.uk 에서
// `^~ /v1/auth/` 로 콘솔을 붙였더니 기존 FMS SPA 의 M365 SSO 콜백
// (/v1/auth/m365/callback) 까지 삼켜서 NOC 로그인이 막혔다. 경로를 하나씩
// 추측해 좁히는 건 틀린 접근이다 — 콘솔은 자기 접두사 하나만 쓰고 남의
// 이름공간에는 들어가지 않는다.
//
// 그래서 UI 가 자기 위치를 보고 접두사를 알아낸다. 접두사를 서버 설정이나
// 빌드 시점 값으로 박아두면 두 배포가 갈라지고, 어느 한쪽은 반드시 깨진다.
(function (g) {
  /**
   * 지금 열린 화면 경로에서 접두사를 떼어낸다.
   * `/settings` → ``   ·   `/console/settings` → `/console`
   * 깊이는 가리지 않는다: `/a/b/login` → `/a/b`
   *
   * @param {string} pathname
   * @returns {string} 접두사. 없으면 빈 문자열
   */
  function baseOf(pathname) {
    const m = /^(.*)\/(?:settings|login)\/?$/.exec(String(pathname || ''));
    return m ? m[1] : '';
  }

  g.cflexBaseOf = baseOf;
  g.CFLEX_BASE = baseOf(g.location ? g.location.pathname : '');

  // 시험에서 그대로 불러 쓴다 — 접두사 계산이 틀리면 로그인이 무한히 돈다.
  if (typeof module !== 'undefined' && module.exports) module.exports = { baseOf };
}(typeof window !== 'undefined' ? window : globalThis));
