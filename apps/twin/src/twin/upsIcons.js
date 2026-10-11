// APC UPS photo-traced icons shared with FMS 1.x (frontend/public/assets/ups/*.svg, copied to apps/twin/public/assets/ups/).
// Same mapping as Fms.jsx iconIdForModel so 1.x and 2.0 show the same picture for the same device.
import * as THREE from 'three';
export const UPS_ICON_META = {
  srt3000: { aspect: 480 / 116, label: 'Smart-UPS SRT 3000', u: 2 },
  srt5000: { aspect: 480 / 248, label: 'Smart-UPS SRT 5000', u: 5 },
  srt8000: { aspect: 480 / 244, label: 'Smart-UPS SRT 8000', u: 5 },
  modular20k: { aspect: 480 / 330, label: 'Smart-UPS Modular Ultra 20kW', u: 7 },
  modular15k: { aspect: 480 / 330, label: 'Smart-UPS Modular Ultra 15kW', u: 7 },
  symmetra_lx: { aspect: 300 / 440, label: 'Symmetra LX 16000', u: null },
};
export const SCREEN = { ok: '#cdd6d2', warn: '#f3d79a', critical: '#f3b3b3', nodata: '#3a3f47', unreachable: '#3a3f47', unknown: '#3a3f47' };
export function iconIdForModel(model) {
  const m = String(model || '');
  if (m.includes('SRT 3000') || /SRT3000/i.test(m)) return 'srt3000';
  if (m.includes('SRT 5000') || /SRT5K|SRT5000/i.test(m)) return 'srt5000';
  if (m.includes('SRT 8000') || /SRT8K|SRT8000/i.test(m)) return 'srt8000';
  if (/Modular Ultra 20/i.test(m) || /SRYLF20K/i.test(m)) return 'modular20k';
  if (/Modular Ultra 15/i.test(m) || /SRYLF15K/i.test(m)) return 'modular15k';
  if (/Symmetra/i.test(m)) return 'symmetra_lx';
  return 'srt5000';
}
// SVGs are bundled (no network) so the twin works offline and in the standalone demo file.
const RAW = import.meta.glob('../../public/assets/ups/*.svg', { query: '?raw', import: 'default', eager: true });
const rawOf = (id) => RAW[`../../public/assets/ups/${id}.svg`];
export const iconUrl = (id) => rawOf(id) ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rawOf(id))}` : `${import.meta.env.BASE_URL}assets/ups/${id}.svg`;

// SVG text cache + per-(model,status) texture cache. The #lcd-screen fill is tinted by status before rasterising.
const svgText = new Map(); const texCache = new Map();
async function fetchSvg(id) { if (!svgText.has(id)) svgText.set(id, rawOf(id) ? Promise.resolve(rawOf(id)) : fetch(`${import.meta.env.BASE_URL}assets/ups/${id}.svg`).then(r => r.text())); return svgText.get(id); }
export async function upsTexture(model, status = 'unknown') {
  const id = iconIdForModel(model); const key = `${id}|${status}`;
  if (texCache.has(key)) return texCache.get(key);
  const p = (async () => {
    let raw = await fetchSvg(id);
    raw = raw.replace(/(<[^>]*id="lcd-screen"[^>]*?)fill="[^"]*"/, `$1fill="${SCREEN[status] || SCREEN.unknown}"`);
    const url = URL.createObjectURL(new Blob([raw], { type: 'image/svg+xml' }));
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const meta = UPS_ICON_META[id]; const W = 1024, H = Math.round(W / meta.aspect);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d'); c.drawImage(img, 0, 0, W, H);
    URL.revokeObjectURL(url);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  })();
  texCache.set(key, p); return p;
}

/**
 * Rasterise an SVG string to a texture, so a generated faceplate can be applied
 * to a 3D unit the same way a photograph is. Width drives the resolution; the
 * height follows the viewBox so nothing is stretched.
 */
export async function rasterSvg(svg, W = 1024) {
  const vb = svg.match(/viewBox=['"]([\d.\s-]+)['"]/);
  const [, , vw, vh] = vb ? vb[1].trim().split(/\s+/).map(Number) : [0, 0, 1000, 92];
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const H = Math.max(8, Math.round(W * vh / vw));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    cv.getContext('2d').drawImage(img, 0, 0, W, H);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  } finally { URL.revokeObjectURL(url); }
}

/** Load an image URL (a photograph) as a texture. */
export async function rasterUrl(src) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth || 1024; cv.height = img.naturalHeight || 256;
  cv.getContext('2d').drawImage(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
