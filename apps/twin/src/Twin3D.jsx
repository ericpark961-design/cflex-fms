import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STATUS, tx } from './theme';
import { layoutFloor } from './layout';
import { devId } from './ids';
import { TWIN, statusColor, labelSprite, buildObject, disposeTree, heatTexture, HEAT_SCALES } from './twin/meshes';

const hex = (c) => new THREE.Color(c);
const RANK = { critical: 3, warn: 2, ok: 1 };
const ROOM_GAP = 3;

const worstOf = (devices) =>
  (devices || []).reduce((w, d) => (RANK[d.status] > (RANK[w] || 0) ? d.status : w), devices?.length ? 'nodata' : 'empty');

// Rooms are laid side by side along +x. A room with a ledger is drawn from its own
// cols/rows; a room without one falls back to v2's name-parsed layout, and both
// can appear in the same scene.
export default function Twin3D({
  topology, tree, assets, selectedId, selectedObjectId, onSelect, onSelectObject,
  mode = 'status', view = 'iso', layers = {}, chain = null, focusId = null,
}) {
  const ref = useRef(null);
  const state = useRef({});
  const cbRef = useRef({ onSelect, onSelectObject });
  useEffect(() => { cbRef.current = { onSelect, onSelectObject }; }, [onSelect, onSelectObject]);

  // ── scene, once ───────────────────────────────────────────────────
  useEffect(() => {
    const el = ref.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = hex('#070a10');
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 3;
    controls.maxDistance = 220;

    scene.add(new THREE.HemisphereLight(0x8fb3ff, 0x101418, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 0.95);
    sun.position.set(20, 34, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, far: 160 });
    sun.shadow.camera.updateProjectionMatrix();      // frustum edits are inert without this
    scene.add(sun);

    const world = new THREE.Group(); scene.add(world);
    const chainGroup = new THREE.Group(); scene.add(chainGroup);

    const ray = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let hovered = null;
    const tip = document.createElement('div');
    Object.assign(tip.style, {
      position: 'absolute', display: 'none', pointerEvents: 'none', background: '#0b0b0b',
      border: '1px solid #393939', color: '#f4f4f4', padding: '7px 10px', fontSize: '12px',
      lineHeight: '1.5', fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",Arial,sans-serif', zIndex: 5,
    });
    el.appendChild(tip);

    const pick = (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(mouse, camera);
      return ray.intersectObjects(state.current.pickables || [], false)[0]?.object || null;
    };
    const clearHover = () => {
      if (hovered) { hovered.userData.hovered = false; hovered.material.emissive?.setHex(0); hovered = null; }
      tip.style.display = 'none';
    };
    renderer.domElement.addEventListener('pointermove', (e) => {
      const o = pick(e);
      if (hovered && hovered !== o) { hovered.userData.hovered = false; hovered.material.emissive?.setHex(0); }
      hovered = o;
      if (o) {
        o.userData.hovered = true;
        o.material.emissive?.setHex(0x335599);
        const r = el.getBoundingClientRect();
        tip.style.display = 'block';
        tip.style.left = `${e.clientX - r.left + 12}px`;
        tip.style.top = `${e.clientY - r.top + 12}px`;
        tip.innerHTML = o.userData.tip || '';
      } else tip.style.display = 'none';
    });
    renderer.domElement.addEventListener('pointerleave', clearHover);

    let down = null;
    renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const o = pick(e);
      if (!o) { cbRef.current.onSelectObject?.(null); return; }
      const u = o.userData;
      if (u.deviceId != null) cbRef.current.onSelect?.(u.deviceId, u);
      cbRef.current.onSelectObject?.(u.objectId ?? null, u);
    });
    // Keyboard equivalent of clicking — the scene is otherwise mouse-only.
    el.addEventListener('keydown', (e) => {
      const list = state.current.pickables || [];
      if (!list.length) return;
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const cur = list.findIndex(m => m.userData.objectId != null && m.userData.objectId === state.current.selectedObjectId);
      const next = list[(cur + step + list.length) % list.length];
      if (next.userData.deviceId != null) cbRef.current.onSelect?.(next.userData.deviceId, next.userData);
      cbRef.current.onSelectObject?.(next.userData.objectId ?? null, next.userData);
    });

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();

    let raf;
    const tick = () => {
      controls.update();
      const t = performance.now() / 1000;
      (state.current.pulse || []).forEach(m => { if (!m.userData.hovered) m.material.emissive?.setHex(Math.sin(t * 5) > 0 ? 0x6a1016 : 0); });
      (state.current.fans || []).forEach(f => { f.rotation.z = t * 2; });
      if (state.current.chainTex) state.current.chainTex.offset.x = -t * 0.35;   // dashes flow toward the source
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    state.current = { ...state.current, renderer, scene, camera, controls, world, chainGroup, pickables: [], pulse: [], fans: [] };
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); clearHover();
      disposeTree(world); disposeTree(chainGroup); renderer.dispose(); el.innerHTML = '';
    };
  }, []);

  // ── rebuild world ─────────────────────────────────────────────────
  useEffect(() => {
    const s = state.current;
    if (!s.world) return;
    disposeTree(s.world);
    s.pickables = []; s.pulse = []; s.fans = [];
    s.centres = new Map();                       // objectId → world centre, for the chain line
    s.selectedObjectId = selectedObjectId;

    const byRack = {};
    (assets || []).forEach(a => {
      const k = `${a.location || 'Unknown Location'}|${a.room || 'Default Room'}|${a.rack || 'Default Rack'}`;
      (byRack[k] = byRack[k] || []).push(a);
    });

    let ox = 0;

    // ---- ledger rooms ----
    for (const room of topology?.rooms || []) {
      const tile = (room.tile_mm || 600) / 1000;
      const W = room.cols * tile, D = room.rows * tile;
      const H = (room.height_mm || 3000) / 1000;

      const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: hex(TWIN.floor), roughness: 1 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(ox + W / 2, 0, D / 2);
      floor.receiveShadow = true;
      s.world.add(floor);

      const grid = new THREE.GridHelper(Math.max(W, D), Math.round(Math.max(W, D) / tile), hex(TWIN.grid), hex(TWIN.gridSub));
      grid.position.set(ox + W / 2, 0.005, D / 2);
      s.world.add(grid);

      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, D)),
        new THREE.LineBasicMaterial({ color: hex(TWIN.wall) }));
      edge.position.set(ox + W / 2, H / 2, D / 2);
      s.world.add(edge);

      if (layers.labels !== false) {
        const lab = labelSprite(`${room.location} · ${room.name} · ${room.objects.length} ${tx('객체', 'objects')}`, 30);
        lab.position.set(ox + W / 2, H + 0.7, -0.4);
        s.world.add(lab);
      }

      const heatMetric = layers.heat && layers.heat !== 'none' ? layers.heat : null;
      if (heatMetric) {
        const cells = (layers.heatRooms || []).find(r => r.id === room.id)?.cells;
        const scale = HEAT_SCALES[heatMetric];
        const tex = heatTexture(cells, room.cols, room.rows, scale.range, scale.stops);
        if (tex) {
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
          plane.rotation.x = -Math.PI / 2;
          plane.position.set(ox + W / 2, 0.01, D / 2);
          s.world.add(plane);
        }
      }

      for (const obj of room.objects) {
        if (obj.kind === 'sensor' && layers.sensors === false) continue;
        if (obj.kind === 'leak_zone' && layers.leak === false) continue;

        const w = (obj.w || 1) * tile, d = (obj.d || 2) * tile;
        const cx = ox + (obj.col + (obj.w || 1) / 2) * tile;
        const cz = (obj.row + (obj.d || 2) / 2) * tile;
        const devices = obj.devices || [];
        const worst = obj.kind === 'rack' ? worstOf(devices) : 'ok';

        let color;
        if (obj.kind === 'rack') {
          color = devices.length ? statusColor(worst) : (obj.attrs?.empty ? TWIN.empty : TWIN.nodata);
          if (mode === 'load') {
            const l = devices.length
              ? Math.max(...devices.map(x => x.load_pct || 0))
              : (obj.attrs?.design_kw != null ? Math.round((obj.attrs.design_kw / 7) * 100) : null);
            if (l != null) color = new THREE.Color().setHSL(0.6 - 0.6 * Math.min(1, l / 100), 0.75, 0.45).getStyle();
          }
          if (mode === 'temp') {
            const tC = devices.length ? Math.max(...devices.map(x => x.temp_c || 22)) : obj.attrs?.design_temp_c;
            if (tC != null) color = new THREE.Color().setHSL(0.6 - 0.6 * Math.min(1, Math.max(0, (tC - 20) / 15)), 0.8, 0.45).getStyle();
          }
        }

        // A leak zone's polygon is authored in tiles; convert to world metres.
        const poly = obj.kind === 'leak_zone' && obj.attrs?.zone_poly
          ? obj.attrs.zone_poly.map(([c, r]) => [ox + c * tile, r * tile])
          : null;

        const g = buildObject(obj.kind, {
          w, d, color, face: obj.face,
          alarm: obj.kind === 'rack' && worst === 'critical',
          ledColor: worst === 'critical' ? '#ff8389' : undefined,
          poly,
        });
        if (poly) g.position.set(0, 0.012, 0);       // polygon already in world space
        else g.position.set(cx, 0, cz);
        s.world.add(g);
        s.centres.set(obj.id, new THREE.Vector3(cx, 1.0, cz));

        const body = g.userData?.pickable || g;
        const first = devices[0];
        body.userData = {
          objectId: obj.id, kind: obj.kind, name: obj.name, hovered: false, deviceId: first?.id,
          tip: `<b>${obj.name}</b> · ${obj.kind}<br>${devices.length
            ? devices.map(x => `${x.label} · ${(STATUS[x.status] || STATUS.unknown).label()}${x.load_pct != null ? ` · ${x.load_pct}%` : ''}`).join('<br>')
            : (obj.attrs?.design_kw != null ? `${obj.attrs.design_kw} kW · ${obj.attrs.design_temp_c}°C` : tx('장치 없음', 'no device'))}`,
        };
        if (obj.kind !== 'leak_zone') s.pickables.push(body);
        if (worst === 'critical') s.pulse.push(body);
        if (g.userData?.fan) s.fans.push(g.userData.fan);

        const isSel = selectedObjectId === obj.id || (selectedId && devices.some(x => devId(x.id) === devId(selectedId)));
        if (isSel && body.geometry) {
          const o = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: hex('#4589ff') }));
          o.scale.set(1.06, 1.03, 1.06);
          body.add(o);
        }
      }
      ox += W + ROOM_GAP;
    }

    // ---- v2 fallback rooms ----
    // Only devices the ledger did not place, so a half-seeded tenant shows
    // everything instead of losing the unplaced half.
    const placed = new Set();
    for (const room of topology?.rooms || []) {
      for (const o of room.objects) for (const dv of o.devices || []) placed.add(String(dv.id));
    }
    const fallbackTree = {};
    for (const [loc, locNode] of Object.entries(tree || {})) {
      for (const [roomName, roomNode] of Object.entries(locNode.rooms || {})) {
        for (const [rackName, rackNode] of Object.entries(roomNode.racks || {})) {
          const devs = (rackNode.devices || []).filter(dv => !placed.has(String(dv.id)));
          if (!devs.length) continue;
          fallbackTree[loc] = fallbackTree[loc] || { name: loc, rooms: {} };
          fallbackTree[loc].rooms[roomName] = fallbackTree[loc].rooms[roomName] || { name: roomName, racks: {} };
          fallbackTree[loc].rooms[roomName].racks[rackName] = { ...rackNode, devices: devs };
        }
      }
    }

    if (Object.keys(fallbackTree).length) {
      const L = layoutFloor(fallbackTree);
      for (const room of L.rooms) {
        const rx = ox + room.x;
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(room.w, room.d), new THREE.MeshStandardMaterial({ color: hex(TWIN.floor), roughness: 1 }));
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(rx + room.w / 2, 0, 0);
        floor.receiveShadow = true;
        s.world.add(floor);
        const grid = new THREE.GridHelper(Math.max(room.w, room.d), Math.round(Math.max(room.w, room.d) / 0.6), hex(TWIN.grid), hex(TWIN.gridSub));
        grid.position.set(rx + room.w / 2, 0.005, 0);
        s.world.add(grid);
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(room.w, 3, room.d)), new THREE.LineBasicMaterial({ color: hex(TWIN.wall) }));
        edge.position.set(rx + room.w / 2, 1.5, 0);
        s.world.add(edge);
        if (layers.labels !== false) {
          // The badge matters: these coordinates are guessed from rack names.
          const lab = labelSprite(`${room.location} · ${room.name} · ${tx('추정 배치', 'estimated placement')}`, 30, TWIN.warn);
          lab.position.set(rx + room.w / 2, 3.4, -room.d / 2);
          s.world.add(lab);
        }
        for (const r of room.racks) {
          const devs = byRack[`${room.location}|${room.name}|${r.name}`] || r.node.devices || [];
          const worst = worstOf(devs);
          let color = worst === 'empty' ? TWIN.empty : statusColor(worst);
          if (mode === 'load' && devs.length) {
            const l = Math.max(...devs.map(d => d.load_pct || 0));
            color = new THREE.Color().setHSL(0.6 - 0.6 * Math.min(1, l / 100), 0.75, 0.45).getStyle();
          }
          if (mode === 'temp' && devs.length) {
            const tC = Math.max(...devs.map(d => d.temp_c || 22));
            color = new THREE.Color().setHSL(0.6 - 0.6 * Math.min(1, Math.max(0, (tC - 20) / 15)), 0.8, 0.45).getStyle();
          }
          const g = buildObject('rack', { w: L.RACK_W, d: L.RACK_D, color, face: r.face > 0 ? 'S' : 'N', alarm: worst === 'critical' });
          g.position.set(ox + r.x, 0, r.z);
          s.world.add(g);
          const body = g.userData.pickable;
          const first = devs[0];
          body.userData = {
            kind: 'rack', name: r.name, estimated: true, hovered: false, deviceId: first?.id,
            tip: `<b>${room.name} · ${r.name}</b> <i style="color:#f1c21b">${tx('추정', 'est.')}</i><br>${devs.length
              ? devs.map(d => `${d.label} · ${(STATUS[d.status] || STATUS.unknown).label()}${d.battery_pct != null ? ` · ${d.battery_pct}%` : ''}`).join('<br>')
              : tx('장치 없음', 'no device')}`,
          };
          s.pickables.push(body);
          if (worst === 'critical') s.pulse.push(body);
          if (selectedId && devs.some(d => devId(d.id) === devId(selectedId))) {
            const o = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: hex('#4589ff') }));
            o.scale.set(1.06, 1.03, 1.06);
            body.add(o);
          }
        }
      }
      ox += L.width + ROOM_GAP;
    }

    s.span = Math.max(ox - ROOM_GAP, 12);
    s.cx = s.span / 2;
  }, [topology, tree, assets, selectedId, selectedObjectId, mode, layers]);

  // ── power chain overlay ───────────────────────────────────────────
  useEffect(() => {
    const s = state.current;
    if (!s.chainGroup) return;
    disposeTree(s.chainGroup);
    s.chainTex = null;
    if (!chain?.length || !s.centres) return;

    // Highlight every object in the chain, even those whose centre is unknown.
    (s.pickables || []).forEach(m => {
      if (chain.some(c => c.type === 'object' && c.id === m.userData.objectId)) m.material.emissive?.setHex(0x7a3c00);
    });

    const pts = chain.map(c => (c.type === 'object' ? s.centres.get(c.id) : null)).filter(Boolean);
    if (pts.length < 2) return;             // a single known point is not a line

    const curve = new THREE.CatmullRomCurve3(pts.map(p => p.clone().setY(1.25)));
    const geo = new THREE.TubeGeometry(curve, Math.max(16, pts.length * 12), 0.05, 8, false);
    // dashes painted into a 1-D texture so they can flow along the tube
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 1;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = TWIN.chain; ctx.fillRect(0, 0, 64, 1);
    ctx.fillStyle = '#ffd6a8'; ctx.fillRect(0, 0, 26, 1);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(4, pts.length * 3), 1);
    s.chainGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.95 })));
    s.chainTex = tex;

    let i = 0;
    for (const c of chain) {
      const p = c.type === 'object' ? s.centres.get(c.id) : null;
      i++;
      if (!p) continue;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), new THREE.MeshBasicMaterial({ color: hex(TWIN.chain) }));
      dot.position.copy(p).setY(1.25);
      s.chainGroup.add(dot);
      const lab = labelSprite(`${i}. ${c.name}${c.rated_a ? ` · ${c.rated_a}A` : ''}`, 24, '#ffd6a8');
      lab.position.copy(p).setY(1.95);
      s.chainGroup.add(lab);
    }
  }, [chain]);

  // ── camera ────────────────────────────────────────────────────────
  // Not keyed on the data: the 30s poll replaces it, and reframing then would
  // yank the operator's orbit back mid-inspection.
  const sceneKey = useMemo(
    () => `${(topology?.rooms || []).map(r => r.id).join(',')}|${Object.keys(tree || {}).join(',')}`,
    [topology, tree]);
  useEffect(() => {
    const s = state.current;
    if (!s.camera || !s.span) return;
    const presets = {
      iso: [s.cx + s.span * 0.5, s.span * 0.5, s.span * 0.75],
      top: [s.cx, s.span * 1.0, 0.01],
      aisle: [s.cx - s.span * 0.3, 1.6, s.span * 0.2],
    };
    s.camera.position.set(...(presets[view] || presets.iso));
    s.controls.target.set(s.cx, 0.8, s.span * 0.12);
    s.controls.update();
  }, [view, sceneKey]);

  // ── focus one object (deep link from a device list) ───────────────
  useEffect(() => {
    const s = state.current;
    if (!focusId || !s.camera || !s.centres) return;
    const target = s.centres.get(focusId);
    if (!target) return;
    const from = s.camera.position.clone();
    const to = target.clone().add(new THREE.Vector3(6, 7, 8));
    const t0 = performance.now();
    const DUR = 650;                        // inside the brief's 1s budget
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / DUR);
      const e = 1 - (1 - k) ** 3;
      s.camera.position.lerpVectors(from, to, e);
      s.controls.target.lerp(target, e);
      s.controls.update();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }, [focusId]);

  const summary = useMemo(() => {
    const n = (assets || []).length;
    const objs = (topology?.rooms || []).reduce((a, r) => a + r.objects.length, 0);
    return tx(`3D 디지털트윈. 객체 ${objs}개, UPS ${n}대. 좌우 방향키로 객체를 선택하세요.`,
      `3D digital twin. ${objs} objects, ${n} UPS. Use left and right arrow keys to step through objects.`);
  }, [assets, topology]);

  return <div ref={ref} tabIndex={0} role="application" aria-label={summary}
    style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', outlineOffset: -2 }} />;
}
