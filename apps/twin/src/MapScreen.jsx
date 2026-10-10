// #/map — alarm map. Campus pins from /v1/fms/sites-map, drilling into the 3D twin.
//
// No map tiles: the addendum rules out a CDN (offline demos, and CARTO already
// broke /fms once by putting its basemap behind a key). This draws a schematic
// instead — pins positioned from each site's lat/lng, normalised to the box.
import React, { useEffect, useState } from 'react';
import { store, sitesMap } from './data';
import { t } from './i18n';
import { tx } from './theme';

const C = { crit: '#fa4d56', warn: '#f1c21b', ok: '#42be65', nodata: '#6f6f6f' };
const worst = (s) => (s.critical > 0 ? 'crit' : s.warn > 0 ? 'warn' : (s.ok > 0 ? 'ok' : 'nodata'));

export default function MapScreen() {
  const [sites, setSites] = useState(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let live = true;
    sitesMap().then(s => { if (live) { setSites(s); setErr(false); } }).catch(() => live && setErr(true));
    return () => { live = false; };
  }, []);

  const nav = [['#/dashboard', t('대시보드')], ['#/powerchain', t('전력체인 트윈')], ['#/device', t('장치')],
    ['#/alarms', t('알람 센터')], ['#/map', t('알람 지도'), true], ['#/twin', t('3D 트윈')],
    ['#/powerchain?panel=copilot', t('AI 코파일럿')], ['#/wall', t('관제 상황판')], ['/fms', t('FMS 1.x (관리)')]];

  // Normalise lat/lng into the drawing box. One site, or sites without
  // coordinates, fall back to an evenly spaced row rather than piling up.
  const withXY = (() => {
    const list = sites || [];
    const geo = list.filter(s => s.lat != null && s.lng != null);
    if (geo.length < 2) return list.map((s, i) => ({ ...s, _x: 12 + (i + 0.5) * (76 / Math.max(1, list.length)), _y: 50 }));
    const lats = geo.map(s => s.lat), lngs = geo.map(s => s.lng);
    const [la0, la1] = [Math.min(...lats), Math.max(...lats)];
    const [ln0, ln1] = [Math.min(...lngs), Math.max(...lngs)];
    const span = (a, b) => (b - a || 1);
    return list.map((s, i) => (s.lat == null
      ? { ...s, _x: 12 + (i + 0.5) * (76 / Math.max(1, list.length)), _y: 86 }
      : { ...s, _x: 14 + ((s.lng - ln0) / span(ln0, ln1)) * 72, _y: 78 - ((s.lat - la0) / span(la0, la1)) * 56 }));
  })();

  const card = { background: '#262626', padding: 14 };
  const head = { fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 8 };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#161616', color: '#f4f4f4', fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif' }}>
      <nav style={{ flex: '0 0 220px', background: '#0b0b0b', borderRight: '1px solid #262626', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid #262626', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, background: '#0f62fe', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#fff' }}>C</div>
          <div><div style={{ fontSize: 15, fontWeight: 700 }}>C-Flex FMS <span style={{ fontSize: 11, color: '#78a9ff' }}>2.0</span></div>
            <div style={{ fontSize: 11, color: '#8d8d8d' }}>RingOn Service · {store.me?.tenantName || 'HAEA'}</div></div>
        </div>
        <div style={{ padding: '10px 0', display: 'flex', flexDirection: 'column' }}>
          {nav.map(([h, l, on]) => <a key={l} href={h} style={{ padding: '11px 16px 11px 13px', fontSize: 14, textDecoration: 'none', color: on ? '#f4f4f4' : '#c6c6c6', background: on ? '#262626' : 'transparent', borderLeft: `3px solid ${on ? '#4589ff' : 'transparent'}`, fontWeight: on ? 600 : 400 }}>{l}</a>)}
        </div>
        <div style={{ marginTop: 'auto', padding: '14px 16px', borderTop: '1px solid #262626', fontSize: 12, color: '#c6c6c6' }}>
          {store.me?.displayName || ''}<br /><span style={{ color: '#8d8d8d' }}>{store.me?.email || ''}</span>
        </div>
      </nav>

      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', background: '#0b0b0b', borderBottom: '1px solid #262626' }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('알람 지도')}</h1>
          <span style={{ fontSize: 12, color: '#8d8d8d' }}>
            {sites ? tx(`사이트 ${sites.length} · 핀을 누르면 건물 목록`, `${sites.length} sites · click a pin for its buildings`) : tx('불러오는 중…', 'Loading…')}
          </span>
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 12, padding: 16 }}>
          <div style={{ position: 'relative', background: '#070a10', border: '1px solid #262626', minHeight: 520 }}>
            {err && <div style={{ padding: 20, color: '#f1c21b' }}>{t('API 오류 · 재시도')}</div>}
            {!sites && !err && <div style={{ padding: 20, color: '#8d8d8d' }}>{tx('불러오는 중…', 'Loading…')}</div>}
            {sites && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                {[20, 40, 60, 80].map(v => <line key={`h${v}`} x1="0" y1={v} x2="100" y2={v} stroke="#1c2230" strokeWidth="0.2" />)}
                {[20, 40, 60, 80].map(v => <line key={`v${v}`} x1={v} y1="0" x2={v} y2="100" stroke="#1c2230" strokeWidth="0.2" />)}
              </svg>
            )}
            {withXY.map(s => {
              const w = worst(s);
              return (
                <button key={s.cbu} onClick={() => setOpen(open === s.cbu ? null : s.cbu)}
                  title={`${s.cbu} · ${s.total} UPS`}
                  style={{ position: 'absolute', left: `${s._x}%`, top: `${s._y}%`, transform: 'translate(-50%,-50%)', background: 'transparent', border: 0, cursor: 'pointer', color: '#f4f4f4', fontFamily: 'inherit' }}>
                  <span style={{ display: 'block', width: 18, height: 18, borderRadius: '50%', background: C[w], margin: '0 auto', boxShadow: `0 0 0 6px ${C[w]}33` }} />
                  <span style={{ display: 'block', marginTop: 6, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{s.cbu}</span>
                  <span style={{ display: 'block', fontSize: 11, color: '#c6c6c6', whiteSpace: 'nowrap' }}>
                    {s.critical ? <b style={{ color: C.crit }}>{s.critical} {t('위험')}</b> : s.warn ? <b style={{ color: C.warn }}>{s.warn} {t('경고')}</b> : `${s.total} UPS`}
                  </span>
                </button>
              );
            })}
            <div style={{ position: 'absolute', left: 12, bottom: 10, fontSize: 11, color: '#8d8d8d' }}>
              {t('지도 타일 없음 — 좌표 개략도 (CDN 미사용)')}
            </div>
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section style={card}>
              <div style={head}>{open ? open : t('사이트')}</div>
              {!open && <span style={{ color: '#8d8d8d', fontSize: 13 }}>{t('핀을 누르면 건물 목록이 표시된다.')}</span>}
              {open && (withXY.find(s => s.cbu === open)?.buildings || []).map(b => (
                <a key={b.name} href={`#/twin?site=${encodeURIComponent(b.name)}`}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 10px', marginBottom: 6, background: '#1f1f1f', color: '#e0e0e0', textDecoration: 'none', fontSize: 13 }}>
                  <span>{b.name}</span><span style={{ color: '#8d8d8d' }}>{b.total} UPS →</span>
                </a>
              ))}
              {open && !(withXY.find(s => s.cbu === open)?.buildings || []).length &&
                <span style={{ color: '#8d8d8d', fontSize: 13 }}>{t('등록된 건물 없음')}</span>}
            </section>

            <section style={card}>
              <div style={head}>{t('상태 요약')}</div>
              {(sites || []).map(s => (
                <div key={s.cbu} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, padding: '6px 0', borderBottom: '1px solid #393939', fontSize: 12 }}>
                  <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: C[worst(s)], marginRight: 6 }} />{s.cbu}</span>
                  <span className="mono" style={{ color: '#c6c6c6' }}>
                    {s.critical ? <b style={{ color: C.crit }}>{s.critical}</b> : 0}/{s.warn || 0}/{s.total}
                  </span>
                </div>
              ))}
              <div style={{ fontSize: 10, color: '#8d8d8d', marginTop: 6 }}>{t('위험/경고/전체')}</div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
