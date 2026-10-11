// One place that decides what a device looks like.
//
// Three sources, in descending order of how much they actually tell you about
// the unit in front of you:
//
//   1. A photograph of that exact model, cropped from the design sheets.
//   2. The generated faceplate, drawn from the catalogue's own port count,
//      rack height and outlet counts.
//   3. Nothing — a model outside every catalogue gets the generic panel, which
//      says so rather than borrowing a near-miss picture.
//
// The 2D panel, the rack elevation and the 3D box all come through here, so a
// device cannot look like one thing in the twin and another in the inventory.
import { catalogSpecLine } from './catalog.js';
import { deviceU } from './capacity.js';
import { photoFor, orderViews, VIEW_LABEL } from './equipmentPhoto.js';
import { apcImg, apcViews, apcMeta } from './equipmentLibrary.js';
import { deviceFace } from './deviceFaces.js';
import { kindOf } from './upsModels.js';

const svgDataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/**
 * @param d     a device record { label, kind, model, status, ports_up, ports_total, … }
 * @param view  'front' | 'side' | 'rear' | 'internal' | 'top' | 'hero'
 * @returns {{source, url, svg, label, spec, views, view, tower, entry, u}}
 */
export function deviceVisual(d = {}, view = 'front') {
  const model = d.model || '';
  const { entry, photoId } = photoFor(model);
  const kind = d.kind || (entry?.kind) || kindOf(d);

  if (photoId) {
    const views = orderViews(apcViews(photoId));
    if (views.length) {
      const want = views.includes(view) ? view : views[0];
      const meta = apcMeta(photoId);
      return {
        source: 'photo',
        url: apcImg(photoId, want),
        svg: null,
        label: entry?.label || meta?.title || d.label,
        spec: catalogSpecLine(entry),
        mm: meta?.mm || null,
        views, view: want,
        tower: entry?.form === 'tower' || entry?.form === 'cabinet',
        entry, u: entry?.u ?? null,
      };
    }
  }

  // No photograph: draw it from the record.
  const f = deviceFace({
    kind, label: d.label, model,
    ports_total: d.ports_total ?? entry?.ports,
    ports_up: d.ports_up,
    status: d.status,
    view: view === 'rear' ? 'rear' : 'front',
  });
  return {
    source: entry ? 'faceplate' : 'generic',
    url: svgDataUrl(f.svg),
    svg: f.svg,
    label: entry?.label || d.label,
    spec: f.caption,
    mm: null,
    views: f.hasRear ? ['front', 'rear'] : ['front'],
    view: f.view || 'front',
    tower: entry?.form === 'tower' || entry?.form === 'cabinet',
    entry: entry || null,
    u: entry?.u ?? null,
  };
}

/** Cache key for a texture built from this visual. */
export const visualKey = (d, view = 'front') =>
  [d.model || d.label, view, d.status, d.ports_up, d.load_pct, d.battery_pct].join('|');

/** Rack height for a device, used by the elevation and the 3D stack. */
export const visualU = deviceU;

export { VIEW_LABEL };
