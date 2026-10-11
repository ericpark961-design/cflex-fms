// node src/twin/capacity.test.mjs
//
// The survey feeds this: devices go into racks, and "can we add four servers
// next quarter" becomes answerable before the order is placed. The tests are
// mostly about what it must refuse to claim.
import assert from 'node:assert';
import { deviceLoad, rollupLoad, rackCapacity, canFit, upsSupply, TYPICAL_W, PLANNING } from './capacity.js';

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

t('a measured reading wins over every estimate', () => {
  const meas = deviceLoad({ kind: 'server', watts: 312 });
  assert.equal(meas.watts, 312);
  assert.equal(meas.source, 'measured');
  // A measurement is of right now; the breaker still has to survive the
  // nameplate, so a peak comes back even for a metered unit.
  assert.ok(meas.peakW >= meas.watts, 'the peak is not below the reading');

  const plate = deviceLoad({ kind: 'server', nameplate_w: 500 });
  assert.equal(plate.source, 'nameplate');

  // A model the planning table knows answers with that model's figure; one it
  // does not falls back to the typical for its kind. Both say which they are.
  const lib = deviceLoad({ kind: 'server', model: 'UCS C240 M6' });
  assert.equal(lib.source, 'library');
  assert.equal(lib.watts, PLANNING.ucs_c240.typ);
  assert.equal(lib.kg, PLANNING.ucs_c240.kg, 'weight comes with it');

  const typ = deviceLoad({ kind: 'server' });
  assert.equal(typ.source, 'typical');
  assert.equal(typ.watts, TYPICAL_W.server);
});

t("a UPS's load_pct against its rating is a real measurement", () => {
  const l = deviceLoad({ kind: 'ups', model: 'Smart-UPS SRT 3000', load_pct: 41 });
  assert.equal(l.source, 'measured');
  assert.equal(l.watts, Math.round(2700 * 0.41));
  // …and without the rating or the percentage it is not invented.
  assert.equal(deviceLoad({ kind: 'ups', model: 'Smart-UPS SRT 3000' }).watts, null);
  assert.equal(deviceLoad({ kind: 'ups', model: 'Nothing At All', load_pct: 50 }).watts, null);
});

t('a PoE budget comes from the model, not a guess', () => {
  const poe = deviceLoad({ kind: 'switch', model: 'Catalyst 9300-48P' });
  assert.equal(poe.watts, PLANNING.cat9300_48p.typ + 740, 'the sheet gives 740 W');
  assert.match(poe.note, /카탈로그/);
  // A core switch powers no endpoints, so nothing is added — and its own draw
  // comes from its own figure, not from the by-kind typical an access switch
  // would get (a 9500 is 320 W, a 9200 is 60 W; they are not the same machine).
  const noPoe = deviceLoad({ kind: 'switch', model: 'Catalyst 9500-48Y4C' });
  assert.equal(noPoe.watts, PLANNING.cat9500_48y4c.typ, 'no PoE budget is added');
  assert.ok(!/PoE/.test(noPoe.note || ''));
  assert.notEqual(noPoe.watts, deviceLoad({ kind: 'switch', model: 'Catalyst 9200' }).watts,
    'two different switches do not report the same draw');
});

t('a device with nothing to go on is counted as unknown, not estimated', () => {
  const l = deviceLoad({ kind: 'mystery-appliance' });
  assert.equal(l.watts, null);
  assert.equal(l.source, null);
  const roll = rollupLoad([{ kind: 'mystery-appliance' }, { kind: 'server' }]);
  assert.equal(roll.unknown, 1);
  assert.equal(roll.confidence, 'partial');
});

t('a UPS in the rack is not added on top of what it feeds', () => {
  // The UPS measurement already includes the switches and servers behind it.
  // Summing both counted the same watts twice: rack A01 read 2,597 W against a
  // 2,700 W unit when the measurement said 1,107 W.
  const devices = [
    { label: 'A01-UPS', kind: 'ups', model: 'Smart-UPS SRT 3000', load_pct: 41, u_height: 2 },
    { label: 'SW', kind: 'switch', model: 'Catalyst 9300-48P', u_height: 1 },
    { label: 'SRV', kind: 'server', model: 'UCS C220 M6', u_height: 1 },
  ];
  const r = rollupLoad(devices);
  assert.equal(r.upsMeasured, 1107);
  assert.equal(r.downstream, PLANNING.cat9300_48p.typ + 740 + PLANNING.ucs_c220.typ);
  assert.ok(r.doubleCountAvoided);
  assert.equal(r.total, Math.max(r.upsMeasured, r.downstream), 'the larger of the two, never the sum');
  assert.ok(r.total < r.upsMeasured + r.downstream);
});

t('headroom is null when the supply is unknown, not a comfortable number', () => {
  const cap = rackCapacity({ rack: { name: 'X', u_height: 42 }, devices: [{ kind: 'server' }] });
  assert.equal(cap.supply, null);
  assert.equal(cap.power.headroomW, null);
  assert.equal(cap.power.usedPct, null);
  const fit = canFit(cap, { kind: 'server', count: 2 });
  assert.equal(fit.powerKnown, false, 'and the answer says it could not be computed');
  assert.equal(fit.power.fits, null);
});

t('space and power are answered separately, because they run out separately', () => {
  const cap = rackCapacity({
    rack: { name: 'A01', u_height: 42 },
    devices: [
      { kind: 'switch', model: 'Catalyst 9300-48P', u_height: 1 },
      { kind: 'switch', model: 'Catalyst 9500-48Y4C', u_height: 1 },
      { kind: 'server', model: 'UCS C220 M6', u_height: 1 },
    ],
    supply: upsSupply('Smart-UPS SRT 3000'),
  });
  assert.equal(cap.supply.watts, 2700);
  assert.equal(cap.space.uFree, 39);

  const r = canFit(cap, { kind: 'server', count: 4, u_height: 1 });
  assert.equal(r.space.fits, true, '39U is plenty of space');
  assert.equal(r.power.fits, false, 'but the UPS is not');
  assert.equal(r.fits, false);
  assert.ok(r.max < r.space.possible, 'the binding constraint is power');
  assert.ok(r.blockers.some(b => /전력 부족/.test(b)));
  assert.ok(!r.blockers.some(b => /공간 부족/.test(b)));
});

t('the design ceiling is applied and stated', () => {
  const cap = rackCapacity({ rack: { u_height: 42 }, devices: [], supply: { watts: 1000 } });
  const at80 = canFit(cap, { kind: 'server', count: 1, watts: 900 });
  assert.equal(at80.power.fits, false, '900 W exceeds the 80% ceiling of a 1,000 W supply');
  assert.equal(at80.power.ceilingW, 800);
  const at100 = canFit(cap, { kind: 'server', count: 1, watts: 900 }, 100);
  assert.equal(at100.power.fits, true);
  assert.equal(at100.limitPct, 100);
});

t('an estimate-based answer says so', () => {
  const cap = rackCapacity({ rack: { u_height: 42 }, devices: [{ kind: 'server' }], supply: { watts: 5000 } });
  const r = canFit(cap, { kind: 'server', count: 1 });
  assert.ok(r.caveat, 'a plan built on typical figures is labelled as such');
  assert.match(r.caveat, /명판값/);
  // Give it a real nameplate and the caveat changes.
  const r2 = canFit(cap, { kind: 'server', count: 1, watts: 400 });
  assert.ok(!/명판값을 넣으면/.test(r2.caveat || ''));
});

t('counting more than fits is still answered with how many do', () => {
  const cap = rackCapacity({ rack: { u_height: 10 }, devices: [], supply: { watts: 10000 } });
  const r = canFit(cap, { kind: 'server', count: 50, u_height: 2, watts: 300 });
  assert.equal(r.fits, false);
  assert.equal(r.space.possible, 5, '10U / 2U');
  assert.ok(r.max <= 5);
  assert.ok(r.blockers.some(b => /공간 부족/.test(b)));
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - capacity answers in both dimensions and refuses to invent the rest');
process.exit(fail ? 1 : 0);
