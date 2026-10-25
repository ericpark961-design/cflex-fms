// settings.js — the Admin screen (spec 01 §2.2 "설정"). Plain DOM, same origin.
// Every value from the server goes in through textContent / value, never
// innerHTML, so a device label cannot become markup.
(function () {
  const $ = (s) => document.querySelector(s);
  const page = $('#page');
  let me = null;

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'on') for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f);
      else if (k === 'class') e.className = v;
      else if (v === true) e.setAttribute(k, '');
      else if (v != null && v !== false) e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const msg = (t, ok) => { const m = $('#msg'); m.textContent = t || ''; m.className = ok ? 'okmsg' : 'error'; };
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

  async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 401) { location.replace('/login?next=/settings'); throw new Error('unauthorized'); }
    let j = {}; try { j = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok || j.ok === false) { const e = new Error(j.message || j.error || `HTTP ${r.status}`); e.body = j; throw e; }
    return j;
  }
  const send = (method, path, body) => api(path, { method, body: JSON.stringify(body || {}) });
  const isAdmin = () => me && me.role === 'admin';
  const table = (head, rows) => el('table', {}, el('thead', {}, el('tr', {}, head.map(h => el('th', {}, h)))), el('tbody', {}, rows));
  const field = (label, name, value, type = 'text', extra = {}) => el('label', {}, label, el('input', { name, type, value: value ?? '', ...extra }));
  const formData = (f) => Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

  // ── tabs ─────────────────────────────────────────────────────────────────
  const TABS = [
    ['status', '상태 / Status', status],
    ['sites', '사이트 / Sites', sites],
    ['devices', '장비 / Devices', devices],
    ['import', '임포트 / Import', importer],
    ['credentials', 'SNMP 크리덴셜', credentials, true],
    ['thresholds', '임계치 / Thresholds', thresholds],
    ['notify', '알림 채널 / Channels', notifyTab, true],
    ['maintenance', '유지보수 / Maintenance', maintenance],
    ['users', '사용자 / Users', users, true],
    ['audit', '감사로그 / Audit', audit, true],
  ];
  function tabs(active) {
    const nav = $('#tabs');
    nav.replaceChildren(...TABS.filter(t => !t[3] || isAdmin()).map(([id, label]) =>
      el('button', { class: id === active ? 'on' : '', on: { click: () => { location.hash = id; } } }, label)));
  }
  async function route() {
    const id = location.hash.slice(1) || 'status';
    const t = TABS.find(x => x[0] === id && (!x[3] || isAdmin())) || TABS[0];
    tabs(t[0]); msg('');
    page.replaceChildren(el('p', { class: 'muted' }, '…'));
    try { page.replaceChildren(...[].concat(await t[2]())); } catch (e) { if (e.message !== 'unauthorized') msg(e.message); }
  }

  // ── status: portal link, collectors, this node ───────────────────────────
  async function status() {
    const s = await api('/v1/console/status');
    return [
      el('h2', {}, '이 노드 / This node'),
      el('p', {}, `${s.node} · Redis ${s.redis ? 'OK' : 'DOWN'} · secret key ${s.secret_key ? 'OK' : 'not configured'}`),
      el('h2', {}, 'Collector'),
      table(['node', 'last seen', 'version', 'queue', 'poll ok', 'devices', 'unreachable'], s.collectors.map(c => el('tr', {},
        el('td', {}, c.node_id), el('td', {}, el('span', { class: `pill ${c.stale ? 'crit' : 'ok'}` }, when(c.last_seen))),
        el('td', {}, c.heartbeat?.version ?? '—'), el('td', {}, c.heartbeat?.queue_depth ?? '—'),
        el('td', {}, c.heartbeat?.last_poll_ok_ratio ?? '—'), el('td', {}, c.heartbeat?.devices_total ?? '—'), el('td', {}, c.heartbeat?.devices_unreachable ?? '—')))),
      el('h2', {}, '포털 연결 / Portal link (collector 보고 기준)'),
      table(['node', 'enabled', 'last reachable', 'sent', 'rejected', 'queued', 'last error'], s.portal.map(p => el('tr', {},
        el('td', {}, p.node_id), el('td', {}, p.enabled == null ? '—' : String(p.enabled)), el('td', {}, when(p.last_reachable)),
        el('td', {}, p.sent ?? '—'), el('td', {}, p.rejected ?? '—'), el('td', {}, p.queued ?? '—'), el('td', {}, p.last_error || '')))),
      isAdmin() ? collectorKeyForm() : null,
    ];
  }
  function collectorKeyForm() {
    const out = el('pre', { hidden: true });
    return el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const node = formData(e.target).node;
      if (!confirm(`${node} 키를 새로 발급하면 기존 키는 즉시 무효가 됩니다. 계속할까요?`)) return;
      const r = await send('POST', `/v1/console/collectors/${encodeURIComponent(node)}/key`).catch(x => msg(x.message));
      if (r) { out.hidden = false; out.textContent = `${r.node_id}: ${r.key}\n(한 번만 표시됩니다 — collector에 0600 파일로 저장)`; }
    } } }, el('h2', {}, 'Collector 키 발급'), el('div', { class: 'row' }, field('node id', 'node', 'cap01', 'text', { pattern: '[a-z0-9][a-z0-9-]{0,31}', required: true })), el('button', {}, '발급 / Issue'), out);
  }

  // ── sites ────────────────────────────────────────────────────────────────
  async function sites() {
    const { sites: list } = await api('/v1/console/sites');
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      await send('PUT', `/v1/console/sites/${encodeURIComponent(b.id.toUpperCase())}`, b).then(() => { msg('저장됨', true); route(); }).catch(x => msg(x.message));
    } } }, el('h2', {}, '사이트 추가·수정'), el('div', { class: 'row' },
      field('코드 (HMA-FV)', 'id', '', 'text', { required: true, pattern: '[A-Za-z0-9][A-Za-z0-9-]{0,31}' }), field('이름', 'name', '', 'text', { required: true }),
      field('회사', 'company', ''), field('타임존', 'timezone', 'America/Los_Angeles')), el('button', {}, '저장'));
    return [table(['코드', '이름', '회사', '타임존'], list.map(s => el('tr', {}, el('td', {}, s.id), el('td', {}, s.name), el('td', {}, s.company || ''), el('td', {}, s.timezone)))), isAdmin() ? form : null];
  }

  // ── devices ──────────────────────────────────────────────────────────────
  async function devices() {
    const [{ devices: list }, { sites: ss }] = await Promise.all([api('/v1/console/devices'), api('/v1/console/sites')]);
    const F = [['site_id', '사이트'], ['label', '라벨'], ['vendor', '제조사'], ['model', '모델'], ['serial', '시리얼'], ['serial_alt', '추가 시리얼(;)'], ['nmc_ip', 'NMC IP'],
      ['building', '건물'], ['floor', '층'], ['room', '룸'], ['rack', '랙'], ['firmware', '펌웨어'], ['mfg_date', '제조(YYYY-MM)'], ['battery_installed', '배터리 설치'], ['battery_due', '배터리 교체'], ['in_sow', 'Exhibit 1 (1/0)']];
    const warnBox = el('div');
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      const id = b.id; delete b.id;
      try {
        const r = await send(id ? 'PUT' : 'POST', id ? `/v1/console/devices/${id}` : '/v1/console/devices', b);
        warnBox.replaceChildren(...r.warnings.map(w => el('p', { class: 'muted' }, `⚠ ${w.code}: ${w.message}`)));
        msg(`저장됨 · device_id ${r.device.device_id}`, true);
        setTimeout(route, r.warnings.length ? 4000 : 0);
      } catch (x) { msg(x.message); }
    } } }, el('h2', {}, '장비 추가·수정 (id가 있으면 수정)'), el('input', { type: 'hidden', name: 'id' }),
    el('div', { class: 'row' }, F.map(([k, l]) => k === 'site_id'
      ? el('label', {}, l, el('select', { name: k }, ss.map(s => el('option', { value: s.id }, s.id))))
      : field(l, k, ''))), el('button', {}, '저장'), warnBox);
    const edit = (d) => { for (const [k] of F) form.elements[k].value = k === 'serial_alt' ? JSON.parse(d.serial_alt || '[]').join(';') : (d[k] ?? ''); form.elements.id.value = d.id; form.scrollIntoView(); };
    return [
      el('p', { class: 'muted' }, `${list.length}대`),
      table(['사이트', '라벨', '모델', '시리얼', 'NMC IP', '위치', 'SOW', 'device_id', ''], list.map(d => el('tr', {},
        el('td', {}, d.site_id), el('td', {}, d.label), el('td', {}, d.model || ''), el('td', {}, d.serial || el('span', { class: 'pill warn' }, 'provisional')),
        el('td', {}, d.nmc_ip || ''), el('td', {}, [d.building, d.floor, d.room, d.rack].filter(Boolean).join(' / ')),
        el('td', {}, d.in_sow ? 'Y' : 'N'), el('td', { class: 'small' }, d.device_id),
        el('td', {}, isAdmin() ? [el('button', { class: 'secondary', on: { click: () => edit(d) } }, '수정'), ' ',
          el('button', { class: 'danger', on: { click: async () => { if (confirm(`${d.label} 삭제?`)) { await send('DELETE', `/v1/console/devices/${d.id}`).catch(x => msg(x.message)); route(); } } } }, '삭제')] : null)))),
      isAdmin() ? form : null,
    ];
  }

  // ── import ───────────────────────────────────────────────────────────────
  function importer() {
    if (!isAdmin()) return el('p', { class: 'muted' }, 'Admin 전용');
    const ta = el('textarea', { placeholder: 'site,unit,model,serial,ip,mfg_date_reported,exhibit1,…' });
    const file = el('input', { type: 'file', accept: '.csv,text/csv' });
    file.addEventListener('change', async () => { ta.value = await file.files[0].text(); });
    const out = el('div');
    const run = async (dry) => {
      const r = await fetch(`/v1/console/import${dry ? '?dry_run=1' : ''}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'text/csv' }, body: ta.value });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && !j.rows) { msg(j.message || j.error || `HTTP ${r.status}`); return; }
      msg(`${dry ? '검증' : '임포트'}: 생성 ${j.created} · 갱신 ${j.updated} · 실패 ${j.failed}`, j.failed === 0);
      out.replaceChildren(table(['행', '사이트', '라벨', '동작', '경고/오류'], j.rows.map(x => el('tr', {},
        el('td', {}, x.row), el('td', {}, x.site), el('td', {}, x.label), el('td', {}, x.error ? el('span', { class: 'pill crit' }, x.error) : x.action),
        el('td', {}, x.message || (x.warnings || []).map(w => `${w.code}: ${w.message}`).join(' · '))))));
    };
    return [
      el('p', { class: 'muted' }, 'Exhibit 1 / Q3 시드 CSV. 열 이름: site(=사이트 코드 또는 접두어), unit|label, ip|nmc_ip, model, serial, serial_alt(;), mfg_date, battery_install, battery_replace_due, exhibit1(Y/N), snmp_version, snmp_community … — 시리얼 기준 갱신, 없으면 (사이트, 라벨). XLSX는 CSV로 저장해서 올린다.'),
      file, ta, el('div', {}, el('button', { class: 'secondary', on: { click: () => run(true) } }, '검증만 / Dry run'), ' ', el('button', { on: { click: () => run(false) } }, '임포트 / Import')), out,
    ];
  }

  // ── credentials ──────────────────────────────────────────────────────────
  async function credentials() {
    const { credentials: list } = await api('/v1/console/credentials');
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      for (const k of Object.keys(b)) if (b[k] === '') delete b[k];
      await send('PUT', '/v1/console/credentials', b).then(() => { msg('저장됨 (비밀값은 암호화 저장, 다시 표시되지 않음)', true); route(); }).catch(x => msg(x.message));
    } } }, el('h2', {}, '크리덴셜 설정 — 사이트 기본값 또는 장비별'), el('div', { class: 'row' },
      field('사이트 코드', 'site_id', ''), field('또는 device_id', 'device_id', ''),
      el('label', {}, '버전', el('select', { name: 'version' }, ['3', '2c', '1'].map(v => el('option', { value: v }, `v${v}`)))),
      field('community (v1/v2c)', 'community', '', 'password', { autocomplete: 'off' }), field('v3 user', 'username', ''),
      field('auth proto (SHA…)', 'auth_proto', 'SHA'), field('auth key', 'auth_key', '', 'password', { autocomplete: 'off' }),
      field('priv proto (AES…)', 'priv_proto', 'AES'), field('priv key', 'priv_key', '', 'password', { autocomplete: 'off' })), el('button', {}, '저장'));
    return [table(['사이트', 'device_id', '버전', 'user', 'auth', 'priv', '비밀값', '수정'], list.map(c => el('tr', {},
      el('td', {}, c.site_id || ''), el('td', {}, c.device_id || ''), el('td', {}, `v${c.version}`), el('td', {}, c.username || ''),
      el('td', {}, c.auth_proto || ''), el('td', {}, c.priv_proto || ''), el('td', {}, c.secret_set ? '설정됨' : '—'), el('td', {}, `${c.updated_by || ''} ${when(c.updated_at)}`)))), form];
  }

  // ── thresholds ───────────────────────────────────────────────────────────
  async function thresholds() {
    const { thresholds: t } = await api('/v1/console/thresholds');
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      const body = {};
      for (const k of Object.keys(t)) body[k] = { critical: Number(b[`${k}.critical`]), warn: Number(b[`${k}.warn`]) };
      await send('PUT', '/v1/console/thresholds', body).then(() => msg('저장됨', true)).catch(x => msg(x.message));
    } } }, table(['지표', '방향', '경고', '위험'], Object.entries(t).map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, v.direction === 'below' ? '미만' : '초과'),
      el('td', {}, el('input', { name: `${k}.warn`, type: 'number', step: 'any', value: v.warn, disabled: !isAdmin() })),
      el('td', {}, el('input', { name: `${k}.critical`, type: 'number', step: 'any', value: v.critical, disabled: !isAdmin() }))))),
    isAdmin() ? el('button', {}, '저장') : null);
    return [el('p', { class: 'muted' }, '장비별 값은 장비 설정이 우선. 알람 코드·심각도는 계약서 부록 B로 고정(여기서 바꾸는 것은 임계치뿐).'), form];
  }

  // ── notification channels ────────────────────────────────────────────────
  async function notifyTab() {
    const { notify: n } = await api('/v1/console/notify');
    const p = n.policy || {};
    const secretField = (label, name, cur) => field(`${label}${cur && cur.set ? ' (설정됨 — 비우면 유지)' : ''}`, name, '', 'password', { autocomplete: 'off' });
    const P = (name, v) => el('select', { name }, ['P1', 'P2', 'P3', 'P4'].map(x => el('option', { value: x, selected: x === (v || 'P2') }, x)));
    const chk = (name, v) => el('label', {}, el('input', { type: 'checkbox', name, checked: v !== false }), name);
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const f = e.target; const b = formData(f);
      const body = {
        policy: { local_email: f.local_email.checked, local_teams: f.local_teams.checked, local_itsm: f.local_itsm.checked, notify_clear: f.notify_clear.checked,
          email_min: b.email_min, teams_min: b.teams_min, itsm_min: b.itsm_min },
        email: { from: b.from, to: b.to.split(/[,;\s]+/).filter(Boolean), smtp: { host: b.smtp_host, port: Number(b.smtp_port) || 25, auth: { user: b.smtp_user || undefined } } },
        servicenow: { instanceUrl: b.sn_url, user: b.sn_user, assignmentGroup: b.sn_group || undefined },
        teams: {},
      };
      if (b.smtp_pass) body.email.smtp.auth.pass = b.smtp_pass;
      if (b.teams_webhook) body.teams.webhook = b.teams_webhook;
      if (b.sn_pass) body.servicenow.pass = b.sn_pass;
      await send('PUT', '/v1/console/notify', body).then(() => { msg('저장됨', true); route(); }).catch(x => msg(x.message));
    } } },
    el('h2', {}, '정책'), el('div', { class: 'row' }, chk('local_email', p.local_email), chk('local_teams', p.local_teams), chk('local_itsm', p.local_itsm), chk('notify_clear', p.notify_clear),
      el('label', {}, 'e-mail 최소', P('email_min', p.email_min)), el('label', {}, 'Teams 최소', P('teams_min', p.teams_min)), el('label', {}, 'ITSM 최소', P('itsm_min', p.itsm_min))),
    el('h2', {}, 'SMTP (HAEA 릴레이)'), el('div', { class: 'row' }, field('host', 'smtp_host', n.email?.smtp?.host), field('port', 'smtp_port', n.email?.smtp?.port || 587, 'number'),
      field('user', 'smtp_user', n.email?.smtp?.auth?.user), secretField('password', 'smtp_pass', n.email?.smtp?.auth?.pass),
      field('from', 'from', n.email?.from), field('to (쉼표 구분)', 'to', (n.email?.to || []).join(', '))),
    el('h2', {}, 'Teams'), el('div', { class: 'row' }, secretField('webhook URL', 'teams_webhook', n.teams?.webhook)),
    el('h2', {}, 'ServiceNow'), el('div', { class: 'row' }, field('instance URL', 'sn_url', n.servicenow?.instanceUrl), field('user', 'sn_user', n.servicenow?.user),
      secretField('password', 'sn_pass', n.servicenow?.pass), field('assignment group', 'sn_group', n.servicenow?.assignmentGroup)),
    el('button', {}, '저장'));
    const out = el('pre', { hidden: true });
    const test = el('button', { class: 'secondary', on: { click: async () => {
      test.disabled = true; out.hidden = false; out.textContent = '생성 → 업데이트 → 종료 …';
      try { const r = await send('POST', '/v1/console/notify/test-ticket', {}); out.textContent = `OK ${r.number} · updated ${r.updated} · resolved ${r.resolved}`; }
      catch (x) { out.textContent = `실패: ${x.body?.step || ''} ${x.message}`; }
      test.disabled = false;
    } } }, 'ServiceNow 테스트 티켓 / Test ticket');
    return [form, el('h2', {}, 'SOW 수락 시험'), test, out];
  }

  // ── maintenance ──────────────────────────────────────────────────────────
  async function maintenance() {
    const { windows } = await api('/v1/console/maintenance');
    const canSet = me.role !== 'viewer';
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      await send('POST', '/v1/console/maintenance', { site_id: b.site_id || undefined, device: b.device || undefined, minutes: Number(b.minutes), reason: b.reason })
        .then(() => { msg('설정됨', true); route(); }).catch(x => msg(x.message));
    } } }, el('h2', {}, '유지보수 창 설정 — 이 기간 알람은 포털로는 가되 로컬 알림은 보내지 않음'), el('div', { class: 'row' },
      field('사이트 코드 (비우면 전체)', 'site_id', ''), field('장비 id 또는 device_id (선택)', 'device', ''), field('분', 'minutes', 60, 'number', { min: 1, max: 44640 }), field('사유', 'reason', '')), el('button', {}, '설정'));
    return [table(['대상', '시작', '종료', '사유', '설정자', ''], windows.map(w => el('tr', {},
      el('td', {}, w.device_id || w.site_id || '전체'), el('td', {}, when(w.starts_at)), el('td', {}, when(w.ends_at)), el('td', {}, w.reason || ''), el('td', {}, w.created_by),
      el('td', {}, canSet ? el('button', { class: 'secondary', on: { click: async () => { await send('DELETE', `/v1/console/maintenance/${w.id}`).catch(x => msg(x.message)); route(); } } }, '종료') : null)))),
    canSet ? form : null];
  }

  // ── users ────────────────────────────────────────────────────────────────
  async function users() {
    const { users: list } = await api('/v1/console/users');
    const role = (name, v) => el('select', { name }, ['viewer', 'operator', 'admin'].map(r => el('option', { value: r, selected: r === v }, r)));
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      await send('POST', '/v1/console/users', formData(e.target)).then(() => { msg('생성됨 — 첫 로그인 때 비밀번호 변경', true); route(); }).catch(x => msg(x.message));
    } } }, el('h2', {}, '사용자 추가'), el('div', { class: 'row' }, field('username', 'username', '', 'text', { required: true }), field('이름', 'display_name', ''), field('e-mail', 'email', '', 'email'),
      el('label', {}, '역할', role('role', 'viewer')), field('임시 비밀번호 (12자+, 3종)', 'password', '', 'password', { required: true, autocomplete: 'new-password' })), el('button', {}, '추가'));
    const act = async (u, body, what) => { await send('PUT', `/v1/console/users/${u.id}`, body).then(() => { msg(`${u.username}: ${what}`, true); route(); }).catch(x => msg(x.message)); };
    return [table(['username', '이름', '역할', '상태', '마지막 로그인', ''], list.map(u => el('tr', {},
      el('td', {}, u.username), el('td', {}, u.display_name || ''), el('td', {}, el('select', { on: { change: (e) => act(u, { role: e.target.value }, '역할 변경') } },
        ['viewer', 'operator', 'admin'].map(r => el('option', { value: r, selected: r === u.role }, r)))),
      el('td', {}, u.disabled ? el('span', { class: 'pill crit' }, '비활성') : (u.must_change ? el('span', { class: 'pill warn' }, '비번 변경 대기') : el('span', { class: 'pill ok' }, '활성'))),
      el('td', {}, when(u.last_login_at)),
      el('td', {}, el('button', { class: 'secondary', on: { click: () => act(u, { disabled: !u.disabled }, u.disabled ? '활성화' : '비활성화') } }, u.disabled ? '활성화' : '비활성화'), ' ',
        el('button', { class: 'secondary', on: { click: () => act(u, { unlock: true }, '잠금 해제') } }, '잠금 해제'), ' ',
        el('button', { class: 'secondary', on: { click: () => { const pw = prompt('임시 비밀번호 (12자+, 3종). 다음 로그인 때 변경해야 함'); if (pw) act(u, { password: pw }, '비밀번호 재설정'); } } }, '비번 재설정'))))), form];
  }

  // ── audit ────────────────────────────────────────────────────────────────
  async function audit() {
    const { entries } = await api('/v1/console/audit?limit=300');
    return [el('p', { class: 'muted' }, '추가 전용(append-only). 최근 300건.'), table(['시각', '사용자', '동작', '대상', '내용', 'IP', '노드'], entries.map(a => el('tr', {},
      el('td', {}, when(a.ts)), el('td', {}, a.actor || ''), el('td', {}, a.action), el('td', {}, a.target || ''), el('td', { class: 'small' }, a.detail || ''), el('td', {}, a.ip || ''), el('td', {}, a.node || ''))))];
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  $('#logout').addEventListener('click', async () => { await send('POST', '/v1/auth/logout').catch(() => {}); location.replace('/login'); });
  window.addEventListener('hashchange', route);
  api('/v1/me').then((m) => {
    me = m;
    if (m.must_change) { location.replace('/login?next=/settings'); return; }
    $('#who').textContent = `${m.displayName} (${m.role})`;
    route();
  }).catch(() => {});
})();
