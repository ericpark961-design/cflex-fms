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

export function layoutFloor(tree) {
  const rooms = []; let ox = 0;
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
      racks.forEach(r => { r.x = ox + 0.8 + (r.col - 0.5) * (RACK_W + 0.04); r.z = 0.6 + (r.row - 0.5) * (RACK_D + AISLE) - d / 2; r.face = r.row % 2 ? 1 : -1; });
      rooms.push({ location: locName, name: roomName, x: ox, w, d, racks, node: room });
      ox += w + ROOM_GAP;
    }
  }
  return { rooms, width: ox - ROOM_GAP, RACK_W, RACK_D };
}
