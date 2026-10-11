// Graphical 42U rack elevation (dcTrack-style) for the click panel: each device drawn with its facade / photo icon at its U position.
import React from 'react';
import { deviceVisual } from './deviceVisual';
import { unitU } from './upsModels';
import { t } from '../i18n';

const ST = { ok: '#24a148', warn: '#f1c21b', critical: '#da1e28', nodata: '#6f6f6f', unreachable: '#6f6f6f' };
export default function RackElevation({ devices = [], units = 42, width = 132, onPick, picked }) {
  const uH = width / 482.6 * 44.45;                    // true proportion: 19" wide, 44.45 mm per U
  const H = units * uH;
  // deviceVisual was called twice per device (once to filter, once to draw).
  const seen = devices.map(d => ({ d, v: deviceVisual(d), u: unitU(d) || 1 }));
  const racked = seen.filter(x => !x.v.tower && Number.isFinite(Number(x.d.u_pos)));
  // A device with no U position cannot be drawn in the elevation. Defaulting it
  // to U1 silently stacked several units on top of each other and read as a
  // placement; they are listed underneath instead.
  const unplaced = seen.filter(x => !x.v.tower && !Number.isFinite(Number(x.d.u_pos)));
  return <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
    <div style={{ position: 'relative', width: width + 28, height: H + 12, background: '#0b0b0b', border: '1px solid #393939', flex: '0 0 auto' }}>
      {/* rails with U numbers every 5U */}
      {[...Array(units)].map((_, i) => { const u = i + 1; const y = 6 + H - u * uH; return <React.Fragment key={u}>
        <div style={{ position: 'absolute', left: 0, top: y, width: 14, height: uH, borderTop: '1px solid #1c1c1c', fontSize: 7, color: u % 5 === 0 ? '#8d8d8d' : 'transparent', textAlign: 'center', lineHeight: `${uH}px` }}>{u}</div>
        <div style={{ position: 'absolute', right: 0, top: y, width: 14, height: uH, borderTop: '1px solid #1c1c1c' }} />
      </React.Fragment>; })}
      <div style={{ position: 'absolute', left: 14, right: 14, top: 6, bottom: 6, background: 'repeating-linear-gradient(#141414 0, #141414 1px, #0f0f0f 1px, #0f0f0f ' + uH + 'px)' }} />
      {racked.map(({ d, v, u }) => { const pos = Number(d.u_pos); const hl = picked === d.label;
        return <div key={d.label} title={`${d.label} · ${d.model} · U${pos}${u > 1 ? '–' + (pos + u - 1) : ''}`} onClick={() => onPick?.(d)}
          style={{ position: 'absolute', left: 14, width, top: 6 + H - (pos + u - 1) * uH, height: u * uH, cursor: 'pointer', outline: hl ? '2px solid #4589ff' : 'none', boxShadow: `inset 3px 0 0 ${ST[d.status] || '#6f6f6f'}`, opacity: ['ok', 'warn', 'critical'].includes(d.status) ? 1 : 0.55 }}>
          <img src={v.url} alt="" style={{ display: 'block', width: '100%', height: '100%', objectFit: 'fill' }} />
        </div>; })}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      {[...racked].sort((a, b) => Number(b.d.u_pos) - Number(a.d.u_pos)).map(({ d }) => <div key={d.label} onClick={() => onPick?.(d)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '3px 6px', marginBottom: 2, background: picked === d.label ? '#1c2a44' : '#262626', borderLeft: `3px solid ${ST[d.status] || '#6f6f6f'}`, cursor: 'pointer' }}>
        <span style={{ color: '#8d8d8d', width: 30, flex: '0 0 auto' }}>U{d.u_pos ?? '—'}</span><div style={{ minWidth: 0 }}><b>{d.label}</b><div style={{ color: '#c6c6c6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.vendor ? d.vendor + ' ' : ''}{d.model}{d.ports_total ? ` · ${d.ports_up ?? 0}/${d.ports_total}p` : ''}</div></div>
      </div>)}
      {unplaced.length > 0 && <div style={{ marginTop: 8, fontSize: 11, color: '#f1c21b' }}>
        {t('U 위치 미지정')} {unplaced.length}{t('대')} — {unplaced.map(x => x.d.label).join(', ')}
      </div>}
    </div>
  </div>;
}
