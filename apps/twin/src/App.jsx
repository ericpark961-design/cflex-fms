import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import './screens/screens.css';
import mainTpl from './screens/Main.tpl.html?raw';
import deviceTpl from './screens/Device.tpl.html?raw';
import alarmsTpl from './screens/Alarms.tpl.html?raw';
import powerTpl from './screens/PowerChain.tpl.html?raw';
import nocTpl from './screens/NOC.tpl.html?raw';
import { render } from './tpl';
import { store, refresh, mainData, deviceData, alarmsData, powerData, nocData } from './data';
import { api } from './theme';
import { devId } from './ids';
import { mountCopilot } from './copilot';
import Twin3D from './Twin3D';
import { buildDemoScene } from './DemoScene';

// ---------- hash router
function useRoute() {
  const parse = () => { const h = location.hash.replace(/^#\/?/, ''); const [path, q] = h.split('?'); return { path: path || 'dashboard', q: Object.fromEntries(new URLSearchParams(q || '')) }; };
  const [r, setR] = useState(parse);
  useEffect(() => { const f = () => setR(parse()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}

// ---------- template screen
function Screen({ name, html, data, onReady }) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (!data) return; render(ref.current, html, data); onReady?.(ref.current); }, [html, data]);
  return <div ref={ref} className={`scr-${name}`} style={{ minHeight: '100vh' }} />;
}
const SampleBadge = ({ on, text }) => on ? <div style={{ position: 'fixed', right: 14, bottom: 14, zIndex: 9, background: '#f1c21b', color: '#161616', fontSize: 11, fontWeight: 700, padding: '5px 10px', fontFamily: 'IBM Plex Sans KR, IBM Plex Sans, sans-serif' }}>{text || 'DEMO · 샘플 데이터'}</div> : null;

// ---------- 3D screen (real data + KMX demo)
function TwinScreen({ q }) {
  const [mode, setMode] = useState('status'); const [view, setView] = useState('iso'); const [scene, setScene] = useState(q.scene || 'real');
  const [sel, setSel] = useState(null); const [detail, setDetail] = useState(null); const [demoSel, setDemoSel] = useState('');
  const [layers, setLayers] = useState({ heat: true, leak: true, sensor: true });
  const demoRef = useRef(null); const canvasRef = useRef(null); const tipRef = useRef(null);
  useEffect(() => { if (q.scene) setScene(q.scene); }, [q.scene]);
  // `live` drops a response for a rack the operator has already clicked away from.
  useEffect(() => {
    if (!sel) return;
    let live = true;
    api(`/v1/fms/assets/${devId(sel)}?range=24h`).then(d => { if (live && d?.ok) setDetail(d.asset); });
    return () => { live = false; };
  }, [sel]);
  useEffect(() => {
    if (scene !== 'demo') return; const api3 = buildDemoScene(canvasRef.current, { tip: tipRef.current, onSelect: (html) => setDemoSel(html) }); demoRef.current = api3;
    return () => { api3.dispose(); demoRef.current = null; };
  }, [scene]);
  useEffect(() => { demoRef.current?.setMode(mode); }, [mode]); useEffect(() => { demoRef.current?.preset(view === 'iso' ? 'iso' : view === 'top' ? 'top' : 'aisle'); }, [view]);
  useEffect(() => { const d = demoRef.current; if (!d) return; d.setHeat(layers.heat); d.setLeak(layers.leak); d.setSensor(layers.sensor); }, [layers, scene]);
  const btn = (on) => ({ fontFamily: 'inherit', fontSize: 12, padding: '6px 11px', cursor: 'pointer', border: `1px solid ${on ? '#4589ff' : '#525252'}`, background: on ? '#1c2a44' : 'transparent', color: '#f4f4f4' });
  const nav = [['#/dashboard', '대시보드'], ['#/powerchain', '전력체인 트윈'], ['#/device', '장치'], ['#/alarms', '알람 센터'], ['#/twin', '3D 트윈', true], ['#/powerchain?panel=copilot', 'AI 코파일럿'], ['#/wall', '관제 상황판'], ['/fms', 'FMS 1.x (관리)']];
  const a = sel && detail && devId(detail.id) === devId(sel) ? detail : null;
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#161616', color: '#f4f4f4', fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif' }}>
      <nav style={{ flex: '0 0 220px', background: '#0b0b0b', borderRight: '1px solid #262626', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid #262626', display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ width: 30, height: 30, background: '#0f62fe', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#fff' }}>C</div><div><div style={{ fontSize: 15, fontWeight: 700 }}>C-Flex FMS <span style={{ fontSize: 11, color: '#78a9ff' }}>2.0</span></div><div style={{ fontSize: 11, color: '#8d8d8d' }}>RingOn Service · {store.me?.tenantName || 'HAEA'}</div></div></div>
        <div style={{ padding: '10px 0', display: 'flex', flexDirection: 'column' }}>{nav.map(([h, l, on]) => <a key={l} href={h} style={{ padding: '11px 16px 11px 13px', fontSize: 14, textDecoration: 'none', color: on ? '#f4f4f4' : '#c6c6c6', background: on ? '#262626' : 'transparent', borderLeft: `3px solid ${on ? '#4589ff' : 'transparent'}`, fontWeight: on ? 600 : 400 }}>{l}</a>)}</div>
        <div style={{ marginTop: 'auto', padding: '14px 16px', borderTop: '1px solid #262626', fontSize: 12, color: '#c6c6c6' }}>{store.me?.displayName || ''}<br /><span style={{ color: '#8d8d8d' }}>{store.me?.email || ''}</span></div>
      </nav>
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 20px', background: '#0b0b0b', borderBottom: '1px solid #262626' }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>3D 디지털트윈</h1>
          <div style={{ display: 'flex', gap: 6, marginLeft: 12 }}><button style={btn(scene === 'real')} onClick={() => setScene('real')}>실데이터 · {store.me?.tenantName || 'HAEA'} {store.assets.length}대</button><button style={btn(scene === 'demo')} onClick={() => setScene('demo')}>KMX CCR 데모 씬</button></div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['status', '상태'], ['load', '부하 kW'], ['temp', '온도']].map(([k, l]) => <button key={k} style={btn(mode === k)} onClick={() => setMode(k)}>{l}</button>)}<span style={{ width: 10 }} />
            {[['iso', '아이소'], ['top', '탑뷰'], ['aisle', '통로']].map(([k, l]) => <button key={k} style={btn(view === k)} onClick={() => setView(k)}>{l}</button>)}
            {scene === 'demo' && <><span style={{ width: 10 }} />{[['heat', '히트맵'], ['leak', '누수 존'], ['sensor', '센서']].map(([k, l]) => <button key={k} style={btn(layers[k])} onClick={() => setLayers({ ...layers, [k]: !layers[k] })}>{l}</button>)}</>}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 12, padding: 16 }}>
          <div style={{ position: 'relative', minHeight: 640, background: '#070a10', border: '1px solid #262626' }}>
            {scene === 'real' ? (store.floor ? <Twin3D tree={store.floor} assets={store.assets} selectedId={sel} onSelect={setSel} mode={mode} view={view} dark /> : <div style={{ padding: 20, color: '#8d8d8d' }}>장치 데이터 불러오는 중…</div>)
              : <><canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} /><div ref={tipRef} style={{ position: 'absolute', display: 'none', pointerEvents: 'none', background: '#0b0b0b', border: '1px solid #393939', padding: '7px 10px', fontSize: 12, lineHeight: 1.5 }} /></>}
            <div style={{ position: 'absolute', left: 12, bottom: 10, fontSize: 11, color: '#8d8d8d' }}>드래그 회전 · 휠 확대 · 우클릭 이동 · 클릭 상세</div>
          </div>
          <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section style={{ background: '#262626', padding: 14, fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 6 }}>선택 객체</div>
              {scene === 'demo' ? (demoSel ? <div dangerouslySetInnerHTML={{ __html: demoSel }} /> : <span style={{ color: '#8d8d8d' }}>랙·CRAC·UPS·센서·누수 존을 클릭하면 상세가 표시된다.</span>)
                : a ? <div><div style={{ fontSize: 15, fontWeight: 700 }}>{a.label}</div><div style={{ color: '#c6c6c6', fontSize: 12 }}>{a.vendor} {a.model} · {a.room} / {a.rack} · <span className="mono">{a.ip}</span></div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>{[['배터리', a.battery_pct != null ? `${a.battery_pct}%` : '—'], ['부하', a.load_pct != null ? `${a.load_pct}%` : '—'], ['온도', a.temp_c != null ? `${a.temp_c}°C` : '—'], ['런타임', a.runtime_min != null ? `${a.runtime_min} min` : '—']].map(([l, v]) => <div key={l} style={{ background: '#1f1f1f', padding: '8px 10px' }}><div style={{ fontSize: 10, color: '#8d8d8d' }}>{l}</div><div style={{ fontSize: 18, fontWeight: 700 }}>{v}</div></div>)}</div><a href={`#/device?id=${a.id}`} style={{ display: 'inline-block', marginTop: 10, fontSize: 12, color: '#78a9ff' }}>장치 상세 →</a></div>
                : <span style={{ color: '#8d8d8d' }}>랙을 클릭하면 장치 상세가 표시된다.</span>}
            </section>
            <section style={{ background: '#262626', padding: 14, fontSize: 12, color: '#c6c6c6', lineHeight: 1.6 }}>
              <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 6 }}>데이터 연결</div>
              {scene === 'real' ? <>실데이터 모드는 <span className="mono">/v1/fms/floor · assets</span>의 UPS를 랙 이름(A01, B-07…)으로 자동 배치한다. 랙 좌표·CRAC·센서·누수 존은 2.0 Phase 0 수집기와 좌표 CSV가 들어오면 같은 화면에 채워진다.</> : <>KMX CCR 서버실(178 ㎡ · 랙 62 · CRAC 3 · UPS 2 · 센서 6 · 누수 존 4 · FM-200) 설계안을 샘플 값으로 보여주는 시연 씬이다. 12월 UAT에서 실제 수집값으로 교체된다.</>}
            </section>
            <section style={{ background: '#262626', padding: 14, fontSize: 11, color: '#c6c6c6', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {[['#1c4f8a', '정상'], ['#08bdba', '고부하'], ['#f1c21b', '경고'], ['#fa4d56', '위험'], ['#6f6f6f', '데이터없음'], ['#2b2b2b', '공랙']].map(([c, l]) => <span key={l}><i style={{ display: 'inline-block', width: 10, height: 10, background: c, marginRight: 5, verticalAlign: -1, border: '1px solid #525252' }} />{l}</span>)}
            </section>
          </aside>
        </div>
      </main>
      <SampleBadge on={scene === 'demo'} text="DEMO · KMX 설계 샘플" />
    </div>
  );
}

// ---------- NOC wall (1920×1080, scaled to fit)
function WallScreen({ data }) {
  const ref = useRef(null); const [scale, setScale] = useState(1);
  useLayoutEffect(() => { if (data) render(ref.current, nocTpl, data); }, [data]);
  useEffect(() => { const f = () => setScale(Math.min(innerWidth / 1920, innerHeight / 1080)); f(); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  return <div style={{ background: '#070a10', minHeight: '100vh', overflow: 'hidden', position: 'relative' }}>
    <a href="#/dashboard" style={{ position: 'fixed', left: 12, top: 12, zIndex: 9, fontSize: 12, color: '#8fa3c4', textDecoration: 'none', background: 'rgba(13,18,28,.9)', border: '1px solid #1f2a3d', padding: '5px 10px' }}>← 대시보드</a>
    <div ref={ref} className="scr-NOC" style={{ width: 1920, height: 1080, transformOrigin: 'top left', transform: `scale(${scale})`, margin: '0 auto', position: 'absolute', left: `calc(50% - ${(1920 * scale) / 2}px)`, top: 0 }} />
  </div>;
}

export default function App() {
  const route = useRoute(); const [tick, setTick] = useState(0); const [ready, setReady] = useState(false); const [devData, setDevData] = useState(null);
  useEffect(() => { api('/v1/me').then(async m => { if (!m || (!m.userId && !m.email)) { location.replace('/login'); return; } store.me = m; await refresh(); setReady(true); }); const t = setInterval(async () => { await refresh(); setTick(x => x + 1); }, 30000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!ready) return; if (route.path === 'device') deviceData(route.q.id).then(setDevData); }, [ready, route.path, route.q.id, tick]);
  const wire = useCallback((root) => {
    root.querySelectorAll('.cbu-btn').forEach(b => b.addEventListener('click', async () => { localStorage.setItem('fms_cbu', b.dataset.cbu); await refresh(); setTick(x => x + 1); }));
    // The copilot form is a real request; every other form in the mockup is inert
    // and just jumps to the copilot panel.
    mountCopilot(root, { deviceId: route.q.id });
    root.querySelectorAll('form').forEach(f => { if (!f.dataset.wired) f.addEventListener('submit', e => { e.preventDefault(); location.hash = '#/powerchain?panel=copilot'; }); });
    if (route.q.panel === 'copilot') root.querySelector('#copilot')?.scrollIntoView({ behavior: 'smooth' });
  }, [route.q.panel, route.q.id]);
  if (!ready) return <div style={{ minHeight: '100vh', background: '#161616', color: '#8d8d8d', display: 'grid', placeItems: 'center', fontFamily: 'IBM Plex Sans KR, sans-serif' }}>C-Flex FMS 2.0 불러오는 중…</div>;
  const p = route.path;
  if (p === 'twin') return <TwinScreen q={route.q} />;
  if (p === 'wall') return <WallScreen data={nocData()} />;
  if (p === 'device') return <><Screen name="Device" html={deviceTpl} data={devData} onReady={wire} /><SampleBadge on={!!devData?.sample} /><SampleBadge on={!devData?.sample} text="AI 예측·RCA·추세는 Phase 2 샘플" /></>;
  if (p === 'alarms') { const d = alarmsData(); return <><Screen name="Alarms" html={alarmsTpl} data={d} onReady={wire} /><SampleBadge on={d.sample} /></>; }
  if (p === 'powerchain') return <><Screen name="PowerChain" html={powerTpl} data={powerData()} onReady={wire} /><SampleBadge on text="전력체인·코파일럿 · Phase 3 샘플" /></>;
  const d = mainData(); return <><Screen name="Main" html={mainTpl} data={d} onReady={wire} /><SampleBadge on={d.sample} /></>;
}
