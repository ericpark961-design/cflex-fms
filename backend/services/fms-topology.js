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
const OBJ_KINDS = new Set(['rack', 'ups_cabinet', 'pdu_cabinet', 'panel', 'crac', 'sensor', 'leak_zone', 'door', 'pillar', 'fm200', 'smoke']);

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

  // Non-UPS equipment, merged into the same racks with `kind` so the 3D scene and
  // the rack elevation see one list. /v1/fms/assets stays UPS-only.
  const netDevices = db.prepare(
    `SELECT id, label, kind, vendor, model, serial, ip, rack_id, u_pos, u_height,
            location, room, rack, status, last_polled, ports_total, ports_up, attrs
     FROM fms_devices WHERE tenant_id=? AND decommissioned_at IS NULL${cbuClause}`,
  ).all(tenantId, ...cbuParam);

  const unplaced = [];
  for (const n of netDevices) {
    const dev = {
      id: `fd-${n.id}`, label: n.label, kind: n.kind, vendor: n.vendor, model: n.model,
      serial: n.serial, ip: n.ip, status: n.status || 'nodata',
      u_pos: n.u_pos, u_height: n.u_height ?? 1,
      ports_total: n.ports_total, ports_up: n.ports_up, attrs: parseAttrs(n.attrs),
    };
    const target = (n.rack_id != null && objById.get(n.rack_id))
      || objByKey.get(`${n.location || 'Unknown Location'}|${n.room || 'Default Room'}|${n.rack || 'Default Rack'}`);
    if (target) target.devices.push(dev);
    else unplaced.push({ id: dev.id, label: n.label, kind: n.kind, status: dev.status, location: n.location, room: n.room, rack: n.rack });
  }

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
    if (target) { target.devices.push(dev); dev._room = target.room_id; dev._rack = target.name; }
    else unplaced.push({ id: d.id, label: d.label, status: d.status, location: d.location, room: d.room, rack: d.rack });
  }

  // Also emit the §8 room-level shape (devices[] + power_links[]). The ledger
  // renderer consumes that directly, so neither side needs an adapter, and with
  // power_links present it can trace a chain without a second request.
  const out = [...roomById.values()];
  // Every endpoint must be nameable, including links that terminate on a device
  // rather than an object — otherwise the renderer silently loses those hops.
  const upsNames = new Map(devices.map(d => [d.id, d.label]));
  const netNames = new Map(netDevices.map(d => [d.id, d.label]));
  for (const room of out) {
    const objIds = room.objects.map(o => o.id);
    const nameById = new Map(room.objects.map(o => [o.id, o.name]));
    const nameOf = (type, id) => (type === 'object' ? nameById.get(id)
      : type === 'device' ? netNames.get(id)
        : upsNames.get(id));
    room.devices = room.objects.flatMap(o => o.devices.map(d => ({ ...d, rack: o.name })));
    room.power_links = objIds.length
      ? db.prepare(
        `SELECT src_type, src_id, src_port, dst_type, dst_id, dst_port, circuit, rated_a, phase
         FROM fms_power_links WHERE tenant_id=?
           AND ((src_type='object' AND src_id IN (${objIds.map(() => '?').join(',')}))
             OR (dst_type='object' AND dst_id IN (${objIds.map(() => '?').join(',')})))
         ORDER BY id`,
      ).all(tenantId, ...objIds, ...objIds).map(l => ({
        src: nameOf(l.src_type, l.src_id), src_type: l.src_type, ...(l.src_port ? { src_port: l.src_port } : {}),
        dst: nameOf(l.dst_type, l.dst_id), dst_type: l.dst_type, ...(l.dst_port ? { dst_port: l.dst_port } : {}),
        ...(l.circuit ? { circuit: l.circuit } : {}), ...(l.rated_a != null ? { rated_a: l.rated_a } : {}),
        ...(l.phase ? { phase: l.phase } : {}),
      })).filter(l => l.src && l.dst)
      : [];
  }
  return { rooms: out, unplaced };
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
  if (type === 'device') {
    const d = db.prepare('SELECT id, label, kind, rack_id FROM fms_devices WHERE id=? AND tenant_id=?').get(id, tenantId);
    return d ? { type, id: d.id, name: d.label, kind: d.kind, col: null, row: null, room_id: null } : null;
  }
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

      // A polled UPS already exists in ups_devices and is only placed here. Anything
      // else (network, UC, server, and design-stage UPS that are not polled yet)
      // becomes an fms_devices row, so the ledger can describe a room before a
      // collector reaches it.
      const upsIdByLabel = new Map();
      const netIdByLabel = new Map();
      for (const d of room.devices || []) {
        const rackId = objIdByName.get(d.rack);
        if (rackId == null) { out.unplaced.push(d.label ?? String(d.id)); continue; }
        const existing = Number.isFinite(d.id)
          ? db.prepare('SELECT id, label FROM ups_devices WHERE id=? AND tenant_id=?').get(d.id, tenantId)
          : db.prepare('SELECT id, label FROM ups_devices WHERE label=? AND tenant_id=?').get(d.label, tenantId);
        if (existing) {
          db.prepare('UPDATE ups_devices SET rack_id=?, u_pos=?, u_height=? WHERE id=? AND tenant_id=?')
            .run(rackId, d.u_pos ?? null, d.u_height ?? null, existing.id, tenantId);
          upsIdByLabel.set(existing.label, existing.id);
          out.placed_devices++;
          continue;
        }
        if (!d.label) { out.unplaced.push(String(d.id)); continue; }

        // A UPS belongs in ups_devices even before a collector reaches it
        // (부록 K1). It used to land in fms_devices, which meant the same unit
        // existed twice as soon as polling started, and it stayed invisible to
        // the dashboard KPIs, the CBU toggle, the device list and the alarm map
        // — all of which read ups_devices. That table is the single source of
        // truth for a UPS; fms_devices keeps the network/UC/server gear.
        if ((d.kind || '') === 'ups') {
          // ups_devices has no UNIQUE(tenant_id, label) — tenant 1 still carries
          // a duplicate BULK-TEST-01 from an old CSV import — so this is a
          // select-then-write rather than an upsert. Adding the constraint would
          // fail on that row, and deleting another tenant's data to make a
          // migration pass is not this service's call.
          const prior = db.prepare('SELECT id, ip FROM ups_devices WHERE tenant_id=? AND label=? LIMIT 1').get(tenantId, d.label);
          let upsId = prior?.id ?? null;
          if (prior) {
            db.prepare(`UPDATE ups_devices SET cbu=?, location=?, room=?, rack=?, rack_id=?, u_pos=?, u_height=?,
                               vendor=COALESCE(?, vendor), model=COALESCE(?, model), serial=COALESCE(?, serial),
                               ip=COALESCE(ip, ?), updated_at=?
                        WHERE id=?`)
              .run(theCbu, room.location, room.name, d.rack, rackId, d.u_pos ?? null, d.u_height ?? null,
                d.vendor ?? null, d.model ?? null, d.serial ?? null, d.ip ?? null, ts, prior.id);
          } else {
            // status stays nodata and polling stays off: a ledger entry is a
            // design document, and it must never make a device look healthy or
            // start a poller against an unconfirmed address.
            const r = db.prepare(
              `INSERT INTO ups_devices (tenant_id, label, cbu, location, room, rack, rack_id, u_pos, u_height,
                                        vendor, model, serial, ip, criticality, status, polling_enabled,
                                        created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'nodata', 0, ?, ?)`,
            ).run(tenantId, d.label, theCbu, room.location, room.name, d.rack, rackId,
              d.u_pos ?? null, d.u_height ?? null, d.vendor ?? null, d.model ?? null, d.serial ?? null,
              d.ip ?? null, d.criticality ?? null, ts, ts);
            upsId = r.lastInsertRowid;
            out.ups_registered = (out.ups_registered || 0) + 1;
          }
          if (upsId != null) {
            upsIdByLabel.set(d.label, upsId);
            // Drop the duplicate an earlier import left in fms_devices — and its
            // power links with it. Deleting only the row left the links pointing
            // at a device id that no longer existed, so a chain trace walked into
            // the dangling edge and stopped: B07-UPS traced to PDU-A and no
            // further, while the correct ups_device link sat beside it unused.
            const stale = db.prepare('SELECT id FROM fms_devices WHERE tenant_id=? AND label=? AND kind=?').get(tenantId, d.label, 'ups');
            if (stale) {
              const cut = db.prepare(
                `DELETE FROM fms_power_links WHERE tenant_id=?
                   AND ((src_type='device' AND src_id=?) OR (dst_type='device' AND dst_id=?))`,
              ).run(tenantId, stale.id, stale.id);
              db.prepare('DELETE FROM fms_devices WHERE id=? AND tenant_id=?').run(stale.id, tenantId);
              out.ups_dedup = (out.ups_dedup || 0) + 1;
              out.links_repaired = (out.links_repaired || 0) + (cut.changes || 0);
            }
            out.placed_devices++;
          } else {
            out.unplaced.push(d.label);
          }
          continue;
        }

        // status is NOT taken from the ledger: without a collector it stays nodata,
        // so a design document can never make a device look healthy.
        db.prepare(
          `INSERT INTO fms_devices (tenant_id, cbu, kind, label, vendor, model, serial, ip, rack_id, u_pos, u_height, location, room, rack, status, ports_total, ports_up, attrs, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'nodata',?,?,?,?)
           ON CONFLICT(tenant_id, label) DO UPDATE SET
             cbu=excluded.cbu, kind=excluded.kind, vendor=excluded.vendor, model=excluded.model,
             serial=excluded.serial, ip=excluded.ip, rack_id=excluded.rack_id, u_pos=excluded.u_pos,
             u_height=excluded.u_height, location=excluded.location, room=excluded.room, rack=excluded.rack,
             ports_total=excluded.ports_total, ports_up=excluded.ports_up, attrs=excluded.attrs, updated_at=excluded.updated_at`,
        ).run(tenantId, theCbu, d.kind || 'other', d.label, d.vendor ?? null, d.model ?? null, d.serial ?? null, d.ip ?? null,
          rackId, d.u_pos ?? null, d.u_height ?? null, room.location, room.name, d.rack,
          d.ports_total ?? null, d.ports_up ?? null, d.attrs ? JSON.stringify(d.attrs) : null, ts);
        const row = db.prepare('SELECT id FROM fms_devices WHERE tenant_id=? AND label=?').get(tenantId, d.label);
        netIdByLabel.set(d.label, row.id);
        out.devices = (out.devices || 0) + 1;
        out.placed_devices++;
      }

      // Returns [id, resolvedType]. A ledger may call something a "ups_device" that
      // is not polled yet; it resolves to its fms_devices row instead, and binds to
      // the real row on the next import once a collector creates it.
      const ref = (name, type) => {
        if (type === 'object') return [objIdByName.get(name) ?? null, 'object'];
        if (type === 'ups_device') {
          if (upsIdByLabel.has(name)) return [upsIdByLabel.get(name), 'ups_device'];
          const d = db.prepare('SELECT id FROM ups_devices WHERE label=? AND tenant_id=?').get(name, tenantId);
          if (d) return [d.id, 'ups_device'];
        }
        if (netIdByLabel.has(name)) return [netIdByLabel.get(name), 'device'];
        const n = db.prepare('SELECT id FROM fms_devices WHERE label=? AND tenant_id=?').get(name, tenantId);
        return n ? [n.id, 'device'] : [null, type];
      };

      for (const l of room.power_links || []) {
        const [srcId, srcType] = ref(l.src, l.src_type || 'object');
        const [dstId, dstType] = ref(l.dst, l.dst_type || 'object');
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

    const upsRows = db.prepare(
      'SELECT d.id, d.label, d.u_pos, d.u_height, r.name AS rack FROM ups_devices d JOIN fms_racks r ON r.id=d.rack_id WHERE d.tenant_id=? AND r.room_id=? ORDER BY d.label',
    ).all(tenantId, r.id);
    const netRows = db.prepare(
      `SELECT d.id, d.label, d.kind, d.vendor, d.model, d.serial, d.ip, d.u_pos, d.u_height,
              d.ports_total, d.ports_up, d.attrs, r.name AS rack
       FROM fms_devices d JOIN fms_racks r ON r.id=d.rack_id
       WHERE d.tenant_id=? AND r.room_id=? AND d.decommissioned_at IS NULL ORDER BY d.label`,
    ).all(tenantId, r.id);
    const devices = [
      ...upsRows.map(d => ({ label: d.label, kind: 'ups', rack: d.rack, ...(d.u_pos != null ? { u_pos: d.u_pos } : {}), ...(d.u_height != null ? { u_height: d.u_height } : {}) })),
      ...netRows.map(d => ({
        label: d.label, kind: d.kind, rack: d.rack,
        ...(d.vendor ? { vendor: d.vendor } : {}), ...(d.model ? { model: d.model } : {}),
        ...(d.serial ? { serial: d.serial } : {}), ...(d.ip ? { ip: d.ip } : {}),
        ...(d.u_pos != null ? { u_pos: d.u_pos } : {}), ...(d.u_height != null ? { u_height: d.u_height } : {}),
        ...(d.ports_total != null ? { ports_total: d.ports_total } : {}), ...(d.ports_up != null ? { ports_up: d.ports_up } : {}),
        ...(parseAttrs(d.attrs) ? { attrs: parseAttrs(d.attrs) } : {}),
      })),
    ];
    // Links can terminate on a ups_devices row OR an fms_devices row; both must be
    // nameable or the export silently drops them (22 of 80 went missing before this).
    const upsNameById = new Map(upsRows.map(x => [x.id, x.label]));
    const netNameById = new Map(netRows.map(x => [x.id, x.label]));

    const objIds = objects.map(o => o.id);
    const upsIds = [...upsNameById.keys()], netIds = [...netNameById.keys()];
    const inList = (col, ids) => (ids.length ? `${col} IN (${ids.map(() => '?').join(',')})` : '0');
    const links = objIds.length
      ? db.prepare(
        `SELECT src_type, src_id, src_port, dst_type, dst_id, dst_port, circuit, rated_a, phase, note
         FROM fms_power_links WHERE tenant_id=?
           AND ((src_type='object' AND ${inList('src_id', objIds)})
             OR (dst_type='object' AND ${inList('dst_id', objIds)})
             OR (src_type='ups_device' AND ${inList('src_id', upsIds)})
             OR (dst_type='ups_device' AND ${inList('dst_id', upsIds)})
             OR (src_type='device' AND ${inList('src_id', netIds)})
             OR (dst_type='device' AND ${inList('dst_id', netIds)}))
         ORDER BY id`,
      ).all(tenantId, ...objIds, ...objIds, ...upsIds, ...upsIds, ...netIds, ...netIds)
      : [];

    const label = (type, id) => {
      if (type === 'object') return nameById.get(id);
      if (type === 'device') return netNameById.get(id) ?? db.prepare('SELECT label FROM fms_devices WHERE id=? AND tenant_id=?').get(id, tenantId)?.label;
      return upsNameById.get(id) ?? db.prepare('SELECT label FROM ups_devices WHERE id=? AND tenant_id=?').get(id, tenantId)?.label;
    };
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

// ── read: non-UPS equipment ─────────────────────────────────────────
// /v1/fms/assets stays UPS-only; this is the matching surface for everything else.
function listDevices(db, tenantId, { cbu, kind } = {}) {
  const where = ['tenant_id=?', 'decommissioned_at IS NULL'];
  const params = [tenantId];
  if (cbu && cbu !== 'all') { where.push('cbu=?'); params.push(cbu); }
  if (kind) { where.push('kind=?'); params.push(kind); }
  return db.prepare(
    `SELECT id, cbu, kind, label, vendor, model, serial, ip, rack_id, u_pos, u_height,
            location, room, rack, status, last_polled, ports_total, ports_up, attrs
     FROM fms_devices WHERE ${where.join(' AND ')} ORDER BY label`,
  ).all(...params).map(d => ({ ...d, attrs: parseAttrs(d.attrs) }));
}

function getDevice(db, tenantId, id) {
  const n = parseInt(String(id ?? '').replace(/^fd-/i, ''), 10);
  if (!Number.isFinite(n)) return null;
  const d = db.prepare('SELECT * FROM fms_devices WHERE id=? AND tenant_id=?').get(n, tenantId);
  if (!d) return null;
  return { ...d, attrs: parseAttrs(d.attrs), chain: traceChain(db, tenantId, 'device', n) };
}

module.exports = { getTopology, getHeat, listDevices, getDevice, powerChainForDevice, powerChainForObject, importTopology, exportTopology, MAX_CHAIN, OBJ_KINDS };
