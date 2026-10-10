// Ledger-driven 3D scene: renders rooms/objects/devices/power_links from the topology JSON (v3 §8).
// Same engine for the KMX CCR sample and for surveyed real rooms. No external assets.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeRackSlot, makeUps, makeUnit } from './upsModels';

const COL = { ok: 0x1c4f8a, hot: 0x08bdba, warn: 0xf1c21b, critical: 0xfa4d56, empty: 0x2b2b2b, nodata: 0x6f6f6f, crac: 0x42be65, ups: 0x4589ff, chain: 0xff832b };
const CSS = { ok: '#4c8dff', hot: '#08bdba', warn: '#f1c21b', critical: '#fa4d56', empty: '#8d8d8d', nodata: '#8d8d8d' };
const KIND_KO = { rack: '랙', ups_cabinet: 'UPS', pdu_cabinet: '분배 PDU', panel: '분전반', crac: 'CRAC', sensor: '온습도 센서', smoke: '연기감지기', leak_zone: '누수 존', fm200: 'FM-200 소화', door: '출입문', pillar: '기둥' };
const LERP = (a, b, t) => a + (b - a) * t;

function labelSprite(text, px = 26, color = '#f4f4f4') {
  const cv = document.createElement('canvas'); const ctx = cv.getContext('2d');
  const font = `600 ${px}px "IBM Plex Sans KR","IBM Plex Sans",Arial,sans-serif`; ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 22; cv.width = w; cv.height = px + 14;
  ctx.font = font; ctx.fillStyle = 'rgba(11,11,11,0.78)'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.strokeStyle = '#393939'; ctx.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, 11, cv.height / 2);
  const t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true, sizeAttenuation: false })); sp.scale.set(cv.width / 2600, cv.height / 2600, 1); sp.renderOrder = 10; return sp;
}

export function buildLedgerScene(el, data, opts = {}) {
  const T = (data.rooms[0]?.tile_mm || 600) / 1000;
  const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' }); el.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x070a10); scene.fog = new THREE.Fog(0x070a10, 40, 90);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 2; controls.maxDistance = 90;
  scene.add(new THREE.HemisphereLight(0xa9c4ff, 0x1a2030, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(14, 20, 10); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 80 }); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.7); fill.position.set(-10, 10, 30); scene.add(fill);
  const world = new THREE.Group(); scene.add(world);
  const tip = document.createElement('div'); Object.assign(tip.style, { position: 'absolute', display: 'none', pointerEvents: 'none', background: '#0b0b0b', border: '1px solid #393939', color: '#f4f4f4', padding: '7px 10px', fontSize: '12px', lineHeight: '1.5', fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif', zIndex: 5, maxWidth: '260px' }); el.appendChild(tip);

  const S = { pickables: [], byName: {}, pulse: [], chain: null, chainGroup: new THREE.Group(), layers: { labels: true, sensors: true, leak: true, heat: 'off' }, mode: 'status', floors: [], rooms: [], hovered: null, selected: null };
  world.add(S.chainGroup);

  // ── build rooms ──
  let ox = 0;
  data.rooms.forEach(room => {
    const W = room.cols * T, D = room.rows * T, H = (room.height_mm || 3000) / 1000;
    const R = { room, ox, W, D, objs: [] }; S.rooms.push(R);
    const toX = (col) => ox + col * T, toZ = (row) => row * T;
    // floor with vertex colors for heatmaps
    const fg = new THREE.PlaneGeometry(W, D, room.cols * 2, room.rows * 2); fg.rotateX(-Math.PI / 2);
    const fm = new THREE.MeshStandardMaterial({ color: 0x1b2333, roughness: 0.9, metalness: 0.05, vertexColors: false });
    const floor = new THREE.Mesh(fg, fm); floor.position.set(ox + W / 2, 0, D / 2); floor.receiveShadow = true; world.add(floor); S.floors.push({ mesh: floor, geo: fg, mat: fm, R });
    const grid = new THREE.GridHelper(Math.max(W, D), Math.round(Math.max(W, D) / T), 0x34405a, 0x243049); grid.position.set(ox + W / 2, 0.006, D / 2); world.add(grid);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a1f27, roughness: 0.95, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const wallN = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat); wallN.position.set(ox + W / 2, H / 2, 0); world.add(wallN);
    const wallW = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat); wallW.position.set(ox, H / 2, D / 2); wallW.rotation.y = Math.PI / 2; world.add(wallW);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, D)), new THREE.LineBasicMaterial({ color: 0x4a5670 })); edge.position.set(ox + W / 2, H / 2, D / 2); world.add(edge);
    const rl = labelSprite(`${room.location} · ${room.name} · ${room.cols}×${room.rows} 타일 · 랙 ${room.objects.filter(o => o.kind === 'rack').length}`, 30); rl.position.set(ox + W / 2, H + 0.5, 0); world.add(rl);
    const devsByRack = {}; (room.devices || []).forEach(d => (devsByRack[d.rack] = devsByRack[d.rack] || []).push(d));

    room.objects.forEach(o => {
      const a = o.attrs || {}; const w = (o.w || 1) * T, d = (o.d || 1) * T; const x = toX(o.col ?? 0) + w / 2, z = toZ(o.row ?? 0) + d / 2;
      const g = new THREE.Group(); g.position.set(x, 0, z); let hit = null; const ud = { name: o.name, kind: o.kind, attrs: a, room: room.name, face: o.face || 'S', devices: devsByRack[o.name] || [] };
      const face = o.face || 'S'; const ry = { S: 0, N: Math.PI, E: -Math.PI / 2, W: Math.PI / 2 }[face] || 0;
      if (o.kind === 'rack') {
        const devs = ud.devices; const st = a.status || (devs.length ? 'ok' : 'empty');
        const slot = makeRackSlot(devs.map(dv => ({ ...dv, id: dv.label })), { w: 0.6, d: 1.0, h: 2.0, frame: true }); slot.rotation.y = ry; g.add(slot);
        hit = new THREE.Mesh(new THREE.BoxGeometry(0.64, 2.02, 1.04), new THREE.MeshStandardMaterial({ color: COL[st] || COL.ok, transparent: true, opacity: st === 'ok' ? 0.05 : 0.18, depthWrite: false, roughness: 0.3 })); hit.position.y = 1.01; g.add(hit);
        if (st === 'critical') S.pulse.push(hit);
        ud.status = st;
      } else if (o.kind === 'ups_cabinet') {
        const dev = ud.devices[0] || { label: o.name, model: 'Symmetra PX', status: a.status || 'ok', battery_pct: 100, load_pct: a.load_pct };
        const m = makeUps({ ...dev, id: dev.label }); const s = m.userData.size; m.scale.set(w / s.w * 0.9, 1.9 / s.h, d / s.d * 0.9); m.rotation.y = ry; g.add(m);
        hit = new THREE.Mesh(new THREE.BoxGeometry(w, 1.95, d), new THREE.MeshStandardMaterial({ color: COL.ups, transparent: true, opacity: 0.06, depthWrite: false })); hit.position.y = 0.98; g.add(hit); ud.status = dev.status;
        const lab = labelSprite(`${o.name} · ${a.capacity_kw || ''}kW · 부하 ${a.load_pct ?? dev.load_pct ?? '—'}%`, 24, '#a6c8ff'); lab.position.set(0, 2.3, 0); g.add(lab); ud.label3d = lab;
      } else if (o.kind === 'pdu_cabinet' || o.kind === 'panel') {
        const h = o.kind === 'panel' ? 1.2 : 1.9; const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: o.kind === 'panel' ? 0x8d8d8d : 0x5a6270, roughness: 0.5, metalness: 0.5 })); m.position.y = o.kind === 'panel' ? 1.2 : h / 2; m.castShadow = true; g.add(m);
        const led = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, 0.02, 0.01), new THREE.MeshBasicMaterial({ color: 0x42be65 })); led.position.set(0, m.position.y + h * 0.3, d / 2 + 0.006); g.add(led);
        hit = m; ud.status = a.status || 'ok';
        const lab = labelSprite(`${o.name}${a.label ? ' · ' + a.label : ''} · ${a.rated_a || ''}A${a.load_a != null ? ' · ' + a.load_a + 'A' : ''}`, 22, a.utility ? '#f1c21b' : '#c6c6c6'); lab.position.set(0, m.position.y + h / 2 + 0.3, 0); g.add(lab); ud.label3d = lab;
      } else if (o.kind === 'crac') {
        const st = a.status || 'ok'; const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.0, d), new THREE.MeshStandardMaterial({ color: st === 'warn' ? COL.warn : COL.crac, roughness: 0.5, metalness: 0.3 })); m.position.y = 1.0; m.castShadow = true; g.add(m);
        const grill = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.85, 0.8), new THREE.MeshBasicMaterial({ color: 0x0b0b0b })); grill.position.set(0, 0.6, d / 2 + 0.002); g.add(grill);
        const fan = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.3, w * 0.3, 0.05, 24), new THREE.MeshStandardMaterial({ color: 0x161616 })); fan.position.set(0, 2.03, 0); g.add(fan); ud.fan = fan; ud.fanSpeed = (a.fan_pct || 70) / 100;
        hit = m; ud.status = st; if (st === 'warn') S.pulse.push(m);
        const lab = labelSprite(`${o.name} · ${a.rt || ''}RT · 팬 ${a.fan_pct ?? '—'}%${a.note ? ' · ' + a.note : ''}`, 24, st === 'warn' ? '#f1c21b' : '#42be65'); lab.position.set(0, 2.6, 0); g.add(lab); ud.label3d = lab;
      } else if (o.kind === 'sensor') {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.5, 8), new THREE.MeshStandardMaterial({ color: 0x8d8d8d })); post.position.y = 0.75; g.add(post);
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), new THREE.MeshStandardMaterial({ color: 0x78a9ff, emissive: 0x1c3f80 })); ball.position.y = 1.55; g.add(ball); hit = ball; ud.status = 'ok';
        const lab = labelSprite(`${o.name} · ${a.temp_c ?? '—'}°C · ${a.humidity ?? '—'}%`, 20, '#78a9ff'); lab.position.set(0, 1.85, 0); g.add(lab); ud.label3d = lab; ud.sensorLayer = true;
      } else if (o.kind === 'smoke') {
        const dsc = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 20), new THREE.MeshStandardMaterial({ color: 0xe0e0e0 })); dsc.position.y = H - 0.02; g.add(dsc); hit = dsc; ud.status = 'ok'; ud.sensorLayer = true;
      } else if (o.kind === 'leak_zone') {
        const poly = (a.zone_poly || []).map(([c, r]) => new THREE.Vector2(toX(c) - x, toZ(r) - z)); if (poly.length < 3) return;
        const shape = new THREE.Shape(poly); const sg = new THREE.ShapeGeometry(shape); sg.rotateX(Math.PI / 2);
        const leak = a.status === 'leak'; const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: leak ? COL.critical : 0x4589ff, transparent: true, opacity: leak ? 0.45 : 0.16, depthWrite: false, side: THREE.DoubleSide })); m.position.y = 0.012; g.add(m); hit = m; ud.status = leak ? 'critical' : 'ok'; ud.leakLayer = true; if (leak) S.pulse.push(m);
        const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(poly.map(p => new THREE.Vector3(p.x, 0.02, p.y))), new THREE.LineDashedMaterial({ color: leak ? 0xff8389 : 0x78a9ff, dashSize: 0.15, gapSize: 0.1 })); outline.computeLineDistances(); g.add(outline);
        const lab = labelSprite(o.name + (leak ? ' · 누수 감지' : ''), 20, leak ? '#ff8389' : '#78a9ff'); lab.position.set(0, 0.35, 0); g.add(lab); ud.label3d = lab;
      } else if (o.kind === 'fm200') {
        for (let i = 0; i < (a.cylinders || 3); i++) { const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.4, 20), new THREE.MeshStandardMaterial({ color: 0xb81921, roughness: 0.4, metalness: 0.5 })); cyl.position.set(0, 0.7, -d / 2 + 0.3 + i * 0.45); cyl.castShadow = true; g.add(cyl); if (!hit) hit = cyl; }
        ud.status = a.status || 'ok'; const lab = labelSprite(`${o.name} · ${a.status === 'ok' ? '정상' : a.status}`, 20, '#c6c6c6'); lab.position.set(0, 1.9, 0); g.add(lab); ud.label3d = lab;
      } else if (o.kind === 'door') {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.1, 0.08), new THREE.MeshStandardMaterial({ color: 0x3a4356, transparent: true, opacity: 0.6 })); m.position.y = 1.05; g.add(m); const lab = labelSprite('출입문 · 카드 리더', 18, '#8d8d8d'); lab.position.set(0, 2.3, 0); g.add(lab); ud.label3d = lab;
      } else { const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.0, d), new THREE.MeshStandardMaterial({ color: 0x393939 })); m.position.y = 1; g.add(m); hit = m; }
      if (o.kind === 'rack') { const lab = labelSprite(o.name, 18, CSS[ud.status] || '#c6c6c6'); lab.position.set(0, 2.25, 0); g.add(lab); ud.label3d = lab; ud.rackLabel = true; }
      if (hit) { hit.userData = ud; S.pickables.push(hit); }
      g.userData = ud; ud.group = g; ud.center = new THREE.Vector3(x, 1.0, z); S.byName[o.name] = ud; R.objs.push(ud); world.add(g);
    });
    // devices → name lookup (power chain endpoints may be device labels)
    (room.devices || []).forEach(dv => { const rack = S.byName[dv.rack]; if (rack) S.byName[dv.label] = { name: dv.label, kind: 'device', device: dv, center: rack.center, group: rack.group, rack }; });
    ox += W + 2.5;
  });
  S.width = ox - 2.5; S.depth = Math.max(...S.rooms.map(r => r.D));

  // ── power chain index (src → dst) ──
  const up = {}; data.rooms.forEach(r => (r.power_links || []).forEach(l => (up[l.src] = up[l.src] || []).push(l)));
  function chainFor(name) {
    const out = []; let cur = name; const seen = new Set();
    for (let i = 0; i < 8 && cur && !seen.has(cur); i++) { seen.add(cur); const l = (up[cur] || [])[0]; if (!l) break; out.push({ ...l, from: S.byName[l.src], to: S.byName[l.dst] }); cur = l.dst; }
    return out;
  }
  function showChain(name) {
    S.chainGroup.clear(); S.chain = null; if (!name) return [];
    const ch = chainFor(name); if (!ch.length) return [];
    const pts = [S.byName[name]?.center.clone()]; ch.forEach(l => l.to && pts.push(l.to.center.clone()));
    const path = new THREE.CatmullRomCurve3(pts.map((p, i) => { const q = p.clone(); q.y = i === 0 ? 1.0 : 2.25; return q; }), false, 'catmullrom', 0.1);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(32, pts.length * 24), 0.03, 10, false), new THREE.MeshStandardMaterial({ color: COL.chain, emissive: COL.chain, emissiveIntensity: 0.8, transparent: true, opacity: 0.9 })); S.chainGroup.add(tube);
    const dash = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.getPoints(200)), new THREE.LineDashedMaterial({ color: 0xffd7a8, dashSize: 0.35, gapSize: 0.25 })); dash.computeLineDistances(); S.chainGroup.add(dash);
    const flow = []; for (let i = 0; i < 6; i++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), new THREE.MeshBasicMaterial({ color: 0xfff1e0 })); S.chainGroup.add(b); flow.push(b); } S.chain = { path, flow };
    pts.forEach((p, i) => { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.03, 8, 32), new THREE.MeshBasicMaterial({ color: COL.chain })); ring.rotation.x = Math.PI / 2; ring.position.set(p.x, 0.03, p.z); S.chainGroup.add(ring); const l = ch[i - 1]; if (l) { const lab = labelSprite(`${i}. ${l.dst}${l.dst_port ? ' · ' + l.dst_port : ''}${l.circuit ? ' · ' + l.circuit : ''} · ${l.rated_a ?? '—'}A`, 20, '#ffd7a8'); lab.position.set(p.x, 2.7, p.z); S.chainGroup.add(lab); } });
    return ch;
  }

  // ── heatmap (floor vertex colours from rack kw / temp, IDW) ──
  function applyHeat(kind) {
    S.layers.heat = kind;
    S.floors.forEach(({ geo, mat, R }) => {
      if (kind === 'off') { mat.vertexColors = false; mat.color.setHex(0x1b2333); mat.needsUpdate = true; geo.deleteAttribute('color'); return; }
      const src = R.objs.filter(o => (o.kind === 'rack' && o.status !== 'empty') || o.kind === 'crac').map(o => ({ x: o.center.x, z: o.center.z, v: kind === 'temp' ? (o.kind === 'crac' ? (o.attrs.supply_c || 18.5) : (o.attrs.temp_c || 23)) : (o.kind === 'crac' ? 0 : (o.attrs.kw || 0)) }));
      const pos = geo.attributes.position; const colors = new Float32Array(pos.count * 3); const c = new THREE.Color(); const cx0 = R.ox + R.W / 2, cz0 = R.D / 2;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + cx0, z = pos.getZ(i) + cz0; let num = 0, den = 0; const base = kind === 'temp' ? 21 : 0;
        for (const h of src) { const d2 = (x - h.x) ** 2 + (z - h.z) ** 2; const w = Math.exp(-d2 / 1.3); num += w * (h.v - base); den += w; }
        const v = base + num / Math.max(den, 0.9); const u = kind === 'temp' ? Math.min(1, Math.max(0, (v - 21) / 6.5)) : Math.min(1, Math.max(0, v / 4.5));
        c.setHSL(0.62 - 0.62 * u, 0.9, 0.22 + 0.28 * u); colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3)); mat.vertexColors = true; mat.color.setHex(0xffffff); mat.needsUpdate = true;
    });
  }
  function applyMode(mode) {
    S.mode = mode;
    S.pickables.forEach(h => { const u = h.userData; if (u.kind !== 'rack') return; const a = u.attrs;
      if (mode === 'status') { h.material.color.setHex(COL[u.status] || COL.ok); h.material.opacity = u.status === 'ok' ? 0.05 : 0.18; }
      else if (mode === 'load') { const t = Math.min(1, (a.kw || 0) / 7); h.material.color.setHSL(0.55 - 0.55 * t, 0.85, 0.45); h.material.opacity = u.status === 'empty' ? 0.03 : 0.22; }
      else { const t = Math.min(1, Math.max(0, ((a.temp_c || 22) - 22) / 7)); h.material.color.setHSL(0.6 - 0.6 * t, 0.9, 0.45); h.material.opacity = u.status === 'empty' ? 0.03 : 0.22; } });
  }
  function applyLayers(L) {
    Object.assign(S.layers, L);
    Object.values(S.byName).forEach(u => { if (u.label3d && u.rackLabel) u.label3d.visible = !!S.layers.labels; if (u.sensorLayer) u.group.visible = !!S.layers.sensors; if (u.leakLayer) u.group.visible = !!S.layers.leak; });
  }

  // ── picking / selection ──
  const ray = new THREE.Raycaster(); const mouse = new THREE.Vector2();
  const pick = (e) => { const r = renderer.domElement.getBoundingClientRect(); mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1; mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1; ray.setFromCamera(mouse, camera); const hits = ray.intersectObjects(S.pickables, false); return hits[0]?.object || null; };
  function describe(u) {
    const a = u.attrs || {}; const k = KIND_KO[u.kind] || u.kind;
    if (u.kind === 'rack') { const st = { ok: '정상', hot: '고부하', warn: '온도 주의', critical: '<span style="color:#ff8389">알람 · 핫스팟</span>', empty: '공랙' }[u.status] || u.status; return `<b>랙 ${u.name}</b> · ${st}<br>${a.kw ?? 0} kW · 상단 ${a.temp_c ?? '—'} °C · ${u.devices.length}대 실장<br><span style="color:#8d8d8d">${a.pdu || ''} ${a.cb || ''}</span>`; }
    if (u.kind === 'crac') return `<b>${u.name}</b> · ${a.rt}RT<br>팬 ${a.fan_pct}% · 급기 ${a.supply_c ?? '—'} °C · ${a.status === 'warn' ? '<span style="color:#f1c21b">' + (a.note || '경고') + '</span>' : '정상'}`;
    if (u.kind === 'ups_cabinet') { const d = u.devices[0]; return `<b>${u.name}</b> · ${d?.model || ''}<br>부하 ${a.load_pct ?? d?.load_pct ?? '—'}% · 배터리 ${d?.battery_pct ?? '—'}% · 런타임 ${d?.runtime_min ?? '—'} min`; }
    if (u.kind === 'sensor') return `<b>${u.name}</b> ${k}<br>${a.temp_c} °C · ${a.humidity}% RH`;
    if (u.kind === 'leak_zone') return `<b>${u.name}</b> ${k}<br>${a.status === 'leak' ? '<span style="color:#ff8389">누수 감지 · 11:02</span>' : '정상'}`;
    if (u.kind === 'panel' || u.kind === 'pdu_cabinet') return `<b>${u.name}</b> ${k}${a.label ? ' · ' + a.label : ''}<br>정격 ${a.rated_a ?? '—'} A${a.load_a != null ? ' · 부하 ' + a.load_a + ' A' : ''}`;
    return `<b>${u.name}</b> ${k}${a.status ? ' · ' + a.status : ''}`;
  }
  renderer.domElement.addEventListener('pointermove', (e) => { const o = pick(e); if (S.hovered && S.hovered !== o && S.hovered.material.emissive) S.hovered.material.emissive.setHex(0); S.hovered = o; if (o) { if (o.material.emissive) o.material.emissive.setHex(0x334466); const r = el.getBoundingClientRect(); tip.style.display = 'block'; tip.style.left = (e.clientX - r.left + 14) + 'px'; tip.style.top = (e.clientY - r.top + 14) + 'px'; tip.innerHTML = describe(o.userData); } else tip.style.display = 'none'; });
  let down = null; renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => { if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; const o = pick(e); select(o ? o.userData.name : null); });
  let selOutline = null;
  function select(name) {
    if (selOutline) { selOutline.parent?.remove(selOutline); selOutline = null; }
    S.selected = name ? S.byName[name] : null; const chain = showChain(name);
    if (S.selected?.group) { const box = new THREE.Box3().setFromObject(S.selected.group); const size = box.getSize(new THREE.Vector3()); const ctr = box.getCenter(new THREE.Vector3()); selOutline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x + 0.06, size.y + 0.04, size.z + 0.06)), new THREE.LineBasicMaterial({ color: 0x4589ff })); selOutline.position.copy(ctr); world.add(selOutline); }
    opts.onSelect?.(S.selected ? { ...S.selected, html: describe(S.selected), chain } : null);
  }

  // ── camera (eased) ──
  let camAnim = null;
  function flyTo(pos, target, ms = 800) { camAnim = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, start: performance.now(), ms }; }
  function preset(n) { const cx = S.width / 2, cz = S.depth / 2, span = Math.max(S.width, S.depth); const P = { iso: [[cx + span * 0.85, span * 0.8, cz + span * 1.15], [cx, 0.4, cz]], top: [[cx, span * 1.35, cz + 0.01], [cx, 0, cz]], aisle: [[cx - 1.5, 1.7, cz + 4.5], [cx + 1, 1.0, cz - 4]], crac: [[cx, 4.5, -6], [cx, 1.0, 2]] }; const p = P[n] || P.iso; flyTo(new THREE.Vector3(...p[0]), new THREE.Vector3(...p[1])); }
  function focus(name) { const u = S.byName[name]; if (!u) return; const c = u.center; const face = (u.attrs && u.attrs.face) || u.face || 'S'; const dir = { S: [0.6, 1], N: [0.6, -1], E: [1, 0.6], W: [-1, 0.6] }[face] || [0.6, 1]; const dist = u.kind === 'rack' || u.kind === 'device' ? 5.2 : 6.5; flyTo(new THREE.Vector3(c.x + dir[0] * dist, 3.6, c.z + dir[1] * dist), new THREE.Vector3(c.x, 0.9, c.z)); select(name); }

  // ── loop ──
  let lastW = 0, lastH = 0; const resize = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h || h > 4096 || (w === lastW && h === lastH)) return; lastW = w; lastH = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(el); resize();
  let raf, running = true; const clock = new THREE.Clock();
  function tick() { if (!running) return; const t = clock.getElapsedTime();
    if (camAnim) { const k = Math.min(1, (performance.now() - camAnim.start) / camAnim.ms); const e = 1 - Math.pow(1 - k, 3); camera.position.lerpVectors(camAnim.p0, camAnim.p1, e); controls.target.lerpVectors(camAnim.t0, camAnim.t1, e); if (k >= 1) camAnim = null; }
    controls.update();
    const p = (Math.sin(t * 4) + 1) / 2; S.pulse.forEach(m => { if (m.material.emissive) m.material.emissive.setHex(p > 0.5 ? (m.userData.kind === 'crac' ? 0x4a3a05 : 0x6a1016) : 0); else m.material.opacity = 0.25 + 0.35 * p; });
    Object.values(S.byName).forEach(u => { if (u.fan) u.fan.rotation.y += 0.2 * u.fanSpeed; });
    if (S.chain) { S.chain.flow.forEach((b, i) => { const u = ((t * 0.18) + i / S.chain.flow.length) % 1; b.position.copy(S.chain.path.getPointAt(u)); }); }
    renderer.render(scene, camera); raf = requestAnimationFrame(tick); }
  tick(); preset('iso'); applyMode('status');

  return { preset, focus, select, setMode: applyMode, setHeat: applyHeat, setLayers: applyLayers, chainFor, byName: S.byName, objects: () => Object.values(S.byName), dispose: () => { running = false; cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); el.innerHTML = ''; } };
}
