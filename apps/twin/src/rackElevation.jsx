// The rack this device sits in, drawn next to its own faceplate.
//
// The detail screen could tell you a unit was in "Rack A-04 · U12" and nothing
// more. What an engineer standing in front of the rack actually needs is the
// column: what is above it, what is below it, and which of its neighbours is
// also in alarm. That is one query away — the inventory already carries
// cbu/location/room/rack/u_pos for both feeds — so it is drawn here.
//
// Mounted into a placeholder the template owns, the same way the faceplate and
// the CBU bar are, because the device screen is template-rendered.
import React from 'react';
import { createRoot } from 'react-dom/client';
import RackElevation from './twin/RackElevation';
import { store } from './data';
import { token } from './theme';
import { inventory, rackMates } from './tree';
import { devId } from './ids';
import { t } from './i18n';

const roots = new WeakMap();

async function fetchNet(cbu) {
  try {
    const q = cbu ? `?cbu=${encodeURIComponent(cbu)}` : '';
    const r = await fetch(`/v1/fms/devices${q}`, { headers: { Authorization: `Bearer ${token()}` } });
    if (!r.ok) return [];
    const j = await r.json();
    return j?.devices || [];
  } catch { return []; }
}

/**
 * @param root  the rendered device screen
 * @param data  what deviceData()/netDeviceData() produced
 */
export async function mountRackElevation(root, data) {
  const host = root?.querySelector('#rack-elevation');
  if (!host) return;
  const d = data?.d;
  // No rack means nothing to draw — a tower UPS on a floor is not a column.
  if (!d?.rack || d.rack === '—') { unmount(host); return; }

  const net = await fetchNet(d.cbu && d.cbu !== '—' ? d.cbu : null);
  // The host can be torn down while the fetch is in flight (the operator clicks
  // through to another device); writing into a detached node would leak a root.
  if (!host.isConnected) return;
  const rows = inventory({ assets: store.assets, devices: net, devId });
  const mates = rackMates(rows, d);
  if (!mates.length) { unmount(host); return; }

  let r = roots.get(host);
  if (!r) { r = createRoot(host); roots.set(host, r); }
  r.render(<Panel mates={mates} picked={d.label} rack={d.rack} />);
}

function unmount(host) {
  const r = roots.get(host);
  if (r) { r.unmount(); roots.delete(host); }
  host.replaceChildren();
}

function Panel({ mates, picked, rack }) {
  const S = {
    box: { background: '#1f1f1f', border: '1px solid #333', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 },
    h: { fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase' },
  };
  const onPick = (dev) => {
    // The elevation is a navigation surface: its whole point is reaching the
    // neighbour you just spotted. UPS ids take the 'ups-' prefix the detail
    // screen strips again; fms_devices rows take the 'fd-' prefix that routes
    // deviceData() to netDeviceData().
    const id = dev.src === 'ups' ? dev.id : `fd-${dev.id}`;
    if (dev.label !== picked) location.hash = `#/device?id=${encodeURIComponent(id)}`;
  };
  return <div style={S.box}>
    <div style={S.h}>{t('랙 실장도')} · {rack} <span style={{ color: '#6f6f6f', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{mates.length}{t('대')}</span></div>
    <RackElevation devices={mates} picked={picked} onPick={onPick} />
  </div>;
}
