// node src/twin/deviceFaces.test.mjs
//
// A faceplate is only worth drawing if it matches the unit: the point of
// generating it is that a 24-port switch is not drawn as a 48-port one.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deviceFace } from './deviceFaces.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(path.join(here, ...p), 'utf8');

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};
// RJ45/keystone cavities are the rects drawn with the thin rim stroke.
const cavities = (svg) => (svg.match(/<rect[^>]*stroke-width="\.7"/g) || []).length;
const lit = (svg) => (svg.match(/fill="#2bd07a"/g) || []).length;

t('port count drives the drawing', () => {
  const p48 = deviceFace({ kind: 'switch', label: 'A', model: 'C9300-48P', ports_total: 48, ports_up: 0 });
  const p24 = deviceFace({ kind: 'switch', label: 'B', model: 'C9200-24P', ports_total: 24, ports_up: 0 });
  assert.equal(cavities(p48.svg) - 4, 48, '48 ports plus the 4 uplink bays');
  assert.equal(cavities(p24.svg) - 4, 24, '24 ports plus the 4 uplink bays');
  assert.ok(p48.w > p24.w, 'and a 48-port chassis is drawn wider');
});

t('the ports reported up are lit, and the caption refuses to imply which', () => {
  const none = deviceFace({ kind: 'switch', label: 'A', model: 'm', ports_total: 24, ports_up: 0 });
  const some = deviceFace({ kind: 'switch', label: 'A', model: 'm', ports_total: 24, ports_up: 18 });
  const all  = deviceFace({ kind: 'switch', label: 'A', model: 'm', ports_total: 24, ports_up: 24 });
  // Two status LEDs are green on every switch, so compare against that floor.
  assert.ok(lit(some.svg) > lit(none.svg), 'more link lights with more ports up');
  assert.ok(lit(all.svg) > lit(some.svg));
  assert.match(some.caption, /24포트 · 링크 업 18/);
  assert.match(some.caption, /실제 포트 번호가 아님/, 'the drawing lights a count, not the real port positions');
});

t('ports_up is clamped to what exists', () => {
  const f = deviceFace({ kind: 'switch', label: 'A', model: 'm', ports_total: 8, ports_up: 99 });
  assert.match(f.caption, /8포트 · 링크 업 8/);
  const neg = deviceFace({ kind: 'switch', label: 'A', model: 'm', ports_total: 8, ports_up: -3 });
  assert.match(neg.caption, /링크 업 0/);
});

t('a passive panel is not described as having links', () => {
  const patch = deviceFace({ kind: 'patch', label: 'PP', model: 'Cat6A', ports_total: 48 });
  assert.equal(cavities(patch.svg), 48);
  assert.ok(!/링크 업/.test(patch.caption), 'a patch panel has no link state');
  const pdu = deviceFace({ kind: 'pdu', label: 'PDU', model: 'AP8653', ports_total: 24 });
  assert.ok(!/링크 업/.test(pdu.caption));
});

t('each kind gets its own faceplate', () => {
  const kinds = ['switch', 'router', 'server', 'storage', 'sbc', 'patch', 'pdu', 'other', undefined];
  const seen = new Set();
  for (const kind of kinds) {
    const f = deviceFace({ kind, label: 'X', model: 'M', ports_total: 8, ports_up: 2 });
    assert.ok(f.svg.startsWith('<svg'), `${kind} produces an svg`);
    assert.match(f.svg, /viewBox="0 0 \d+(\.\d+)? \d+(\.\d+)?"/);
    assert.ok(f.w > 0 && f.h > 0);
    seen.add(f.svg.length);
  }
  assert.ok(seen.size >= 5, 'the kinds are not all the same drawing');
});

t('no vendor logo or wordmark is drawn — only the model text from the record', () => {
  const f = deviceFace({ kind: 'switch', label: 'ACC-A', model: 'Catalyst 9300-48P', ports_total: 48, ports_up: 30 });
  assert.ok(f.svg.includes('Catalyst 9300-48P'), 'the model string is rendered as supplied');
  // Nothing beyond the record's own text claims a brand.
  const literals = f.svg.replace(/Catalyst 9300-48P|ACC-A/g, '');
  for (const brand of ['cisco', 'apc', 'schneider', 'juniper', 'aruba', 'dell', 'hpe']) {
    assert.ok(!new RegExp(brand, 'i').test(literals), `no built-in "${brand}" marking`);
  }
  assert.ok(!/<image\b/.test(f.svg), 'no embedded raster of a product photo');
});

t('text from the database cannot break out of the markup', () => {
  const f = deviceFace({ kind: 'switch', label: '<script>x</script>', model: '"><rect/>', ports_total: 8, ports_up: 0 });
  assert.ok(!f.svg.includes('<script>'), 'label is escaped');
  assert.ok(f.svg.includes('&lt;script&gt;'));
  assert.ok(!/"><rect\/>/.test(f.svg.replace(/&quot;/g, '')), 'model cannot close an attribute');
});

t('a device with no port count still gets a panel and says so', () => {
  const f = deviceFace({ kind: 'switch', label: 'A', model: '' });
  assert.ok(f.svg.startsWith('<svg'));
  assert.match(f.caption, /포트 수 미수집/);
  assert.equal(cavities(f.svg) - 4, 0, 'no ports are drawn for a count nothing measured');
  assert.ok(f.svg.includes('포트 수 미수집'), 'the bezel says so instead');
  const srv = deviceFace({ kind: 'server', label: 'S', model: '' });
  assert.match(srv.caption, /포트 수 미수집/);
});

t('missing input is drawn, not thrown', () => {
  for (const arg of [undefined, {}, { kind: null, label: null, model: null }]) {
    const f = deviceFace(arg);
    assert.ok(f.svg.startsWith('<svg'));
    assert.ok(f.caption);
  }
});

t('the detail screen mounts it, and the template owns the placeholder', () => {
  const tpl = read('..', 'screens', 'Device.tpl.html');
  const app = read('..', 'App.jsx');
  const face = read('..', 'deviceFace.js');
  assert.ok(tpl.includes('id="device-face"'), 'the template carries the placeholder');
  assert.match(app, /mountDeviceFace\(root, devData\)/, 'the device route mounts it');
  assert.match(face, /iconIdForModel/, 'APC units reuse the traced SVGs shared with 1.x');
  assert.match(face, /deviceFace\(\{/, 'everything else is drawn from its own record');
});

t('a power chain is accepted in either shape it arrives in', async () => {
  // getDevice() returns traceChain()'s envelope { chain, upstream_capacity_a };
  // /v1/fms/power-chain/* puts the array at the top level. Assuming the array
  // shape is what threw "(i.chain || []).map is not a function" on every
  // network device.
  const src = read('..', 'data.js');
  assert.match(src, /export const chainOf = /, 'one helper takes either shape');
  assert.match(src, /chainOf\(d\.chain\)\.map/, 'netDeviceData uses it');
  assert.ok(!/\(d\.chain \|\| \[\]\)\.map/.test(src), 'the array assumption is gone');

  const chainOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.chain) ? v.chain : []);
  assert.equal(chainOf({ chain: [1, 2], upstream_capacity_a: 16 }).length, 2);
  assert.equal(chainOf([1]).length, 1);
  for (const junk of [undefined, null, 42, {}, { chain: 'x' }]) assert.equal(chainOf(junk).length, 0);
});

t('the detail screen has no hard-coded illustration left', () => {
  const tpl = read('..', 'screens', 'Device.tpl.html');
  // A CSS-drawn panel used to sit in the spec column saying "SRT 5000 /
  // ON BATTERY / RT 18 MIN" for every device — including a Cisco switch.
  for (const lie of ['SRT 5000', 'ON BATTERY', 'RT 18 MIN']) {
    assert.ok(!tpl.includes(lie), `no hard-coded "${lie}" under an arbitrary device`);
  }
  assert.ok(tpl.includes('id="device-face"'), 'the real faceplate takes its place');
});

t('a screen with no data yet is visible, not a black page', () => {
  const app = read('..', 'App.jsx');
  // `if (!data) return` left an empty full-height div, which on a dark page is
  // indistinguishable from a dead session or a failed fetch.
  assert.match(app, /if \(!data\) \{/, 'Screen renders a loading state');
  assert.match(app, /t\('불러오는 중…'\)/);
  assert.match(app, /class ScreenBoundary/, 'and an effect that throws shows why');
  assert.match(app, /getDerivedStateFromError/);
  assert.match(app, /setDevErr\(e\)/, 'a rejected device fetch is surfaced, not swallowed');
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - faceplates match the unit they depict, and failures are visible');
process.exit(fail ? 1 : 0);
