// node --test probe-agent/test/modbus.test.js
//
// WO-INT-017 §5 격리 시험: the Modbus TCP read client, register-map profiles,
// the CRAC Modbus path and the contact-module collector, against
// sim/sim-modbus.js on 127.0.0.1. No real device, no other host.
//
// The one assertion that matters most is at the end: the simulator, which
// records every write function code it receives, received none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const mb = require('../src/services/modbus-read');
const profiles = require('../src/services/modbus-profiles');
const { pollCrac } = require('../src/pollers/crac');
const { pollCracModbus } = require('../src/pollers/crac-modbus');
const { pollDio } = require('../src/pollers/dio');
const registry = require('../src/pollers');
const { createModbusSim, defaultTables } = require('../sim/sim-modbus');

const FAST = { timeoutMs: 400, retries: 0 };
let sim, port;

test.before(async () => {
  sim = createModbusSim({ tables: defaultTables({}) });
  port = await sim.listen(0, '127.0.0.1');
});
test.after(async () => { await sim.close(); });
test.beforeEach(() => {
  sim.set({ tables: defaultTables({}), fragment: 0, delayMs: 0, exception: 0, disconnect: false, silent: false, tamper: null });
});

const crac = (over = {}) => ({
  id: 'crac-1', name: 'CRAC-1', kind: 'crac', ip: '127.0.0.1',
  attrs: { protocol: 'modbus-tcp', modbus: { unit_id: 1, port, profile: 'sim-crac' }, ...over },
});
const dio = (inputs, mbOver = {}) => ({
  id: 'dio-1', name: 'FIRE-DIO', kind: 'dio', ip: '127.0.0.1',
  attrs: { protocol: 'modbus-tcp', modbus: { unit_id: 2, port, type: 'discrete', address_base: 0, ...mbOver }, inputs },
});
const find = (r, metric) => r.metrics.find(m => m.metric === metric);
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ── request building ─────────────────────────────────────────────────────

test('request builder refuses write function codes 5, 6, 15, 16 (and 22, 23)', async () => {
  for (const fc of [5, 6, 15, 16, 22, 23]) {
    assert.throws(() => mb.buildReadRequest({ unitId: 1, fc, address: 0, count: 1 }, 1),
      (e) => e.kind === 'request' && /write — refused: the probe is read-only/.test(e.message), `fc ${fc}`);
  }
  assert.throws(() => mb.buildReadRequest({ unitId: 1, fc: 8, address: 0, count: 1 }, 1), /not a read code/);
  // The pool refuses before queueing: nothing reaches the wire.
  const pool = mb.createModbusPool(FAST);
  sim.reset();
  await assert.rejects(pool.read({ host: '127.0.0.1', port, unitId: 1, fc: 6, address: 0, count: 1 }), /read-only/);
  await assert.rejects(pool.read({ host: '127.0.0.1', port, unitId: 1, fc: 16, address: 0, count: 2 }), /read-only/);
  pool.close();
  assert.strictEqual(sim.stats.connections, 0, 'no connection opened for a refused request');
  // The four read codes build.
  for (const fc of [1, 2, 3, 4]) assert.strictEqual(mb.buildReadRequest({ unitId: 1, fc, address: 0, count: 1 }, 7)[7], fc);
});

// ── response validation ──────────────────────────────────────────────────

test('responses with the wrong transaction id, unit id or length are discarded', async () => {
  const req = mb.buildReadRequest({ unitId: 3, fc: 3, address: 0, count: 1 }, 0x1234);
  const good = Buffer.from([0x12, 0x34, 0, 0, 0, 5, 3, 3, 2, 0x00, 0xb7]);
  assert.deepStrictEqual(mb.decodeReadResponse(good, req), [183]);
  const bad = (i, v) => { const b = Buffer.from(good); b[i] = v; return b; };
  assert.throws(() => mb.decodeReadResponse(bad(1, 0x35), req), /transaction id mismatch/);
  assert.throws(() => mb.decodeReadResponse(bad(6, 4), req), /unit id mismatch/);
  assert.throws(() => mb.decodeReadResponse(bad(5, 6), req), /length field/);
  assert.throws(() => mb.decodeReadResponse(bad(3, 1), req), /protocol id/);
  assert.throws(() => mb.decodeReadResponse(bad(7, 4), req), /function code mismatch/);
  assert.throws(() => mb.decodeReadResponse(bad(8, 4), req), /byte count/);

  // And on the wire: a tampered answer yields an error, never a value.
  const pool = mb.createModbusPool(FAST);
  for (const [what, tamper, re] of [
    ['tid', (f) => { f.writeUInt16BE((f.readUInt16BE(0) + 1) & 0xffff, 0); return f; }, /transaction id mismatch/],
    ['unit', (f) => { f[6] = 9; return f; }, /unit id mismatch/],
    ['length', (f) => Buffer.concat([f.subarray(0, 4), Buffer.from([0, f.readUInt16BE(4) - 1]), f.subarray(6, f.length - 1)]), /byte count|length field/],
  ]) {
    sim.set({ tamper });
    await assert.rejects(pool.read({ host: '127.0.0.1', port, unitId: 1, table: 'input', address: 0, count: 2 }),
      (e) => e.kind === 'protocol' && re.test(e.message), what);
  }
  pool.close();
});

test('exception 02 and exception 04 are reported with different text, and 02 is not a comms failure', async () => {
  const pool = mb.createModbusPool(FAST);
  sim.set({ exception: 2 });
  const e2 = await pool.read({ host: '127.0.0.1', port, unitId: 1, table: 'input', address: 0, count: 1 }).catch(e => e);
  sim.set({ exception: 4 });
  const e4 = await pool.read({ host: '127.0.0.1', port, unitId: 1, table: 'input', address: 0, count: 1 }).catch(e => e);
  pool.close();
  assert.strictEqual(e2.kind, 'exception'); assert.strictEqual(e2.code, 2); assert.strictEqual(e2.mapMismatch, true);
  assert.strictEqual(e4.kind, 'exception'); assert.strictEqual(e4.code, 4); assert.strictEqual(e4.mapMismatch, false);
  assert.match(e2.message, /illegal data address .*register map/);
  assert.match(e4.message, /server device failure/);
  assert.notStrictEqual(e2.message, e4.message);
  // Through the collector: "map mismatch" vs "device exception" vs "communication failure".
  sim.set({ exception: 2 });
  const r2 = await pollCrac(crac(), { modbus: FAST });
  sim.set({ exception: 4 });
  const r4 = await pollCrac(crac(), { modbus: FAST });
  assert.match(r2.error, /^register map mismatch/);
  assert.match(r4.error, /^device exception/);
  assert.ok(!/communication failure/.test(r2.error + r4.error));
  // Exception text table covers the codes the work order names.
  for (const c of [1, 2, 3, 4, 6, 10, 11]) assert.ok(mb.EXCEPTIONS[c], `code ${c}`);
});

// ── transport ────────────────────────────────────────────────────────────

test('a response split across many TCP segments is reassembled', async () => {
  sim.set({ fragment: 2 });
  const pool = mb.createModbusPool(FAST);
  const words = await pool.read({ host: '127.0.0.1', port, unitId: 1, table: 'holding', address: 0, count: 4 });
  pool.close();
  assert.deepStrictEqual(words, [1, 1, 0, 72]);
});

test('a device that never answers times out (and is retried MODBUS_RETRIES times)', async () => {
  sim.set({ silent: true });
  sim.reset();
  const pool = mb.createModbusPool({ timeoutMs: 150, retries: 1 });
  const t0 = Date.now();
  const e = await pool.read({ host: '127.0.0.1', port, unitId: 1, table: 'input', address: 0, count: 1 }).catch(x => x);
  pool.close();
  assert.strictEqual(e.kind, 'comms');
  assert.match(e.message, /timeout after 150 ms/);
  assert.ok(Date.now() - t0 >= 280, 'two attempts');
  assert.strictEqual(sim.stats.requests, 2, '1 try + 1 retry');
});

test('a refused connection is a comms failure, reported as such', async () => {
  const closed = await freePort();
  const pool = mb.createModbusPool(FAST);
  const e = await pool.read({ host: '127.0.0.1', port: closed, unitId: 1, table: 'input', address: 0, count: 1 }).catch(x => x);
  pool.close();
  assert.strictEqual(e.kind, 'comms');
  assert.match(e.message, /ECONNREFUSED/);
  const r = await pollCrac(crac({ modbus: { unit_id: 1, port: closed, profile: 'sim-crac' } }), { modbus: FAST });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /^communication failure/);
  assert.deepStrictEqual(r.metrics, []);
});

test('a connection dropped mid-request is a comms failure', async () => {
  sim.set({ disconnect: true });
  const pool = mb.createModbusPool(FAST);
  const e = await pool.read({ host: '127.0.0.1', port, unitId: 1, table: 'input', address: 0, count: 1 }).catch(x => x);
  pool.close();
  assert.strictEqual(e.kind, 'comms');
});

// ── value conversion ─────────────────────────────────────────────────────

test('int16 negative, uint32 / int32 / float32 in ABCD and CDAB, and bit conversion', () => {
  const P = (o) => ({ metric: 'x', scale: 1, unit: 'u', ...o });
  assert.strictEqual(profiles.decodeValue(P({ data: 'int16', scale: 0.1 }), [0xff9c]).value, -10);   // -100 × 0.1
  assert.strictEqual(profiles.decodeValue(P({ data: 'int16' }), [0xff9c]).raw, -100);
  assert.strictEqual(profiles.decodeValue(P({ data: 'uint16' }), [0xff9c]).value, 65436);
  // 0x0001_86A0 = 100000
  assert.strictEqual(profiles.decodeValue(P({ data: 'uint32', word_order: 'ABCD' }), [0x0001, 0x86a0]).value, 100000);
  assert.strictEqual(profiles.decodeValue(P({ data: 'uint32', word_order: 'CDAB' }), [0x86a0, 0x0001]).value, 100000);
  assert.strictEqual(profiles.decodeValue(P({ data: 'int32', word_order: 'ABCD' }), [0xffff, 0xfffe]).value, -2);
  assert.strictEqual(profiles.decodeValue(P({ data: 'int32', word_order: 'CDAB' }), [0xfffe, 0xffff]).value, -2);
  // 21.5 = 0x41AC0000
  assert.strictEqual(profiles.decodeValue(P({ data: 'float32', word_order: 'ABCD' }), [0x41ac, 0x0000]).value, 21.5);
  assert.strictEqual(profiles.decodeValue(P({ data: 'float32', word_order: 'CDAB' }), [0x0000, 0x41ac]).value, 21.5);
  // The same two words in the other order are a different number — which is why it is never guessed.
  assert.notStrictEqual(profiles.decodeValue(P({ data: 'float32', word_order: 'CDAB' }), [0x41ac, 0x0000]).value, 21.5);
  // bit n of a register; a coil/discrete value as is.
  assert.strictEqual(profiles.decodeValue(P({ data: 'bit', type: 'holding', bit: 3 }), [0b1000]).value, 1);
  assert.strictEqual(profiles.decodeValue(P({ data: 'bit', type: 'holding', bit: 2 }), [0b1000]).value, 0);
  assert.strictEqual(profiles.decodeValue(P({ data: 'bit', type: 'discrete' }), [1]).value, 1);
  // scale rounding does not leak binary fractions; raw keeps the integer.
  const t = profiles.decodeValue(P({ data: 'int16', scale: 0.1 }), [183]);
  assert.deepStrictEqual([t.value, t.raw], [18.3, 183]);
});

test('a point without word_order, scale or unit is refused, not converted with a default', () => {
  const base = { id: 'p', vendor: 'v', source_doc: { title: 'doc' }, address_base: 0 };
  const pt = { metric: 'kw', type: 'input', address: 0, data: 'uint32', word_order: 'ABCD', scale: 1, unit: 'kW', confidence: 'documented' };
  assert.strictEqual(profiles.validateProfile({ ...base, points: [pt] }).ok, true);
  const without = (k) => { const p = { ...pt }; delete p[k]; return profiles.validateProfile({ ...base, points: [p] }); };
  assert.match(without('word_order').errors.join(), /needs word_order ABCD or CDAB/);
  assert.match(without('scale').errors.join(), /scale must be written out/);
  assert.match(without('unit').errors.join(), /unit must be written out/);
  assert.match(profiles.validateProfile({ ...base, points: [{ ...pt, word_order: 'BADC' }] }).errors.join(), /word_order/);
  // decodeValue refuses too, for points built by hand.
  assert.throws(() => profiles.decodeValue({ metric: 'x', data: 'uint32', scale: 1, unit: 'u' }, [0, 1]), /word_order/);
  assert.throws(() => profiles.decodeValue({ metric: 'x', data: 'uint16', unit: 'u' }, [1]), /scale and unit/);
  assert.throws(() => profiles.decodeValue({ metric: 'x', data: 'uint16', scale: 1 }, [1]), /scale and unit/);
  // address_base itself is mandatory.
  const nb = { ...base }; delete nb.address_base;
  assert.match(profiles.validateProfile({ ...nb, points: [pt] }).errors.join(), /address_base must be 0 or 1/);
  // A profile cannot name a host.
  assert.match(profiles.validateProfile({ ...base, host: '192.0.2.10', points: [pt] }).errors.join(), /device IP comes from the ledger only/);
});

test('an address_base 1 profile is converted to 0-based PDU addresses', async () => {
  const p = profiles.validateProfile({
    id: 'one-based', vendor: 'test', source_doc: { title: 'test fixture' }, address_base: 1,
    points: [
      { metric: 'supply_temp_c', type: 'input', address: 1, data: 'int16', scale: 0.1, unit: '°C', confidence: 'documented' },
      { metric: 'return_temp_c', type: 'input', address: 2, data: 'int16', scale: 0.1, unit: '°C', confidence: 'documented' },
    ],
  });
  assert.ok(p.ok, p.errors && p.errors.join());
  assert.deepStrictEqual(p.profile.points.map(x => x.pdu), [0, 1]);
  assert.match(profiles.validateProfile({ ...p.profile, points: [{ ...p.profile.points[0], address: 0 }] }).errors.join(), /outside the 1-based range/);
  // On the wire: register 1 (1-based) is PDU 0 → the simulator's supply temperature.
  sim.reset();
  const pool = mb.createModbusPool(FAST);
  const r = await profiles.readProfile(pool, { host: '127.0.0.1', port, unitId: 1 }, p.profile);
  pool.close();
  assert.deepStrictEqual(sim.stats.frames.map(f => [f.fc, f.address, f.count]), [[4, 0, 2]]);
  assert.deepStrictEqual(r.readings.map(x => [x.point.metric, x.value]), [['supply_temp_c', 18.3], ['return_temp_c', 26.5]]);
});

test('a contiguous run of more than 125 registers is split into several requests', async () => {
  const input = {};
  for (let a = 100; a < 230; a++) input[a] = a;          // 130 registers
  sim.set({ tables: { 7: { input } } });
  sim.reset();
  const pool = mb.createModbusPool(FAST);
  const words = await pool.read({ host: '127.0.0.1', port, unitId: 7, table: 'input', address: 100, count: 130 });
  pool.close();
  assert.strictEqual(words.length, 130);
  assert.strictEqual(words[129], 229);
  assert.deepStrictEqual(sim.stats.frames.map(f => [f.address, f.count]), [[100, 125], [225, 5]]);
  assert.deepStrictEqual(mb.splitRange(1, 0, 4500).map(x => x.count), [2000, 2000, 500], 'bits split at 2000');
  // The planner merges touching points into one range and leaves gaps alone.
  const pts = [0, 1, 2, 6].map(a => ({ type: 'input', pdu: a, words: 1 })).concat([{ type: 'input', pdu: 3, words: 2 }]);
  assert.deepStrictEqual(profiles.planReads(pts).map(r => [r.address, r.count]), [[0, 5], [6, 1]]);
});

// ── one connection per host ──────────────────────────────────────────────

test('two unit IDs on the same host share one connection, one request at a time', async () => {
  // Let the previous tests' connections finish closing on the server side.
  for (let i = 0; i < 100 && sim.stats.open > 0; i++) await new Promise(r => setTimeout(r, 10));
  sim.reset();
  const pool = mb.createModbusPool(FAST);
  // As the cycle does with POLL_CONCURRENCY workers: both at once.
  const inputs = [{ channel: 0, metric: 'fire_alarm', active_state: 'closed' }];
  const [c, d, c2] = await Promise.all([
    pollCrac(crac(), { modbusPool: pool }),
    pollDio(dio(inputs), { modbusPool: pool }),
    pollCrac(crac(), { modbusPool: pool }),
  ]);
  pool.close();
  assert.ok(c.ok && d.ok && c2.ok);
  assert.strictEqual(sim.stats.connections, 1, 'one TCP connection for the whole cycle');
  assert.strictEqual(sim.stats.maxOpen, 1, 'never two at once');
  assert.strictEqual(sim.stats.maxInFlight, 1, 'requests strictly sequential');
  assert.deepStrictEqual(Object.keys(sim.stats.byUnit).sort(), ['1', '2']);
  // Closing the pool closes the connection.
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(sim.stats.open, 0);
});

// ── CRAC over Modbus ─────────────────────────────────────────────────────

test('CRAC over Modbus: same metric names as SNMP, cooling_available and delta_t_c derived', async () => {
  const r = await pollCrac(crac(), { modbus: FAST });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(find(r, 'supply_temp_c').value, 18.3);
  assert.strictEqual(find(r, 'supply_temp_c').raw_value, 183);
  assert.strictEqual(find(r, 'supply_temp_c').oid, 'modbus:1:input:0');
  assert.strictEqual(find(r, 'return_temp_c').value, 26.5);
  assert.strictEqual(find(r, 'state_cooling').str_value, 'on');
  assert.strictEqual(find(r, 'alarm_count').value, 0);
  assert.strictEqual(find(r, 'setpoint_c').value, 21.5);
  assert.strictEqual(find(r, 'cooling_available').value, 1);
  assert.strictEqual(find(r, 'delta_t_c').value, 8.2);
  assert.ok(r.metrics.filter(m => m.source === 'measured').every(m => m.confidence === 'documented' && m.raw_value != null));
  assert.match(r.notes, /documented, confirm against the unit display/);
});

test('CRAC over Modbus: a unit in standby is NOT cooling-available', async () => {
  sim.set({ tables: defaultTables({ COOLING: 'standby', ALARMS: '1' }) });
  const r = await pollCrac(crac(), { modbus: FAST });
  assert.strictEqual(find(r, 'state_cooling').str_value, 'standby');
  assert.strictEqual(find(r, 'cooling_available').value, 0);
  assert.strictEqual(find(r, 'cooling_available').str_value, 'standby');
  assert.strictEqual(find(r, 'cooling_available').label, 'alarms 1');
});

test('CRAC over Modbus: a partly answering unit returns what it read and names what it did not', async () => {
  const t = defaultTables({});
  delete t[1].input[10]; delete t[1].input[11];          // no setpoint on this unit
  sim.set({ tables: t });
  const r = await pollCrac(crac(), { modbus: FAST });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(find(r, 'setpoint_c'), undefined);
  assert.match(r.notes, /absent: setpoint_c \(register map mismatch/);
});

// ── contact module ───────────────────────────────────────────────────────

test('dio: NO and NC contacts are converted by active_state', async () => {
  sim.set({ tables: defaultTables({ DIO_INPUTS: '1,0,1,0' }) });
  const r = await pollDio(dio([
    { channel: 0, metric: 'fire_alarm', active_state: 'closed', label: 'FM-200 Alarm' },   // closed=1 → active
    { channel: 1, metric: 'fire_trouble', active_state: 'closed' },                          // 0 → normal
    { channel: 2, metric: 'fire_supervisory', active_state: 'open' },                        // NC, reads 1 → normal
    { channel: 3, metric: 'leak_alarm', active_state: 'open' },                              // NC, reads 0 → active
  ]), { modbus: FAST });
  assert.strictEqual(r.ok, true);
  const v = (m) => [find(r, m).value, find(r, m).str_value, find(r, m).raw_value];
  assert.deepStrictEqual(v('fire_alarm'), [1, 'active', 1]);
  assert.deepStrictEqual(v('fire_trouble'), [0, 'normal', 0]);
  assert.deepStrictEqual(v('fire_supervisory'), [0, 'normal', 1]);
  assert.deepStrictEqual(v('leak_alarm'), [1, 'active', 0]);
  assert.strictEqual(find(r, 'fire_alarm').oid, 'modbus:2:discrete:0');
  assert.strictEqual(find(r, 'fire_alarm').unit, 'state');
  assert.strictEqual(find(r, 'fire_alarm').label, 'FM-200 Alarm');
});

test('dio: a channel without active_state is reported, not converted', async () => {
  sim.set({ tables: defaultTables({ DIO_INPUTS: '1,1' }) });
  const r = await pollDio(dio([
    { channel: 0, metric: 'fire_alarm', active_state: 'closed' },
    { channel: 1, metric: 'fire_discharge' },
  ]), { modbus: FAST });
  assert.strictEqual(r.ok, true);
  const m = find(r, 'fire_discharge');
  assert.deepStrictEqual([m.value, m.str_value, m.raw_value], [null, null, 1]);
  assert.match(r.notes, /active_state 미지정 — not converted: fire_discharge \(channel 1, raw 1\)/);
});

test('dio: a module that does not answer is ok:false with no values — never filled with 0', async () => {
  const closed = await freePort();
  const inputs = [{ channel: 0, metric: 'fire_alarm', active_state: 'closed' }];
  const r = await pollDio(dio(inputs, { port: closed }), { modbus: FAST });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.metrics, []);
  assert.match(r.error, /communication failure/);
  sim.set({ silent: true });
  const t = await pollDio(dio(inputs), { modbus: { timeoutMs: 150, retries: 0 } });
  assert.strictEqual(t.ok, false);
  assert.deepStrictEqual(t.metrics, []);
  assert.match(t.error, /timeout/);
});

test('dio: metric names outside the list, missing address_base and coil addressing', async () => {
  const bad = await pollDio(dio([{ channel: 0, metric: 'fire_alrm', active_state: 'closed' }]), { modbus: FAST });
  assert.strictEqual(bad.unsupported, true);
  assert.match(bad.error, /"fire_alrm" is not an allowed contact name/);
  const nb = await pollDio(dio([{ channel: 0, metric: 'fire_alarm', active_state: 'closed' }], { address_base: undefined }), { modbus: FAST });
  assert.match(nb.error, /address_base must be 0 or 1/);
  for (const ok of ['smoke_zone_3', 'contact_12', 'fire_predischarge']) assert.ok(require('../src/pollers/dio').NAMES.test(ok), ok);
  // coil table, 1-based channels: channel 1 is PDU 0.
  sim.set({ tables: defaultTables({ DIO_INPUTS: '1,0' }) });
  sim.reset();
  const c = await pollDio(dio([{ channel: 1, metric: 'smoke_zone_1', active_state: 'closed' }], { type: 'coil', address_base: 1 }), { modbus: FAST });
  assert.strictEqual(find(c, 'smoke_zone_1').value, 1);
  assert.strictEqual(find(c, 'smoke_zone_1').oid, 'modbus:2:coil:0');
  assert.deepStrictEqual(sim.stats.frames.map(f => [f.fc, f.address]), [[1, 0]]);
});

// ── profiles that do not load; the registry ──────────────────────────────

test('an invalid profile returns unsupported with the reason, and the cycle carries on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-modbus-prof-'));
  fs.writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({ id: 'broken', vendor: 'x', source_doc: { title: 'x' }, points: [{ metric: 'supply_temp_c', type: 'input', address: 0, data: 'float32', unit: '°C', confidence: 'documented' }] }));
  fs.writeFileSync(path.join(dir, 'notjson.json'), '{ nope');
  fs.copyFileSync(path.join(profiles.PROFILE_DIR, 'sim-crac.json'), path.join(dir, 'sim-crac.json'));
  const opts = { modbus: FAST, modbusProfileDir: dir };
  // A cycle's worth, in order: three bad, one good. Nothing throws; the good one is read.
  const out = [];
  for (const prof of ['broken', 'notjson', 'missing', '../etc/passwd', 'sim-crac']) {
    out.push(await registry.pollOne(crac({ modbus: { unit_id: 1, port, profile: prof } }), opts));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const [broken, notjson, missing, traversal, good] = out;
  for (const r of [broken, notjson, missing, traversal]) {
    assert.strictEqual(r.ok, false); assert.strictEqual(r.unsupported, true); assert.deepStrictEqual(r.metrics, []);
  }
  assert.match(broken.error, /address_base must be 0 or 1/);
  assert.match(broken.error, /needs word_order/);
  assert.match(broken.error, /scale must be written out/);
  assert.match(notjson.error, /not valid JSON/);
  assert.match(missing.error, /not found/);
  assert.match(traversal.error, /not a plain name/);
  assert.strictEqual(good.ok, true);
  assert.strictEqual(find(good, 'cooling_available').value, 1);
  // The shipped profile itself validates.
  assert.strictEqual(profiles.loadProfile('sim-crac').ok, true);
});

test('the registry sends crac + modbus-tcp to the Modbus path and dio to the contact collector', async () => {
  assert.strictEqual(registry.collectorFor({ kind: 'dio' }).name, 'pollDio');
  assert.strictEqual(registry.collectorFor({ kind: 'crac', attrs: { protocol: 'modbus-tcp' } }).name, 'pollCrac');
  const viaRegistry = await registry.pollOne(crac(), { modbus: FAST });
  assert.ok(viaRegistry.metrics.length && viaRegistry.metrics.filter(m => m.source === 'measured').every(m => /^modbus:1:/.test(m.oid)), 'read over Modbus');
  const plain = await registry.pollOne(crac({ protocol: 'modbus' }), { modbus: FAST });
  assert.strictEqual(plain.ok, true, '"modbus" is accepted as well as "modbus-tcp"');
  const d = await registry.pollOne(dio([{ channel: 0, metric: 'fire_alarm', active_state: 'closed' }]), { modbus: FAST });
  assert.ok(d.ok && find(d, 'fire_alarm').oid === 'modbus:2:discrete:0');
  // BACnet stays unsupported; the wording no longer says SNMP is the only protocol.
  const b = await pollCrac({ id: 6, name: 'CRAC-3', kind: 'crac', attrs: { protocol: 'bacnet' } });
  assert.strictEqual(b.unsupported, true);
  assert.match(b.error, /iCOM SNMP and Modbus TCP only/);
  // A Modbus CRAC without a unit id is a configuration fault, not a dead unit.
  const nu = await pollCrac(crac({ modbus: { port, profile: 'sim-crac' } }), { modbus: FAST });
  assert.strictEqual(nu.unsupported, true);
  assert.match(nu.error, /unit_id/);
});

// ── the write guard, end to end ──────────────────────────────────────────

test('the simulator records write requests (so its count of zero below means something)', async () => {
  const other = createModbusSim({ tables: defaultTables({}) });
  const p = await other.listen(0, '127.0.0.1');
  // A raw fc 6 frame, built by hand here because the probe cannot build one.
  const frame = Buffer.from([0, 1, 0, 0, 0, 6, 1, 6, 0, 1, 0, 2]);
  const reply = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port: p }, () => s.write(frame));
    s.on('data', (d) => { s.destroy(); resolve(d); });
    s.on('error', reject);
  });
  await other.close();
  assert.deepStrictEqual([reply[7], reply[8]], [0x86, 1], 'exception 01');
  assert.deepStrictEqual(other.stats.writes.map(w => [w.unit, w.fc]), [[1, 6]]);
});

test('the simulator received no write request from the probe in this whole file', () => {
  assert.ok(sim.stats.total > 50, `the probe did talk to it (${sim.stats.total} requests)`);
  assert.deepStrictEqual(sim.stats.writes, []);
});
