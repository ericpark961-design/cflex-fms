// The inventory hierarchy, as a pure function so it can be tested without a DOM.
//
// CBU → 장소 → 룸 → 랙 → 장비. The server's /v1/fms/floor tree starts at the
// location and covers only ups_devices, so two sites with a room called "CCR"
// collapsed together and no switch ever appeared. This assembles the same five
// levels from the two feeds that make up the real inventory, which also means
// the screen works against the API that is already deployed.

export const UNSET = '(미지정)';

/** A rack holds whatever is bolted into it, so both feeds normalise to one shape. */
export function inventory({ assets = [], devices = [], devId = (x) => String(x) } = {}) {
  const rows = [];
  for (const a of assets) {
    rows.push({
      kind: 'ups', src: 'ups', id: devId(a.id), label: a.label || `ups-${devId(a.id)}`,
      cbu: a.cbu || null, location: a.location || null, room: a.room || null, rack: a.rack || null,
      u_pos: a.u_pos ?? null, rack_id: a.rack_id ?? null,
      status: a.status || 'nodata', ip: a.ip || null, vendor: a.vendor || null, model: a.model || null,
      polling_enabled: a.polling_enabled ?? null, last_polled: a.last_polled ?? null,
      editable: true,
    });
  }
  for (const d of devices) {
    rows.push({
      kind: d.kind || 'other', src: 'net', id: String(d.id), label: d.label,
      cbu: d.cbu || null, location: d.location || null, room: d.room || null, rack: d.rack || null,
      u_pos: d.u_pos ?? null, rack_id: d.rack_id ?? null,
      status: d.status || 'nodata', ip: d.ip || null, vendor: d.vendor || null, model: d.model || null,
      polling_enabled: null, last_polled: d.last_polled ?? null,
      ports: d.ports_total ? `${d.ports_up ?? '—'}/${d.ports_total}p` : null,
      editable: false,          // fms_devices gained PATCH; flipped on once deployed
    });
  }
  return rows;
}

const roll = () => ({ count: 0, ok: 0, warn: 0, critical: 0, nodata: 0 });

/**
 * Nest the rows and roll status up every level.
 *
 * `unreachable` counts as nodata, matching the freshness gate: a device nobody
 * could reach is not a device known to be in trouble, and showing it as a
 * distinct colour invites reading "unreachable" as a measurement.
 */
export function buildTree(rows) {
  const bump = (n, st) => {
    n.count++;
    if (st === 'ok') n.ok++;
    else if (st === 'warn') n.warn++;
    else if (st === 'critical') n.critical++;
    else n.nodata++;
  };
  const tree = new Map();
  for (const r of rows) {
    const c = r.cbu || UNSET, l = r.location || UNSET, m = r.room || UNSET, k = r.rack || UNSET;
    if (!tree.has(c)) tree.set(c, { name: c, ...roll(), locations: new Map() });
    const C = tree.get(c);
    if (!C.locations.has(l)) C.locations.set(l, { name: l, ...roll(), rooms: new Map() });
    const L = C.locations.get(l);
    if (!L.rooms.has(m)) L.rooms.set(m, { name: m, ...roll(), racks: new Map() });
    const M = L.rooms.get(m);
    if (!M.racks.has(k)) M.racks.set(k, { name: k, ...roll(), devices: [] });
    const K = M.racks.get(k);
    K.devices.push(r);
    for (const n of [C, L, M, K]) bump(n, r.status);
  }
  // Within a rack, order by U so the tree reads like the physical cabinet.
  for (const C of tree.values()) {
    for (const L of C.locations.values()) {
      for (const M of L.rooms.values()) {
        for (const K of M.racks.values()) {
          K.devices.sort((a, b) => (a.u_pos ?? 999) - (b.u_pos ?? 999) || String(a.label).localeCompare(String(b.label)));
        }
      }
    }
  }
  return tree;
}

/** Unassigned sorts last: it is a to-do list, not a site. */
export const sortedKeys = (map) =>
  [...map.keys()].sort((a, b) => (a === UNSET) - (b === UNSET) || String(a).localeCompare(String(b)));

/** Every expandable node key, for expand-all and for revealing search hits. */
export function allKeys(tree) {
  const keys = new Set();
  for (const [c, C] of tree) {
    keys.add(`c:${c}`);
    for (const [l, L] of C.locations) {
      keys.add(`l:${c}/${l}`);
      for (const [m, M] of L.rooms) {
        keys.add(`m:${c}/${l}/${m}`);
        for (const k of M.racks.keys()) keys.add(`k:${c}/${l}/${m}/${k}`);
      }
    }
  }
  return keys;
}

/** Free-text filter across the fields someone would actually search by. */
export function filterRows(rows, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(r => [r.label, r.ip, r.model, r.vendor, r.rack, r.room, r.location, r.cbu]
    .some(v => String(v || '').toLowerCase().includes(needle)));
}

/** Headline counts for the toolbar. */
export function totals(rows) {
  const t = { count: rows.length, ups: 0, net: 0, cbus: new Set(), racks: new Set(), unplaced: 0 };
  for (const r of rows) {
    if (r.src === 'ups') t.ups++; else t.net++;
    if (r.cbu) t.cbus.add(r.cbu);
    if (r.rack) t.racks.add(`${r.cbu}/${r.location}/${r.room}/${r.rack}`);
    else t.unplaced++;
  }
  return t;
}
