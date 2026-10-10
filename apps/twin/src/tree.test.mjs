// node src/tree.test.mjs
//
// The inventory tree is what the real rollout is driven from, so its shape and
// its roll-ups are asserted rather than eyeballed.
import assert from 'node:assert';
import { inventory, buildTree, sortedKeys, allKeys, filterRows, totals, UNSET } from './tree.js';

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

const ASSETS = [
  { id: 'ups-55', label: 'B07-UPS', cbu: 'KMX', location: 'KMX Pesquería', room: 'CCR', rack: 'B07', u_pos: 2, status: 'critical', polling_enabled: 0 },
  { id: 'ups-56', label: 'KMX-UPS-01', cbu: 'KMX', location: 'KMX Pesquería', room: 'CCR', rack: 'UPS-1', u_pos: 1, status: 'nodata', polling_enabled: 0 },
  { id: 'ups-10', label: 'HMA UPS PG-A', cbu: 'HMA', location: 'Parking Garage', room: 'PG-A', rack: null, status: 'ok', polling_enabled: 1 },
  { id: 'ups-11', label: 'orphan', cbu: null, location: null, room: null, rack: null, status: 'warn', polling_enabled: 1 },
];
const DEVICES = [
  { id: 7, label: 'MDF-CORE-1', kind: 'switch', cbu: 'KMX', location: 'KMX Pesquería', room: 'CCR', rack: 'A01', u_pos: 40, status: 'nodata', ports_total: 48, ports_up: 31 },
  { id: 8, label: 'A01-SW-2', kind: 'switch', cbu: 'KMX', location: 'KMX Pesquería', room: 'CCR', rack: 'A01', u_pos: 12, status: 'nodata' },
];
const rows = inventory({ assets: ASSETS, devices: DEVICES, devId: (v) => String(v).replace(/^ups-/, '') });

t('both inventories become one row set', () => {
  assert.equal(rows.length, 6);
  assert.equal(rows.filter(r => r.src === 'ups').length, 4);
  assert.equal(rows.filter(r => r.src === 'net').length, 2);
  assert.equal(rows.find(r => r.label === 'B07-UPS').id, '55', 'the ups- prefix is stripped so #/device?id= resolves');
});

t('a switch and a UPS in the same rack land in the same rack node', () => {
  const tree = buildTree(rows);
  const ccr = tree.get('KMX').locations.get('KMX Pesquería').rooms.get('CCR');
  assert.deepEqual(sortedKeys(ccr.racks), ['A01', 'B07', 'UPS-1']);
  assert.equal(ccr.racks.get('A01').count, 2);
  assert.deepEqual(ccr.racks.get('A01').devices.map(d => d.kind), ['switch', 'switch']);
});

t('CBU is the top level, so two sites cannot share a room node', () => {
  const tree = buildTree(inventory({
    assets: [
      { id: 1, label: 'a', cbu: 'KMX', location: 'L', room: 'CCR', rack: 'R1', status: 'ok' },
      { id: 2, label: 'b', cbu: 'HMA', location: 'L', room: 'CCR', rack: 'R1', status: 'ok' },
    ],
  }));
  assert.equal(tree.size, 2, 'one node per CBU');
  assert.equal(tree.get('KMX').locations.get('L').rooms.get('CCR').count, 1);
  assert.equal(tree.get('HMA').locations.get('L').rooms.get('CCR').count, 1);
});

t('status rolls up every level, and unreachable counts as nodata', () => {
  const tree = buildTree(inventory({
    assets: [
      { id: 1, label: 'a', cbu: 'C', location: 'L', room: 'M', rack: 'K', status: 'critical' },
      { id: 2, label: 'b', cbu: 'C', location: 'L', room: 'M', rack: 'K', status: 'unreachable' },
      { id: 3, label: 'c', cbu: 'C', location: 'L', room: 'M', rack: 'K', status: 'ok' },
      { id: 4, label: 'd', cbu: 'C', location: 'L', room: 'M2', rack: 'K2', status: 'warn' },
    ],
  }));
  const C = tree.get('C'), L = C.locations.get('L');
  assert.deepEqual([C.count, C.critical, C.warn, C.ok, C.nodata], [4, 1, 1, 1, 1]);
  assert.deepEqual([L.count, L.critical, L.warn, L.ok, L.nodata], [4, 1, 1, 1, 1]);
  const K = L.rooms.get('M').racks.get('K');
  assert.deepEqual([K.count, K.critical, K.ok, K.nodata], [3, 1, 1, 1], 'unreachable is nodata, not its own bucket');
});

t('a device with nothing assigned is visible under 미지정, not dropped', () => {
  const tree = buildTree(rows);
  const un = tree.get(UNSET);
  assert.ok(un, 'the unassigned CBU node exists');
  assert.equal(un.locations.get(UNSET).rooms.get(UNSET).racks.get(UNSET).devices[0].label, 'orphan');
  // The 44 HAEA UPS have no rack at all, so this path is the common case.
  const hma = tree.get('HMA').locations.get('Parking Garage').rooms.get('PG-A');
  assert.deepEqual([...hma.racks.keys()], [UNSET], 'no rack reads as 미지정');
});

t('미지정 sorts last — it is a to-do list, not a site', () => {
  const keys = sortedKeys(buildTree(rows));
  assert.equal(keys[keys.length - 1], UNSET);
  assert.deepEqual(keys.slice(0, 3), ['HMA', 'KMX', UNSET].slice(0, 3).sort((a, b) => (a === UNSET) - (b === UNSET) || a.localeCompare(b)));
});

t('a rack is ordered by U position, so it reads like the cabinet', () => {
  const a01 = buildTree(rows).get('KMX').locations.get('KMX Pesquería').rooms.get('CCR').racks.get('A01');
  assert.deepEqual(a01.devices.map(d => d.u_pos), [12, 40]);
});

t('search matches any field a person would type, and keys reveal the hits', () => {
  assert.equal(filterRows(rows, 'b07').length, 1);
  assert.equal(filterRows(rows, 'switch').length, 0, 'kind is not a search field; label/ip/model/place are');
  assert.equal(filterRows(rows, 'A01').length, 2, 'rack name matches');
  assert.equal(filterRows(rows, 'pesquería').length, 4, 'location matches');
  assert.equal(filterRows(rows, '').length, rows.length);
  const keys = allKeys(buildTree(filterRows(rows, 'A01')));
  assert.ok(keys.has('k:KMX/KMX Pesquería/CCR/A01'), 'the rack node can be expanded to the hit');
});

t('totals separate the two inventories and count what is unplaced', () => {
  const tt = totals(rows);
  assert.equal(tt.count, 6);
  assert.equal(tt.ups, 4);
  assert.equal(tt.net, 2);
  assert.deepEqual([...tt.cbus].sort(), ['HMA', 'KMX']);
  assert.equal(tt.racks.size, 3, 'A01, B07, UPS-1');
  assert.equal(tt.unplaced, 2, 'the two with no rack — what the rollout has to fill in');
});

t('an empty inventory is an empty tree, not a crash', () => {
  const tree = buildTree(inventory({}));
  assert.equal(tree.size, 0);
  assert.deepEqual(sortedKeys(tree), []);
  assert.equal(totals([]).count, 0);
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - the inventory tree nests and rolls up correctly');
process.exit(fail ? 1 : 0);
