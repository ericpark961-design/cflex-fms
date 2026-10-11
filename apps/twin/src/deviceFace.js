// The front panel on the device detail screen.
//
// The screen had no picture at all: a name, a status badge and tables. The APC
// units have photo-traced SVGs already (twin/upsIcons.js, shared with 1.x so the
// same unit looks the same in both), and everything else gets a faceplate drawn
// from its own port count (twin/deviceFaces.js).
//
// Injected into a placeholder the template owns, the same way the CBU bar is —
// the template language has no way to emit raw SVG.
import { iconIdForModel, iconUrl, UPS_ICON_META } from './twin/upsIcons';
import { deviceFace } from './twin/deviceFaces';
import { t } from './i18n';

/**
 * @param root  the rendered screen
 * @param data  whatever deviceData()/netDeviceData() produced
 */
export function mountDeviceFace(root, data) {
  const host = root?.querySelector('#device-face');
  if (!host) return;
  host.replaceChildren();
  const d = data?.d;
  if (!d) return;
  try {
    host.appendChild(buildFace(data, d));
  } catch (e) {
    // A faceplate is decoration. It must never be able to take the screen with
    // it: this used to throw out of useLayoutEffect, React unmounted the tree,
    // and the operator got a black page with the device's data nowhere.
    console.error('[device-face]', e);
    const warn = document.createElement('div');
    warn.style.cssText = 'background:#3d2a0a;border-left:3px solid #f1c21b;padding:8px 12px;font-size:12px;color:#f1c21b';
    warn.textContent = `${t('전면부 도식을 그릴 수 없습니다')} — ${e && e.message ? e.message : e}`;
    host.appendChild(warn);
  }
}

function buildFace(data, d) {

  const box = document.createElement('div');
  box.style.cssText = 'background:#1f1f1f;border:1px solid #333;padding:12px;display:flex;flex-direction:column;gap:8px';

  const head = document.createElement('div');
  head.style.cssText = 'font-size:11px;color:#8d8d8d;font-weight:600;letter-spacing:.04em;text-transform:uppercase';
  head.textContent = t('전면부');
  box.appendChild(head);

  const art = document.createElement('div');
  art.style.cssText = 'background:#141414;padding:10px;display:grid;place-items:center;min-height:70px';

  let caption;
  if (data.isNet) {
    const f = deviceFace({
      kind: d.kindLabel, label: d.label, model: d.model === '—' ? '' : d.model,
      ports_total: data.portsTotal, ports_up: data.portsUp,
    });
    art.innerHTML = f.svg;
    const svg = art.querySelector('svg');
    // The spec column is narrow (260px); the drawing scales to it rather than
    // overflowing, and a 48-port faceplate stays legible because it is vector.
    if (svg) svg.style.cssText = 'width:100%;height:auto;display:block';
    caption = f.caption;
  } else {
    // APC: the traced SVG, with the LCD tinted by the device's own status so the
    // picture agrees with the badge next to it.
    const id = iconIdForModel(d.model);
    const meta = UPS_ICON_META[id];
    const img = document.createElement('img');
    img.alt = `${d.label} ${d.model || ''} ${t('전면부')}`.trim();
    img.src = iconUrl(id);
    img.style.cssText = `width:100%;max-width:${meta && meta.aspect < 1 ? 160 : 100}%;height:auto;display:block`;
    art.appendChild(img);
    caption = `${meta?.label || id}${meta?.u ? ` · ${meta.u}U` : ''}`;
  }
  box.appendChild(art);

  const cap = document.createElement('div');
  cap.style.cssText = 'font-size:11px;color:#6f6f6f';
  cap.textContent = caption;
  box.appendChild(cap);

  // Where it is, which is the other half of recognising it in a rack.
  const place = [d.location, d.room, d.rack, d.u].filter(v => v && v !== '—').join(' · ');
  if (place) {
    const p = document.createElement('div');
    p.style.cssText = 'font-size:12px;color:#c6c6c6';
    p.textContent = place;
    box.appendChild(p);
  }
  return box;
}
