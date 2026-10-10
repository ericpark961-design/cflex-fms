// Shared 3D vocabulary for the twin: palette, labels, and one builder per object
// kind. Twin3D (ledger-driven) and DemoScene (hand-placed KMX demo) both draw the
// same equipment, so the geometry lives here rather than in either of them.
//
// Sizes are in metres. A ledger object's footprint is given in tiles; callers
// multiply by the room's tile size before calling.
import * as THREE from 'three';

export const TWIN = {
  ok: '#1c4f8a', hot: '#08bdba', warn: '#f1c21b', crit: '#fa4d56',
  nodata: '#6f6f6f', empty: '#2b2b2b',
  crac: '#42be65', ups: '#4589ff', pdu: '#8d8d8d', panel: '#a8a8a8',
  sensor: '#78a9ff', leak: '#4589ff', chain: '#ff832b',
  floor: '#141a24', grid: '#2a3140', gridSub: '#1c2230', wall: '#3a4356',
  ink: '#f4f4f4',
};

// Status → rack colour, matching the dark scene's vocabulary.
export const statusColor = (s) => ({ ok: TWIN.ok, warn: TWIN.warn, critical: TWIN.crit }[s] || TWIN.nodata);

export function labelSprite(text, px = 28, color = TWIN.ink, dark = true) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const font = `600 ${px}px "IBM Plex Sans KR","IBM Plex Sans",Arial,sans-serif`;
  ctx.font = font;
  cv.width = Math.ceil(ctx.measureText(text).width) + 24;
  cv.height = px + 18;
  ctx.font = font;
  ctx.fillStyle = dark ? 'rgba(11,11,11,0.78)' : 'rgba(255,255,255,0.92)';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = dark ? '#393939' : '#e0e0e0';
  ctx.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(cv.width / 170, cv.height / 170, 1);
  return sp;
}

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.55, metalness: 0.25, ...o });

// Height in metres for each kind. Racks and UPS are full-height cabinets; panels
// hang on a wall; sensors sit on a post.
const HEIGHT = { rack: 2.0, ups_cabinet: 1.9, pdu_cabinet: 1.8, crac: 2.0, panel: 0.9, door: 2.1, pillar: 3.0 };

/**
 * Build one placeable object.
 * @param kind   ledger kind
 * @param opts   {w,d}  footprint in METRES
 *               color  override (status colour for racks)
 *               face   N|S|E|W — which side the front panel faces
 *               label  optional text sprite above the object
 */
export function buildObject(kind, opts = {}) {
  const w = opts.w ?? 0.6;
  const d = opts.d ?? 1.2;
  const h = opts.h ?? HEIGHT[kind] ?? 1.0;
  const faceSign = opts.face === 'N' ? -1 : 1;

  if (kind === 'sensor') {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.5, 8), std('#8d8d8d'));
    post.position.y = 0.75;
    g.add(post);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), std(TWIN.sensor, { emissive: new THREE.Color('#1c3f80') }));
    ball.position.y = 1.55;
    g.add(ball);
    g.userData.pickable = ball;
    return g;
  }

  if (kind === 'leak_zone') {
    // A floor polygon, not a box. `opts.poly` is in metres, relative to the room origin.
    const pts = (opts.poly || [[0, 0], [w, 0], [w, d], [0, d]]).map(([x, z]) => new THREE.Vector2(x, z));
    const shape = new THREE.Shape(pts);
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: new THREE.Color(opts.alarm ? TWIN.crit : TWIN.leak),
      transparent: true, opacity: opts.alarm ? 0.45 : 0.16, depthWrite: false,
    }));
    mesh.position.y = 0.012;
    return mesh;
  }

  if (kind === 'crac') {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(opts.color || TWIN.crac, { roughness: 0.5, metalness: 0.3 }));
    body.position.y = h / 2; body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    const grill = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.8, h * 0.4), new THREE.MeshBasicMaterial({ color: 0x0b0b0b }));
    grill.position.set(0, h * 0.3, faceSign * (d / 2 + 0.001));
    if (faceSign < 0) grill.rotation.y = Math.PI;
    g.add(grill);
    // fan disc on top — the demo scene's visual cue for a running unit
    const fan = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w, d) * 0.3, 24), new THREE.MeshBasicMaterial({ color: 0x1c2230 }));
    fan.rotation.x = -Math.PI / 2; fan.position.y = h + 0.002;
    g.add(fan);
    g.userData.pickable = body;
    g.userData.fan = fan;
    return g;
  }

  if (kind === 'panel') {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, Math.min(d, 0.25)), std(opts.color || TWIN.panel, { metalness: 0.4 }));
    body.position.y = 1.3; body.castShadow = true;
    g.add(body);
    g.userData.pickable = body;
    return g;
  }

  // rack | ups_cabinet | pdu_cabinet | door | pillar — a cabinet with a front LED
  const color = opts.color || (kind === 'ups_cabinet' ? TWIN.ups : kind === 'pdu_cabinet' ? TWIN.pdu : TWIN.ok);
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(color, { metalness: kind === 'rack' ? 0.25 : 0.3 }));
  body.position.y = h / 2; body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  if (kind !== 'pillar' && kind !== 'door') {
    const led = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, 0.03, 0.02),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(opts.ledColor || (opts.alarm ? '#ff8389' : '#7ad7ff')) }));
    led.position.set(0, h * 0.42, faceSign * (d / 2 + 0.011));
    g.add(led);
  }
  g.userData.pickable = body;
  return g;
}

/** Dispose everything a group owns — the scene is rebuilt on every poll. */
export function disposeTree(root) {
  root.traverse(o => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach(m => { m.map?.dispose?.(); m.dispose?.(); });
  });
  root.clear();
}

/**
 * Inverse-distance-weighted heat texture for one room.
 * cells: [{col,row,v}] in tile coordinates; range maps v → 0..1.
 * Returns a CanvasTexture to lay on the floor, or null when there is nothing to draw.
 */
export function heatTexture(cells, cols, rows, [lo, hi], stops) {
  if (!cells?.length) return null;
  const SCALE = 8;                       // texels per tile — smooth enough, cheap to build
  const cv = document.createElement('canvas');
  cv.width = Math.max(8, cols * SCALE);
  cv.height = Math.max(8, rows * SCALE);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cv.width, cv.height);

  const ramp = (t) => {
    const n = stops.length - 1;
    const i = Math.min(n - 1, Math.max(0, Math.floor(t * n)));
    const f = Math.min(1, Math.max(0, t * n - i));
    const a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };

  for (let py = 0; py < cv.height; py++) {
    for (let px = 0; px < cv.width; px++) {
      const x = px / SCALE, y = py / SCALE;
      let num = 0, den = 0, near = Infinity;
      for (const c of cells) {
        const dx = x - (c.col + 0.5), dy = y - (c.row + 1);     // racks are 2 tiles deep
        const d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) { num = c.v; den = 1; near = 0; break; }
        const wgt = 1 / (d2 * d2);                              // IDW, power 4 — keeps hotspots local
        num += c.v * wgt; den += wgt;
        if (d2 < near) near = d2;
      }
      const v = den ? num / den : lo;
      const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
      const [r, g, b] = ramp(t);
      // fade out far from any reading rather than painting the whole floor
      const alpha = Math.max(0, Math.min(190, 190 - Math.sqrt(near) * 26));
      const o = (py * cv.width + px) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

export const HEAT_SCALES = {
  load: { range: [0, 100], stops: [[33, 102, 172], [255, 255, 191], [215, 48, 39]] },   // blue → yellow → red
  temp: { range: [18, 35], stops: [[33, 102, 172], [215, 48, 39]] },                    // blue → red
};
