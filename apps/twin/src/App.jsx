import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { LayoutGrid, Map as MapIcon, Server, AlertTriangle, Globe, Settings as SettingsIcon, Search, Bell, LogOut, RefreshCw, Box, Battery, Activity, Thermometer, Clock, Menu, X as XIcon } from 'lucide-react';
import { C, FONT, tx, api, withCbu, cbu as getCbu, STATUS, SEV } from './theme';
import { devId } from './ids';
import Twin3D from './Twin3D';

const fmtAgo = (ms) => { if (!ms) return '—'; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
const card = { background: C.card, border: `1px solid ${C.hairline}` };
const sec = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: C.inkMuted };

// Single breakpoint at 768px, same as Fms.jsx.
const MOBILE_BP = 768;
function useViewport() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1280);
  useEffect(() => { const onR = () => setW(window.innerWidth); window.addEventListener('resize', onR); return () => window.removeEventListener('resize', onR); }, []);
  return { w, isMobile: w < MOBILE_BP };
}

function Nav({ me, isMobile, open, onClose }) {
  const items = [
    [LayoutGrid, tx('대시보드', 'Dashboard'), '/fms'], [Box, tx('3D 트윈', '3D Twin'), '/twin/', true], [Server, tx('장치', 'Devices'), '/fms'],
    [AlertTriangle, tx('알람', 'Alarms'), '/fms'], [MapIcon, tx('플로어', 'Floor'), '/fms'], [Globe, tx('알람 지도', 'Alarm map'), '/fms'], [SettingsIcon, tx('관리', 'Admin'), '/fms'],
  ];
  if (isMobile && !open) return null;
  const drawer = isMobile ? { position: 'fixed', inset: '0 auto 0 0', zIndex: 20, boxShadow: '0 0 0 100vmax rgba(0,0,0,0.45)' } : null;
  return (
    <aside style={{ width: 220, background: C.navBg, color: C.navText, display: 'flex', flexDirection: 'column', flexShrink: 0, ...drawer }}>
      <div style={{ padding: '18px 22px', borderBottom: '1px solid rgba(255,255,255,0.08)', position: 'relative' }}>
        <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: C.navText }}>RingOn FMS</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>{me?.tenantName || me?.tenant?.display_name || 'HAEA'}</div>
        {isMobile && <button onClick={onClose} aria-label={tx('메뉴 닫기', 'Close menu')} style={{ position: 'absolute', top: 14, right: 12, background: 'none', border: 0, color: C.navText, cursor: 'pointer', padding: 4 }}><XIcon size={16} /></button>}
      </div>
      <nav style={{ padding: '8px 0', display: 'flex', flexDirection: 'column' }} aria-label={tx('주요 메뉴', 'Main navigation')}>
        {items.map(([Icon, label, href, on]) => (
          <a key={label} href={href} aria-current={on ? 'page' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 22px', fontSize: 13, textDecoration: 'none', color: on ? '#fff' : C.navText, background: on ? 'rgba(15,98,254,0.18)' : 'transparent', borderLeft: `3px solid ${on ? C.primary : 'transparent'}` }}>
            <Icon size={16} aria-hidden="true" />{label}
          </a>
        ))}
      </nav>
      <div style={{ marginTop: 'auto', padding: '14px 22px', borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: 12 }}>
        <div style={{ color: '#fff' }}>{me?.displayName || me?.name || ''}</div>
        <div style={{ color: C.navText, overflow: 'hidden', textOverflow: 'ellipsis' }}>{me?.email || ''}</div>
        <a href="/login" onClick={() => { localStorage.removeItem('cflex_token'); localStorage.removeItem('token'); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, color: C.navText, textDecoration: 'none', fontSize: 12 }}><LogOut size={14} aria-hidden="true" />{tx('로그아웃', 'Sign out')}</a>
      </div>
    </aside>
  );
}

function CbuToggle({ summary, value, onChange }) {
  const list = [{ cbu: 'all', total: summary?.devices?.total }, ...(summary?.cbu_list || [])];
  return (
    <div style={{ display: 'flex', border: `1px solid ${C.hairline}` }} role="group" aria-label={tx('CBU 필터', 'CBU filter')}>
      {list.map(x => (
        <button key={x.cbu} onClick={() => onChange(x.cbu)} aria-pressed={value === x.cbu} style={{ fontFamily: FONT, fontSize: 12, padding: '6px 12px', border: 0, borderLeft: x.cbu === 'all' ? 0 : `1px solid ${C.hairline}`, background: value === x.cbu ? C.primarySoft : C.card, color: value === x.cbu ? C.primary : C.ink, cursor: 'pointer', fontWeight: value === x.cbu ? 600 : 400, whiteSpace: 'nowrap' }}>
          {x.cbu === 'all' ? tx('전체', 'All') : x.cbu} <span style={{ color: C.inkMuted, fontFamily: 'monospace' }}>{x.total ?? ''}</span>{x.critical ? <span style={{ color: C.critical, fontWeight: 700, marginLeft: 4 }}>●{x.critical}</span> : null}
        </button>
      ))}
    </div>
  );
}

// Segmented button row — shared by the 3D render mode and the camera preset.
function Seg({ label, options, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label={label}>
      {options.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)} aria-pressed={value === k} style={{ fontFamily: FONT, fontSize: 12, padding: '5px 10px', cursor: 'pointer', border: `1px solid ${value === k ? C.primary : C.hairline}`, background: value === k ? C.primarySoft : C.card, color: value === k ? C.primary : C.ink }}>{l}</button>
      ))}
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null); const [summary, setSummary] = useState(null); const [tree, setTree] = useState(null);
  const [assets, setAssets] = useState([]); const [alerts, setAlerts] = useState([]); const [sel, setSel] = useState(null); const [detail, setDetail] = useState(null);
  const [mode, setMode] = useState('status'); const [view, setView] = useState('iso'); const [cbuV, setCbuV] = useState(getCbu()); const [tick, setTick] = useState(0);
  const [q, setQ] = useState(''); const [p1Only, setP1Only] = useState(false); const [navOpen, setNavOpen] = useState(false);
  const { isMobile } = useViewport();
  const searchRef = useRef(null);

  const load = useCallback(async () => {
    const [s, f, a, al] = await Promise.all([api('/v1/fms/summary' + withCbu()), api('/v1/fms/floor' + withCbu()), api('/v1/fms/assets' + withCbu()), api('/v1/fms/alerts?hours=24')]);
    if (s?.ok) setSummary(s); if (f?.ok) setTree(f.tree); if (a?.ok) setAssets(a.assets || []); if (al?.ok) setAlerts(al.alerts || []);
  }, []);
  useEffect(() => { api('/v1/me').then(m => { if (!m || (!m.userId && !m.email)) { location.replace('/login'); return; } setMe(m); }); }, []);
  // 30s polling, same cadence as the /fms dashboard. Replaced by a WebSocket later.
  // oxlint-disable-next-line react/set-state-in-effect -- load() only sets state after awaiting the API
  useEffect(() => { load(); const t = setInterval(() => { load(); setTick(x => x + 1); }, 30000); return () => clearInterval(t); }, [load, cbuV]);
  // `sel` is always a normalised numeric-ish id, so it can be used as the :id path segment.
  // `live` drops a late response for a selection the operator has already moved off.
  useEffect(() => {
    if (!sel) return;
    let live = true;
    api(`/v1/fms/assets/${sel}?range=24h`).then(d => { if (live && d?.ok) setDetail(d); });
    return () => { live = false; };
  }, [sel, tick]);
  const changeCbu = (v) => { localStorage.setItem('fms_cbu', v); setCbuV(v); setSel(null); };

  const dev = summary?.devices || {};
  const kpi = [[tx('위험', 'Critical'), dev.critical, C.critical], [tx('경고', 'Warning'), dev.warn, C.warn], [tx('정상', 'Normal'), dev.normal, C.ok], [tx('데이터없음', 'No data'), (dev.nodata || 0) + (dev.unreachable || 0), C.inkSubtle]];
  // Derived, not stored: a stale detail from the previous selection must never render.
  const a = sel && detail && devId(detail.asset?.id) === devId(sel) ? detail.asset : null;

  // Search matches a device by label, ip, room or rack. Empty query = everything matches.
  const needle = q.trim().toLowerCase();
  const matchIds = useMemo(() => {
    if (!needle) return null;
    return new Set(assets.filter(x => [x.label, x.ip, x.room, x.rack, x.model].some(v => String(v ?? '').toLowerCase().includes(needle))).map(x => devId(x.id)));
  }, [assets, needle]);
  const shownAlerts = useMemo(() => alerts.filter(x =>
    (!p1Only || x.priority === 'P1') &&
    (!matchIds || matchIds.has(devId(x.device_id)) || [x.message, x.device_label].some(v => String(v ?? '').toLowerCase().includes(needle))),
  ), [alerts, p1Only, matchIds, needle]);
  const p1Count = alerts.filter(x => x.priority === 'P1').length;

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: FONT, color: C.ink, background: C.bg }}>
      <Nav me={me} isMobile={isMobile} open={navOpen} onClose={() => setNavOpen(false)} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={{ height: 56, flexShrink: 0, background: C.card, borderBottom: `1px solid ${C.hairline}`, display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 16, padding: isMobile ? '0 12px' : '0 24px' }}>
          {isMobile && <button onClick={() => setNavOpen(true)} aria-label={tx('메뉴 열기', 'Open menu')} style={{ background: 'none', border: `1px solid ${C.hairline}`, padding: 6, cursor: 'pointer', color: C.inkMuted }}><Menu size={16} /></button>}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, maxWidth: 480, minWidth: 0, border: `1px solid ${C.hairline}`, padding: '6px 10px', color: C.inkMuted }}>
            <Search size={14} aria-hidden="true" />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} aria-label={tx('장치 · 랙 · 룸 검색', 'Search devices, racks, rooms')} placeholder={tx('장치 · 랙 · 룸 검색', 'Search devices, racks, rooms')}
              style={{ flex: 1, minWidth: 0, fontFamily: FONT, fontSize: 13, border: 0, outline: 'none', background: 'transparent', color: C.ink }} />
            {q && <button onClick={() => { setQ(''); searchRef.current?.focus(); }} aria-label={tx('검색 지우기', 'Clear search')} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: C.inkMuted, display: 'flex' }}><XIcon size={13} /></button>}
          </label>
          {!isMobile && <CbuToggle summary={summary} value={cbuV} onChange={changeCbu} />}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={load} aria-label={tx('새로고침', 'Refresh')} style={{ background: 'none', border: `1px solid ${C.hairline}`, padding: 6, cursor: 'pointer', color: C.inkMuted }}><RefreshCw size={14} /></button>
            <button onClick={() => { localStorage.setItem('lang', tx('en', 'ko')); location.reload(); }} aria-label={tx('KO / EN · 영어로 전환', 'KO / EN · switch to Korean')} style={{ fontFamily: FONT, background: 'none', border: `1px solid ${C.hairline}`, padding: '6px 10px', cursor: 'pointer', fontSize: 12, color: C.ink }}>KO / EN</button>
            {/* The P1 count sits outside the button: a numeric label inside it would
                become the button's visible text and never match its accessible name. */}
            <span style={{ position: 'relative', display: 'flex' }}>
              <button onClick={() => setP1Only(v => !v)} aria-pressed={p1Only} aria-label={tx(`P1 알람 ${p1Count}건만 보기`, `Show only the ${p1Count} P1 alerts`)} style={{ background: p1Only ? C.primarySoft : 'none', border: `1px solid ${p1Only ? C.primary : C.hairline}`, padding: 6, cursor: 'pointer', color: p1Only ? C.primary : C.inkMuted, display: 'flex' }}>
                <Bell size={16} />
              </button>
              {p1Count ? <span aria-hidden="true" style={{ position: 'absolute', top: -7, right: -8, background: C.critical, color: '#fff', fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 8, pointerEvents: 'none' }}>{p1Count}</span> : null}
            </span>
          </div>
        </header>

        <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: isMobile ? 'auto' : 'hidden' }}>
          {isMobile && <div style={{ padding: '12px 12px 0' }}><CbuToggle summary={summary} value={cbuV} onChange={changeCbu} /></div>}
          <div style={{ padding: isMobile ? '12px 12px 0' : '16px 24px 0', display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: 12, flexShrink: 0 }}>
            {kpi.map(([l, v, col]) => (
              <div key={l} style={{ ...card, padding: '14px 18px 12px', borderTop: `4px solid ${col}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.inkSubtle, textTransform: 'uppercase' }}>{l}</div>
                <div style={{ fontSize: 30, fontWeight: 700, color: col, lineHeight: 1.1 }}>{v ?? '—'}<span style={{ fontSize: 12, color: C.inkMuted, fontWeight: 400, marginLeft: 6 }}>/ {dev.total ?? '—'}</span></div>
                <div style={{ height: 3, background: C.hairline, marginTop: 8 }}><div style={{ height: '100%', width: `${dev.total ? Math.round(((v || 0) / dev.total) * 100) : 0}%`, background: col }} /></div>
              </div>
            ))}
          </div>

          <div style={{ flex: 1, minHeight: isMobile ? 0 : 0, display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) 320px', gap: 12, padding: isMobile ? '12px' : '12px 24px 16px' }}>
            <section style={{ ...card, display: 'flex', flexDirection: 'column', minHeight: isMobile ? 420 : 0 }} aria-label={tx('3D 트윈', '3D Twin')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${C.hairline}`, flexWrap: 'wrap' }}>
                <span style={sec}>{tx('3D 트윈', '3D Twin')}</span>
                <span style={{ fontSize: 12, color: C.inkMuted }}>{tree ? `${Object.keys(tree).length} ${tx('사이트', 'sites')} · ${assets.length} UPS${matchIds ? ` · ${matchIds.size} ${tx('일치', 'match')}` : ''}` : tx('불러오는 중…', 'Loading…')}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <Seg label={tx('표시 모드', 'Render mode')} value={mode} onChange={setMode} options={[['status', tx('상태', 'Status')], ['load', tx('부하', 'Load')], ['temp', tx('온도', 'Temp')]]} />
                  <Seg label={tx('시점', 'Camera')} value={view} onChange={setView} options={[['iso', tx('아이소', 'Iso')], ['top', tx('탑뷰', 'Top')], ['aisle', tx('통로', 'Aisle')]]} />
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>{tree && <Twin3D tree={tree} assets={assets} selectedId={sel} onSelect={(id) => setSel(devId(id))} mode={mode} view={view} matchIds={matchIds} />}</div>
              <div style={{ display: 'flex', gap: 14, padding: '8px 14px', borderTop: `1px solid ${C.hairline}`, fontSize: 11, color: C.inkMuted, flexWrap: 'wrap' }}>
                {Object.entries({ ok: STATUS.ok, warn: STATUS.warn, critical: STATUS.critical, nodata: STATUS.nodata }).map(([k, v]) => <span key={k}><i style={{ display: 'inline-block', width: 10, height: 10, background: v.color, marginRight: 5, verticalAlign: -1 }} />{v.label()}</span>)}
                <span><i style={{ display: 'inline-block', width: 10, height: 10, background: '#c6c6c6', marginRight: 5, verticalAlign: -1 }} />{tx('장치 없는 랙', 'Empty rack')}</span>
                <span style={{ marginLeft: 'auto' }}>{tx('드래그 회전 · 휠 확대 · 우클릭 이동 · 랙 클릭 상세 · ←→ 키로 랙 이동', 'Drag to orbit · wheel to zoom · right-drag to pan · click a rack · ←→ to step racks')}</span>
              </div>
            </section>

            <aside style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
              <section style={{ ...card, padding: 14, flex: '0 0 auto' }} aria-label={tx('선택 장치', 'Selected device')}>
                <div style={sec}>{tx('선택 장치', 'Selected device')}</div>
                {!a ? <div style={{ fontSize: 13, color: C.inkMuted, marginTop: 8 }}>{tx('3D에서 랙을 클릭하면 장치 상세가 표시됩니다.', 'Click a rack in 3D to see device details.')}</div> : (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontSize: 15, fontWeight: 700 }}>{a.label}</span><span style={{ background: (STATUS[a.status] || STATUS.unknown).color, color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 7px' }}>{(STATUS[a.status] || STATUS.unknown).label()}</span></div>
                    <div style={{ fontSize: 12, color: C.inkMuted, marginTop: 2 }}>{a.vendor} {a.model} · {a.room} / {a.rack} · <span style={{ fontFamily: 'monospace' }}>{a.ip}</span></div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                      {[[Battery, tx('배터리', 'Battery'), a.battery_pct != null ? `${a.battery_pct}%` : '—'], [Activity, tx('부하', 'Load'), a.load_pct != null ? `${a.load_pct}%` : '—'], [Thermometer, tx('온도', 'Temp'), a.temp_c != null ? `${a.temp_c}°C` : '—'], [Clock, tx('런타임', 'Runtime'), a.runtime_min != null ? `${a.runtime_min} min` : '—']].map(([I, l, v]) => (
                        <div key={l} style={{ border: `1px solid ${C.hairline}`, padding: '8px 10px' }}><div style={{ fontSize: 10, color: C.inkMuted, display: 'flex', alignItems: 'center', gap: 4 }}><I size={11} aria-hidden="true" />{l}</div><div style={{ fontSize: 18, fontWeight: 700 }}>{v}</div></div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: C.inkMuted, marginTop: 8 }}>{tx('마지막 폴링', 'Last poll')} {fmtAgo(a.last_polled)} · {tx('헬스', 'Health')} {a.health_score ?? '—'}</div>
                    <a href="/fms" style={{ display: 'inline-block', marginTop: 10, fontSize: 12, color: C.primary, textDecoration: 'none', fontWeight: 600 }}>{tx('FMS에서 열기 →', 'Open in FMS →')}</a>
                  </div>
                )}
              </section>
              <section style={{ ...card, padding: 14, flex: 1, minHeight: isMobile ? 240 : 0, display: 'flex', flexDirection: 'column' }} aria-label={tx('최근 알람 24h', 'Alerts 24h')}>
                <div style={sec}>{tx('최근 알람 24h', 'Alerts 24h')} <span style={{ color: C.inkMuted, fontWeight: 400 }}>{shownAlerts.length}{shownAlerts.length !== alerts.length ? ` / ${alerts.length}` : ''}</span></div>
                <div style={{ overflow: 'auto', marginTop: 6 }}>
                  {shownAlerts.slice(0, 40).map(x => (
                    <button key={x.id} onClick={() => setSel(devId(x.device_id))} style={{ width: '100%', textAlign: 'left', fontFamily: FONT, background: 'none', border: 0, borderBottom: `1px solid ${C.hairline}`, display: 'grid', gridTemplateColumns: '30px 1fr auto', gap: 8, alignItems: 'center', padding: '7px 0', cursor: 'pointer' }}>
                      <span style={{ background: SEV[x.priority] || C.inkMuted, color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 0', textAlign: 'center' }}>{x.priority}</span>
                      <span style={{ minWidth: 0 }}><span style={{ display: 'block', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.message}</span><span style={{ fontSize: 11, color: C.inkMuted }}>{x.device_label}{x.recurring ? ` · ${tx('반복', 'recurring')}` : ''}</span></span>
                      <span style={{ fontSize: 11, color: C.inkMuted, fontFamily: 'monospace' }}>{fmtAgo(x.received_at)}</span>
                    </button>
                  ))}
                  {!shownAlerts.length && <div style={{ fontSize: 12, color: C.inkMuted, marginTop: 6 }}>{alerts.length ? tx('조건에 맞는 알람 없음', 'No alerts match') : tx('알람 없음', 'No alerts')}</div>}
                </div>
              </section>
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}
