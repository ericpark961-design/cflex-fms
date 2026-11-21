// Modbus TCP simulator. Dev-only, node:net, no dependencies. (WO-INT-017 §3.6)
//
// One listener, any number of unit IDs behind it — the way an RS-485 → TCP
// gateway fronts several controllers — each with holding / input / coil /
// discrete tables. An address that is not in a table answers exception 02,
// like a real device asked for a register its map does not have.
//
// Its other job is to catch the probe misbehaving: every WRITE function code
// (5, 6, 15, 16, 22, 23) is answered with exception 01 and RECORDED, so a test
// can assert that the probe sent none. It also counts connections and the
// most it ever had open at once, and the most requests in flight on one
// connection, which is how "one connection per host, one request at a time"
// is checked rather than assumed.
//
// Default tables (no MODBUS_TABLES): unit 1 is the CRAC that
// profiles/modbus/sim-crac.json describes, unit 2 a 16-channel contact module.
//
//   MODBUS_PORT=15020 node sim/sim-modbus.js
//   MODBUS_PORT=15020 SUPPLY_C=18.3 RETURN_C=26.5 COOLING=standby ALARMS=1 node sim/sim-modbus.js
//   MODBUS_PORT=15020 DIO_INPUTS=1,0,0,1 node sim/sim-modbus.js          # unit 2 discrete inputs 0..3
//   MODBUS_PORT=15020 MODBUS_TABLES='{"1":{"input":{"0":183,"1":265}}}' node sim/sim-modbus.js
//   MODBUS_PORT=15020 MODBUS_TABLES_FILE=./tables.json node sim/sim-modbus.js
//   MODBUS_PORT=15020 FRAGMENT=3 DELAY_MS=200 node sim/sim-modbus.js     # 3-byte TCP writes, 200 ms late
//   MODBUS_PORT=15020 EXCEPTION=4 node sim/sim-modbus.js                 # every read → exception 04
//   MODBUS_PORT=15020 DISCONNECT=1 node sim/sim-modbus.js                # hang up on every request
//
// stdin (one per line): `cooling on|standby|off`, `dio <n> 0|1`, `exception <code>|off`.
//
// Table JSON: { "<unit>": { "holding": {"<pdu addr>": word}, "input": {...}, "coil": {"<addr>": 0|1}, "discrete": {...} } }
// Addresses are PDU (0-based). Words are 0–65535 (write a negative int16 as its two's complement, or as a negative number).
const net = require('net');

const FC_TABLE = { 1: 'coil', 2: 'discrete', 3: 'holding', 4: 'input' };
const WRITE_CODES = new Set([5, 6, 15, 16, 22, 23]);

const CODE = { on: 1, standby: 2, off: 3 };

/** Unit 1 = sim-crac.json, unit 2 = contact module. */
function defaultTables(env = {}) {
  const tenth = (v) => Math.round(parseFloat(v) * 10) & 0xffff;
  const f32 = Buffer.alloc(4); f32.writeFloatBE(parseFloat(env.SETPOINT_C || '21.5'), 0);
  const dio = String(env.DIO_INPUTS || '0,0,0,0').split(',').map(x => (x.trim() === '1' ? 1 : 0));
  const discrete2 = {};
  for (let i = 0; i < 16; i++) discrete2[i] = dio[i] || 0;
  return {
    1: {
      input: {
        0: tenth(env.SUPPLY_C || '18.3'), 1: tenth(env.RETURN_C || '26.5'), 2: tenth(env.HUMIDITY || '45.0'),
        10: f32.readUInt16BE(0), 11: f32.readUInt16BE(2),
      },
      holding: {
        0: CODE[(env.SYSTEM || 'on').toLowerCase()] ?? 1,
        1: CODE[(env.COOLING || 'on').toLowerCase()] ?? 1,
        2: parseInt(env.ALARMS || '0', 10),
        3: parseInt(env.FAN_PCT || '72', 10),
      },
      discrete: { 0: env.FILTER_ALARM === '1' ? 1 : 0 },
    },
    2: { discrete: discrete2, coil: { ...discrete2 } },
  };
}

/**
 * @param {object} o
 * @param {object} [o.tables]      as the JSON above
 * @param {number} [o.fragment]    write responses in pieces of this many bytes
 * @param {number} [o.delayMs]     answer this late
 * @param {number} [o.exception]   answer every read with this exception code
 * @param {boolean} [o.disconnect] close the connection instead of answering
 * @param {boolean} [o.silent]     never answer (for timeouts)
 * @param {Function} [o.tamper]    (frame:Buffer, req) → Buffer — rewrite a response (bad tid, unit, length…)
 * @param {object} [o.log]
 */
function createModbusSim(o = {}) {
  const opt = {
    tables: o.tables || defaultTables(), fragment: o.fragment || 0, delayMs: o.delayMs || 0,
    exception: o.exception || 0, disconnect: !!o.disconnect, silent: !!o.silent, tamper: o.tamper || null,
  };
  const log = o.log || { log: () => {} };
  const stats = { connections: 0, open: 0, maxOpen: 0, requests: 0, total: 0, maxInFlight: 0, writes: [], byUnit: {}, frames: [] };
  const sockets = new Set();

  const table = (unit, name) => (opt.tables[unit] || opt.tables[String(unit)] || {})[name] || {};
  const word = (v) => (v < 0 ? (v + 0x10000) & 0xffff : v & 0xffff);

  function exception(req, code) {
    const b = Buffer.alloc(9);
    req.copy(b, 0, 0, 4);
    b.writeUInt16BE(3, 4); b[6] = req[6]; b[7] = req[7] | 0x80; b[8] = code;
    return b;
  }

  function answer(req) {
    const unit = req[6], fc = req[7];
    stats.byUnit[unit] = (stats.byUnit[unit] || 0) + 1;
    if (WRITE_CODES.has(fc)) {
      stats.writes.push({ unit, fc, at: Date.now() });
      log.log(`[sim-modbus] WRITE REQUEST RECEIVED unit ${unit} fc ${fc} — answered exception 01`);
      return exception(req, 1);
    }
    const name = FC_TABLE[fc];
    if (!name || req.length < 12) return exception(req, 1);
    if (opt.exception) return exception(req, opt.exception);
    const addr = req.readUInt16BE(8), count = req.readUInt16BE(10);
    const t = table(unit, name);
    const vals = [];
    for (let a = addr; a < addr + count; a++) {
      const v = t[a] ?? t[String(a)];
      if (v == null) return exception(req, 2);
      vals.push(v);
    }
    let pdu;
    if (fc <= 2) {
      const n = Math.ceil(count / 8);
      pdu = Buffer.alloc(2 + n);
      vals.forEach((v, i) => { if (v) pdu[2 + (i >> 3)] |= 1 << (i & 7); });
      pdu[1] = n;
    } else {
      pdu = Buffer.alloc(2 + count * 2);
      vals.forEach((v, i) => pdu.writeUInt16BE(word(v), 2 + i * 2));
      pdu[1] = count * 2;
    }
    pdu[0] = fc;
    const b = Buffer.alloc(7 + pdu.length);
    req.copy(b, 0, 0, 4);
    b.writeUInt16BE(1 + pdu.length, 4); b[6] = unit;
    pdu.copy(b, 7);
    return b;
  }

  function send(sock, buf) {
    if (!opt.fragment) return sock.write(buf);
    for (let i = 0; i < buf.length; i += opt.fragment) {
      const piece = buf.subarray(i, i + opt.fragment);
      setTimeout(() => { if (!sock.destroyed) sock.write(piece); }, (i / opt.fragment) * 5);
    }
  }

  const server = net.createServer((sock) => {
    stats.connections++; stats.open++; stats.maxOpen = Math.max(stats.maxOpen, stats.open);
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let inFlight = 0;
    sock.on('close', () => { stats.open--; sockets.delete(sock); });
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 7 && buf.length >= 6 + buf.readUInt16BE(4)) {
        const req = buf.subarray(0, 6 + buf.readUInt16BE(4));
        buf = buf.subarray(req.length);
        stats.requests++; stats.total++;
        stats.frames.push({ unit: req[6], fc: req[7], address: req.length >= 12 ? req.readUInt16BE(8) : null, count: req.length >= 12 ? req.readUInt16BE(10) : null });
        inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
        if (opt.disconnect) { sock.destroy(); return; }
        if (opt.silent && !WRITE_CODES.has(req[7])) { continue; }
        let res = answer(Buffer.from(req));
        if (opt.tamper) res = opt.tamper(res, req);
        setTimeout(() => { inFlight--; if (!sock.destroyed) send(sock, res); }, opt.delayMs);
      }
    });
  });

  return {
    stats, server,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address().port); });
      });
    },
    set(changes) { Object.assign(opt, changes); },
    setValue(unit, name, addr, v) { ((opt.tables[unit] = opt.tables[unit] || {})[name] = opt.tables[unit][name] || {})[addr] = v; },
    // Per-test counters. `writes` and `total` are never reset: they cover the whole run.
    reset() { Object.assign(stats, { connections: 0, maxOpen: stats.open, requests: 0, maxInFlight: 0, byUnit: {}, frames: [] }); },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise(r => server.close(() => r()));
    },
  };
}

module.exports = { createModbusSim, defaultTables, WRITE_CODES };

if (require.main === module) {
  const fs = require('fs');
  const env = process.env;
  let tables = defaultTables(env);
  if (env.MODBUS_TABLES_FILE) tables = JSON.parse(fs.readFileSync(env.MODBUS_TABLES_FILE, 'utf8'));
  else if (env.MODBUS_TABLES) tables = JSON.parse(env.MODBUS_TABLES);
  const sim = createModbusSim({
    tables, log: console,
    fragment: parseInt(env.FRAGMENT || '0', 10), delayMs: parseInt(env.DELAY_MS || '0', 10),
    exception: parseInt(env.EXCEPTION || '0', 10), disconnect: env.DISCONNECT === '1',
  });
  const port = parseInt(env.MODBUS_PORT || '15020', 10);
  sim.listen(port, env.MODBUS_BIND || '127.0.0.1').then((p) => {
    console.log(`[sim-modbus] tcp/${p} units ${Object.keys(tables).join(',')}`);
    const c = tables[1]?.holding;
    if (c && !env.MODBUS_TABLES && !env.MODBUS_TABLES_FILE) {
      const name = (v) => Object.keys(CODE).find(k => CODE[k] === v) || `code${v}`;
      console.log(`[sim-modbus] unit 1 CRAC: supply ${env.SUPPLY_C || '18.3'}°C return ${env.RETURN_C || '26.5'}°C system=${name(c[0])} cooling=${name(c[1])} alarms=${c[2]}`);
      console.log(`[sim-modbus] unit 1 cooling_available must come out ${c[1] === 1 ? '1 (cooling)' : `0 (${name(c[1])})`}`);
      console.log(`[sim-modbus] unit 2 contacts: ${Object.values(tables[2].discrete).slice(0, 4).join(',')} (discrete 0..3)`);
    }
  });
  require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const [cmd, a, b] = line.trim().split(/\s+/);
    if (cmd === 'cooling' && CODE[a]) { sim.setValue(1, 'holding', 1, CODE[a]); console.log(`[sim-modbus] unit 1 cooling=${a}`); }
    else if (cmd === 'dio' && a != null) { sim.setValue(2, 'discrete', parseInt(a, 10), b === '1' ? 1 : 0); console.log(`[sim-modbus] unit 2 discrete ${a}=${b}`); }
    else if (cmd === 'exception') { sim.set({ exception: a === 'off' ? 0 : parseInt(a, 10) }); console.log(`[sim-modbus] exception ${a}`); }
  });
  const stop = () => {
    if (sim.stats.writes.length) console.log(`[sim-modbus] ${sim.stats.writes.length} WRITE request(s) received during this run`);
    else console.log('[sim-modbus] 0 write requests received');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
