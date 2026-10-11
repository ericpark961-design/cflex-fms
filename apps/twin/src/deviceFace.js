// The front panel on the device detail screen.
//
// The screen had no picture at all: a name, a status badge and tables. The APC
// units have photo-traced SVGs already (twin/upsIcons.js, shared with 1.x so the
// same unit looks the same in both), and everything else gets a faceplate drawn
// from its own port count (twin/deviceFaces.js).
//
// Injected into a placeholder the template owns, the same way the CBU bar is —
// the template language has no way to emit raw SVG.
import { iconUrl, UPS_ICON_META } from './twin/upsIcons';
import { deviceFace } from './twin/deviceFaces';
import { catalogModel, catalogSpecLine, catalogNote } from './twin/catalog';
import { photoFor, orderViews, VIEW_LABEL } from './twin/equipmentPhoto';
import { apcImg, apcViews, apcMeta } from './twin/equipmentLibrary';
import { t } from './i18n';

// The six models that have a photo-traced SVG (shared with 1.x). Everything
// else is drawn from its catalogue entry — which is the point: a Modular Ultra
// 15 kW, a Symmetra PX and a Smart-UPS X used to be shown as an SRT 5000
// because iconIdForModel() defaulted there for anything it did not know.
const TRACED = new Set(Object.keys(UPS_ICON_META));

/**
 * @param root  the rendered screen
 * @param data  whatever deviceData()/netDeviceData() produced
 */
export function mountDeviceFace(root, data, view = 'front') {
  const host = root?.querySelector('#device-face');
  if (!host) return;
  host.replaceChildren();
  const d = data?.d;
  if (!d) return;
  try {
    host.appendChild(buildFace(data, d, view, (next) => mountDeviceFace(root, data, next)));
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

function buildFace(data, d, view = 'front', onView = null) {

  const box = document.createElement('div');
  box.style.cssText = 'background:#1f1f1f;border:1px solid #333;padding:12px;display:flex;flex-direction:column;gap:8px';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px';
  const title = document.createElement('span');
  title.style.cssText = 'font-size:11px;color:#8d8d8d;font-weight:600;letter-spacing:.04em;text-transform:uppercase';
  title.textContent = t(VIEW_LABEL[view] ? `${VIEW_LABEL[view]}부` : '전면부');
  head.appendChild(title);
  box.appendChild(head);

  const art = document.createElement('div');
  art.style.cssText = 'background:#141414;padding:10px;display:grid;place-items:center;min-height:70px';

  let caption; let note = null; let hasRear = false; let rearNote = null;
  let views = [];

  // A photograph of this exact model, cropped from the same sheets the
  // catalogue was transcribed from, beats both the traced SVGs and the
  // generated faceplate. Only when there is none do we fall through.
  const { entry: pEntry, photoId } = photoFor(d.model === '—' ? '' : d.model);
  const available = photoId ? orderViews(apcViews(photoId)) : [];
  if (photoId && available.length) {
    views = available;
    const want = available.includes(view) ? view : available[0];
    const img = document.createElement('img');
    img.alt = `${d.label} ${pEntry?.label || ''} ${VIEW_LABEL[want] || want}`.trim();
    img.src = apcImg(photoId, want);
    img.loading = 'lazy';
    img.style.cssText = 'width:100%;max-width:100%;height:auto;display:block';
    art.appendChild(img);
    const e = pEntry;
    caption = [e?.label, catalogSpecLine(e)].filter(Boolean).join(' · ');
    note = catalogNote(e);
    const mm = apcMeta(photoId)?.mm;
    if (mm) caption += `  ·  ${mm[0]} × ${mm[1]} × ${mm[2]} mm`;
    box.appendChild(art);
    return finish(box, caption, note, views, view, onView, data, d);
  }
  if (data.isNet) {
    const f = deviceFace({
      kind: d.kindLabel, label: d.label, model: d.model === '—' ? '' : d.model,
      ports_total: data.portsTotal, ports_up: data.portsUp, view,
    });
    hasRear = !!f.hasRear;
    rearNote = f.rearNote || null;
    art.innerHTML = f.svg;
    const svg = art.querySelector('svg');
    // The spec column is narrow (260px); the drawing scales to it rather than
    // overflowing, and a 48-port faceplate stays legible because it is vector.
    if (svg) svg.style.cssText = 'width:100%;height:auto;display:block';
    caption = f.caption;
  } else {
    const entry = catalogModel(d.model);
    if (entry && TRACED.has(entry.id) && view !== 'rear') {
      // A traced photo beats a drawing when one exists for this exact model.
      const meta = UPS_ICON_META[entry.id];
      const img = document.createElement('img');
      img.alt = `${d.label} ${entry.label} ${t('전면부')}`.trim();
      img.src = iconUrl(entry.id);
      img.style.cssText = `width:100%;max-width:${meta && meta.aspect < 1 ? 160 : 100}%;height:auto;display:block`;
      art.appendChild(img);
      caption = [entry.label, catalogSpecLine(entry)].filter(Boolean).join(' · ');
      note = catalogNote(entry);
      hasRear = !!entry.rear;
    } else {
      // Drawn from the catalogue: rack height, display, module bays, outlets.
      const f = deviceFace({ kind: 'ups', label: d.label, model: d.model === '—' ? '' : d.model, status: data.statusKey, view });
      hasRear = !!f.hasRear;
      rearNote = f.rearNote || null;
      art.innerHTML = f.svg;
      const svg = art.querySelector('svg');
      if (svg) svg.style.cssText = 'width:100%;height:auto;display:block';
      caption = f.caption;
      note = f.note || null;
    }
  }
  box.appendChild(art);
  return finish(box, caption, note, hasRear ? ['front', 'rear'] : [], view, onView, data, d, rearNote);
}

/**
 * The footer every variant shares: the view picker, the caption, the
 * sheet-discrepancy note, and where the unit is.
 */
function finish(box, caption, note, views, view, onView, data, d, rearNote = null) {
  const head = box.firstChild;

  // Without a picker the extra views are fetched and never seen.
  if (views.length > 1 && onView && head) {
    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;border:1px solid #393939;width:max-content';
    for (const key of views) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = VIEW_LABEL[key] || key;
      b.setAttribute('aria-pressed', String(view === key));
      b.style.cssText = `border:0;border-left:1px solid #393939;padding:4px 12px;font-size:11px;font-family:inherit;cursor:pointer;background:${view === key ? '#393939' : 'transparent'};color:#f4f4f4`;
      b.addEventListener('click', () => onView(key));
      tabs.appendChild(b);
    }
    head.appendChild(tabs);
  }
  if (rearNote && view === 'rear') {
    const rn = document.createElement('div');
    rn.style.cssText = 'font-size:10px;color:#8d8d8d';
    rn.textContent = rearNote;
    box.appendChild(rn);
  }

  const cap = document.createElement('div');
  cap.style.cssText = 'font-size:11px;color:#6f6f6f';
  cap.textContent = caption;
  box.appendChild(cap);

  // Where the sheets disagree with each other, say so rather than presenting
  // one of the two figures as settled.
  if (note) {
    const n = document.createElement('div');
    n.style.cssText = 'font-size:10px;color:#f1c21b';
    n.textContent = `※ ${note}`;
    box.appendChild(n);
  }

  // The power chain was being collected and then dropped. For a switch it is
  // most of what the detail screen can say, so it is shown here.
  const hops = Array.isArray(data.chain) ? data.chain : [];
  if (hops.length) {
    const h = document.createElement('div');
    h.style.cssText = 'font-size:11px;color:#8d8d8d;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-top:4px';
    h.textContent = `${t('전원 체인')} (${t('부하 → 공급')})`;
    box.appendChild(h);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:11px';
    hops.forEach((c, i) => {
      if (i) {
        const arrow = document.createElement('span');
        arrow.style.color = '#6f6f6f'; arrow.textContent = '→';
        row.appendChild(arrow);
      }
      const chip = document.createElement('span');
      chip.style.cssText = 'background:#262626;padding:2px 7px';
      chip.textContent = c.name;
      if (c.kind) {
        const k = document.createElement('span');
        k.style.cssText = 'color:#8d8d8d;font-size:10px;margin-left:4px';
        k.textContent = c.kind;
        chip.appendChild(k);
      }
      row.appendChild(chip);
    });
    box.appendChild(row);
    if (data.upstreamCapacityA != null) {
      const capA = document.createElement('div');
      capA.style.cssText = 'font-size:11px;color:#6f6f6f';
      capA.textContent = `${t('상류 최소 정격')} ${data.upstreamCapacityA} A`;
      box.appendChild(capA);
    }
  }

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
