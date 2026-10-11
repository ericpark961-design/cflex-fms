import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import './screens/screens.css';
import mainTpl from './screens/Main.tpl.html?raw';
import deviceTpl from './screens/Device.tpl.html?raw';
import alarmsTpl from './screens/Alarms.tpl.html?raw';
import powerTpl from './screens/PowerChain.tpl.html?raw';
import nocTpl from './screens/NOC.tpl.html?raw';
import { render } from './tpl';
import { buildLedgerScene } from './twin/LedgerScene';
import { store, refresh, mainData, deviceData, alarmsData, powerData, nocData, heatFor, powerChain, powerChainObject, fleetLive, ackAlert, muteDevice, runControlAction } from './data';
import { api, lang, tx, cbu as globalCbu } from './theme';
import { devId } from './ids';
import { mountCopilot } from './copilot';
import { mountDeviceFace } from './deviceFace';
import { mountRackElevation } from './rackElevation';
import { t } from './i18n';
import { mountCbuBar } from './cbubar';
import TwinScreen from './TwinScreen';
import MapScreen from './MapScreen';
import DevicesScreen from './DevicesScreen';
import Workbench from './Workbench';

// ---------- hash router
function useRoute() {
  const parse = () => { const h = location.hash.replace(/^#\/?/, ''); const [path, q] = h.split('?'); return { path: path || 'dashboard', q: Object.fromEntries(new URLSearchParams(q || '')) }; };
  const [r, setR] = useState(parse);
  useEffect(() => { const f = () => setR(parse()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}

// ---------- template screen
/**
 * Any screen that throws — in render or in an effect — shows what happened
 * instead of a black page. A blank dark screen is the least diagnosable
 * outcome there is: the operator cannot tell it apart from a dead session.
 */
class ScreenBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('[screen]', this.props.name || '', err, info?.componentStack); }
  render() {
    if (!this.state.err) return this.props.children;
    const e = this.state.err;
    return <div style={{ minHeight: '100vh', background: '#161616', color: '#f4f4f4', padding: 24, fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif' }}>
      <div style={{ maxWidth: 760 }}>
        <div style={{ fontSize: 11, color: '#8d8d8d', letterSpacing: '.04em' }}>{this.props.name || 'SCREEN'}</div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: '6px 0 10px' }}>{t('이 화면을 그리는 중 오류가 발생했습니다')}</h1>
        <pre style={{ background: '#1f1f1f', borderLeft: '3px solid #fa4d56', padding: 12, fontSize: 12, color: '#ff8389', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{String(e?.stack || e?.message || e)}</pre>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <a href="#/devices" style={{ background: '#262626', border: '1px solid #525252', color: '#f4f4f4', padding: '7px 12px', fontSize: 12, textDecoration: 'none' }}>{t('장비 인벤토리')}</a>
          <a href="#/" style={{ background: '#262626', border: '1px solid #525252', color: '#f4f4f4', padding: '7px 12px', fontSize: 12, textDecoration: 'none' }}>{t('시설 대시보드')}</a>
          <button onClick={() => this.setState({ err: null })} style={{ background: '#0f62fe', border: '1px solid #0f62fe', color: '#fff', padding: '7px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}>{t('다시 시도')}</button>
        </div>
      </div>
    </div>;
  }
}

function Screen({ name, html, data, onReady }) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (!data) return; render(ref.current, html, data); onReady?.(ref.current); }, [html, data]);
  // Until data arrives this rendered an empty full-height div — a black page,
  // which is exactly what a failed fetch looked like too.
  if (!data) {
    return <div className={`scr-${name}`} style={{ minHeight: '100vh', background: '#161616', color: '#8d8d8d', display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif', fontSize: 13 }}>
      {t('불러오는 중…')}
    </div>;
  }
  return <div ref={ref} className={`scr-${name}`} style={{ minHeight: '100vh' }} />;
}
const SampleBadge = ({ on, text }) => on ? <div style={{ position: 'fixed', right: 14, bottom: 14, zIndex: 9, background: '#f1c21b', color: '#161616', fontSize: 11, fontWeight: 700, padding: '5px 10px', fontFamily: 'IBM Plex Sans KR, IBM Plex Sans, sans-serif' }}>{text || t('DEMO · 샘플 데이터')}</div> : null;

// ---------- 3D screen (real data + KMX demo)
// ---------- NOC wall (1920×1080, scaled to fit)
function WallScreen({ data }) {
  const ref = useRef(null); const [scale, setScale] = useState(1);
  const sceneBox = useRef(null); const sceneRef = useRef(null);
  useLayoutEffect(() => { if (!data) return; render(ref.current, nocTpl, data); mountCbuBar(ref.current, () => location.reload()); }, [data]);

  // The wall's isometric panel is the real twin, read-only in top view: the
  // ledger when there is one, otherwise nothing (the panel says so) rather than
  // a drawn-on mockup.
  useLayoutEffect(() => {
    const host = ref.current?.querySelector('#wall-3d');
    if (!host) return;
    sceneBox.current = host;
    const ledger = store.topology?.rooms?.length ? store.topology : null;
    if (!ledger) { host.innerHTML = `<div style="display:grid;place-items:center;height:100%;color:#8d8d8d;font-size:13px">${t('원장 미등록 — 서베이 필요')}</div>`; return; }
    const s3 = buildLedgerScene(host, ledger, { onSelect: () => {} });
    sceneRef.current = s3;
    s3.preset('top');
    s3.setLayers({ labels: false, sensors: true, leak: true });
    return () => { s3.dispose(); sceneRef.current = null; };
  }, [data]);
  useEffect(() => { const f = () => setScale(Math.min(innerWidth / 1920, innerHeight / 1080)); f(); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  return <div style={{ background: '#070a10', minHeight: '100vh', overflow: 'hidden', position: 'relative' }}>
    <a href="#/dashboard" style={{ position: 'fixed', left: 12, top: 12, zIndex: 9, fontSize: 12, color: '#8fa3c4', textDecoration: 'none', background: 'rgba(13,18,28,.9)', border: '1px solid #1f2a3d', padding: '5px 10px' }}>{t('← 대시보드')}</a>
    <div ref={ref} className="scr-NOC" style={{ width: 1920, height: 1080, transformOrigin: 'top left', transform: `scale(${scale})`, margin: '0 auto', position: 'absolute', left: `calc(50% - ${(1920 * scale) / 2}px)`, top: 0 }} />
  </div>;
}

export default function App() {
  const route = useRoute(); const [tick, setTick] = useState(0); const [ready, setReady] = useState(false); const [devData, setDevData] = useState(null); const [devErr, setDevErr] = useState(null); const [devRange, setDevRange] = useState('24h');
  useEffect(() => { api('/v1/me').then(async m => { if (!m || (!m.userId && !m.email)) { location.replace('/login'); return; } store.me = m; await refresh(); setReady(true); }); const t = setInterval(async () => { await refresh(); setTick(x => x + 1); }, 30000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!ready) return;
    if (route.path !== 'device') return;
    let live = true;
    setDevErr(null);
    deviceData(route.q.id, false, devRange)
      .then(d => { if (live) setDevData(d); })
      .catch(e => { if (live) { console.error('[device]', e); setDevErr(e); } });
    return () => { live = false; };
  }, [ready, route.path, route.q.id, tick, devRange]);
  const wire = useCallback((root) => {
    mountCbuBar(root, () => setTick(x => x + 1));
    // The copilot form is a real request; every other form in the mockup is inert
    // and just jumps to the copilot panel.
    // Every screen's header carries a KO / EN button from the mockup markup.
    root.querySelectorAll('button, a').forEach(b => {
      if (!/^KO\s*\/\s*EN$/.test(b.textContent.trim())) return;
      b.addEventListener('click', e => { e.preventDefault(); localStorage.setItem('lang', lang() === 'en' ? 'ko' : 'en'); location.reload(); });
    });
    // Fleet Live range buttons — refetch at the chosen window and re-render.
    root.querySelectorAll('.fleet-range').forEach(b => b.addEventListener('click', async () => {
      await fleetLive(parseInt(b.dataset.minutes, 10));
      setTick(x => x + 1);
    }));
    // Alarm acknowledge / un-acknowledge.
    root.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', async (e) => {
      e.preventDefault();
      b.disabled = true;
      await ackAlert(b.dataset.ack, b.dataset.acked !== '1');
      await refresh();
      setTick(x => x + 1);
    }));
    // Alarm rows open the global modal — never a route change (house rule).
    root.querySelectorAll('.alarm-open').forEach(b => b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const d = b.dataset;
      dispatchEvent(new CustomEvent('cflex:open-alarm', { detail: {
        id: Number(d.alarm) || null, priority: d.pri, message: d.msg, device: d.dev,
        deviceId: d.devid, metric: d.metric,
        value: d.value === '' ? null : d.value, threshold: d.threshold === '' ? null : d.threshold,
        at: Number(d.at) || null,
      } }));
    }));
    // Device detail: trend range, maintenance mode, control actions.
    root.querySelectorAll('.dev-range').forEach(b => b.addEventListener('click', () => setDevRange(b.dataset.range)));
    root.querySelectorAll('.dev-mute').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      await muteDevice(b.dataset.device, b.dataset.on === 'true' ? 0 : 60, '2.0 콘솔');
      setTick(x => x + 1);
    }));
    root.querySelectorAll('.dev-action').forEach(b => b.addEventListener('click', async () => {
      const was = b.textContent;
      b.disabled = true; b.textContent = '실행 중…';
      const r = await runControlAction(b.dataset.device, b.dataset.action);
      // The result is reported on the button itself: a control action that
      // silently did nothing is the worst outcome here.
      b.textContent = r?.ok ? '요청됨' : (r?.status === 403 ? '권한 없음' : '실패');
      setTimeout(() => { b.textContent = was; b.disabled = false; }, 2500);
    }));
    mountCopilot(root, { deviceId: route.q.id });
    root.querySelectorAll('form').forEach(f => { if (!f.dataset.wired) f.addEventListener('submit', e => { e.preventDefault(); location.hash = '#/powerchain?panel=copilot'; }); });
    if (route.q.panel === 'copilot') root.querySelector('#copilot')?.scrollIntoView({ behavior: 'smooth' });
  }, [route.q.panel, route.q.id]);
  const withModal = (el) => <><ScreenBoundary name={route.path || 'dashboard'}>{el}</ScreenBoundary><Workbench /></>;
  if (!ready) return <div style={{ minHeight: '100vh', background: '#161616', color: '#8d8d8d', display: 'grid', placeItems: 'center', fontFamily: 'IBM Plex Sans KR, sans-serif' }}>{t('C-Flex FMS 2.0 불러오는 중…')}</div>;
  const p = route.path;
  // #/incident/:id is the link a dispatched engineer opens — the workbench
  // renders full-screen over the alarm centre behind it.
  if (p === 'incident') { const d = alarmsData(null); return withModal(<Screen name="Alarms" html={alarmsTpl} data={d} onReady={wire} />); }
  if (p === 'devices') return withModal(<DevicesScreen />);
  if (p === 'map') return withModal(<MapScreen />);
  if (p === 'twin') return withModal(<TwinScreen q={route.q} tick={tick} />);
  if (p === 'wall') return withModal(<WallScreen data={nocData()} />);
  if (p === 'device') {
    if (devErr) {
      return withModal(<div style={{ minHeight: '100vh', background: '#161616', color: '#f4f4f4', padding: 24, fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif' }}>
        <div style={{ fontSize: 11, color: '#8d8d8d', letterSpacing: '.04em' }}>DEVICE · {route.q.id || '—'}</div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: '6px 0 10px' }}>{t('장치 정보를 불러오지 못했습니다')}</h1>
        <pre style={{ background: '#1f1f1f', borderLeft: '3px solid #fa4d56', padding: 12, fontSize: 12, color: '#ff8389', whiteSpace: 'pre-wrap', maxWidth: 760, overflowX: 'auto' }}>{String(devErr?.stack || devErr?.message || devErr)}</pre>
        <a href="#/devices" style={{ display: 'inline-block', marginTop: 14, background: '#262626', border: '1px solid #525252', color: '#f4f4f4', padding: '7px 12px', fontSize: 12, textDecoration: 'none' }}>{t('← 장비 인벤토리')}</a>
      </div>);
    }
    return withModal(<><Screen name="Device" html={deviceTpl} data={devData} onReady={(root) => { wire(root); mountDeviceFace(root, devData); mountRackElevation(root, devData); }} /><SampleBadge on={!!devData?.sample} /><SampleBadge on={!devData?.sample} text={t('AI 예측·RCA는 Phase 2 샘플')} /></>);
  }
  if (p === 'alarms') { const d = alarmsData(route.q.cbu || (globalCbu() === 'all' ? null : globalCbu())); return withModal(<><Screen name="Alarms" html={alarmsTpl} data={d} onReady={wire} /><SampleBadge on={d.sample} /></>); }
  if (p === 'powerchain') return withModal(<><Screen name="PowerChain" html={powerTpl} data={powerData()} onReady={wire} /><SampleBadge on text={t('전력체인·코파일럿 · Phase 3 샘플')} /></>);
  const d = mainData(); return withModal(<><Screen name="Main" html={mainTpl} data={d} onReady={wire} /><SampleBadge on={d.sample} /></>);
}
