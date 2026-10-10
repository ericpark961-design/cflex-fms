// #/map — alarm map. Same picture as FMS 1.x: a real basemap with campus pins,
// drilling into the 3D twin.
//
// Basemap is OpenFreeMap "positron" — the keyless source 1.x was moved to after
// CARTO put theirs behind an API key and filled /fms with "API KEY REQUIRED"
// watermarks. Same style, same renderer (maplibre-gl 5.24), so 1.x and 2.0 show
// the same map. The style carries no attribution field, so OSM credit is
// supplied explicitly below — do not drop it.
import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { store, sitesMap } from './data';
import { t } from './i18n';
import { tx } from './theme';

const BASEMAP = 'https://tiles.openfreemap.org/styles/positron';
const C = { crit: '#fa4d56', warn: '#f1c21b', ok: '#42be65', nodata: '#6f6f6f', ink: '#161616', muted: '#525252' };
const worst = (s) => (s.critical > 0 ? 'crit' : s.warn > 0 ? 'warn' : (s.ok > 0 ? 'ok' : 'nodata'));

function ensureKeyframes() {
  if (document.getElementById('twin-map-keyframes')) return;
  const el = document.createElement('style');
  el.id = 'twin-map-keyframes';
  el.textContent = '@keyframes twinPulseDot{0%,100%{transform:scale(1);opacity:.20}50%{transform:scale(1.35);opacity:.06}}';
  document.head.appendChild(el);
}

export default function MapScreen({ q = {} }) {
  const [sites, setSites] = useState(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(null);
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => {
    let live = true;
    sitesMap()
      .then(s => { if (live) { setSites(s); setErr(false); } })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, []);

  // map once
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    ensureKeyframes();
    const map = new maplibregl.Map({
      container: boxRef.current,
      style: BASEMAP,
      center: [-117.86, 33.70],          // southern California; refit once sites load
      zoom: 9,
      attributionControl: {
        customAttribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · <a href="https://openfreemap.org/">OpenFreeMap</a>',
      },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // pins
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sites?.length) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    const bounds = new maplibregl.LngLatBounds();
    let placed = 0;

    for (const s of sites) {
      if (s.lat == null || s.lng == null) continue;        // a site with no survey coordinates is simply not drawn
      const color = C[worst(s)];
      const el = document.createElement('div');
      el.style.cssText = 'position:relative;width:18px;height:18px;cursor:pointer';
      el.innerHTML =
        `<span style="position:absolute;left:-10px;top:-10px;width:38px;height:38px;border-radius:50%;background:${color};opacity:.20;animation:twinPulseDot 2s ease-in-out infinite"></span>` +
        `<span style="position:absolute;inset:0;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.3)"></span>`;
      // Clicking a pin goes straight to that site's alarm centre. The 3D route
      // stays available from the building rows in the panel and the popup.
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(s.cbu);
        location.hash = `#/alarms?cbu=${encodeURIComponent(s.cbu)}`;
      });

      const buildings = (s.buildings || []).map(b =>
        `<a href="#/twin?site=${encodeURIComponent(b.name)}" style="display:flex;justify-content:space-between;gap:10px;padding:5px 7px;margin-top:4px;background:#f4f4f4;color:#161616;text-decoration:none;font-size:11px"><span>${b.name}</span><span style="color:${C.muted}">${b.total} UPS →</span></a>`).join('');

      const popup = new maplibregl.Popup({ offset: 18, closeButton: true, maxWidth: '280px' }).setHTML(
        `<div style="font-family:'IBM Plex Sans KR','IBM Plex Sans',Arial,sans-serif;padding:2px;min-width:210px">
           <div style="font-weight:700;font-size:13px;color:${C.ink}">${s.company || s.cbu}</div>
           <div style="font-size:11px;color:${C.muted};margin:2px 0 8px">${s.display || s.address || ''}</div>
           <div style="display:flex;gap:9px;font-size:11px;align-items:center;flex-wrap:wrap">
             <span style="padding:2px 8px;background:#e0e0e0;font-weight:700">${s.total} UPS</span>
             ${s.critical > 0 ? `<span style="color:${C.crit};font-weight:700">● ${s.critical} ${t('위험')}</span>` : ''}
             ${s.warn > 0 ? `<span style="color:${C.warn};font-weight:700">● ${s.warn} ${t('경고')}</span>` : ''}
             ${s.ok > 0 ? `<span style="color:${C.ok}">● ${s.ok} ${t('정상')}</span>` : ''}
             ${(s.nodata || s.unreachable) ? `<span style="color:${C.muted}">● ${(s.nodata || 0) + (s.unreachable || 0)} ${t('데이터없음')}</span>` : ''}
           </div>
           <a href="#/alarms?cbu=${encodeURIComponent(s.cbu)}" style="display:block;margin-top:9px;font-size:11px;color:#0f62fe;font-weight:700;text-decoration:none">→ ${t('알람 센터로 이동')}</a>
           <div style="margin-top:9px;font-size:10px;color:${C.muted};font-weight:600;letter-spacing:.03em">${t('건물')}</div>
           ${buildings || `<div style="font-size:11px;color:${C.muted};margin-top:4px">${t('등록된 건물 없음')}</div>`}
         </div>`);

      markersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).setPopup(popup).addTo(map));
      bounds.extend([s.lng, s.lat]);
      placed++;
    }

    if (placed === 1) map.easeTo({ center: bounds.getCenter(), zoom: 12, duration: 600 });
    else if (placed > 1) map.fitBounds(bounds, { padding: 90, maxZoom: 12, duration: 600 });
  }, [sites]);

  const nav = [['#/dashboard', t('대시보드')], ['#/powerchain', t('전력체인 트윈')], ['#/device', t('장치')],
    ['#/alarms', t('알람 센터')], ['#/map', t('알람 지도'), true], ['#/twin', t('3D 트윈')],
    ['#/powerchain?panel=copilot', t('AI 코파일럿')], ['#/wall', t('관제 상황판')], ['/fms', t('FMS 1.x (관리)')]];

  const card = { background: '#262626', padding: 14 };
  const head = { fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 8 };
  const sel = sites?.find(s => s.cbu === open);
  const noGeo = (sites || []).filter(s => s.lat == null || s.lng == null);

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
            {sites
              ? tx(`사이트 ${sites.length} · 핀을 누르면 건물 목록`, `${sites.length} sites · click a pin for its buildings`)
              : tx('불러오는 중…', 'Loading…')}
          </span>
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 12, padding: 16 }}>
          <div style={{ position: 'relative', border: '1px solid #262626', height: 'calc(100vh - 150px)', minHeight: 480, overflow: 'hidden' }}>
            <div ref={boxRef} style={{ position: 'absolute', inset: 0 }} />
            {err && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(11,11,11,.85)', color: '#f1c21b', fontSize: 13 }}>{t('API 오류 · 재시도')}</div>}
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section style={card}>
              <div style={head}>{sel ? (sel.company || sel.cbu) : t('사이트')}</div>
              {!sel && <span style={{ color: '#8d8d8d', fontSize: 13 }}>{t('핀을 누르면 건물 목록이 표시된다.')}</span>}
              {sel && (sel.buildings || []).map(b => (
                <a key={b.name} href={`#/twin?site=${encodeURIComponent(b.name)}`}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 10px', marginBottom: 6, background: '#1f1f1f', color: '#e0e0e0', textDecoration: 'none', fontSize: 13 }}>
                  <span>{b.name}</span><span style={{ color: '#8d8d8d' }}>{b.total} UPS →</span>
                </a>
              ))}
              {sel && !(sel.buildings || []).length && <span style={{ color: '#8d8d8d', fontSize: 13 }}>{t('등록된 건물 없음')}</span>}
            </section>

            <section style={card}>
              <div style={head}>{t('상태 요약')}</div>
              {(sites || []).map(s => (
                <button key={s.cbu} onClick={() => { location.hash = `#/alarms?cbu=${encodeURIComponent(s.cbu)}`; }}
                  style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, width: '100%', padding: '7px 0', borderBottom: '1px solid #393939', fontSize: 12, background: 'none', border: 0, borderBottomStyle: 'solid', color: '#f4f4f4', fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                  <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: C[worst(s)], marginRight: 6 }} />{s.cbu}</span>
                  <span className="mono" style={{ color: '#c6c6c6' }}>
                    {s.critical ? <b style={{ color: C.crit }}>{s.critical}</b> : 0}/{s.warn || 0}/{s.total}
                  </span>
                </button>
              ))}
              <div style={{ fontSize: 10, color: '#8d8d8d', marginTop: 6 }}>{t('위험/경고/전체')}</div>
              {/* A site with no coordinates has no pin — say so rather than let it vanish. */}
              {noGeo.length > 0 && (
                <div style={{ fontSize: 11, color: '#f1c21b', marginTop: 8 }}>
                  {tx(`좌표 없음 ${noGeo.length}곳 — 지도에 표시되지 않음`, `${noGeo.length} site(s) have no coordinates and are not pinned`)}
                </div>
              )}
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
