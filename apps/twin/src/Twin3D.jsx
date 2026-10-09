import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { C, STATUS } from './theme';
import { layoutFloor } from './layout';

const hex = (c) => new THREE.Color(c);
const statusColor = (s) => (STATUS[s] || STATUS.unknown).color;

function labelSprite(text, px = 28, color = '#161616', dark = false) {
  const cv = document.createElement('canvas'); const ctx = cv.getContext('2d');
  const font = `600 ${px}px "IBM Plex Sans", Arial, sans-serif`; ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 24; cv.width = w; cv.height = px + 18;
  ctx.font = font; ctx.fillStyle = dark ? 'rgba(11,11,11,0.8)' : 'rgba(255,255,255,0.92)'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = dark ? '#393939' : '#e0e0e0'; ctx.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, 12, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(cv.width / 170, cv.height / 170, 1); return sp;
}

// The world is rebuilt on every 30s poll, so everything it owns has to be released
// or the GPU side grows without bound on a wall display left running for days.
function disposeTree(root) {
  root.traverse(o => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach(m => { m.map?.dispose?.(); m.dispose?.(); });
  });
  root.clear();
}

export default function Twin3D({ tree, assets, selectedId, onSelect, mode = 'status', view = 'iso', dark = true }) {
  const ref = useRef(null); const state = useRef({}); const onSelectRef = useRef(onSelect);
  // The three.js listeners are attached once, so they reach the current onSelect
  // through a ref rather than closing over the first one.
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  // scene once
  useEffect(() => {
    const el = ref.current; const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; el.appendChild(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = hex(dark ? '#070a10' : C.bg);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 3; controls.maxDistance = 120;
    scene.add(new THREE.HemisphereLight(dark ? 0x8fb3ff : 0xffffff, dark ? 0x101418 : 0xdddddd, dark ? 0.7 : 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(20, 30, 10); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, far: 120 });
    sun.shadow.camera.updateProjectionMatrix();   // frustum edits are inert without this
    scene.add(sun);
    const world = new THREE.Group(); scene.add(world);
    const ray = new THREE.Raycaster(); const mouse = new THREE.Vector2(); let hovered = null;
    const tip = document.createElement('div');
    Object.assign(tip.style, { position: 'absolute', display: 'none', pointerEvents: 'none', background: '#161616', color: '#fff', padding: '6px 10px', fontSize: '12px', lineHeight: '1.5', fontFamily: '"IBM Plex Sans",Arial,sans-serif', zIndex: 5 });
    el.appendChild(tip);
    const pick = (e) => { const r = renderer.domElement.getBoundingClientRect(); mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1; mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1; ray.setFromCamera(mouse, camera); const hits = ray.intersectObjects(state.current.pickables || [], false); return hits[0]?.object || null; };
    renderer.domElement.addEventListener('pointermove', (e) => { const o = pick(e); if (hovered && hovered !== o) hovered.material.emissive.setHex(0); hovered = o; if (o) { o.material.emissive.setHex(0x335599); const u = o.userData; tip.style.display = 'block'; const r = el.getBoundingClientRect(); tip.style.left = (e.clientX - r.left + 12) + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px'; tip.innerHTML = u.tip; } else tip.style.display = 'none'; });
    let down = null; renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener('pointerup', (e) => { if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; const o = pick(e); if (o?.userData.deviceId) onSelectRef.current?.(o.userData.deviceId, o.userData); });
    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();
    let raf; const tick = () => { controls.update(); const t = performance.now() / 1000; (state.current.pulse || []).forEach(m => m.material.emissive.setHex(Math.sin(t * 5) > 0 ? 0x6a1016 : 0)); renderer.render(scene, camera); raf = requestAnimationFrame(tick); }; tick();
    state.current = { renderer, scene, camera, controls, world, pickables: [], pulse: [] };
    return () => { cancelAnimationFrame(raf); ro.disconnect(); disposeTree(world); renderer.dispose(); el.innerHTML = ''; };
  }, []);

  // rebuild world when data changes
  useEffect(() => {
    const s = state.current; if (!s.world || !tree) return;
    disposeTree(s.world); s.pickables = []; s.pulse = [];
    const byRack = {}; (assets || []).forEach(a => { const k = `${a.location || 'Unknown Location'}|${a.room || 'Default Room'}|${a.rack || 'Default Rack'}`; (byRack[k] = byRack[k] || []).push(a); });
    const L = layoutFloor(tree);
    s.span = Math.max(L.width, 12); s.cx = L.width / 2;
    L.rooms.forEach(room => {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(room.w, room.d), new THREE.MeshStandardMaterial({ color: dark ? 0x141a24 : 0xe8e8e8, roughness: 1 }));
      floor.rotation.x = -Math.PI / 2; floor.position.set(room.x + room.w / 2, 0, 0); floor.receiveShadow = true; s.world.add(floor);
      const g = new THREE.GridHelper(Math.max(room.w, room.d), Math.round(Math.max(room.w, room.d) / 0.6), dark ? 0x2a3140 : 0xcfcfcf, dark ? 0x1c2230 : 0xdedede); g.position.set(room.x + room.w / 2, 0.005, 0); s.world.add(g);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(room.w, 3, room.d)), new THREE.LineBasicMaterial({ color: dark ? 0x3a4356 : 0xa8a8a8 })); edge.position.set(room.x + room.w / 2, 1.5, 0); s.world.add(edge);
      const lab = labelSprite(`${room.location} · ${room.name} · ${room.node.count ?? room.racks.length} UPS`, 30, dark ? '#f4f4f4' : '#161616', dark); lab.position.set(room.x + room.w / 2, 3.4, -room.d / 2); s.world.add(lab);
      room.racks.forEach(r => {
        const devs = byRack[`${room.location}|${room.name}|${r.name}`] || r.node.devices || [];
        const worst = devs.reduce((w, d) => ({ critical: 3, warn: 2, ok: 1 }[d.status] > ({ critical: 3, warn: 2, ok: 1 }[w] || 0) ? d.status : w), devs.length ? 'nodata' : 'empty');
        let color = worst === 'empty' ? (dark ? '#2b2b2b' : '#c6c6c6') : (dark ? ({ ok: '#1c4f8a', warn: '#f1c21b', critical: '#fa4d56' }[worst] || '#6f6f6f') : statusColor(worst));
        if (mode === 'load' && devs.length) { const l = Math.max(...devs.map(d => d.load_pct || 0)); color = new THREE.Color().setHSL(0.6 - 0.6 * Math.min(1, l / 100), 0.75, 0.45).getStyle(); }
        if (mode === 'temp' && devs.length) { const t = Math.max(...devs.map(d => d.temp_c || 22)); color = new THREE.Color().setHSL(0.6 - 0.6 * Math.min(1, Math.max(0, (t - 20) / 15)), 0.8, 0.45).getStyle(); }
        const m = new THREE.Mesh(new THREE.BoxGeometry(L.RACK_W, 2.0, L.RACK_D), new THREE.MeshStandardMaterial({ color: hex(color), roughness: 0.6, metalness: 0.15 }));
        m.position.set(r.x, 1.0, r.z); m.castShadow = true; m.receiveShadow = true;
        const first = devs[0];
        m.userData = { rackName: r.name, deviceId: first?.id, device: first, tip: `<b>${room.name} · ${r.name}</b><br>${devs.length ? devs.map(d => `${d.label} · ${(STATUS[d.status] || STATUS.unknown).label()}${d.battery_pct != null ? ` · ${d.battery_pct}%` : ''}`).join('<br>') : '장치 없음'}` };
        if (selectedId && devs.some(d => d.id === selectedId)) { const o = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: hex(C.primary), linewidth: 2 })); o.scale.set(1.04, 1.02, 1.04); m.add(o); }
        if (worst === 'critical') s.pulse.push(m);
        const led = new THREE.Mesh(new THREE.BoxGeometry(L.RACK_W * 0.8, 0.03, 0.02), new THREE.MeshBasicMaterial({ color: hex(worst === 'critical' ? C.critical : C.primary) })); led.position.set(0, 0.85, r.face * (L.RACK_D / 2 + 0.011)); m.add(led);
        s.world.add(m); s.pickables.push(m);
      });
    });
  }, [tree, assets, selectedId, mode, dark]);


  const siteKey = useMemo(() => Object.keys(tree || {}).join('|'), [tree]);

  // Camera presets. Deliberately NOT keyed on `tree`/`assets`: the 30s poll replaces
  // both, and reframing then would yank the operator's orbit back to the preset
  // mid-inspection. `siteKey` only changes when the set of sites does (CBU switch).
  useEffect(() => {
    const s = state.current; if (!s.camera || !s.span) return;
    const presets = { iso: [s.cx + s.span * 0.55, s.span * 0.55, s.span * 0.75], top: [s.cx, s.span * 1.1, 0.01], aisle: [s.cx - s.span * 0.3, 1.6, 0.4] };
    s.camera.position.set(...(presets[view] || presets.iso)); s.controls.target.set(s.cx, 0.8, 0); s.controls.update();
  }, [view, siteKey]);

  return <div ref={ref} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }} />;
}
