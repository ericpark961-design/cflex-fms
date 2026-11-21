// Modbus TCP — read only. (WO-INT-017)
//
// The probe collects and shows; it never sets anything on a device (D-12a).
// For SNMP that is a matter of only ever issuing GETs. For Modbus it has to be
// enforced, because one function code is all that separates "read the supply
// temperature" from "write a setpoint", and the request builder is the one
// place every request goes through. So:
//
//   · function codes 1 (coils), 2 (discrete inputs), 3 (holding registers) and
//     4 (input registers) are the only ones this module will put on the wire;
//   · 5, 6, 15, 16, 22 and 23 (the write codes) are refused by name, and any
//     other code is refused as unknown. There is no write path to opt into.
//
// Rewritten from the Codex reference (cflex-fms-codex/services/probe/collectors/
// modbus.mjs, 53b8c00) as CommonJS on node:net alone — no npm dependency, which
// on the RHEL Satellite hosts would be a security review of its own — and
// extended with what a probe cycle needs and a one-shot script does not:
// coils and discrete inputs (contact modules), request splitting, one
// connection per host shared by every unit ID behind it, and exception codes
// that say what they mean.
//
// Hosts come from the inventory only. Nothing in here takes an address from a
// profile or a setting: the caller passes the ledger device's IP.
const net = require('net');

const DEFAULTS = Object.freeze({ timeoutMs: 3000, retries: 1, port: 502 });

/** Table name → read function code. The only codes this module sends. */
const READ_FC = Object.freeze({ coil: 1, discrete: 2, holding: 3, input: 4 });
const READ_CODES = new Set(Object.values(READ_FC));
/** Refused by name, so the error says why rather than "unknown". */
const WRITE_CODES = new Set([5, 6, 15, 16, 22, 23]);

/** Modbus application protocol limits per request (spec V1.1b3 §6.1–6.4). */
const MAX_REGISTERS = 125;
const MAX_BITS = 2000;

const isBitFc = (fc) => fc === 1 || fc === 2;

/**
 * Exception codes, in words. 02 matters most: it is not a communication
 * failure but the device saying "there is no such address" — which, for a
 * profile that has worked elsewhere, means the register map does not match
 * this model. Reporting that as "unreachable" would send someone to check a
 * cable.
 */
const EXCEPTIONS = Object.freeze({
  1: 'illegal function (지원하지 않는 기능)',
  2: 'illegal data address (없는 주소) — the register map does not match this device',
  3: 'illegal data value (잘못된 값)',
  4: 'server device failure (장비 고장)',
  5: 'acknowledge (처리 중)',
  6: 'server device busy (장비 사용 중)',
  8: 'memory parity error',
  10: 'gateway path unavailable (게이트웨이 경로 없음)',
  11: 'gateway target device failed to respond (게이트웨이 대상 무응답)',
});

/**
 * kind:
 *   'request'   — refused before anything was sent (write code, bad range)
 *   'exception' — the device answered with an exception (code set)
 *   'protocol'  — an answer that failed validation; its values were discarded
 *   'comms'     — timeout, refused, reset, closed: nothing usable came back
 */
class ModbusError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ModbusError';
    this.kind = kind;
    Object.assign(this, extra);
  }
  /** Exception 02: the map, not the wire. */
  get mapMismatch() { return this.kind === 'exception' && this.code === 2; }
}

function exceptionError(code, fc) {
  const text = EXCEPTIONS[code] || `exception code ${code}`;
  return new ModbusError('exception', `modbus exception ${String(code).padStart(2, '0')} on fc ${fc}: ${text}`, { code, fc });
}

/**
 * One read request as bytes (MBAP header + PDU).
 * @param {{unitId:number, fc:number, address:number, count:number}} r  address is the PDU address (0-based)
 * @param {number} tid transaction id 0–65535
 */
function buildReadRequest({ unitId, fc, address, count }, tid) {
  if (WRITE_CODES.has(fc)) {
    throw new ModbusError('request', `function code ${fc} is a write — refused: the probe is read-only (D-12a)`, { fc });
  }
  if (!READ_CODES.has(fc)) throw new ModbusError('request', `function code ${fc} is not a read code (1–4) — refused`, { fc });
  const max = isBitFc(fc) ? MAX_BITS : MAX_REGISTERS;
  const bad = [unitId, address, count, tid].some(v => !Number.isInteger(v))
    || unitId < 0 || unitId > 255 || tid < 0 || tid > 0xffff
    || address < 0 || count < 1 || count > max || address + count > 0x10000;
  if (bad) throw new ModbusError('request', `invalid read request unit ${unitId} fc ${fc} address ${address} count ${count}`, { fc });
  const b = Buffer.alloc(12);
  b.writeUInt16BE(tid, 0);
  b.writeUInt16BE(0, 2);           // protocol id: Modbus
  b.writeUInt16BE(6, 4);           // unit id + 5 PDU bytes
  b[6] = unitId;
  b[7] = fc;
  b.writeUInt16BE(address, 8);
  b.writeUInt16BE(count, 10);
  return b;
}

/**
 * Validate one complete response frame against its request and return the
 * values: register words, or bits (0/1) for fc 1 and 2. Anything that does
 * not match — transaction id, protocol id, unit id, length, function code,
 * byte count — throws, and nothing from the frame is used.
 */
function decodeReadResponse(b, req) {
  if (!Buffer.isBuffer(b) || b.length < 9) throw new ModbusError('protocol', 'short modbus response');
  const tid = req.readUInt16BE(0), unit = req[6], fc = req[7], count = req.readUInt16BE(10);
  if (b.readUInt16BE(0) !== tid) throw new ModbusError('protocol', `transaction id mismatch (sent ${tid}, got ${b.readUInt16BE(0)}) — response discarded`);
  if (b.readUInt16BE(2) !== 0) throw new ModbusError('protocol', `protocol id ${b.readUInt16BE(2)} is not 0 (Modbus) — response discarded`);
  if (b.readUInt16BE(4) !== b.length - 6) throw new ModbusError('protocol', `length field ${b.readUInt16BE(4)} does not match frame (${b.length - 6}) — response discarded`);
  if (b[6] !== unit) throw new ModbusError('protocol', `unit id mismatch (sent ${unit}, got ${b[6]}) — response discarded`);
  if (b[7] === (fc | 0x80)) {
    if (b.length !== 9) throw new ModbusError('protocol', 'malformed exception response — discarded');
    throw exceptionError(b[8], fc);
  }
  if (b[7] !== fc) throw new ModbusError('protocol', `function code mismatch (sent ${fc}, got ${b[7]}) — response discarded`);
  const want = isBitFc(fc) ? Math.ceil(count / 8) : count * 2;
  if (b[8] !== want || b.length !== 9 + want) {
    throw new ModbusError('protocol', `byte count ${b[8]} (frame ${b.length - 9}) where ${want} expected — response discarded`);
  }
  if (isBitFc(fc)) return Array.from({ length: count }, (_, i) => (b[9 + (i >> 3)] >> (i & 7)) & 1);
  return Array.from({ length: count }, (_, i) => b.readUInt16BE(9 + i * 2));
}

/** Split [address, address+count) into requests the protocol allows. */
function splitRange(fc, address, count) {
  const max = isBitFc(fc) ? MAX_BITS : MAX_REGISTERS;
  const out = [];
  for (let a = address, left = count; left > 0; a += max, left -= max) out.push({ address: a, count: Math.min(max, left) });
  return out;
}

/**
 * One TCP connection to one host:port. Requests are strictly one at a time:
 * the caller (the pool's lane) waits for each answer before sending the next,
 * so a frame that arrives is either the answer to the outstanding request or
 * it is wrong — never an answer to some other request in flight.
 */
class Connection {
  constructor({ host, port, timeoutMs, connect }) {
    Object.assign(this, { host, port, timeoutMs, connect: connect || net.createConnection });
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.opened = 0;
  }

  open() {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = this.connect({ host: this.host, port: this.port });
      let done = false;
      const timer = setTimeout(() => fail(new ModbusError('comms', `connect timeout ${this.host}:${this.port} after ${this.timeoutMs} ms`)), this.timeoutMs);
      const fail = (e) => {
        if (done) return; done = true; clearTimeout(timer); s.destroy();
        reject(e.kind ? e : new ModbusError('comms', `connect ${this.host}:${this.port}: ${e.code || e.message}`, { cause: e }));
      };
      s.once('error', fail);
      s.once('connect', () => {
        if (done) return; done = true; clearTimeout(timer);
        s.removeListener('error', fail);
        s.setNoDelay(true);
        this.socket = s;
        this.opened++;
        this.buf = Buffer.alloc(0);
        // Events from a socket this connection has already let go of (closed
        // after a timeout, replaced by a reconnect) concern nobody.
        s.on('data', (chunk) => { if (this.socket === s) this.onData(chunk); });
        s.on('error', (e) => { if (this.socket === s) this.drop(new ModbusError('comms', `${this.host}:${this.port}: ${e.code || e.message}`)); });
        s.on('close', () => { if (this.socket === s) this.drop(new ModbusError('comms', `${this.host}:${this.port}: connection closed by peer`)); });
        resolve();
      });
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // A frame is 6 bytes of header plus the length field. A response cannot
    // exceed 260 bytes; anything claiming more is not Modbus.
    if (this.buf.length >= 6) {
      const len = this.buf.readUInt16BE(4);
      if (len < 2 || len > 254) return this.fail(new ModbusError('protocol', `implausible length field ${len} — response discarded`));
      if (this.buf.length >= 6 + len) {
        // Bytes beyond the frame mean the stream is out of step; take exactly
        // one frame and let validation judge it, but never reuse the rest.
        const frame = this.buf.subarray(0, 6 + len);
        const extra = this.buf.length > 6 + len;
        this.buf = Buffer.alloc(0);
        const w = this.waiter; this.waiter = null;
        if (w) w.resolve(frame);
        if (extra) this.close();
      }
    }
  }

  fail(err) {
    const w = this.waiter; this.waiter = null;
    this.close();
    if (w) w.reject(err);
  }

  drop(err) {
    this.socket = null;
    const w = this.waiter; this.waiter = null;
    if (w) w.reject(err);
  }

  /** Send one request and wait for one frame. */
  async exchange(req) {
    await this.open();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ModbusError('comms', `timeout after ${this.timeoutMs} ms (${this.host}:${this.port})`)), this.timeoutMs);
      this.waiter = {
        resolve: (f) => { clearTimeout(timer); resolve(f); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.buf = Buffer.alloc(0);
      this.socket.write(req);
    });
  }

  close() {
    const s = this.socket;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    if (s) s.destroy();
  }
}

/**
 * The connections of one poll cycle.
 *
 * Controllers and RTU gateways often accept one or two sessions in total, and
 * a gateway fronts several unit IDs. So: one connection per host:port, shared
 * by every unit ID behind it, and one request at a time on it — even when the
 * cycle runs twelve devices in parallel (POLL_CONCURRENCY), work for the same
 * host waits in that host's lane. close() at the end of the cycle drops them.
 *
 * @param {object} [o] { timeoutMs, retries, connect } — connect is for tests
 */
function createModbusPool(o = {}) {
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULTS.timeoutMs;
  const retries = Number.isFinite(o.retries) ? Math.max(0, o.retries) : DEFAULTS.retries;
  const lanes = new Map();   // "host:port" → { conn, tail: Promise }
  let tid = Math.floor(Math.random() * 0x10000);
  const nextTid = () => (tid = (tid + 1) & 0xffff);
  const stats = { connects: 0, requests: 0 };

  function lane(host, port) {
    const key = `${host}:${port}`;
    let l = lanes.get(key);
    if (!l) {
      l = { conn: new Connection({ host, port, timeoutMs, connect: o.connect }), tail: Promise.resolve() };
      lanes.set(key, l);
    }
    return l;
  }

  /** Run fn(conn) after everything already queued for this host. */
  function serial(host, port, fn) {
    const l = lane(host, port);
    const run = l.tail.then(() => fn(l.conn));
    l.tail = run.catch(() => {});
    return run;
  }

  async function once(conn, spec) {
    const req = buildReadRequest(spec, nextTid());
    const before = conn.opened;
    try {
      const frame = await conn.exchange(req);
      stats.requests++;
      return decodeReadResponse(frame, req);
    } catch (e) {
      // A frame that failed validation leaves the stream in an unknown
      // state; start the next request on a fresh connection.
      if (e.kind === 'protocol') conn.close();
      throw e;
    } finally {
      stats.connects += conn.opened - before;
    }
  }

  /**
   * Read a contiguous range from one unit. Split as the protocol requires;
   * retried on comms and protocol failures (not on an exception — the device
   * answered, and asking again changes nothing).
   * @returns {Promise<number[]>} words, or bits for coil/discrete
   */
  function read({ host, port = DEFAULTS.port, unitId, table, fc, address, count }) {
    const code = fc ?? READ_FC[table];
    // Validate before queueing: a refused request never touches the lane.
    let parts;
    try {
      if (!Number.isInteger(count) || count < 1) throw new ModbusError('request', `invalid count ${count}`);
      parts = splitRange(code, address, count);
      for (const part of parts) buildReadRequest({ unitId, fc: code, ...part }, 0);
    } catch (e) { return Promise.reject(e); }
    if (!host) return Promise.reject(new ModbusError('request', 'no host — the device has no IP in the ledger'));
    return serial(host, port, async (conn) => {
      const out = [];
      for (const part of parts) {
        for (let attempt = 0; ; attempt++) {
          try { out.push(...await once(conn, { unitId, fc: code, ...part })); break; }
          catch (e) { if (e.kind === 'exception' || e.kind === 'request' || attempt >= retries) throw e; }
        }
      }
      return out;
    });
  }

  function close() {
    for (const l of lanes.values()) l.conn.close();
    lanes.clear();
  }

  return { read, close, stats, hosts: () => [...lanes.keys()] };
}

module.exports = {
  DEFAULTS, READ_FC, WRITE_CODES, EXCEPTIONS, MAX_REGISTERS, MAX_BITS,
  ModbusError, buildReadRequest, decodeReadResponse, splitRange, createModbusPool,
};
