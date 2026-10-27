// onboard/transport-ssh.js — the NMC CLI over SSH (spec 04 §3, priority 1),
// and config.ini over SCP (§3, the backup).
//
// Two checks stand between cflex-onboard and a card, both here:
//   1. gate.assert(ip) before a socket is opened (targets.js — option 1 list),
//   2. commands.check(line, mode) before a line is written to the channel.
// run() is the only function that writes to the shell, scpGet() the only one
// that opens an exec channel, and its one allowed line is `scp -f config.ini`.
//
// Host keys: trust on first use, pinned in <out>/known_hosts.json (0600). A
// changed key is refused — a card swap is resolved by the operator deleting
// that line, not by this tool.
const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('ssh2');
const commands = require('./commands');

class TransportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Older AOS builds offer only these (NMC2 v5/v6). Appended, not preferred —
// only with --ssh-legacy-algorithms.
const LEGACY_ALGORITHMS = {
  kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] },
  cipher: { append: ['aes128-cbc', 'aes256-cbc', '3des-cbc'] },
  serverHostKey: { append: ['ssh-rsa'] },
  hmac: { append: ['hmac-sha1'] },
};

const PROMPT = /(?:^|\n)[A-Za-z0-9_.@-]{1,32}>\s?$/;
const SCP_FILES = new Set(['config.ini']);

function knownHosts(path) {
  let map = {};
  if (path && fs.existsSync(path)) { try { map = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { map = {}; } }
  return {
    get: (ip) => map[ip] || null,
    set(ip, fp) {
      map[ip] = fp;
      if (path) fs.writeFileSync(path, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
    },
  };
}

/**
 * @param {object} o
 * @param {object} o.gate          targets.createGate()
 * @param {object} o.redactor      credentials.createRedactor()
 * @param {object} [o.log]
 * @param {number} [o.timeoutMs]   per step: connect, each command, the SCP transfer (spec 04 §5-5: 30 s)
 * @param {string} [o.knownHostsPath]
 * @param {Function} [o.endpoint]  ip → {host, port}; the default is {host: ip, port: 22}.
 *                                 Tests map 192.0.2.x to the 127.0.0.1 simulator here.
 * @param {boolean} [o.legacyAlgorithms]
 * @param {Function} [o.onCommand] (ip, displayLine, kind) — audit hook
 */
function createSshTransport({ gate, redactor, log = console, timeoutMs = 30000, knownHostsPath = null, endpoint = null,
  legacyAlgorithms = false, onCommand = null }) {
  const hosts = knownHosts(knownHostsPath);
  const ep = endpoint || ((ip) => ({ host: ip, port: 22 }));
  let connections = 0;

  function connect(ip, cred) {
    gate.assert(ip); // no socket for an address outside the list
    const { host, port } = ep(ip);
    connections++;
    return new Promise((resolve, reject) => {
      const c = new Client();
      let settled = false;
      const done = (err, v) => {
        if (settled) return;
        settled = true;
        if (err) { try { c.end(); } catch { /* closing */ } reject(err); } else resolve(v);
      };
      c.on('keyboard-interactive', (name, instr, lang, prompts, finish) => finish(prompts.map(() => cred.password)));
      c.on('ready', () => done(null, c));
      c.on('error', (e) => {
        if (e.level === 'client-authentication') return done(new TransportError('auth_failed', `${ip}: authentication failed`));
        if (e.code === 'host_key_mismatch') return done(e);
        if (/timed out/i.test(e.message)) return done(new TransportError('unreachable', `${ip}: SSH timeout`));
        return done(new TransportError('unreachable', `${ip}: SSH ${e.code || 'error'}`));
      });
      c.connect({
        host, port, username: cred.user, password: cred.password, tryKeyboard: true,
        readyTimeout: timeoutMs, keepaliveInterval: 0,
        ...(legacyAlgorithms ? { algorithms: LEGACY_ALGORITHMS } : {}),
        hostVerifier: (key) => {
          const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          const had = hosts.get(ip);
          if (!had) { hosts.set(ip, fp); log.warn(`[onboard] ${ip}: new host key ${fp} pinned (first use)`); return true; }
          if (had === fp) return true;
          setImmediate(() => done(new TransportError('host_key_mismatch', `${ip}: host key changed (pinned ${had}, offered ${fp}) — refused`)));
          return false;
        },
      });
    });
  }

  /**
   * @param {object} target   {ip, …}
   * @param {object} cred     credentials.forTarget()
   * @param {object} [mode]   {write: false, policy: {legacy, ntp}}
   */
  async function open(target, cred, mode = { write: false, policy: {} }) {
    const ip = target.ip;
    const client = await connect(ip, cred);
    let shell = null;
    let buf = '';
    let waiter = null;

    function waitPrompt() {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { waiter = null; reject(new TransportError('timeout', `${ip}: no CLI prompt within ${timeoutMs} ms`)); }, timeoutMs);
        waiter = () => {
          const norm = buf.replace(/\r/g, '');
          if (PROMPT.test(norm)) { clearTimeout(t); waiter = null; const out = norm; buf = ''; resolve(out); }
        };
        waiter();
      });
    }

    async function startShell() {
      shell = await new Promise((resolve, reject) => client.shell({ term: 'vt100', cols: 200, rows: 60 }, (e, s) => (e ? reject(new TransportError('unreachable', `${ip}: no shell`)) : resolve(s))));
      shell.on('data', (d) => { buf += d.toString('utf8'); if (waiter) waiter(); });
      shell.stderr?.on('data', (d) => { buf += d.toString('utf8'); if (waiter) waiter(); });
      return waitPrompt(); // banner
    }

    async function run(line) {
      const kind = commands.check(line, mode); // throws before anything is written
      if (!shell) await startShell();
      const shown = commands.display(line);
      log.log(redactor.redact(`[onboard] ${ip} ${kind.kind}> ${shown}`));
      if (onCommand) onCommand(ip, redactor.redact(shown), kind.kind);
      const p = waitPrompt();
      shell.write(`${line}\r`);
      const raw = await p;
      // Drop the echoed line and the trailing prompt.
      const lines = raw.split('\n');
      if (lines.length && lines[0].trim() === line) lines.shift();
      if (lines.length && PROMPT.test('\n' + lines[lines.length - 1])) lines.pop();
      const out = lines.join('\n');
      return { out, result: commands.resultOf(out) };
    }

    /** SCP sink for one whitelisted file (config.ini). */
    function scpGet(file) {
      if (!SCP_FILES.has(file)) return Promise.reject(new commands.CommandRefused(`scp ${file} is not on the whitelist`));
      if (onCommand) onCommand(ip, `scp -f ${file}`, 'read');
      return new Promise((resolve, reject) => {
        client.exec(`scp -f ${file}`, (e, ch) => {
          if (e) return reject(new TransportError('scp_failed', `${ip}: scp not available`));
          let state = 'header', acc = Buffer.alloc(0), size = 0;
          const t = setTimeout(() => { ch.close(); reject(new TransportError('timeout', `${ip}: scp timeout`)); }, timeoutMs);
          const fail = (m) => { clearTimeout(t); ch.close(); reject(new TransportError('scp_failed', `${ip}: ${m}`)); };
          ch.on('data', (d) => {
            acc = Buffer.concat([acc, d]);
            for (;;) {
              if (state === 'header') {
                if (acc.length && (acc[0] === 1 || acc[0] === 2)) return fail('scp error from card');
                const nl = acc.indexOf(0x0a);
                if (nl < 0) return;
                const h = acc.slice(0, nl).toString('utf8');
                acc = acc.slice(nl + 1);
                const m = /^C0[0-7]{3} (\d+) (\S+)$/.exec(h);
                if (!m) return fail('unexpected scp header');
                size = parseInt(m[1], 10);
                if (size > 4 * 1024 * 1024) return fail('config.ini larger than 4 MB');
                state = 'data';
                ch.write(Buffer.from([0]));
              } else if (state === 'data') {
                if (acc.length < size + 1) return;
                const body = acc.slice(0, size);
                acc = acc.slice(size + 1);
                state = 'end';
                ch.write(Buffer.from([0]));
                clearTimeout(t);
                ch.end();
                return resolve(body);
              } else return;
            }
          });
          ch.on('close', () => { if (state !== 'end') fail('scp closed early'); });
          ch.write(Buffer.from([0]));
        });
      });
    }

    function close() {
      try { if (shell) shell.end(); } catch { /* closing */ }
      try { client.end(); } catch { /* closing */ }
    }

    return { ip, run, scpGet, close };
  }

  return { open, connections: () => connections };
}

module.exports = { createSshTransport, TransportError, LEGACY_ALGORITHMS };
