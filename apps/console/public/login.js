// login.js — sign in, and the forced first password change. Same-origin only.
(function () {
  const $ = (s) => document.querySelector(s);
  const msg = (t) => { $('#msg').textContent = t || ''; };
  const ERR = {
    invalid_credentials: '사용자명 또는 비밀번호가 틀렸습니다. / Wrong username or password.',
    locked: '로그인 실패가 많아 잠시 잠겼습니다. 15분 후 다시 시도하거나 관리자에게 문의하세요. / Locked after too many attempts.',
    weak_password: '비밀번호 정책에 맞지 않습니다: ',
    session_store_unavailable: '세션 저장소(Redis)에 연결할 수 없습니다. / Session store unavailable.',
  };
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    let j = null; try { j = await r.json(); } catch (e) { /* empty */ }
    return { status: r.status, json: j || {} };
  }
  const next = () => { const n = new URLSearchParams(location.search).get('next'); return n && n.startsWith('/') && !n.startsWith('//') ? n : '/twin/'; };

  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault(); msg('');
    const f = e.target;
    const r = await post('/v1/auth/login', { username: f.username.value, password: f.password.value });
    if (r.status !== 200) { msg(ERR[r.json.error] || r.json.message || `HTTP ${r.status}`); return; }
    if (r.json.must_change) { $('#login').hidden = true; $('#change').hidden = false; $('#change').current.value = f.password.value; $('#change').next.focus(); return; }
    location.replace(next());
  });

  $('#change').addEventListener('submit', async (e) => {
    e.preventDefault(); msg('');
    const f = e.target;
    if (f.next.value !== f.confirm.value) { msg('새 비밀번호가 일치하지 않습니다. / Passwords do not match.'); return; }
    const r = await post('/v1/auth/password', { current: f.current.value, next: f.next.value });
    if (r.status !== 200) { msg((ERR[r.json.error] || '') + (r.json.message || '') || `HTTP ${r.status}`); return; }
    location.replace(next());
  });
})();
