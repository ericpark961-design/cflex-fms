// node src/twin/rackElevation.test.mjs
//
// The elevation is the one place a rack is drawn as a column, so two things
// must hold: a unit with no U position must not be drawn as though it had one,
// and a rack must be identified by all four levels rather than by its name —
// "Rack A-04" exists in every site anyone has ever built.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inventory, rackMates } from '../tree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(path.join(here, rel), 'utf8');

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

t('a device with no U position is listed, not stacked at U1', () => {
  const el = src('RackElevation.jsx');
  // The original did `d.u_pos || 1`, so every unplaced unit was drawn in the
  // bottom slot, on top of each other, and read as a placement.
  assert.ok(!/u_pos \|\| 1/.test(el), 'no silent default to U1');
  assert.match(el, /unplaced/, 'unplaced units are accounted for instead');
  assert.match(el, /Number\.isFinite\(Number\(x\.d\.u_pos\)\)/,
    'placement is decided by whether a U position exists at all');
});

t('the column is to scale and comes from the one visual decision', () => {
  const el = src('RackElevation.jsx');
  assert.match(el, /44\.45/, '1U is 44.45 mm against a 19-inch (482.6 mm) width');
  assert.match(el, /from '\.\/deviceVisual'/, 'the picture comes from deviceVisual');
  assert.match(el, /unitU/, 'the height comes from the catalogue, not a constant');
  assert.match(el, /\.v\.tower/, 'a tower has no slot, so it is not drawn in the column');
});

t('a rack is four levels, not a name', () => {
  const rows = inventory({
    assets: [
      { id: 1, label: 'A', cbu: 'KMX', location: 'Pesqueria', room: 'MDF', rack: 'A-04', u_pos: 12, status: 'ok' },
      { id: 2, label: 'B', cbu: 'KUS', location: 'Irvine', room: 'MDF', rack: 'A-04', u_pos: 14, status: 'ok' },
    ],
    devices: [{ id: 9, label: 'C', cbu: 'KMX', location: 'Pesqueria', room: 'MDF', rack: 'A-04', u_pos: 20, kind: 'switch' }],
    devId: (x) => String(x),
  });
  const mates = rackMates(rows, { cbu: 'KMX', location: 'Pesqueria', room: 'MDF', rack: 'A-04' });
  assert.deepEqual(mates.map(m => m.label).sort(), ['A', 'C'],
    'the same rack name in another site is a different rack');
  assert.equal(rackMates(rows, { rack: '—' }).length, 0, 'no rack means no elevation');
  assert.equal(rackMates(rows, {}).length, 0);
});

t('both surfaces that can show a rack do show it', () => {
  const twin = src('../TwinScreen.jsx');
  assert.match(twin, /<RackElevation /, 'the 3D panel draws the elevation');
  assert.match(twin, /onRackView=\{\(n\) => ledgerRef\.current\?\.rackView\(n\)\}/,
    '랙 전면 보기 moves the camera to the rack face');
  assert.ok(!/U\{d\.u_pos \?\? '—'\}<\/span><b>\{d\.label\}/.test(twin),
    'the old text list was replaced, not left alongside the drawing');

  assert.match(src('../App.jsx'), /mountRackElevation\(root, devData\)/,
    'the device detail screen gets its own rack column');
  const mount = src('../rackElevation.jsx');
  assert.match(mount, /host\.isConnected/,
    'a fetch landing after the operator clicked away must not write into a dead node');
  assert.match(mount, /roots\.get\(host\)/, 'one React root per host, reused across renders');
  assert.match(mount, /rackMates/, 'the four-level match is shared with the tree');
  assert.ok(src('../screens/Device.tpl.html').includes('id="rack-elevation"'),
    'the template owns the placeholder');
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - a rack is drawn as a rack');
process.exit(fail ? 1 : 0);
