// Procedural 3D models of UPS equipment for the digital twin (no external assets).
// Family is inferred from the model string: rack-mount (SRT/SMX/…RM), large tower cabinet (Symmetra/Galaxy),
// small tower (SMT/SMC/BR/Back-UPS). The front has an LCD (CanvasTexture) showing label, battery and load,
// a status LED strip, and vent slots. Status 'nodata'/'unreachable' renders dim with "NO LINK".
import * as THREE from 'three';
import { catalogModel } from './catalog.js';
import { rasterUrl } from './upsIcons';
import { iconIdForModel, UPS_ICON_META, upsTexture } from './upsIcons';

export const U = 0.04445;            // 1U in metres
const STATUS_HEX = { ok: 0x2f7bff, warn: 0xf1c21b, critical: 0xfa4d56, nodata: 0x5a5f6a, unreachable: 0x5a5f6a, unknown: 0x5a5f6a };
const STATUS_CSS = { ok: '#4c8dff', warn: '#f1c21b', critical: '#fa4d56', nodata: '#8d8d8d', unreachable: '#8d8d8d', unknown: '#8d8d8d' };
const live = (s) => s === 'ok' || s === 'warn' || s === 'critical';

export function family(model = '') {
  const m = String(model);
  if (/symmetra|galaxy|\bSY\d|\bPX\b/i.test(m)) return 'cabinet';
  if (/SRT|SMX|RM\b|RM\d|rack|\bSRC|\bSUA\d+RM|XL\s*RM/i.test(m)) return 'rack';
  if (/SMT|SMC|SUA|\bBR\d|\bBX\d|BE\d|back-?ups|tower/i.test(m)) return 'tower';
  return 'rack';
}
export function unitsU(model = '') {
  const va = +(String(model).match(/(\d{3,5})\s*VA?/i)?.[1] || String(model).match(/\b(\d{3,5})\b/)?.[1] || 0);
  if (va >= 8000) return 6; if (va >= 5000) return 3; if (va >= 2200) return 2; return 2;
}

// shared materials
const MAT = {
  body: new THREE.MeshStandardMaterial({ color: 0x4a4f5a, roughness: 0.5, metalness: 0.3 }),
  bodyDim: new THREE.MeshStandardMaterial({ color: 0x33363d, roughness: 0.8, metalness: 0.2 }),
  bezel: new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.7, metalness: 0.2 }),
  rail: new THREE.MeshStandardMaterial({ color: 0x3a3f49, roughness: 0.5, metalness: 0.6 }),
  post: new THREE.MeshStandardMaterial({ color: 0x2c3139, roughness: 0.5, metalness: 0.5 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x3d6fd6, transparent: true, opacity: 0.06, depthWrite: false, roughness: 0.2 }),
};

const texCache = new Map();
function lcdTexture(d) {
  const key = `${d.label}|${d.status}|${d.battery_pct}|${d.load_pct}|${d.runtime_min}`;
  if (texCache.has(key)) return texCache.get(key);
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 96; const c = cv.getContext('2d');
  const on = live(d.status);
  c.fillStyle = on ? '#0b1a2e' : '#15171a'; c.fillRect(0, 0, 256, 96);
  c.strokeStyle = on ? '#1f3f6e' : '#2a2d33'; c.lineWidth = 3; c.strokeRect(2, 2, 252, 92);
  c.font = '600 18px "IBM Plex Sans", Arial, sans-serif'; c.fillStyle = on ? '#9ec5ff' : '#6f6f6f'; c.fillText(String(d.label || '').slice(0, 20), 12, 26);
  if (on) {
    c.font = '700 40px "IBM Plex Sans", Arial, sans-serif'; c.fillStyle = STATUS_CSS[d.status]; c.fillText(`${d.battery_pct ?? '--'}%`, 12, 72);
    c.font = '500 14px "IBM Plex Sans", Arial, sans-serif'; c.fillStyle = '#c6c6c6'; c.fillText('BATT', 112, 48); c.fillText(`LOAD ${d.load_pct ?? '--'}%`, 112, 70);
    c.fillStyle = '#1f3f6e'; c.fillRect(112, 76, 130, 8); c.fillStyle = (d.load_pct || 0) > 80 ? '#fa4d56' : '#4c8dff'; c.fillRect(112, 76, 130 * Math.min(1, (d.load_pct || 0) / 100), 8);
  } else {
    c.font = '700 26px "IBM Plex Sans", Arial, sans-serif'; c.fillStyle = '#6f6f6f'; c.fillText('NO LINK', 12, 64);
    c.font = '500 13px "IBM Plex Sans", Arial, sans-serif'; c.fillStyle = '#525252'; c.fillText(d.status === 'unreachable' ? 'SNMP timeout' : 'polling pending', 128, 64);
  }
  const t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter; t.colorSpace = THREE.SRGBColorSpace; texCache.set(key, t); return t;
}

// front face assembly (bezel + lcd + led + vents), built in local space facing +z, centred at origin, size w×h
function frontFace(d, w, h) {
  const g = new THREE.Group();
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.012), MAT.bezel); g.add(bezel);
  const on = live(d.status);
  const lcdW = Math.min(w * 0.5, 0.2), lcdH = Math.min(h * 0.7, 0.075);
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(lcdW, lcdH), new THREE.MeshBasicMaterial({ map: lcdTexture(d), toneMapped: false })); lcd.position.set(-w / 2 + 0.02 + lcdW / 2, 0, 0.0065); g.add(lcd);
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.012, h * 0.6, 0.006), new THREE.MeshBasicMaterial({ color: STATUS_HEX[d.status] || STATUS_HEX.unknown })); led.position.set(-w / 2 + 0.012, 0, 0.007); g.add(led);
  if (!on) led.material.color.multiplyScalar(0.6);
  // vent slots on the right half
  const ventMat = new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 1 });
  const slots = Math.max(3, Math.floor(h / 0.012)); const vx = w / 2 - 0.03 - (w * 0.32) / 2;
  for (let i = 0; i < slots; i++) { const v = new THREE.Mesh(new THREE.BoxGeometry(w * 0.32, 0.004, 0.004), ventMat); v.position.set(vx, -h / 2 + 0.008 + i * ((h - 0.016) / Math.max(1, slots - 1)), 0.0065); g.add(v); }
  g.userData.led = led; g.userData.lcd = lcd;
  return g;
}

// one UPS unit. Returns Group with .userData.size {w,h,d}; origin at bottom-centre, front at +z.
// The front face is the photo-traced APC icon shared with FMS 1.x (LCD tinted by status); body depth is procedural.
export function makeUps(d) {
  const fam = family(d.model); const on = live(d.status);
  const body = on ? MAT.body : MAT.bodyDim;
  const id = iconIdForModel(d.model); const meta = UPS_ICON_META[id];
  let w, h, dep;
  if (fam === 'rack') { w = 0.44; h = Math.max(2 * U, w / meta.aspect); dep = 0.62; }          // height follows the photo (SRT 5000 = UPS + battery pack ≈ 5U)
  else if (fam === 'cabinet') { w = 0.48; h = w / Math.min(meta.aspect, 1); dep = 0.8; }       // tower cabinet
  else { w = 0.17; h = 0.23; dep = 0.44; }
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, dep), body); box.position.set(0, h / 2, 0); box.castShadow = true; box.receiveShadow = true; g.add(box);
  // front: photo plane (placeholder until the SVG texture resolves)
  const faceMat = new THREE.MeshBasicMaterial({ color: 0x1d2026, toneMapped: false });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), faceMat); face.position.set(0, h / 2, dep / 2 + 0.003); g.add(face);
  upsTexture(d.model, d.status).then(t => { faceMat.map = t; faceMat.color.set(on ? 0xffffff : 0x8a8f99); faceMat.needsUpdate = true; }).catch(() => {});
  // status LED strip on the left edge (photo has its own LCD)
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.008, Math.min(h * 0.5, 0.12), 0.006), new THREE.MeshBasicMaterial({ color: STATUS_HEX[d.status] || STATUS_HEX.unknown })); led.position.set(-w / 2 + 0.014, h / 2, dep / 2 + 0.006); g.add(led);
  if (!on) led.material.color.multiplyScalar(0.6);
  // "NO LINK" tag for devices without fresh data
  if (!on) { const tag = tagSprite('NO LINK'); tag.position.set(0, h + 0.06, dep / 2); g.add(tag); }
  if (fam === 'rack') for (const sx of [-1, 1]) { const ear = new THREE.Mesh(new THREE.BoxGeometry(0.02, h, 0.004), MAT.rail); ear.position.set(sx * (w / 2 + 0.01), h / 2, dep / 2 + 0.002); g.add(ear); }
  g.userData = { size: { w, h, d: dep }, family: fam, led, iconId: id };
  return g;
}
function tagSprite(text) {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32; const c = cv.getContext('2d');
  c.fillStyle = 'rgba(20,22,26,0.85)'; c.fillRect(0, 0, 128, 32); c.strokeStyle = '#525252'; c.strokeRect(0.5, 0.5, 127, 31);
  c.font = '700 16px "IBM Plex Sans", Arial, sans-serif'; c.fillStyle = '#8d8d8d'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 64, 16);
  const t = new THREE.CanvasTexture(cv); const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true })); sp.scale.set(0.24, 0.06, 1); return sp;
}

// open 42U rack frame; origin bottom-centre, front at +z. w/d in metres.
export function makeRackFrame({ w = 0.6, d = 1.0, h = 2.0, label } = {}) {
  const g = new THREE.Group();
  const px = w / 2 - 0.03, pz = d / 2 - 0.03;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.05), MAT.post); p.position.set(sx * px, h / 2, sz * pz); p.castShadow = true; g.add(p); }
  for (const y of [0.02, h - 0.02]) for (const sz of [-1, 1]) { const r = new THREE.Mesh(new THREE.BoxGeometry(w - 0.06, 0.04, 0.05), MAT.rail); r.position.set(0, y, sz * pz); g.add(r); }
  for (const y of [0.02, h - 0.02]) for (const sx of [-1, 1]) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, d - 0.06), MAT.rail); r.position.set(sx * px, y, 0); g.add(r); }
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), MAT.post); base.position.set(0, 0.03, 0); base.receiveShadow = true; g.add(base);
  // blanking panels every 6U on the front give the rack visual density without hiding units
  g.userData = { size: { w, h, d } };
  return g;
}

// A rack slot populated with devices: frame + units (rack-mount stacked by U; towers/cabinets on the floor).
// devs: [{id,label,model,status,battery_pct,load_pct,u_pos?,u_height?}]; returns Group (origin bottom-centre, front +z)
export function makeRackSlot(devs, { w = 0.6, d = 1.0, h = 2.0, frame = true } = {}) {
  const g = new THREE.Group();
  const isRack = (x) => kindOf(x) !== 'ups' || family(x.model) === 'rack';
  const racked = devs.filter(isRack); const floorUnits = devs.filter(x => !isRack(x));
  if (frame && (racked.length || !floorUnits.length)) g.add(makeRackFrame({ w, d, h }));
  // UPS at the bottom, servers above, network gear at the top (typical rack elevation) unless u_pos is given
  const order = { ups: 0, pdu: 1, server: 2, sbc: 3, router: 4, switch: 5, patch: 6 };
  let u = 2;
  [...racked].sort((a, b) => (order[kindOf(a)] ?? 9) - (order[kindOf(b)] ?? 9)).forEach((dev) => {
    const m = makeUnit(dev); const uh = unitU(dev);
    const upos = dev.u_pos != null ? dev.u_pos : (racked.length === 1 ? 18 : u);
    m.position.set(0, 0.06 + upos * U, d / 2 - m.userData.size.d / 2 - 0.05); g.add(m); u = upos + uh + 1;
  });
  floorUnits.forEach((dev, i) => {
    const m = makeUps(dev); const n = floorUnits.length; const sz = m.userData.size;
    m.position.set((i - (n - 1) / 2) * (sz.w + 0.08), 0.0, d / 2 - sz.d / 2 - 0.02); g.add(m);
  });
  g.userData = { size: { w, h, d } };
  return g;
}

// ───────────────────────── network / UC / server equipment ─────────────────────────
// dev.kind: 'ups' (default) | 'switch' | 'router' | 'sbc' | 'server' | 'pdu' | 'patch'
const KIND_U = { switch: 1, router: 1, sbc: 1, server: 2, pdu: 1, patch: 1 };
export function kindOf(d) { return d.kind || (d.model && /catalyst|nexus|switch|SG\d|C9[0-9]{3}|EX\d|QFX/i.test(d.model) ? 'switch' : /ISR|ASR|router|SBC|CUBE|session border/i.test(d.model || '') ? 'router' : /UCS|server|PowerEdge|ProLiant/i.test(d.model || '') ? 'server' : 'ups'); }

function portPanelTexture(d, ports = 48, cols = 24) {
  const key = `ports|${d.label}|${d.status}|${ports}|${d.ports_up ?? ''}`; if (texCache.has(key)) return texCache.get(key);
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 64; const c = cv.getContext('2d');
  c.fillStyle = '#1b1d22'; c.fillRect(0, 0, 512, 64);
  const on = live(d.status); const up = d.ports_up ?? Math.round(ports * 0.6);
  const rows = Math.ceil(ports / cols); const pw = 440 / cols, ph = 40 / rows;
  for (let i = 0; i < ports; i++) {
    const r = Math.floor(i / cols), col = i % cols; const x = 60 + col * pw, y = 12 + r * ph;
    c.fillStyle = '#0a0b0d'; c.fillRect(x + 1, y + 1, pw - 3, ph - 3);
    c.fillStyle = !on ? '#3a3d44' : i < up ? (i % 7 === 3 ? '#f1c21b' : '#42be65') : '#2a2d33'; c.fillRect(x + 3, y + ph - 7, pw - 7, 3);
  }
  c.font = '600 14px "IBM Plex Sans", Arial, sans-serif'; c.fillStyle = on ? '#c6c6c6' : '#6f6f6f'; c.fillText(String(d.label || '').slice(0, 7), 4, 38);
  const t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter; t.colorSpace = THREE.SRGBColorSpace; texCache.set(key, t); return t;
}
function serverFaceTexture(d, bays = 8) {
  const key = `srv|${d.label}|${d.status}`; if (texCache.has(key)) return texCache.get(key);
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96; const c = cv.getContext('2d');
  c.fillStyle = '#23262c'; c.fillRect(0, 0, 512, 96);
  const on = live(d.status); const bw = 380 / bays;
  for (let i = 0; i < bays; i++) { const x = 70 + i * bw; c.fillStyle = '#121418'; c.fillRect(x + 2, 10, bw - 4, 76); c.fillStyle = on ? (i % 5 === 4 ? '#f1c21b' : '#42be65') : '#3a3d44'; c.fillRect(x + 6, 74, 10, 4); c.fillStyle = '#2f333b'; c.fillRect(x + 6, 16, bw - 12, 50); }
  c.fillStyle = on ? '#4c8dff' : '#3a3d44'; c.beginPath(); c.arc(30, 30, 7, 0, 7); c.fill();
  c.font = '600 16px "IBM Plex Sans", Arial, sans-serif'; c.fillStyle = on ? '#e0e0e0' : '#6f6f6f'; c.fillText(String(d.label || '').slice(0, 8), 8, 72);
  c.fillStyle = '#0a0b0d'; for (let i = 0; i < 6; i++) c.fillRect(462, 12 + i * 13, 40, 5);
  const t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter; t.colorSpace = THREE.SRGBColorSpace; texCache.set(key, t); return t;
}

// ── real-equipment front faces ───────────────────────────────────────
// A unit's 3D front is the photograph of that model when one exists. The
// photo has to decode before it can become a texture, so the face is built
// with the procedural panel and swapped in place once it is ready — the rack
// never renders empty waiting for an image.
const photoTexCache = new Map();

function applyPhotoFace(faceMesh, dev) {
  let visual;
  try {
    visual = deviceVisualOf(dev);
  } catch { return; }
  if (!visual || visual.source !== 'photo' || !visual.url) return;
  const key = visual.url;
  const got = photoTexCache.get(key)
    || photoTexCache.set(key, rasterUrl(visual.url).catch(() => null)).get(key);
  got.then((tex) => {
    if (!tex || !faceMesh.material) return;
    faceMesh.material.map = tex;
    faceMesh.material.needsUpdate = true;
  });
}

// Resolved lazily: deviceVisual imports from here (kindOf), so a static import
// would be a cycle.
let _deviceVisual = null;
function deviceVisualOf(dev) {
  if (!_deviceVisual) return null;
  return _deviceVisual(dev, 'front');
}
/** Wired once at startup by the scene, to break the import cycle. */
export function setDeviceVisual(fn) { _deviceVisual = fn; }

export function makeNetUnit(d) {
  const kind = kindOf(d); const on = live(d.status);
  const uh = d.u_height || KIND_U[kind] || 1; const w = 0.44, h = uh * U, dep = kind === 'server' ? 0.7 : kind === 'patch' ? 0.12 : 0.42;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, dep), on ? MAT.body : MAT.bodyDim); body.position.set(0, h / 2, 0); body.castShadow = true; g.add(body);
  let map;
  if (kind === 'switch') map = portPanelTexture(d, 48, 24);
  else if (kind === 'router' || kind === 'sbc') map = portPanelTexture(d, 8, 8);
  else if (kind === 'patch') map = portPanelTexture(d, 24, 24);
  else if (kind === 'server') map = serverFaceTexture(d);
  else map = portPanelTexture(d, 16, 16);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.01, h - 0.004), new THREE.MeshBasicMaterial({ map, toneMapped: false })); face.position.set(0, h / 2, dep / 2 + 0.002);
  applyPhotoFace(face, d); g.add(face);
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.008, h * 0.5, 0.004), new THREE.MeshBasicMaterial({ color: STATUS_HEX[d.status] || STATUS_HEX.unknown })); led.position.set(-w / 2 + 0.012, h / 2, dep / 2 + 0.004); g.add(led);
  for (const sx of [-1, 1]) { const ear = new THREE.Mesh(new THREE.BoxGeometry(0.02, h, 0.004), MAT.rail); ear.position.set(sx * (w / 2 + 0.01), h / 2, dep / 2 + 0.002); g.add(ear); }
  g.userData = { size: { w, h, d: dep }, family: 'rack', kind, led };
  return g;
}

// generic dispatcher used by makeRackSlot
export function makeUnit(d) { return kindOf(d) === 'ups' ? makeUps(d) : makeNetUnit(d); }
/**
 * How many U a unit occupies in the 3D rack.
 *
 * Order of truth: the record's own u_height, then the equipment catalogue, then
 * a per-kind default. The catalogue step is what stops a 7U Nexus 9500 chassis
 * and a 1U Catalyst 9300 from being drawn the same height — KIND_U only knows
 * "switch", which is not enough to draw a rack that matches the room.
 */
export function unitU(d) {
  if (d.u_height) return d.u_height;
  const cat = catalogModel(d.model);
  if (cat?.u) return cat.u;
  if (kindOf(d) !== 'ups') return KIND_U[kindOf(d)] || 1;
  const m = UPS_ICON_META[iconIdForModel(d.model)];
  return m.u || Math.ceil((0.44 / m.aspect) / U);
}
