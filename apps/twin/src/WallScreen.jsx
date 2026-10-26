// #/wall — the NOC wall. Moved out of App.jsx unchanged (WO-INT-004c) so the
// portal's screens are all reached through portalScreens.jsx.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import nocTpl from './screens/NOC.tpl.html?raw';
import { render } from './tpl';
import { buildLedgerScene } from './twin/LedgerScene';
import { store } from './data';
import { t } from './i18n';
import { mountCbuBar } from './cbubar';

// ---------- NOC wall (1920×1080, scaled to fit)
export default function WallScreen({ data }) {
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
