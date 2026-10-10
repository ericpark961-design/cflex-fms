// node src/workbench.test.mjs
//
// v5 §6: "모든 알람 클릭 지점 → 같은 워크벤치". That is a property of the wiring,
// not of any one screen, so it is asserted here rather than left to a click-through.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, f), 'utf8');
let fail = 0;
const check = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const app = read('App.jsx');

// 1. Every route renders the workbench, including the wall and device detail,
//    which previously had no alarm panel mounted at all.
// Two route forms exist — `return withModal(...)` and `{ const d = ...; return
// withModal(...) }` — so each branch is read to its end rather than pattern-matched.
const routes = [];
for (const m of app.matchAll(/if \(p === '(\w+)'\)/g)) {
  const body = app.slice(m.index, app.indexOf('\n', app.indexOf('return', m.index)));
  routes.push({ p: m[1], wrapped: body.includes('withModal(') });
}
check(routes.length >= 7, 'App.jsx declares the hash routes', `${routes.map(r => r.p).join(', ')}`);
for (const r of routes) check(r.wrapped, `route #/${r.p} mounts the workbench`);
check(/const d = mainData\(\); return withModal\(/.test(app), 'the default route (dashboard) mounts the workbench');
check(/<Workbench \/>/.test(app), 'withModal renders <Workbench/>');

// 2. #/incident/:id resolves to a screen rather than falling through to the
//    dashboard, so a dispatched engineer's link opens the workbench.
check(/p === 'incident'/.test(app), 'the #/incident/:id deep link has a route');

// 3. An alarm click dispatches the event; it must never navigate.
const wire = app.slice(app.indexOf('const wire = useCallback'), app.indexOf('const withModal'));
check(/cflex:open-alarm/.test(wire), "alarm rows dispatch cflex:open-alarm");
check(!/location\.hash\s*=\s*['"`]#\/(alarms|incident)/.test(wire), 'wire() never navigates on an alarm click');

// Any screen that lists alarms must use the .alarm-open hook, not an <a href>.
for (const f of readdirSync(path.join(here, 'screens')).filter(f => f.endsWith('.tpl.html'))) {
  const s = read(path.join('screens', f));
  if (!/data-alarm=/.test(s)) continue;
  const rows = [...s.matchAll(/<(a|button)\b[^>]*data-alarm=/g)];
  const bad = [...s.matchAll(/<a\b[^>]*data-alarm=[^>]*href="#\/(?!incident)/g)];
  check(rows.length > 0 && bad.length === 0, `${f} opens alarms via the event`, `${rows.length} rows, ${bad.length} navigating`);
}

// 4. The workbench itself: the triage card must never be able to render empty,
//    and it must host the alarm panel when there is no incident.
const wb = read('Workbench.jsx');
check(/state === 'nobackend'/.test(wb) && /워크벤치 백엔드 미배포/.test(wb), 'an undeployed backend is stated, not blank');
check(/<AlarmPanel/.test(wb), 'the no-incident path still offers the alarm panel');
check(/t\('아직 트리아지가 없다'\)/.test(wb), 'a missing triage shows a prompt rather than nothing');
check(/규칙 기반/.test(wb), 'a rule-based card is labelled as such');
check(/evidence_ids \|\| \[\]/.test(wb), 'hypotheses render their evidence references');
check(/데이터 축적 중/.test(wb), 'an empty trend says so instead of drawing a fake curve');
check(/can_transition \|\| \[\]/.test(wb), 'state buttons follow the server-side state machine');
check(/aria-modal="true"/.test(wb), 'the panel is a dialog for assistive tech');

// 5. The status-merge convention — a 404 from an unmounted router must be
//    distinguishable from a missing incident.
check(/status: r\.status/.test(wb), 'req() merges the HTTP status onto the body');
check(!/\bapi\(`\/v1\/incidents/.test(wb), 'workbench calls do not use the status-less api() helper');

// 6. The five surfaces v5 §4 names, each checked where it actually lives.
check(/data-alarm="\{\{h\.alertId\}\}"/.test(read('screens/Device.tpl.html')), 'device detail alarm history opens the workbench');
const noc = read('screens/NOC.tpl.html');
check(/alarm-open/.test(noc) && /<sc-for list="\{\{ticker\}\}"/.test(noc), 'the NOC ticker is data-driven and clickable');
check(!/KUS-UPS-03 배터리 전압 25\.1 V/.test(noc), 'the ticker no longer carries hard-coded sample alarms');
const twin = read('TwinScreen.jsx');
check(/cflex:open-alarm/.test(twin), 'the 3D twin alarm list opens the workbench');
check(/scene === 'real'/.test(twin) && /store\.alerts\.slice/.test(twin), 'the twin lists real alarms, not only the demo ledger');
const main = read('screens/Main.tpl.html');
check(/alarm-open/.test(main), "the dashboard's recent alarms open the workbench");
check(/alarm-open/.test(read('screens/Alarms.tpl.html')), 'alarm centre rows open the workbench');

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - every alarm entry point opens the one workbench');
process.exit(fail ? 1 : 0);
