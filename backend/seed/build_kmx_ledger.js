#!/usr/bin/env node
// Regenerates backend/seed/kmx_ccr_topology.json from the demo scene's geometry.
//
//   node backend/seed/build_kmx_ledger.js > backend/seed/kmx_ccr_topology.json
//
// apps/twin/src/DemoScene.js places the KMX CCR room in metres around a centre
// origin. The ledger uses 600 mm tiles from the room's top-left corner, so this
// replays the same layout maths and converts. Keeping it as a script rather than
// a hand-written JSON means the seed can be rebuilt if the demo scene moves.
//
// Source of truth for the numbers below: DemoScene.js lines 4 (ROOM), 29-57
// (racks), 59-62 (CRAC), 64-67 (UPS/FM-200), 69-70 (sensors), 74 (leak zones).

const ROOM = { w: 14, d: 12.7, h: 3.0 };
const TILE = 0.6;

// metre (centre origin, +x right, +z down) → tile (top-left origin)
const toCol = (x) => Math.max(0, Math.round((x + ROOM.w / 2) / TILE));
const toRow = (z) => Math.max(0, Math.round((z + ROOM.d / 2) / TILE));

const objects = [];
const power_links = [];

// ── racks: 6 rows, 62 cabinets ──────────────────────────────────────
const rowSpec = [11, 11, 10, 10, 10, 10];
const rackW = 0.6, rackD = 1.2;
const rowNames = 'ABCDEF';
const empties = new Set(['A09', 'A10', 'C10', 'E09', 'E10', 'F07', 'F08', 'F09', 'F10']);
// DemoScene's per-rack design figures. They are design values, not telemetry, so
// they live in attrs — the real heat endpoint reads device readings instead, and
// the mock falls back to these so the heatmap has something to draw offline.
const special = { B07: { kw: 6.4, temp: 27.9 }, B02: { kw: 4.3, temp: 25.1 }, A04: { kw: 4.8, temp: 25.4 }, C01: { kw: 3.9, temp: 26.3 }, C03: { kw: 3.6, temp: 26.1 }, D05: { kw: 4.6, temp: 24.9 }, D06: { kw: 4.1, temp: 24.7 }, F03: { kw: 4.2, temp: 24.4 } };
let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };   // same PRNG and seed as DemoScene

let z = -ROOM.d / 2 + 1.9;
const rackNames = [];
rowSpec.forEach((n, ri) => {
  const rowLen = n * (rackW + 0.02);
  let x = -rowLen / 2 + rackW / 2 + (ri % 2 ? 0.3 : 0);
  const hotSide = ri % 2 === 0;                       // alternating hot/cold aisle
  for (let i = 0; i < n; i++) {
    const name = rowNames[ri] + String(i + 1).padStart(2, '0');
    const sp = special[name];
    const empty = empties.has(name);
    const kw = empty ? 0 : (sp ? sp.kw : +(0.6 + rnd() * 2.4).toFixed(1));
    const temp_c = empty ? 23.0 : (sp ? sp.temp : +(22.8 + rnd() * 1.8).toFixed(1));
    objects.push({
      name, kind: 'rack', col: toCol(x), row: toRow(z), w: 1, d: 2,
      face: hotSide ? 'S' : 'N', u_height: 42,
      attrs: { design_kw: kw, design_temp_c: temp_c, ...(empty ? { empty: true } : {}) },
    });
    rackNames.push(name);
    x += rackW + 0.02;
  }
  z += rackD + (ri % 2 === 0 ? 1.2 : 1.0);
});

// ── CRAC along the north wall ───────────────────────────────────────
[{ id: 'CRAC-1', x: -4.6, rt: 30 }, { id: 'CRAC-2', x: 0, rt: 30 }, { id: 'CRAC-3', x: 4.6, rt: 20 }]
  .forEach(c => objects.push({
    name: c.id, kind: 'crac', col: toCol(c.x), row: toRow(-ROOM.d / 2 + 0.5), w: 2, d: 2, face: 'S',
    attrs: { rt: c.rt },
  }));

// ── UPS cabinets on the east wall ───────────────────────────────────
[{ id: 'UPS-1', z: -3.0 }, { id: 'UPS-2', z: -1.6 }].forEach(u => objects.push({
  name: u.id, kind: 'ups_cabinet', col: toCol(ROOM.w / 2 - 0.6), row: toRow(u.z), w: 2, d: 2, face: 'W',
  attrs: { capacity_kw: 40 },
}));

// ── PDUs: one per rack row, at the row head ─────────────────────────
// The demo scene draws the power chain as a diagram rather than placed cabinets;
// the ledger needs real objects for it, so each row gets a PDU at its west end.
let pz = -ROOM.d / 2 + 1.9;
rowSpec.forEach((n, ri) => {
  objects.push({
    name: `PDU-${rowNames[ri]}`, kind: 'pdu_cabinet',
    col: toCol(-(n * (rackW + 0.02)) / 2 - 0.9), row: toRow(pz), w: 1, d: 2, face: 'E',
    attrs: { rated_a: 63 },
  });
  pz += rackD + (ri % 2 === 0 ? 1.2 : 1.0);
});

// ── panels ──────────────────────────────────────────────────────────
objects.push({ name: 'PANEL-A', kind: 'panel', col: toCol(ROOM.w / 2 - 0.3), row: toRow(-ROOM.d / 2 + 0.4), attrs: { rated_a: 200 } });
objects.push({ name: 'PANEL-B', kind: 'panel', col: toCol(ROOM.w / 2 - 0.3), row: toRow(ROOM.d / 2 - 0.4), attrs: { rated_a: 200 } });
objects.push({ name: 'UTILITY', kind: 'panel', col: toCol(-ROOM.w / 2 + 0.3), row: toRow(ROOM.d / 2 - 0.4), attrs: { utility: true, rated_a: 400 } });

// ── environment sensors ─────────────────────────────────────────────
[[-5, -3.2], [0, -3.2], [5, -3.2], [-5, 3.2], [0, 3.2], [5, 3.2]].forEach((p, i) => objects.push({
  name: `TH-${String(i + 1).padStart(2, '0')}`, kind: 'sensor', col: toCol(p[0]), row: toRow(p[1]), w: 1, d: 1,
  attrs: { metrics: ['temp_c', 'humidity'] },
}));

// ── leak zones (floor polygons under the CRACs and the UPS bay) ─────
const rect = (x, zc, w, d) => {
  const c0 = toCol(x - w / 2), r0 = toRow(zc - d / 2), c1 = toCol(x + w / 2), r1 = toRow(zc + d / 2);
  return [[c0, r0], [c1, r0], [c1, r1], [c0, r1]];
};
[
  { id: 'ZONE-1', x: -4.6, z: -ROOM.d / 2 + 1.1, w: 2.4, d: 1.4 },
  { id: 'ZONE-2', x: 0, z: -ROOM.d / 2 + 1.1, w: 2.4, d: 1.4 },
  { id: 'ZONE-3', x: 4.6, z: -ROOM.d / 2 + 1.1, w: 2.4, d: 1.4 },
  { id: 'ZONE-4', x: ROOM.w / 2 - 1.3, z: -2.3, w: 1.6, d: 2.6 },
].forEach(zn => objects.push({
  name: zn.id, kind: 'leak_zone', col: toCol(zn.x - zn.w / 2), row: toRow(zn.z - zn.d / 2),
  attrs: { zone_poly: rect(zn.x, zn.z, zn.w, zn.d) },
}));

// ── power chain: rack → row PDU → UPS → panel → utility ─────────────
// Rows A-C sit on the A side, D-F on the B side, which is what gives the
// demo scene its "UPS-A outage moves everything to B" what-if.
rowSpec.forEach((n, ri) => {
  const row = rowNames[ri];
  const pdu = `PDU-${row}`;
  const ups = ri < 3 ? 'UPS-1' : 'UPS-2';
  for (let i = 0; i < n; i++) {
    const name = row + String(i + 1).padStart(2, '0');
    if (empties.has(name)) continue;                 // an empty cabinet has nothing to feed
    power_links.push({ src: name, src_type: 'object', dst: pdu, dst_type: 'object', dst_port: `CB-${i + 1}`, rated_a: 16, phase: 'L' + (1 + (i % 3)) });
  }
  power_links.push({ src: pdu, src_type: 'object', dst: ups, dst_type: 'object', dst_port: `OUT-${ri + 1}`, rated_a: 63 });
});
power_links.push({ src: 'UPS-1', src_type: 'object', dst: 'PANEL-A', dst_type: 'object', circuit: 'LP-A1', rated_a: 200 });
power_links.push({ src: 'UPS-2', src_type: 'object', dst: 'PANEL-B', dst_type: 'object', circuit: 'LP-B1', rated_a: 200 });
power_links.push({ src: 'CRAC-1', src_type: 'object', dst: 'PANEL-A', dst_type: 'object', circuit: 'LP-A4', rated_a: 60 });
power_links.push({ src: 'CRAC-2', src_type: 'object', dst: 'PANEL-A', dst_type: 'object', circuit: 'LP-A5', rated_a: 60 });
power_links.push({ src: 'CRAC-3', src_type: 'object', dst: 'PANEL-B', dst_type: 'object', circuit: 'LP-B4', rated_a: 40 });
power_links.push({ src: 'PANEL-A', src_type: 'object', dst: 'UTILITY', dst_type: 'object', circuit: 'MAIN-A', rated_a: 400 });
power_links.push({ src: 'PANEL-B', src_type: 'object', dst: 'UTILITY', dst_type: 'object', circuit: 'MAIN-B', rated_a: 400 });

// DemoScene's six rack rows run past its own south wall: row F lands at z≈7.15
// while ROOM.d/2 is 6.35, so drawing the room at ROOM.d would leave 11 cabinets
// outside it. The ledger describes what is actually placed, so the room is sized
// to its contents (and is never smaller than the drawn box).
const extent = objects.reduce((m, o) => ({
  cols: Math.max(m.cols, o.col + (o.w ?? 1)),
  rows: Math.max(m.rows, o.row + (o.d ?? 2)),
}), { cols: Math.ceil(ROOM.w / TILE), rows: Math.ceil(ROOM.d / TILE) });

const doc = {
  cbu: 'KMX',
  rooms: [{
    location: 'KMX Pesquería', name: 'CCR',
    cols: extent.cols + 1, rows: extent.rows + 1,
    tile_mm: TILE * 1000, height_mm: ROOM.h * 1000,
    note: 'Extracted from apps/twin/src/DemoScene.js by backend/seed/build_kmx_ledger.js. Room sized to contents: DemoScene rack row F sits past its drawn south wall.',
    objects,
    devices: [],            // KMX has no polled UPS yet; devices attach when they are onboarded
    power_links,
  }],
};

process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
