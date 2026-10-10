// services/fms-topology.js — the placement ledger: rooms, objects, power links.
//
// One module behind both the HTTP routes and the seed script, so an imported
// ledger and a seeded one cannot drift.
//
// Coordinates are tiles (600 mm). Power links point load → upstream: `src`
// receives power, `dst` supplies it, so tracing a chain follows src → dst.
//
// Everything here is tenant-scoped. There is no query without a tenant_id.
const STALE_MS = 5 * 60 * 1000;                                   // same freshness gate as fms.routes.js
const FRESH = '(last_polled IS NOT NULL AND last_polled > ?)';
const EFF = `CASE WHEN ${FRESH} THEN status ELSE 'nodata' END`;

const MAX_CHAIN = 8;                                              // brief: trace at most 8 hops
const OBJ_KINDS = new Set(['rack', 'ups_cabinet', 'pdu_cabinet', 'panel', 'crac', 'sensor', 'leak_zone', 'door', 'pillar']);

const now = () => Date.now();
const parseAttrs = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };

// ── read: topology ──────────────────────────────────────────────────
function getTopology(db, tenantId, cbu) {
  const fresh = now() - STALE_MS;
  const cbuClause = cbu && cbu !== 'all' ? ' AND cbu=?' : '';
  const cbuParam = cbu && cbu !== 'all' ? [cbu] : [];

  const rooms = db.prepare(
    `SELECT id, cbu, location, name, cols, rows, tile_mm, height_mm
     FROM fms_rooms WHERE tenant_id=?${cbuClause} ORDER BY location, name`,
  ).all(tenantId, ...cbuParam);

  const objects = db.prepare(
    `SELECT id, room_id, name, kind, col, row, w, d, face, u_height, attrs
     FROM fms_racks WHERE tenant_id=? ORDER BY room_id, name`,
  ).all(tenantId);

  const devices = db.prepare(
    `SELECT id, label, location, room, rack, rack_id, u_pos, u_height, vendor, model,
            ${EFF} AS status,
            CASE WHEN ${FRESH} THEN health_score ELSE NULL END AS health_score,
            CASE WHEN ${FRESH} THEN battery_pct  ELSE NULL END AS battery_pct,
            CASE WHEN ${FRESH} THEN load_pct     ELSE NULL END AS load_pct,
            CASE WHEN ${FRESH} THEN temp_c       ELSE NULL END AS temp_c
     FROM ups_devices
     WHERE tenant_id=? AND decommissioned_at IS NULL${cbuClause}`,
  ).all(fresh, fresh, fresh, fresh, fresh, tenantId, ...cbuParam);

  const roomById = new Map(rooms.map(r => [r.id, { ...r, objects: [] }]));
  const objById = new Map();
  // Name match is the fallback path, so it is keyed exactly the way the floor
  // endpoint groups devices: location | room | rack.
  const objByKey = new Map();
  for (const o of objects) {
    const room = roomById.get(o.room_id);
    if (!room) continue;                                          // object in a room this CBU filter excluded
    const obj = { ...o, attrs: parseAttrs(o.attrs), devices: [] };
    room.objects.push(obj);
    objById.set(o.id, obj);
    objByKey.set(`${room.location}|${room.name}|${o.name}`, obj);
  }

  const unplaced = [];
  for (const d of devices) {
    const dev = {
      id: d.id, label: d.label, status: d.status, health_score: d.health_score,
      battery_pct: d.battery_pct, load_pct: d.load_pct, temp_c: d.temp_c,
      // vendor/model drive which photo-traced icon the 3D unit wears.
      vendor: d.vendor, model: d.model, kind: 'ups',
      u_pos: d.u_pos, u_height: d.u_height ?? 2,
    };
    // rack_id wins; otherwise fall back to the v2 string match.
    const target = (d.rack_id != null && objById.get(d.rack_id))
      || objByKey.get(`${d.location || 'Unknown Location'}|${d.room || 'Default Room'}|${d.rack || 'Default Rack'}`);
    if (target) target.devices.push(dev);
    else unplaced.push({ id: d.id, label: d.label, status: d.status, location: d.location, room: d.room, rack: d.rack });
  }
  return { rooms: [...roomById.values()], unplaced };
}

// ── read: heat cells ────────────────────────────────────────────────
// Rack-level values only; interpolation is the client's job (the brief puts IDW
// in the renderer so the API stays cheap and cacheable).
function getHeat(db, tenantId, cbu, metric) {
  const col = metric === 'temp' ? 'temp_c' : 'load_pct';
  const { rooms } = getTopology(db, tenantId, cbu);
  return rooms.map(r => ({
    id: r.id,
    cells: r.objects.flatMap(o => {
      const vals = o.devices.map(d => d[col]).filter(v => v != null);
      if (!vals.length) return [];                                // "데이터 없는 랙은 생략"
      return [{ col: o.col, row: o.row, v: Math.max(...vals) }];
    }),
  }));
}

// ── read: power chain ───────────────────────────────────────────────
function resolveNode(db, tenantId, type, id) {
  if (type === 'ups_device') {
    const d = db.prepare('SELECT id, label, rack_id FROM ups_devices WHERE id=? AND tenant_id=?').get(id, tenantId);
    return d ? { type, id: d.id, name: d.label, kind: 'ups_device', col: null, row: null, room_id: null } : null;
  }
  const o = db.prepare('SELECT id, name, kind, col, row, room_id FROM fms_racks WHERE id=? AND tenant_id=?').get(id, tenantId);
  return o ? { type: 'object', id: o.id, name: o.name, kind: o.kind, col: o.col, row: o.row, room_id: o.room_id } : null;
}

function traceChain(db, tenantId, startType, startId) {
  const start = resolveNode(db, tenantId, startType, startId);
  if (!start) return { chain: [], upstream_capacity_a: null };

  const chain = [start];
  const seen = new Set([`${start.type}:${start.id}`]);            // cycle guard — a mis-entered ledger must not hang the request
  let cur = start;

  for (let hop = 0; hop < MAX_CHAIN; hop++) {
    const link = db.prepare(
      `SELECT dst_type, dst_id, dst_port, src_port, circuit, rated_a, phase
       FROM fms_power_links WHERE tenant_id=? AND src_type=? AND src_id=? ORDER BY id LIMIT 1`,
    ).get(tenantId, cur.type, cur.id);
    if (!link) break;
    const key = `${link.dst_type}:${link.dst_id}`;
    if (seen.has(key)) break;                                     // cycle
    const node = resolveNode(db, tenantId, link.dst_type, link.dst_id);
    if (!node) break;
    seen.add(key);
    chain.push({ ...node, port: link.dst_port || link.src_port || null, circuit: link.circuit || null, rated_a: link.rated_a ?? null, phase: link.phase || null });
    cur = node;
  }
  // Weakest rated link in the chain — that is what actually limits the load.
  const rated = chain.map(c => c.rated_a).filter(v => v != null);
  return { chain, upstream_capacity_a: rated.length ? Math.min(...rated) : null };
}

function powerChainForDevice(db, tenantId, deviceId) {
  const id = parseInt(String(deviceId ?? '').replace(/^ups-/i, ''), 10);
  if (!Number.isFinite(id)) return { chain: [], load_pct: null, upstream_capacity_a: null };
  const fresh = now() - STALE_MS;
  const d = db.prepare(`SELECT CASE WHEN ${FRESH} THEN load_pct ELSE NULL END AS load_pct FROM ups_devices WHERE id=? AND tenant_id=?`).get(fresh, id, tenantId);
  const r = traceChain(db, tenantId, 'ups_device', id);
  return { ...r, load_pct: d?.load_pct ?? null };
}

function powerChainForObject(db, tenantId, objectId) {
  const id = parseInt(objectId, 10);
  if (!Number.isFinite(id)) return { chain: [], load_pct: null, upstream_capacity_a: null };
  const r = traceChain(db, tenantId, 'object', id);
  // An object's load is the worst of whatever sits in it.
  const fresh = now() - STALE_MS;
  const row = db.prepare(`SELECT MAX(CASE WHEN ${FRESH} THEN load_pct ELSE NULL END) AS load_pct FROM ups_devices WHERE rack_id=? AND tenant_id=?`).get(fresh, id, tenantId);
  return { ...r, load_pct: row?.load_pct ?? null };
}

// ── write: import ───────────────────────────────────────────────────
function importTopology(db, tenantId, doc, { mode = 'merge', cbu = null } = {}) {
  if (!doc || !Array.isArray(doc.rooms)) throw new Error('invalid ledger: rooms[] required');
  const theCbu = cbu || doc.cbu || null;
  const ts = now();
  const out = { rooms: 0, objects: 0, links: 0, placed_devices: 0, unplaced: [] };

  const run = () => {
    if (mode === 'replace') {
      // Only this CBU's rooms, so a replace of KMX cannot wipe HMA.
      const roomIds = db.prepare('SELECT id FROM fms_rooms WHERE tenant_id=? AND cbu IS ?').all(tenantId, theCbu).map(r => r.id);
      for (const rid of roomIds) {
        const objIds = db.prepare('SELECT id FROM fms_racks WHERE tenant_id=? AND room_id=?').all(tenantId, rid).map(o => o.id);
        for (const oid of objIds) {
          db.prepare('DELETE FROM fms_power_links WHERE tenant_id=? AND ((src_type=? AND src_id=?) OR (dst_type=? AND dst_id=?))').run(tenantId, 'object', oid, 'object', oid);
          db.prepare('UPDATE ups_devices SET rack_id=NULL WHERE tenant_id=? AND rack_id=?').run(tenantId, oid);
        }
        db.prepare('DELETE FROM fms_racks WHERE tenant_id=? AND room_id=?').run(tenantId, rid);
        db.prepare('DELETE FROM fms_rooms WHERE tenant_id=? AND id=?').run(tenantId, rid);
      }
    }

    for (const room of doc.rooms) {
      if (!room.location || !room.name) throw new Error('invalid ledger: room.location and room.name are required');
      db.prepare(
        `INSERT INTO fms_rooms (tenant_id, cbu, location, name, cols, rows, tile_mm, height_mm, note, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, location, name) DO UPDATE SET
           cbu=excluded.cbu, cols=excluded.cols, rows=excluded.rows,
           tile_mm=excluded.tile_mm, height_mm=excluded.height_mm, note=excluded.note, updated_at=excluded.updated_at`,
      ).run(tenantId, theCbu, room.location, room.name, room.cols ?? 20, room.rows ?? 12, room.tile_mm ?? 600, room.height_mm ?? 3000, room.note ?? null, ts);
      const roomRow = db.prepare('SELECT id FROM fms_rooms WHERE tenant_id=? AND location=? AND name=?').get(tenantId, room.location, room.name);
      const roomId = roomRow.id;
      out.rooms++;

      const objIdByName = new Map();
      for (const o of room.objects || []) {
        if (!o.name) throw new Error('invalid ledger: object.name is required');
        if (o.kind && !OBJ_KINDS.has(o.kind)) throw new Error(`invalid ledger: unknown object kind "${o.kind}"`);
        db.prepare(
          `INSERT INTO fms_racks (tenant_id, room_id, name, col, row, w, d, face, u_height, kind, attrs, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(tenant_id, room_id, name) DO UPDATE SET
             col=excluded.col, row=excluded.row, w=excluded.w, d=excluded.d, face=excluded.face,
             u_height=excluded.u_height, kind=excluded.kind, attrs=excluded.attrs, updated_at=excluded.updated_at`,
        ).run(tenantId, roomId, o.name, o.col ?? 0, o.row ?? 0, o.w ?? 1, o.d ?? 2, o.face ?? 'S', o.u_height ?? 42, o.kind ?? 'rack', o.attrs ? JSON.stringify(o.attrs) : null, ts);
        const row = db.prepare('SELECT id FROM fms_racks WHERE tenant_id=? AND room_id=? AND name=?').get(tenantId, roomId, o.name);
        objIdByName.set(o.name, row.id);
        out.objects++;
      }

      // Devices are matched by label (or numeric id) — the ledger does not create devices.
      const devIdByLabel = new Map();
      for (const d of room.devices || []) {
        const found = Number.isFinite(d.id)
          ? db.prepare('SELECT id, label FROM ups_devices WHERE id=? AND tenant_id=?').get(d.id, tenantId)
          : db.prepare('SELECT id, label FROM ups_devices WHERE label=? AND tenant_id=?').get(d.label, tenantId);
        if (!found) { out.unplaced.push(d.label ?? String(d.id)); continue; }
        const rackId = objIdByName.get(d.rack);
        if (rackId == null) { out.unplaced.push(d.label ?? String(d.id)); continue; }
        db.prepare('UPDATE ups_devices SET rack_id=?, u_pos=?, u_height=? WHERE id=? AND tenant_id=?')
          .run(rackId, d.u_pos ?? null, d.u_height ?? null, found.id, tenantId);
        devIdByLabel.set(found.label, found.id);
        out.placed_devices++;
      }

      const ref = (name, type) => {
        if (type === 'ups_device') {
          if (devIdByLabel.has(name)) return devIdByLabel.get(name);
          const d = db.prepare('SELECT id FROM ups_devices WHERE label=? AND tenant_id=?').get(name, tenantId);
          return d ? d.id : null;
        }
        return objIdByName.get(name) ?? null;
      };

      for (const l of room.power_links || []) {
        const srcType = l.src_type || 'object';
        const dstType = l.dst_type || 'object';
        const srcId = ref(l.src, srcType);
        const dstId = ref(l.dst, dstType);
        // A link to something that is not in the ledger is a ledger error, not a
        // silent no-op: a half-traced chain looks like "no upstream" on screen.
        if (srcId == null || dstId == null) throw new Error(`invalid ledger: power link references unknown ${srcId == null ? `${srcType} "${l.src}"` : `${dstType} "${l.dst}"`}`);
        db.prepare('DELETE FROM fms_power_links WHERE tenant_id=? AND src_type=? AND src_id=? AND dst_type=? AND dst_id=?').run(tenantId, srcType, srcId, dstType, dstId);
        db.prepare(
          `INSERT INTO fms_power_links (tenant_id, src_type, src_id, src_port, dst_type, dst_id, dst_port, circuit, rated_a, phase, note, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(tenantId, srcType, srcId, l.src_port ?? null, dstType, dstId, l.dst_port ?? null, l.circuit ?? null, l.rated_a ?? null, l.phase ?? null, l.note ?? null, ts);
        out.links++;
      }
    }
  };

  if (typeof db.transaction === 'function') db.transaction(run)();   // better-sqlite3
  else run();
  return out;
}

// ── write: export (round-trips with import) ─────────────────────────
function exportTopology(db, tenantId, cbu) {
  const cbuClause = cbu && cbu !== 'all' ? ' AND cbu IS ?' : '';
  const cbuParam = cbu && cbu !== 'all' ? [cbu] : [];
  const rooms = db.prepare(
    `SELECT id, cbu, location, name, cols, rows, tile_mm, height_mm, note
     FROM fms_rooms WHERE tenant_id=?${cbuClause} ORDER BY location, name`,
  ).all(tenantId, ...cbuParam);

  const out = { cbu: cbu && cbu !== 'all' ? cbu : (rooms[0]?.cbu ?? null), rooms: [] };
  for (const r of rooms) {
    const objects = db.prepare(
      'SELECT id, name, kind, col, row, w, d, face, u_height, attrs FROM fms_racks WHERE tenant_id=? AND room_id=? ORDER BY name',
    ).all(tenantId, r.id);
    const nameById = new Map(objects.map(o => [o.id, o.name]));

    const devices = db.prepare(
      'SELECT d.label, d.u_pos, d.u_height, r.name AS rack FROM ups_devices d JOIN fms_racks r ON r.id=d.rack_id WHERE d.tenant_id=? AND r.room_id=? ORDER BY d.label',
    ).all(tenantId, r.id);
    const devNameById = new Map(
      db.prepare('SELECT d.id, d.label FROM ups_devices d JOIN fms_racks r ON r.id=d.rack_id WHERE d.tenant_id=? AND r.room_id=?').all(tenantId, r.id).map(x => [x.id, x.label]),
    );

    const objIds = objects.map(o => o.id);
    const links = objIds.length
      ? db.prepare(
        `SELECT src_type, src_id, src_port, dst_type, dst_id, dst_port, circuit, rated_a, phase, note
         FROM fms_power_links WHERE tenant_id=?
           AND ((src_type='object' AND src_id IN (${objIds.map(() => '?').join(',')}))
             OR (dst_type='object' AND dst_id IN (${objIds.map(() => '?').join(',')})))
         ORDER BY id`,
      ).all(tenantId, ...objIds, ...objIds)
      : [];

    const label = (type, id) => (type === 'object' ? nameById.get(id) : (devNameById.get(id) ?? db.prepare('SELECT label FROM ups_devices WHERE id=? AND tenant_id=?').get(id, tenantId)?.label));
    out.rooms.push({
      location: r.location, name: r.name, cols: r.cols, rows: r.rows, tile_mm: r.tile_mm, height_mm: r.height_mm,
      ...(r.note ? { note: r.note } : {}),
      objects: objects.map(o => ({
        name: o.name, kind: o.kind, col: o.col, row: o.row, w: o.w, d: o.d, face: o.face, u_height: o.u_height,
        ...(parseAttrs(o.attrs) ? { attrs: parseAttrs(o.attrs) } : {}),
      })),
      devices: devices.map(d => ({ label: d.label, rack: d.rack, ...(d.u_pos != null ? { u_pos: d.u_pos } : {}), ...(d.u_height != null ? { u_height: d.u_height } : {}) })),
      power_links: links.map(l => ({
        src: label(l.src_type, l.src_id), src_type: l.src_type, ...(l.src_port ? { src_port: l.src_port } : {}),
        dst: label(l.dst_type, l.dst_id), dst_type: l.dst_type, ...(l.dst_port ? { dst_port: l.dst_port } : {}),
        ...(l.circuit ? { circuit: l.circuit } : {}), ...(l.rated_a != null ? { rated_a: l.rated_a } : {}),
        ...(l.phase ? { phase: l.phase } : {}), ...(l.note ? { note: l.note } : {}),
      })).filter(l => l.src && l.dst),
    });
  }
  return out;
}

module.exports = { getTopology, getHeat, powerChainForDevice, powerChainForObject, importTopology, exportTopology, MAX_CHAIN, OBJ_KINDS };
