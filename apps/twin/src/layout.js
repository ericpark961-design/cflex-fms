// Turns the /v1/fms/floor tree into 3D positions. Rooms are laid side by side; racks inside a room
// use (row,col) parsed from the rack name ("A01", "B-07", "Row A Rack 7", "R2-C5"); otherwise sequential.
const RACK_W = 0.6, RACK_D = 1.2, AISLE = 1.2, ROOM_GAP = 2.0, PER_ROW = 10;

export function parseRack(name) {
  const s = String(name || '').trim();
  let m = s.match(/^([A-Za-z])[-_ ]?(\d{1,3})$/);                 // A01, B-07
  if (m) return { row: m[1].toUpperCase().charCodeAt(0) - 64, col: +m[2] };
  m = s.match(/row\s*([A-Za-z0-9]+).*?(?:rack|r)\s*(\d+)/i);     // Row A Rack 7
  if (m) { const r = isNaN(+m[1]) ? m[1].toUpperCase().charCodeAt(0) - 64 : +m[1]; return { row: r, col: +m[2] }; }
  m = s.match(/^R(\d+)[-_ ]?C(\d+)$/i);                           // R2-C5
  if (m) return { row: +m[1], col: +m[2] };
  return null;
}

/**
 * Arrange room boxes on a grid instead of one long row.
 *
 * Production has 31 rooms holding a single rack each (no rack names are
 * recorded), which in a single row is a ~100 m line that reads as empty from any
 * usable camera distance. A grid keeps the whole site in frame.
 *
 * @param boxes [{w, d}] in metres
 * @param cols  columns before wrapping
 * @returns {placed:[{x,z}], width, depth} — x,z are the CENTRE of each box
 */
export function packRooms(boxes, cols = 6) {
  const n = boxes.length;
  const perRow = Math.max(1, Math.min(cols, Math.ceil(Math.sqrt(n * 1.6))));
  const placed = [];
  let z = 0, width = 0;
  for (let i = 0; i < n; i += perRow) {
    const row = boxes.slice(i, i + perRow);
    const rowDepth = Math.max(...row.map(b => b.d));
    let x = 0;
    for (const b of row) {
      placed.push({ x: x + b.w / 2, z: z + rowDepth / 2 });
      x += b.w + ROOM_GAP;
    }
    width = Math.max(width, x - ROOM_GAP);
    z += rowDepth + ROOM_GAP;
  }
  return { placed, width, depth: Math.max(0, z - ROOM_GAP) };
}

export function layoutFloor(tree) {
  const rooms = [];
  for (const [locName, loc] of Object.entries(tree || {})) {
    for (const [roomName, room] of Object.entries(loc.rooms || {})) {
      const rackNames = Object.keys(room.racks || {});
      const parsed = rackNames.map(n => ({ n, p: parseRack(n) }));
      const anyParsed = parsed.some(x => x.p);
      let maxRow = 1, maxCol = 1; const racks = [];
      parsed.sort((a, b) => a.n.localeCompare(b.n, undefined, { numeric: true })).forEach((x, i) => {
        const p = anyParsed && x.p ? x.p : { row: Math.floor(i / PER_ROW) + 1, col: (i % PER_ROW) + 1 };
        maxRow = Math.max(maxRow, p.row); maxCol = Math.max(maxCol, p.col);
        racks.push({ name: x.n, row: p.row, col: p.col, node: room.racks[x.n] });
      });
      const w = maxCol * (RACK_W + 0.04) + 1.6, d = maxRow * (RACK_D + AISLE) + 1.2;
      rooms.push({ location: locName, name: roomName, w, d, racks, node: room, estimated: true });
    }
  }
  // Place the rooms, then position each rack relative to its room's centre.
  const { placed, width, depth } = packRooms(rooms);
  rooms.forEach((room, i) => {
    room.x = placed[i].x - room.w / 2;      // left edge, as callers expect
    room.z = placed[i].z;                   // centre, as the rack maths assumes
    room.racks.forEach(r => {
      r.x = room.x + 0.8 + (r.col - 0.5) * (RACK_W + 0.04);
      r.z = room.z + 0.6 + (r.row - 0.5) * (RACK_D + AISLE) - room.d / 2;
      r.face = r.row % 2 ? 1 : -1;
    });
  });
  return { rooms, width, depth, RACK_W, RACK_D };
}
