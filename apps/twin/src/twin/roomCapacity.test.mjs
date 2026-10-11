// node src/twin/roomCapacity.test.mjs
//
// The expansion question — "can eight more servers go in B07" — is answered by
// a chain of arithmetic, and every step of it has a way to be confidently
// wrong. These are the ways:
//
//   · adding a meter reading to an estimate of the same watts (double count)
//   · reading a missing figure as a zero (free headroom that is not there)
//   · averaging two meters that contradict each other (hiding a survey finding)
//   · calling an impossible reading an overload (crying wolf on bad data)
//   · using the wrong voltage (every breaker in the room off by the same %)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { roomCapacity, chainReport, simulateAdd, roomVoltage, nodeSupply, kwToBtu, rtToKw } from './roomCapacity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const kmx = JSON.parse(readFileSync(path.join(here, '..', 'demo', 'kmx_ccr_topology.json'), 'utf8'));
const room = kmx.rooms[0];

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

// A deliberately small room, so each rule can be checked in isolation.
const mk = (over = {}) => ({
  name: 'TEST', voltage_1ph: 127, voltage_3ph: 220,
  objects: [
    { name: 'R1', kind: 'rack', u_height: 42, attrs: {} },
    { name: 'PDU', kind: 'pdu_cabinet', attrs: { rated_a: 125 } },
    { name: 'UPS', kind: 'ups_cabinet', attrs: { capacity_kw: 40 } },
  ],
  devices: [],
  power_links: [
    { src: 'R1', src_type: 'object', dst: 'PDU', dst_type: 'object', rated_a: 30, volts: 220 },
    { src: 'PDU', src_type: 'object', dst: 'UPS', dst_type: 'object' },
  ],
  ...over,
});

t('the voltage is stated, and an assumed one says so', () => {
  const known = roomVoltage({ voltage_1ph: 127, voltage_3ph: 220 });
  assert.equal(known.assumed, false);
  assert.deepEqual([known.v1, known.v3], [127, 220]);

  const guessed = roomVoltage({});
  assert.equal(guessed.assumed, true, 'a room with no voltage is flagged, not silently 120 V');
  assert.match(guessed.note, /가정/);

  // 6 % on the voltage is 6 % on every circuit in the room at once.
  const at127 = nodeSupply({ kind: 'panel', attrs: { rated_a: 200 } }, roomVoltage({ voltage_1ph: 127, voltage_3ph: 220 }));
  const at120 = nodeSupply({ kind: 'panel', attrs: { rated_a: 200 } }, roomVoltage({}));
  assert.ok(at127.kw > at120.kw, 'a 220 V plant has more capacity on the same breaker than a 208 V one');
  assert.match(at120.basis, /가정/, 'the basis says the voltage was assumed');
  assert.ok(!/가정/.test(at127.basis), 'a surveyed voltage is not marked as assumed');

  // The real KMX ledger carries its own voltage, so nothing in it is assumed.
  assert.equal(roomCapacity(room).voltage.assumed, false, 'the KMX ledger states 127/220 V');
});

t('a missing rating is null capacity, never free headroom', () => {
  const r = mk({ objects: [{ name: 'R1', kind: 'rack', u_height: 42, attrs: { kw: 3 } }], power_links: [] });
  const cap = roomCapacity(r);
  const n = cap.nodes.R1;
  assert.equal(n.cap_kw, null, 'no feed and no rating means capacity is unknown');
  assert.equal(n.pct, null, 'and the percentage is unanswerable, not 0');
  assert.equal(n.headroom_kw, null, 'and so is the headroom');
  assert.equal(n.status, 'nodata');
  assert.equal(nodeSupply({ kind: 'rack', attrs: {} }, roomVoltage(r)), null);
});

t('a rack rests on its own meter, with the inventory as the cross-check', () => {
  const r = mk();
  r.objects[0].attrs = { kw: 2.4 };
  r.devices = [
    { label: 'SW1', kind: 'switch', model: 'Catalyst 9300-48P', rack: 'R1', u_height: 1 },
    { label: 'SRV1', kind: 'server', model: 'UCS C220 M6', rack: 'R1', u_height: 1 },
  ];
  const n = roomCapacity(r).nodes.R1;
  // 890 W + 400 W of estimate is NOT added to the 2.4 kW the meter reports.
  assert.equal(n.load_kw, 2.4, 'the measurement is the number');
  assert.equal(n.basis, 'measured');
  assert.ok(n.est_kw > 1.2 && n.est_kw < 1.4, `the estimate is kept separately (${n.est_kw})`);
  assert.ok(n.load_kw < n.measured_kw + n.est_kw, 'the two are never summed');
  assert.equal(n.gap_kw, null, 'a rack has nothing metered below it to disagree with');
});

t('equipment that is not installed yet is added on top of the meter', () => {
  const r = mk();
  r.objects[0].attrs = { kw: 2.4 };
  const sim = simulateAdd(r, 'R1', [{ kind: 'server', model: 'UCS C240 M6', qty: 2, u_height: 2 }]);
  const a = sim.rack.after;
  // A meter cannot have read a machine that has not arrived.
  assert.equal(a.load_kw, 3.6, '2.4 kW measured + 1.2 kW of new load');
  assert.equal(a.basis, 'measured+planned');
  assert.equal(a.confidence, 'mixed', 'the total now rests on a measurement AND an estimate');
  assert.equal(sim.added_kw, 1.2);
  assert.equal(sim.added_u, 4);
  assert.equal(sim.added_kg, 56, 'weight comes along, because floors have limits too');
});

t('two meters that contradict each other are reported, not averaged', () => {
  const r = mk();
  r.objects[0].attrs = { kw: 30 };              // rack meter: 30 kW
  r.objects[1].attrs = { rated_a: 125, load_a: 20 };   // PDU meter: 20 A ≈ 7.6 kW
  const n = roomCapacity(r).nodes.PDU;
  assert.equal(n.status, 'conflict', 'a contradiction is its own state, not an overload');
  assert.equal(n.inconsistent, true);
  assert.match(n.conflict_reason, /자체 계측[\s\S]*하위 계측 합/);
  assert.equal(n.confidence, 'partial');
  // Planning takes the larger figure: under-reporting load is the error that
  // trips a breaker.
  assert.ok(n.load_kw >= 30, `the conservative figure is used (${n.load_kw})`);
  assert.equal(n.basis, 'ledger-inconsistent');

  const sim = simulateAdd(r, 'R1', [{ kind: 'server', model: 'UCS C220 M6', qty: 1 }]);
  assert.ok(sim.issues.some(i => i.level === 'conflict'), 'the simulator surfaces it');
  assert.equal(sim.ok, false, 'and refuses to pass the expansion through an unreadable node');
  assert.ok(sim.undecided.length > 0, 'what could not be decided is listed');
});

t('a reading its own breaker could not survive is data, not an overload', () => {
  const r = mk();
  // 30 A at 220 V is 5.28 kW derated. A meter claiming 40 kW on it would mean
  // 182 A through a 30 A breaker — which opens in seconds.
  r.objects[0].attrs = { kw: 40 };
  const n = roomCapacity(r).nodes.R1;
  assert.equal(n.status, 'conflict', 'not "critical" — the circuit is not carrying this');
  assert.match(n.conflict_reason, /차단기가 버틸 수 없는 값/);

  // A plausible overload is still an overload and must still alarm.
  const r2 = mk();
  r2.objects[0].attrs = { kw: 5.8 };            // 110 % of 5.28 kW
  const n2 = roomCapacity(r2).nodes.R1;
  assert.equal(n2.status, 'critical', 'a breaker at 110 % is real and is reported');
  assert.equal(n2.inconsistent, false);
});

t('a device with no power information is counted, not guessed at', () => {
  const r = mk();
  r.devices = [{ label: 'X', kind: 'mystery', model: 'nothing known', rack: 'R1', u_height: 1 }];
  const n = roomCapacity(r).nodes.R1;
  assert.equal(n.unknown, 1, 'it is counted as unknown');
  assert.equal(n.confidence, 'partial');
  assert.equal(n.est_kw, 0, 'and contributes no invented watts');

  const sim = simulateAdd(r, 'R1', [{ kind: 'server', model: 'UCS C220 M6' }]);
  assert.ok(sim.issues.some(i => i.level === 'nodata' && /정보 없는 장비 1대/.test(i.msg)),
    'the hole in the number is stated');
  // And an issue is NOT raised for nodes that have no unknown devices at all.
  assert.ok(!sim.issues.some(i => /정보 없는 장비 0대/.test(i.msg)));
});

t('a UPS is crossed with its losses, and is not double counted', () => {
  const r = mk();
  r.objects[0].attrs = { kw: 19 };
  const cap = roomCapacity(r);
  // 19 kW of load through a 95 %-efficient UPS draws 20 kW from upstream.
  assert.ok(cap.nodes.UPS.load_kw > 19.9 && cap.nodes.UPS.load_kw < 20.1,
    `UPS input includes conversion loss (${cap.nodes.UPS.load_kw})`);

  // A UPS standing inside its own cabinet is one node, not two.
  const r2 = mk();
  r2.objects[0].attrs = { kw: 10 };
  r2.devices = [{ label: 'U1', kind: 'ups', model: 'Symmetra PX 40kW', rack: 'UPS', u_height: 10, load_pct: 48 }];
  const chain = chainReport(roomCapacity(r2), 'R1');
  assert.deepEqual(chain.map(c => c.name), ['R1', 'PDU', 'UPS'],
    'the device does not appear as an extra hop under its cabinet');
});

t('the chain runs upward and terminates', () => {
  const cap = roomCapacity(room);
  const chain = chainReport(cap, 'A01');
  assert.deepEqual(chain.map(c => c.name), ['A01', 'PDU-A', 'UPS-1', 'PANEL-1', 'UTILITY']);
  assert.deepEqual(chain.map(c => c.kind), ['rack', 'pdu_cabinet', 'ups_cabinet', 'panel', 'panel']);
  // Load can only grow going up: every hop carries its children plus itself.
  for (let i = 1; i < chain.length; i++) {
    assert.ok(chain[i].before.load_kw >= chain[i - 1].before.load_kw,
      `${chain[i].name} carries at least what ${chain[i - 1].name} draws`);
  }
  // A loop in the ledger must not hang the rollup.
  const loop = mk({
    power_links: [
      { src: 'R1', src_type: 'object', dst: 'PDU', dst_type: 'object', rated_a: 30, volts: 220 },
      { src: 'PDU', src_type: 'object', dst: 'UPS', dst_type: 'object' },
      { src: 'UPS', src_type: 'object', dst: 'PDU', dst_type: 'object' },
    ],
  });
  loop.objects[0].attrs = { kw: 1 };
  assert.ok(roomCapacity(loop).nodes.PDU.load_kw >= 0, 'a cycle returns rather than recursing forever');
});

t('cooling is judged with the largest unit out', () => {
  const cap = roomCapacity(room);
  const { room: R } = cap;
  assert.ok(R.cooling_kw > R.cooling_n1_kw, 'N+1 is less than the nameplate total');
  const largest = Math.max(...cap.cracs.map(c => c.cooling_kw));
  assert.equal(R.cooling_n1_kw, Math.round((R.cooling_kw - largest) * 10) / 10);
  // Heat is the IT load plus what the UPS wastes making it.
  assert.equal(R.heat_kw, Math.round((R.it_kw + R.ups_loss_kw) * 100) / 100);
  assert.equal(R.heat_btu_h, kwToBtu(R.heat_kw));
  assert.equal(rtToKw(30), 105.5, 'a 30-ton unit removes 105.5 kW');

  // A CRAC with no rating is excluded from the total and the exclusion is said.
  const r = mk();
  r.objects.push({ name: 'C1', kind: 'crac', attrs: { rt: 10 } });
  r.objects.push({ name: 'C2', kind: 'crac', attrs: {} });
  const out = roomCapacity(r).room;
  assert.equal(out.cooling_kw, rtToKw(10), 'the unrated unit adds no cooling');
  assert.match(out.cooling_note, /1대 용량 미기재/);
});

t('the peak never falls below the load the node rests on', () => {
  // Most KMX racks carry a branch meter and no inventory, so a peak summed from
  // devices alone came out an order of magnitude under the measured load, and
  // the room reported a peak lower than its own average.
  const cap = roomCapacity(room);
  assert.ok(cap.room.it_peak_kw >= cap.room.it_kw,
    `${cap.room.it_peak_kw} kW peak vs ${cap.room.it_kw} kW load`);
  for (const n of Object.values(cap.nodes)) {
    assert.ok(n.peak_kw >= n.load_kw, `${n.name}: peak ${n.peak_kw} < load ${n.load_kw}`);
  }
});

t('the KMX ledger agrees with itself', () => {
  const cap = roomCapacity(room);
  // Every node that both measures itself and has meters below it must agree
  // with them, or the demo only ever demonstrates the error path. The ledger's
  // distribution is derived from its rack figures, so the only gaps left are
  // rounding and UPS losses.
  const conflicted = Object.values(cap.nodes).filter(n => n.inconsistent);
  assert.deepEqual(conflicted.map(n => `${n.name}: ${n.conflict_reason}`), []);
  assert.equal(cap.room.unknown, 0, 'every device in the demo resolves to a load');
  assert.equal(cap.room.confidence, 'measured');
  for (const n of Object.values(cap.nodes)) {
    if (n.gap_kw == null) continue;
    const tol = Math.max(0.5, n.load_kw * 0.1);
    assert.ok(Math.abs(n.gap_kw) <= tol,
      `${n.name} gap ${n.gap_kw} kW exceeds ${tol.toFixed(2)} kW (meter ${n.measured_kw} vs below ${n.downstream_kw})`);
  }
});

t('the expansion answer names what gives first', () => {
  const sim = simulateAdd(room, 'B07', [{ kind: 'server', vendor: 'Cisco', model: 'UCS C240 M6', qty: 4, u_height: 2 }]);
  assert.equal(sim.ok, false);
  const crit = sim.issues.filter(i => i.level === 'critical');
  assert.equal(crit.length, 1, 'one thing gives first, and it is named');
  assert.match(crit[0].msg, /^B07 용량 초과/, 'B07 runs out of branch circuit before anything upstream');
  assert.match(crit[0].msg, /× 0\.8/, 'and the arithmetic behind the limit travels with it');
  // Enough room left over must read as a pass.
  const small = simulateAdd(room, 'A02', [{ kind: 'switch', model: 'Catalyst 9200', qty: 1, u_height: 1 }]);
  assert.equal(small.ok, true, 'a 60 W switch into a 0.9 kW rack fits');
  assert.ok(small.chain.every(c => c.pct_after != null), 'every hop is answerable');
});

t('the panel shows every number with its basis, and is reachable', () => {
  const panel = readFileSync(path.join(here, 'CapacityPanel.jsx'), 'utf8');
  // A figure without its basis is the thing this module exists to prevent: an
  // expansion signed off against a planning estimate nobody knew was one.
  assert.match(panel, /cap_basis/, 'the limit shows the arithmetic behind it');
  assert.match(panel, /BASIS\[/, 'the load says whether it is measured or estimated');
  assert.match(panel, /conflict_reason/, 'a ledger contradiction is shown, not swallowed');
  assert.match(panel, /n\.unknown > 0|rk\.unknown > 0/, 'devices with no power data are counted on screen');
  assert.match(panel, /voltage\.assumed/, 'an assumed voltage is marked');
  assert.match(panel, /회로 정격 미등록|정격 미기재/, 'an unknown supply reads as unknown, not as 0 %');
  // conflict must have its own colour; reusing warn or critical reads as a
  // load condition.
  assert.match(panel, /conflict: '#[0-9a-f]{6}'/i);

  const twin = readFileSync(path.join(here, '..', 'TwinScreen.jsx'), 'utf8');
  assert.match(twin, /<CapacityPanel room=\{data\.rooms\[0\]\} rackName=\{sel\.name\}/,
    'clicking a rack in the twin opens its capacity picture');
  assert.match(twin, /<RoomCapacitySummary room=\{room\}/, 'the room carries its own summary');
  // The "UPS 40 kW ×2" on the room card was typed in, and the ledger now says
  // 100 kW. Nothing on that card may be a literal again.
  assert.ok(!/UPS 40 kW/.test(twin), 'the UPS rating is read off the ledger');
  assert.match(twin, /upsCabs\.map\(o => `\$\{o\.attrs\?\.capacity_kw/);
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - the expansion answer rests on measurements and says where it does not');
process.exit(fail ? 1 : 0);
