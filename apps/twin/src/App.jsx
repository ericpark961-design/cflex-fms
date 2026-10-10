import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import './screens/screens.css';
import mainTpl from './screens/Main.tpl.html?raw';
import deviceTpl from './screens/Device.tpl.html?raw';
import alarmsTpl from './screens/Alarms.tpl.html?raw';
import powerTpl from './screens/PowerChain.tpl.html?raw';
import nocTpl from './screens/NOC.tpl.html?raw';
import { render } from './tpl';
import { store, refresh, mainData, deviceData, alarmsData, powerData, nocData, heatFor, powerChain, powerChainObject } from './data';
import { api, lang, tx } from './theme';
import { devId } from './ids';
import { mountCopilot } from './copilot';
import { t } from './i18n';
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
const SampleBadge = ({ on, text }) => on ? <div style={{ position: 'fixed', right: 14, bottom: 14, zIndex: 9, background: '#f1c21b', color: '#161616', fontSize: 11, fontWeight: 700, padding: '5px 10px', fontFamily: 'IBM Plex Sans KR, IBM Plex Sans, sans-serif' }}>{text || t('DEMO · 샘플 데이터')}</div> : null;

// ---------- 3D screen (real data + KMX demo)
function TwinScreen({ q }) {
  const [mode, setMode] = useState('status');
  const [view, setView] = useState('iso');
  const [scene, setScene] = useState(q.scene || 'real');
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selObj, setSelObj] = useState(null);
  const [demoSel, setDemoSel] = useState('');
  // `heat` is the ledger-driven floor layer; leak/sensor only apply to the demo scene's own toggles.
  const [layers, setLayers] = useState({ labels: true, sensors: true, leak: true, heat: 'none' });
  const [heatRooms, setHeatRooms] = useState([]);
  const [chain, setChain] = useState(null);
  const demoRef = useRef(null); const canvasRef = useRef(null); const tipRef = useRef(null);

  useEffect(() => { if (q.scene) setScene(q.scene); }, [q.scene]);

  // device detail for the selected rack
  useEffect(() => {
    if (!sel) return;
    let live = true;
    api(`/v1/fms/assets/${devId(sel)}?range=24h`).then(d => { if (live && d?.ok) setDetail(d.asset); });
    return () => { live = false; };
  }, [sel]);

  // power chain — object first, falling back to the device inside it
  useEffect(() => {
    let live = true;
    if (selObj != null) powerChainObject(selObj).then(c => { if (live) setChain(c); });
    else if (sel) powerChain(sel).then(c => { if (live) setChain(c); });
    else setChain(null);
    return () => { live = false; };
  }, [selObj, sel]);

  useEffect(() => {
    if (layers.heat === 'none') { setHeatRooms([]); return; }
    let live = true;
    heatFor(layers.heat).then(r => { if (live) setHeatRooms(r); });
    return () => { live = false; };
  }, [layers.heat]);

  // ESC clears the trace, as the brief asks
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { setSelObj(null); setSel(null); setChain(null); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (scene !== 'demo') return;
    const api3 = buildDemoScene(canvasRef.current, { tip: tipRef.current, onSelect: (html) => setDemoSel(html) });
    demoRef.current = api3;
    return () => { api3.dispose(); demoRef.current = null; };
  }, [scene]);
  useEffect(() => { demoRef.current?.setMode(mode); }, [mode]);
  useEffect(() => { demoRef.current?.preset(view); }, [view]);
  useEffect(() => {
    const d = demoRef.current; if (!d) return;
    d.setHeat(layers.heat !== 'none'); d.setLeak(layers.leak); d.setSensor(layers.sensors);
  }, [layers, scene]);

  const btn = (on) => ({ fontFamily: 'inherit', fontSize: 12, padding: '6px 11px', cursor: 'pointer', border: `1px solid ${on ? '#4589ff' : '#525252'}`, background: on ? '#1c2a44' : 'transparent', color: '#f4f4f4' });
  const nav = [['#/dashboard', t('대시보드')], ['#/powerchain', t('전력체인 트윈')], ['#/device', t('장치')], ['#/alarms', t('알람 센터')], ['#/twin', t('3D 트윈'), true], ['#/powerchain?panel=copilot', t('AI 코파일럿')], ['#/wall', t('관제 상황판')], ['/fms', t('FMS 1.x (관리)')]];

  // Stable identity: Twin3D rebuilds the whole scene when `layers` changes, and a
  // fresh object every render meant rebuilding on every poll tick.
  const twinLayers = useMemo(() => ({ ...layers, heatRooms }), [layers, heatRooms]);

  const a = detail;
  const ledger = store.topology;
  const objCount = (ledger?.rooms || []).reduce((n, r) => n + r.objects.length, 0);
  const focusId = q.focus ? Number(q.focus) : null;
  // Which placement a selection came from — never let a guess read as surveyed truth.
  const selObjRow = (ledger?.rooms || []).flatMap(r => r.objects).find(o => o.id === selObj);
  const sourceLabel = selObj != null
    ? t('원장 좌표')
    : (sel ? t('추정 배치') : null);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#161616', color: '#f4f4f4', fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif' }}>
      <nav style={{ flex: '0 0 220px', background: '#0b0b0b', borderRight: '1px solid #262626', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid #262626', display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ width: 30, height: 30, background: '#0f62fe', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#fff' }}>C</div><div><div style={{ fontSize: 15, fontWeight: 700 }}>C-Flex FMS <span style={{ fontSize: 11, color: '#78a9ff' }}>2.0</span></div><div style={{ fontSize: 11, color: '#8d8d8d' }}>RingOn Service · {store.me?.tenantName || 'HAEA'}</div></div></div>
        <div style={{ padding: '10px 0', display: 'flex', flexDirection: 'column' }}>{nav.map(([h, l, on]) => <a key={l} href={h} style={{ padding: '11px 16px 11px 13px', fontSize: 14, textDecoration: 'none', color: on ? '#f4f4f4' : '#c6c6c6', background: on ? '#262626' : 'transparent', borderLeft: `3px solid ${on ? '#4589ff' : 'transparent'}`, fontWeight: on ? 600 : 400 }}>{l}</a>)}</div>
        <div style={{ marginTop: 'auto', padding: '14px 16px', borderTop: '1px solid #262626', fontSize: 12, color: '#c6c6c6' }}>{store.me?.displayName || ''}<br /><span style={{ color: '#8d8d8d' }}>{store.me?.email || ''}</span></div>
      </nav>

      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 20px', background: '#0b0b0b', borderBottom: '1px solid #262626' }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('3D 디지털트윈')}</h1>
          <div style={{ display: 'flex', gap: 6, marginLeft: 12 }}>
            <button style={btn(scene === 'real')} onClick={() => setScene('real')}>{tx('실데이터', 'Live')} · {store.me?.tenantName || 'HAEA'} {store.assets.length}{tx('대', ' UPS')}{objCount ? ` · ${objCount} ${t('객체')}` : ''}</button>
            <button style={btn(scene === 'demo')} onClick={() => setScene('demo')}>{t('KMX CCR 데모 씬')}</button>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {[['status', t('상태')], ['load', t('부하 kW')], ['temp', t('온도')]].map(([k, l]) => <button key={k} style={btn(mode === k)} onClick={() => setMode(k)}>{l}</button>)}
            <span style={{ width: 10 }} />
            {[['iso', t('아이소')], ['top', t('탑뷰')], ['aisle', t('통로')]].map(([k, l]) => <button key={k} style={btn(view === k)} onClick={() => setView(k)}>{l}</button>)}
            <span style={{ width: 10 }} />
            <span style={{ fontSize: 11, color: '#8d8d8d' }}>{t('레이어')}</span>
            {[['labels', t('라벨')], ['sensors', t('센서')], ['leak', t('누수 존')]].map(([k, l]) =>
              <button key={k} style={btn(layers[k])} onClick={() => setLayers(v => ({ ...v, [k]: !v[k] }))}>{l}</button>)}
            {[['load', t('전력 히트맵')], ['temp', t('온도 히트맵')]].map(([k, l]) =>
              <button key={k} style={btn(layers.heat === k)} onClick={() => setLayers(v => ({ ...v, heat: v.heat === k ? 'none' : k }))}>{l}</button>)}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 12, padding: 16 }}>
          <div style={{ position: 'relative', height: 'calc(100vh - 150px)', minHeight: 480, overflow: 'hidden', background: '#070a10', border: '1px solid #262626' }}>
            {scene === 'real'
              ? ((ledger || store.floor)
                ? <Twin3D topology={ledger} tree={store.floor} assets={store.assets}
                  selectedId={sel} selectedObjectId={selObj}
                  onSelect={(id) => setSel(devId(id))} onSelectObject={(id) => setSelObj(id)}
                  mode={mode} view={view} focusId={focusId}
                  chain={chain?.chain?.length ? chain.chain : null}
                  layers={twinLayers} />
                : <div style={{ padding: 20, color: '#8d8d8d' }}>{t('장치 데이터 불러오는 중…')}</div>)
              : <><canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} /><div ref={tipRef} style={{ position: 'absolute', display: 'none', pointerEvents: 'none', background: '#0b0b0b', border: '1px solid #393939', padding: '7px 10px', fontSize: 12, lineHeight: 1.5 }} /></>}
            <div style={{ position: 'absolute', left: 12, bottom: 10, fontSize: 11, color: '#8d8d8d' }}>{t('드래그 회전 · 휠 확대 · 우클릭 이동 · 클릭 상세')}{chain?.chain?.length ? ` · ESC ${t('추적 해제')}` : ''}</div>
            {layers.heat !== 'none' && scene === 'real' && (
              <div style={{ position: 'absolute', right: 12, bottom: 10, background: 'rgba(11,11,11,.85)', border: '1px solid #262626', padding: '6px 10px', fontSize: 11, color: '#c6c6c6' }}>
                <div style={{ marginBottom: 4 }}>{layers.heat === 'load' ? t('전력 히트맵') : t('온도 히트맵')}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{layers.heat === 'load' ? '0%' : '18°C'}</span>
                  <i style={{ display: 'inline-block', width: 90, height: 8, background: layers.heat === 'load' ? 'linear-gradient(90deg,#2166ac,#ffffbf,#d73027)' : 'linear-gradient(90deg,#2166ac,#d73027)' }} />
                  <span>{layers.heat === 'load' ? '100%' : '35°C'}</span>
                </div>
              </div>
            )}
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section style={{ background: '#262626', padding: 14, fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('선택 객체')}</span>
                {scene === 'real' && sourceLabel && <span style={{ color: selObj != null ? '#42be65' : '#f1c21b' }}>{sourceLabel}</span>}
              </div>
              {scene === 'demo'
                ? (demoSel ? <div dangerouslySetInnerHTML={{ __html: demoSel }} /> : <span style={{ color: '#8d8d8d' }}>{t('랙·CRAC·UPS·센서·누수 존을 클릭하면 상세가 표시된다.')}</span>)
                : a ? <div><div style={{ fontSize: 15, fontWeight: 700 }}>{a.label}</div><div style={{ color: '#c6c6c6', fontSize: 12 }}>{a.vendor} {a.model} · {a.room} / {a.rack} · <span className="mono">{a.ip}</span></div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>{[[t('배터리'), a.battery_pct != null ? `${a.battery_pct}%` : '—'], [t('부하'), a.load_pct != null ? `${a.load_pct}%` : '—'], [t('온도'), a.temp_c != null ? `${a.temp_c}°C` : '—'], [t('런타임'), a.runtime_min != null ? `${a.runtime_min} min` : '—']].map(([l, v]) => <div key={l} style={{ background: '#1f1f1f', padding: '8px 10px' }}><div style={{ fontSize: 10, color: '#8d8d8d' }}>{l}</div><div style={{ fontSize: 18, fontWeight: 700 }}>{v}</div></div>)}</div><a href={`#/device?id=${a.id}`} style={{ display: 'inline-block', marginTop: 10, fontSize: 12, color: '#78a9ff' }}>{t('장치 상세 →')}</a></div>
                  : selObjRow ? <div><div style={{ fontSize: 15, fontWeight: 700 }}>{selObjRow.name}</div><div style={{ color: '#c6c6c6', fontSize: 12 }}>{selObjRow.kind} · {t('타일')} {selObjRow.col},{selObjRow.row}{selObjRow.attrs?.rated_a ? ` · ${selObjRow.attrs.rated_a}A` : ''}{selObjRow.attrs?.capacity_kw ? ` · ${selObjRow.attrs.capacity_kw}kW` : ''}</div></div>
                    : <span style={{ color: '#8d8d8d' }}>{t('랙을 클릭하면 장치 상세가 표시된다.')}</span>}
            </section>

            {scene === 'real' && (
              <section style={{ background: '#262626', padding: 14, fontSize: 12 }}>
                <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 6 }}>{t('전원 체인')}</div>
                {!chain ? <span style={{ color: '#8d8d8d' }}>{t('랙·UPS를 클릭하면 상류 전원 경로를 추적한다.')}</span>
                  : chain.chain.length <= 1
                    // Not an error: the ledger simply has no link for this object.
                    ? <span style={{ color: '#f1c21b' }}>{t('연결 정보 없음')}</span>
                    : <>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                        <thead><tr style={{ color: '#8d8d8d', textAlign: 'left' }}>
                          <th style={{ padding: '3px 4px', fontWeight: 600 }}>#</th>
                          <th style={{ padding: '3px 4px', fontWeight: 600 }}>{t('객체')}</th>
                          <th style={{ padding: '3px 4px', fontWeight: 600 }}>{t('포트/회로')}</th>
                          <th style={{ padding: '3px 4px', fontWeight: 600, textAlign: 'right' }}>A</th>
                        </tr></thead>
                        <tbody>
                          {chain.chain.map((c, i) => (
                            <tr key={`${c.type}-${c.id}`} style={{ borderTop: '1px solid #393939' }}>
                              <td style={{ padding: '4px', color: '#8d8d8d' }}>{i + 1}</td>
                              <td style={{ padding: '4px' }}><span style={{ color: i === 0 ? '#f4f4f4' : '#ff832b' }}>{c.name}</span><span style={{ display: 'block', color: '#8d8d8d', fontSize: 10 }}>{c.kind}</span></td>
                              <td style={{ padding: '4px', color: '#c6c6c6' }} className="mono">{c.circuit || c.port || '—'}</td>
                              <td style={{ padding: '4px', textAlign: 'right' }} className="mono">{c.rated_a ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ marginTop: 8, color: '#c6c6c6' }}>
                        {t('현재 부하')} <span className="mono">{chain.load_pct != null ? `${chain.load_pct}%` : '—'}</span>
                        {' · '}{t('최소 정격')} <span className="mono">{chain.upstream_capacity_a != null ? `${chain.upstream_capacity_a}A` : '—'}</span>
                      </div>
                    </>}
              </section>
            )}

            <section style={{ background: '#262626', padding: 14, fontSize: 12, color: '#c6c6c6', lineHeight: 1.6 }}>
              <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 6 }}>{t('데이터 연결')}</div>
              {scene === 'real'
                ? (objCount
                  ? tx(`원장에 ${objCount}개 객체가 있고 그 좌표로 그린다. 원장에 없는 장치는 랙 이름으로 추정 배치해 같은 씬에 함께 보여준다.`,
                    `${objCount} objects come from the ledger and are drawn at its coordinates. Devices with no ledger row are placed by parsing rack names and shown in the same scene, badged as estimated.`)
                  : tx('이 테넌트에는 아직 원장이 없다. 모든 장치를 랙 이름으로 추정 배치한다(v2와 동일).',
                    'This tenant has no ledger yet, so every device is placed by parsing rack names — the v2 behaviour.'))
                : t('KMX CCR 서버실(178 ㎡ · 랙 62 · CRAC 3 · UPS 2 · 센서 6 · 누수 존 4 · FM-200) 설계안을 샘플 값으로 보여주는 시연 씬이다. 12월 UAT에서 실제 수집값으로 교체된다.')}
            </section>

            <section style={{ background: '#262626', padding: 14, fontSize: 11, color: '#c6c6c6', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {[['#1c4f8a', t('정상')], ['#08bdba', t('고부하')], ['#f1c21b', t('경고')], ['#fa4d56', t('위험')], ['#6f6f6f', t('데이터없음')], ['#2b2b2b', t('공랙')], ['#ff832b', t('전원 체인')]].map(([c, l]) => <span key={l}><i style={{ display: 'inline-block', width: 10, height: 10, background: c, marginRight: 5, verticalAlign: -1, border: '1px solid #525252' }} />{l}</span>)}
            </section>
          </aside>
        </div>
      </main>
      <SampleBadge on={scene === 'demo'} text={t('DEMO · KMX 설계 샘플')} />
    </div>
  );
}

// ---------- NOC wall (1920×1080, scaled to fit)
function WallScreen({ data }) {
  const ref = useRef(null); const [scale, setScale] = useState(1);
  useLayoutEffect(() => { if (data) render(ref.current, nocTpl, data); }, [data]);
  useEffect(() => { const f = () => setScale(Math.min(innerWidth / 1920, innerHeight / 1080)); f(); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  return <div style={{ background: '#070a10', minHeight: '100vh', overflow: 'hidden', position: 'relative' }}>
    <a href="#/dashboard" style={{ position: 'fixed', left: 12, top: 12, zIndex: 9, fontSize: 12, color: '#8fa3c4', textDecoration: 'none', background: 'rgba(13,18,28,.9)', border: '1px solid #1f2a3d', padding: '5px 10px' }}>{t('← 대시보드')}</a>
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
    // Every screen's header carries a KO / EN button from the mockup markup.
    root.querySelectorAll('button, a').forEach(b => {
      if (!/^KO\s*\/\s*EN$/.test(b.textContent.trim())) return;
      b.addEventListener('click', e => { e.preventDefault(); localStorage.setItem('lang', lang() === 'en' ? 'ko' : 'en'); location.reload(); });
    });
    mountCopilot(root, { deviceId: route.q.id });
    root.querySelectorAll('form').forEach(f => { if (!f.dataset.wired) f.addEventListener('submit', e => { e.preventDefault(); location.hash = '#/powerchain?panel=copilot'; }); });
    if (route.q.panel === 'copilot') root.querySelector('#copilot')?.scrollIntoView({ behavior: 'smooth' });
  }, [route.q.panel, route.q.id]);
  if (!ready) return <div style={{ minHeight: '100vh', background: '#161616', color: '#8d8d8d', display: 'grid', placeItems: 'center', fontFamily: 'IBM Plex Sans KR, sans-serif' }}>{t('C-Flex FMS 2.0 불러오는 중…')}</div>;
  const p = route.path;
  if (p === 'twin') return <TwinScreen q={route.q} />;
  if (p === 'wall') return <WallScreen data={nocData()} />;
  if (p === 'device') return <><Screen name="Device" html={deviceTpl} data={devData} onReady={wire} /><SampleBadge on={!!devData?.sample} /><SampleBadge on={!devData?.sample} text={t('AI 예측·RCA·추세는 Phase 2 샘플')} /></>;
  if (p === 'alarms') { const d = alarmsData(); return <><Screen name="Alarms" html={alarmsTpl} data={d} onReady={wire} /><SampleBadge on={d.sample} /></>; }
  if (p === 'powerchain') return <><Screen name="PowerChain" html={powerTpl} data={powerData()} onReady={wire} /><SampleBadge on text={t('전력체인·코파일럿 · Phase 3 샘플')} /></>;
  const d = mainData(); return <><Screen name="Main" html={mainTpl} data={d} onReady={wire} /><SampleBadge on={d.sample} /></>;
}
