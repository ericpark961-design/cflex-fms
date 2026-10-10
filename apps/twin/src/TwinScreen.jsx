import React, { useEffect, useRef, useState, useMemo } from 'react';
import { store } from './data';
import { api, tx } from './theme';
import { t } from './i18n';
import { buildDemoScene } from './DemoScene';
import Twin3D from './Twin3D';
import { buildLedgerScene } from './twin/LedgerScene';
import { iconIdForModel, iconUrl, UPS_ICON_META } from './twin/upsIcons';
import kmx from './demo/kmx_ccr_topology.json';

const SampleBadge = ({ on, text = 'DEMO · KMX 설계 샘플' }) => on ? <div style={{ position: 'fixed', right: 14, bottom: 12, zIndex: 40, background: '#f1c21b', color: '#161616', fontSize: 11, fontWeight: 700, padding: '5px 9px', letterSpacing: '.03em' }}>{text}</div> : null;
const PRI = { P1: '#fa4d56', P2: '#f1c21b', P3: '#8d8d8d' };
const KIND_KO = { ups: 'UPS', switch: '스위치', router: '라우터', sbc: 'SBC', server: '서버', patch: '패치패널', pdu: '랙 PDU', storage: '스토리지' };

// ---------- right-hand panel for the ledger scene
function LedgerPanel({ sel, data, onFocus }) {
  if (!sel) return <span style={{ color: '#8d8d8d' }}>랙·UPS·CRAC·센서·누수 존을 클릭하면 상세와 전원 체인이 표시된다.</span>;
  const alarms = (data.alarms || []).filter(a => a.object === sel.name || sel.devices?.some(d => d.label === a.device));
  const ups = sel.devices?.find(d => d.kind === 'ups') || (sel.kind === 'device' && sel.device.kind === 'ups' ? sel.device : null);
  const stColor = { ok: '#24a148', warn: '#f1c21b', critical: '#da1e28', empty: '#525252' }[sel.status] || '#8d8d8d';
  return <div style={{ fontSize: 13, lineHeight: 1.5 }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      {ups && <div style={{ flex: '0 0 96px', padding: 5, background: '#111', border: `2px solid ${{ ok: '#24a148', warn: '#f1c21b', critical: '#da1e28' }[ups.status] || '#8d8d8d'}` }}><img src={iconUrl(iconIdForModel(ups.model))} alt="" style={{ display: 'block', width: '100%' }} /><div style={{ fontSize: 9, color: '#8d8d8d', marginTop: 3, textAlign: 'center' }}>{UPS_ICON_META[iconIdForModel(ups.model)].label}</div></div>}
      <div style={{ minWidth: 0, flex: 1 }} dangerouslySetInnerHTML={{ __html: sel.html }} />
    </div>
    {ups && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 }}>{[['배터리', `${ups.battery_pct ?? '—'}%`], ['부하', `${ups.load_pct ?? '—'}%`], ['온도', `${ups.temp_c ?? '—'}°C`], ['런타임', `${ups.runtime_min ?? '—'} min`]].map(([l, v]) => <div key={l} style={{ background: '#1f1f1f', padding: '6px 9px' }}><div style={{ fontSize: 10, color: '#8d8d8d' }}>{l}</div><div style={{ fontSize: 16, fontWeight: 700 }}>{v}</div></div>)}</div>}
    {sel.kind === 'rack' && sel.devices?.length > 0 && <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 4 }}>랙 실장 (42U)</div>
      <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 2, background: '#111', padding: 6, border: '1px solid #393939' }}>
        {[...sel.devices].sort((a, b) => (a.u_pos || 0) - (b.u_pos || 0)).map(d => <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, padding: '3px 6px', background: d.kind === 'ups' ? '#1c2a44' : '#262626', borderLeft: `3px solid ${{ ok: '#24a148', warn: '#f1c21b', critical: '#da1e28' }[d.status] || '#8d8d8d'}` }}><span style={{ color: '#8d8d8d', width: 34 }}>U{d.u_pos ?? '—'}</span><b>{d.label}</b><span style={{ color: '#c6c6c6' }}>{KIND_KO[d.kind] || d.kind} · {d.model}</span>{d.ports_total && <span style={{ marginLeft: 'auto', color: '#8d8d8d' }}>{d.ports_up}/{d.ports_total}p</span>}</div>)}
      </div></div>}
    {alarms.length > 0 && <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 4 }}>알람</div>
      {alarms.map(a => <div key={a.id} style={{ background: '#1f1f1f', padding: '7px 9px', marginBottom: 4, borderLeft: `3px solid ${PRI[a.priority]}` }}><div style={{ fontSize: 11 }}><b style={{ color: PRI[a.priority] }}>{a.priority}</b> · {a.received_at} · {a.id}</div><div>{a.message}</div>{a.ai && <div style={{ marginTop: 5, padding: '6px 8px', background: '#0f2340', borderLeft: '2px solid #4589ff', fontSize: 12 }}><b style={{ color: '#78a9ff' }}>AI 코파일럿</b> · {a.ai}</div>}</div>)}
    </div>}
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 4 }}>전원 체인 (부하 → 공급)</div>
      {sel.chain?.length ? <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}><tbody>
        <tr style={{ background: '#1f1f1f' }}><td style={{ padding: '4px 6px', color: '#ff832b' }}>0</td><td style={{ padding: '4px 6px' }}><b>{sel.name}</b></td><td style={{ padding: '4px 6px', color: '#8d8d8d' }}>부하</td><td></td></tr>
        {sel.chain.map((l, i) => <tr key={i} style={{ borderTop: '1px solid #393939', cursor: 'pointer' }} onClick={() => onFocus(l.dst)}><td style={{ padding: '4px 6px', color: '#ff832b' }}>{i + 1}</td><td style={{ padding: '4px 6px' }}><b>{l.dst}</b></td><td style={{ padding: '4px 6px', color: '#c6c6c6' }}>{l.dst_port || l.circuit || ''}{l.phase ? ' · ' + l.phase : ''}</td><td style={{ padding: '4px 6px', textAlign: 'right' }}>{l.rated_a ?? '—'} A</td></tr>)}
      </tbody></table> : <span style={{ color: '#8d8d8d', fontSize: 12 }}>연결 정보 없음 — 원장에 전원 링크가 등록되지 않은 객체.</span>}
    </div>
  </div>;
}

export default function TwinScreen({ q, standalone = false, tick = 0 }) {
  const [mode, setMode] = useState('status'); const [view, setView] = useState('iso'); const [scene, setScene] = useState(q.scene || (standalone ? 'kmx' : 'real'));
  const [sel, setSel] = useState(null); const [detail, setDetail] = useState(null); const [lsel, setLsel] = useState(null);
  const [layers, setLayers] = useState({ labels: true, sensors: true, leak: true }); const [heat, setHeat] = useState('off');
  const ledgerRef = useRef(null); const boxRef = useRef(null);
  const demoRef = useRef(null); const demoCanvasRef = useRef(null); const demoTipRef = useRef(null);
  const [demoSel, setDemoSel] = useState('');
  // Follows the live ledger once it loads; falls back to the bundled KMX design.
  const data = useMemo(() => (store.topology?.rooms?.length ? store.topology : kmx), [store.topology, tick]);
  useEffect(() => { if (q.scene) setScene(q.scene); }, [q.scene]);
  useEffect(() => { if (!sel) { setDetail(null); return; } api(`/v1/fms/assets/${sel}?range=24h`).then(d => d?.ok && setDetail(d.asset)); }, [sel]);
  useEffect(() => {
    if (scene !== 'kmx') return; const s = buildLedgerScene(boxRef.current, data, { onSelect: setLsel }); ledgerRef.current = s;
    s.setLayers(layers); s.setHeat(heat); s.setMode(mode); if (q.focus) setTimeout(() => s.focus(q.focus), 300);
    return () => { s.dispose(); ledgerRef.current = null; };
  }, [scene, data]);
  // The hand-built KMX demo scene stays reachable (#/twin?scene=demo).
  useEffect(() => {
    if (scene !== 'demo') return;
    const d = buildDemoScene(demoCanvasRef.current, { tip: demoTipRef.current, onSelect: setDemoSel });
    demoRef.current = d;
    return () => { d.dispose(); demoRef.current = null; };
  }, [scene]);
  useEffect(() => { demoRef.current?.setMode(mode); }, [mode, scene]);
  useEffect(() => { demoRef.current?.preset(view); }, [view, scene]);
  useEffect(() => { ledgerRef.current?.setMode(mode); }, [mode]); useEffect(() => { ledgerRef.current?.preset(view); }, [view]);
  useEffect(() => { ledgerRef.current?.setLayers(layers); }, [layers]); useEffect(() => { ledgerRef.current?.setHeat(heat); }, [heat]);
  const btn = (on) => ({ fontFamily: 'inherit', fontSize: 12, padding: '6px 11px', cursor: 'pointer', border: `1px solid ${on ? '#4589ff' : '#525252'}`, background: on ? '#1c2a44' : 'transparent', color: '#f4f4f4' });
  const nav = [['#/dashboard', '대시보드'], ['#/powerchain', '전력체인 트윈'], ['#/device', '장치'], ['#/alarms', '알람 센터'], ['#/twin', '3D 트윈', true], ['#/powerchain?panel=copilot', 'AI 코파일럿'], ['#/wall', '관제 상황판'], ['/fms', 'FMS 1.x (관리)']];
  const a = detail; const room = data.rooms[0]; const nRack = room.objects.filter(o => o.kind === 'rack').length;
  const alarms = data.alarms || [];
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#161616', color: '#f4f4f4', fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif' }}>
      <nav style={{ flex: '0 0 220px', background: '#0b0b0b', borderRight: '1px solid #262626', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid #262626', display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ width: 30, height: 30, background: '#0f62fe', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#fff' }}>C</div><div><div style={{ fontSize: 15, fontWeight: 700 }}>C-Flex FMS <span style={{ fontSize: 11, color: '#78a9ff' }}>2.0</span></div><div style={{ fontSize: 11, color: '#8d8d8d' }}>RingOn Service · {standalone ? 'KMX (Kia Mexico)' : (store.me?.tenantName || 'HAEA')}</div></div></div>
        {!standalone && <div style={{ padding: '10px 0', display: 'flex', flexDirection: 'column' }}>{nav.map(([h, l, on]) => <a key={l} href={h} style={{ padding: '11px 16px 11px 13px', fontSize: 14, textDecoration: 'none', color: on ? '#f4f4f4' : '#c6c6c6', background: on ? '#262626' : 'transparent', borderLeft: `3px solid ${on ? '#4589ff' : 'transparent'}`, fontWeight: on ? 600 : 400 }}>{l}</a>)}</div>}
        {scene === 'kmx' && <div style={{ padding: '12px 14px', borderTop: '1px solid #262626' }}>
          <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 8 }}>알람 {alarms.length} · 클릭하면 3D 이동</div>
          {alarms.map(al => <div key={al.id} onClick={() => ledgerRef.current?.focus(al.object)} style={{ cursor: 'pointer', padding: '7px 9px', marginBottom: 6, background: '#1f1f1f', borderLeft: `3px solid ${PRI[al.priority]}`, fontSize: 12, lineHeight: 1.4 }}><div><b style={{ color: PRI[al.priority] }}>{al.priority}</b> <span style={{ color: '#8d8d8d' }}>{al.received_at}</span> · <b>{al.object}</b></div><div style={{ color: '#c6c6c6' }}>{al.message}</div></div>)}
          <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', margin: '12px 0 6px' }}>시설 요약</div>
          <div style={{ fontSize: 12, color: '#c6c6c6', lineHeight: 1.6 }}>{room.location} · {room.name}<br />{room.cols}×{room.rows} 타일 ({(room.cols * room.tile_mm / 1000).toFixed(1)}×{(room.rows * room.tile_mm / 1000).toFixed(1)} m)<br />랙 {nRack} · UPS 40 kW ×2 · CRAC {room.objects.filter(o => o.kind === 'crac').length} · 센서 {room.objects.filter(o => o.kind === 'sensor').length} · 누수 존 {room.objects.filter(o => o.kind === 'leak_zone').length}<br />장비 {room.devices.length} (UPS {room.devices.filter(d => d.kind === 'ups').length} · 네트워크/UC {room.devices.filter(d => d.kind !== 'ups').length}) · 전원 링크 {room.power_links.length}</div>
        </div>}
        <div style={{ marginTop: 'auto', padding: '14px 16px', borderTop: '1px solid #262626', fontSize: 12, color: '#c6c6c6' }}>{standalone ? 'Eric Park · RingOn Service Corp.' : (store.me?.displayName || '')}<br /><span style={{ color: '#8d8d8d' }}>{standalone ? 'ericpark@ringonservice.com' : (store.me?.email || '')}</span></div>
      </nav>
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 20px', background: '#0b0b0b', borderBottom: '1px solid #262626' }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>3D 디지털트윈</h1>
          <div style={{ display: 'flex', gap: 6, marginLeft: 12 }}>{!standalone && <button style={btn(scene === 'real')} onClick={() => setScene('real')}>{tx('실데이터', 'Live')} · {store.me?.tenantName || 'HAEA'} {store.assets.length}{tx('대', ' UPS')}</button>}<button style={btn(scene === 'kmx')} onClick={() => setScene('kmx')}>KMX CCR · {t('원장')} {nRack}{tx('랙', ' racks')}</button>{!standalone && <button style={btn(scene === 'demo')} onClick={() => setScene('demo')}>{t('KMX CCR 데모 씬')}</button>}</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['status', '상태'], ['load', '부하 kW'], ['temp', '온도']].map(([k, l]) => <button key={k} style={btn(mode === k)} onClick={() => setMode(k)}>{l}</button>)}<span style={{ width: 10 }} />
            {[['iso', '아이소'], ['top', '탑뷰'], ['aisle', '통로'], ...(scene === 'kmx' ? [['crac', 'CRAC']] : [])].map(([k, l]) => <button key={k} style={btn(view === k)} onClick={() => { setView(k); if (k === view) ledgerRef.current?.preset(k); }}>{l}</button>)}
            {scene === 'kmx' && <><span style={{ width: 10, borderLeft: '1px solid #393939' }} /><span style={{ fontSize: 11, color: '#8d8d8d', alignSelf: 'center' }}>레이어</span>{[['labels', '라벨'], ['sensors', '센서'], ['leak', '누수 존']].map(([k, l]) => <button key={k} style={btn(layers[k])} onClick={() => setLayers({ ...layers, [k]: !layers[k] })}>{l}</button>)}{[['load', '전력 히트맵'], ['temp', '온도 히트맵']].map(([k, l]) => <button key={k} style={btn(heat === k)} onClick={() => setHeat(heat === k ? 'off' : k)}>{l}</button>)}</>}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 12, padding: 16 }}>
          <div ref={boxRef} style={{ position: 'relative', height: 'calc(100vh - 150px)', minHeight: 480, overflow: 'hidden', background: '#070a10', border: '1px solid #262626' }}>
            {scene === 'real' && (store.floor ? <Twin3D tree={store.floor} assets={store.assets} selectedId={sel} onSelect={setSel} mode={mode} view={view} /> : <div style={{ padding: 20, color: '#8d8d8d' }}>{t('장치 데이터 불러오는 중…')}</div>)}
            {scene === 'demo' && <><canvas ref={demoCanvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} /><div ref={demoTipRef} style={{ position: 'absolute', display: 'none', pointerEvents: 'none', background: '#0b0b0b', border: '1px solid #393939', padding: '7px 10px', fontSize: 12, lineHeight: 1.5 }} /></>}
            <div style={{ position: 'absolute', left: 12, bottom: 10, fontSize: 11, color: '#8d8d8d', pointerEvents: 'none' }}>드래그 회전 · 휠 확대 · 우클릭 이동 · 클릭 상세 · 전원 체인 자동 추적</div>
          </div>
          <aside style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', maxHeight: 'calc(100vh - 150px)' }}>
            <section style={{ background: '#262626', padding: 14, fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 6 }}>선택 객체</div>
              {scene === 'demo' ? (demoSel ? <div dangerouslySetInnerHTML={{ __html: demoSel }} /> : <span style={{ color: '#8d8d8d' }}>{t('랙·CRAC·UPS·센서·누수 존을 클릭하면 상세가 표시된다.')}</span>)
                : scene === 'kmx' ? <LedgerPanel sel={lsel} data={data} onFocus={(n) => ledgerRef.current?.focus(n)} />
                : a ? <div><div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}><div style={{ flex: '0 0 110px', padding: 6, background: '#111', border: `2px solid ${({ ok: '#24a148', warn: '#f1c21b', critical: '#da1e28' })[a.status] || '#8d8d8d'}` }}><img src={iconUrl(iconIdForModel(a.model))} alt="" style={{ display: 'block', width: '100%', opacity: ['ok', 'warn', 'critical'].includes(a.status) ? 1 : 0.45 }} /><div style={{ fontSize: 10, color: '#8d8d8d', marginTop: 4, textAlign: 'center' }}>{UPS_ICON_META[iconIdForModel(a.model)].label}</div></div><div style={{ minWidth: 0 }}><div style={{ fontSize: 15, fontWeight: 700 }}>{a.label}</div><div style={{ color: '#c6c6c6', fontSize: 12 }}>{a.vendor} {a.model} · {a.room} / {a.rack} · <span className="mono">{a.ip}</span></div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>{[['배터리', a.battery_pct != null ? `${a.battery_pct}%` : '—'], ['부하', a.load_pct != null ? `${a.load_pct}%` : '—'], ['온도', a.temp_c != null ? `${a.temp_c}°C` : '—'], ['런타임', a.runtime_min != null ? `${a.runtime_min} min` : '—']].map(([l, v]) => <div key={l} style={{ background: '#1f1f1f', padding: '8px 10px' }}><div style={{ fontSize: 10, color: '#8d8d8d' }}>{l}</div><div style={{ fontSize: 18, fontWeight: 700 }}>{v}</div></div>)}</div><a href={`#/device?id=${a.id}`} style={{ display: 'inline-block', marginTop: 10, fontSize: 12, color: '#78a9ff' }}>장치 상세 →</a></div></div></div>
                : <span style={{ color: '#8d8d8d' }}>랙을 클릭하면 장치 상세가 표시된다.</span>}
            </section>
            <section style={{ background: '#262626', padding: 14, fontSize: 12, color: '#c6c6c6', lineHeight: 1.6 }}>
              <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 6 }}>데이터 연결</div>
              {scene === 'real' ? <>실데이터 모드는 <span className="mono">/v1/fms/floor · assets</span>의 UPS를 랙 이름으로 추정 배치한다. 서베이 원장이 들어오면 KMX와 같은 엔진으로 그려진다.</> : <>KMX CCR 설계안을 <b>원장(topology JSON)</b>으로 기술한 씬 — 객체 {room.objects.length} · 장비 {room.devices.length} · 전원 링크 {room.power_links.length}. 서베이 시트가 같은 형식이라 현장 값이 들어오면 그대로 실데이터가 된다. 수치는 12월 UAT에서 실제 수집값으로 교체.</>}
            </section>
            <section style={{ background: '#262626', padding: 14, fontSize: 11, color: '#c6c6c6', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {[['#1c4f8a', '정상'], ['#08bdba', '고부하'], ['#f1c21b', '경고'], ['#fa4d56', '위험'], ['#6f6f6f', '데이터없음'], ['#2b2b2b', '공랙'], ['#ff832b', '전원 체인']].map(([c, l]) => <span key={l}><i style={{ display: 'inline-block', width: 10, height: 10, background: c, marginRight: 5, verticalAlign: -1, border: '1px solid #525252' }} />{l}</span>)}
            </section>
          </aside>
        </div>
      </main>
      <SampleBadge on={scene === 'kmx' || scene === 'demo'} text={standalone ? 'KMX CCR · 설계 샘플 원장 · 개발 계획 공유용' : 'DEMO · KMX 설계 샘플 원장'} />
    </div>
  );
}
