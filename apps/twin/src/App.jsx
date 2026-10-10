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
import { api, lang, tx } from './theme';
import { devId } from './ids';
import { mountCopilot } from './copilot';
import { t } from './i18n';
import TwinScreen from './TwinScreen';
import MapScreen from './MapScreen';
import AlarmModal from './AlarmModal';

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
// ---------- NOC wall (1920×1080, scaled to fit)
function WallScreen({ data }) {
  const ref = useRef(null); const [scale, setScale] = useState(1);
  const sceneBox = useRef(null); const sceneRef = useRef(null);
  useLayoutEffect(() => { if (data) render(ref.current, nocTpl, data); }, [data]);

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
  const route = useRoute(); const [tick, setTick] = useState(0); const [ready, setReady] = useState(false); const [devData, setDevData] = useState(null); const [devRange, setDevRange] = useState('24h');
  useEffect(() => { api('/v1/me').then(async m => { if (!m || (!m.userId && !m.email)) { location.replace('/login'); return; } store.me = m; await refresh(); setReady(true); }); const t = setInterval(async () => { await refresh(); setTick(x => x + 1); }, 30000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!ready) return; if (route.path === 'device') deviceData(route.q.id, false, devRange).then(setDevData); }, [ready, route.path, route.q.id, tick, devRange]);
  const wire = useCallback((root) => {
    root.querySelectorAll('.cbu-btn').forEach(b => b.addEventListener('click', async () => { localStorage.setItem('fms_cbu', b.dataset.cbu); await refresh(); setTick(x => x + 1); }));
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
  const withModal = (el) => <>{el}<AlarmModal /></>;
  if (!ready) return <div style={{ minHeight: '100vh', background: '#161616', color: '#8d8d8d', display: 'grid', placeItems: 'center', fontFamily: 'IBM Plex Sans KR, sans-serif' }}>{t('C-Flex FMS 2.0 불러오는 중…')}</div>;
  const p = route.path;
  if (p === 'map') return withModal(<MapScreen />);
  if (p === 'twin') return withModal(<TwinScreen q={route.q} tick={tick} />);
  if (p === 'wall') return <WallScreen data={nocData()} />;
  if (p === 'device') return <><Screen name="Device" html={deviceTpl} data={devData} onReady={wire} /><SampleBadge on={!!devData?.sample} /><SampleBadge on={!devData?.sample} text={t('AI 예측·RCA·추세는 Phase 2 샘플')} /></>;
  if (p === 'alarms') { const d = alarmsData(route.q.cbu || null); return withModal(<><Screen name="Alarms" html={alarmsTpl} data={d} onReady={wire} /><SampleBadge on={d.sample} /></>); }
  if (p === 'powerchain') return <><Screen name="PowerChain" html={powerTpl} data={powerData()} onReady={wire} /><SampleBadge on text={t('전력체인·코파일럿 · Phase 3 샘플')} /></>;
  const d = mainData(); return withModal(<><Screen name="Main" html={mainTpl} data={d} onReady={wire} /><SampleBadge on={d.sample} /></>);
}
