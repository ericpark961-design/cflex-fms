// onboard/credentials.js — card log-ins and SNMPv3 keys (spec 04 §2).
//
// The values come from the operator at run time: onboard-credentials.yaml
// (mode 0600, refused otherwise) or prompts (--ask). The file may hold a value
// or `ref:NAME`, which is read from the environment variable NAME (or asked
// for). There are no values in the code, in site.yaml or in the repository.
//
// Every value loaded is registered with the redactor, and everything
// cflex-onboard prints or writes — log lines, prompts, reports, audit lines,
// error messages — goes through redact(). That is defence in depth: the code
// also never formats a credential into a message in the first place.
//
// Shape (structure only):
//   defaults:  { user: <u>, password: ref:ONBOARD_DEFAULT_PW, transport: ssh }
//   overrides: { <ip>: { user: <u>, password: ref:<NAME>, transport: ssh|https } }
//   snmpv3:    { auth_key: ref:<NAME>, priv_key: ref:<NAME> }
//   sites:     { <SITE>: { snmpv3: { auth_key: …, priv_key: … } } }
//   console:   { user: <u>, password: ref:<NAME> }      (optional, set_maintenance)
//   scan:      { community: ref:<NAME> }                 (optional, option 2 sysObjectID)
const fs = require('fs');
const readline = require('readline');
const { loads } = require('./yaml-lite');

// The factory account of an NMC (APC documentation; spec 04 §2). Not a secret
// of any site — it is compared against, to warn, never used to log in unless
// the operator's own credentials are these.
const FACTORY = { user: 'apc', password: 'apc' };
const MIN_REDACT = 4;
const AUTH_FAIL_LIMIT = 3;

class CredentialError extends Error { constructor(m) { super(m); this.code = 'credential_error'; } }

/** Replaces every registered secret value with ***. */
function createRedactor() {
  const values = new Set();
  let sorted = [];
  return {
    add(v) {
      if (v == null) return;
      const s = String(v);
      // Shorter values (the factory "apc") would mangle model names and prompts;
      // they are never printed in the first place.
      if (s.length < MIN_REDACT || values.has(s)) return;
      values.add(s);
      sorted = [...values].sort((a, b) => b.length - a.length);
    },
    redact(text) {
      let s = String(text == null ? '' : text);
      for (const v of sorted) s = s.split(v).join('***');
      return s;
    },
    size: () => values.size,
  };
}

/** A logger whose every line is redacted first. */
function safeLog(redactor, base = console) {
  const wrap = (fn) => (...a) => fn.call(base, redactor.redact(a.map(x => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
  return { log: wrap(base.log), info: wrap(base.info || base.log), warn: wrap(base.warn), error: wrap(base.error) };
}

/** Terminal prompts. Non-TTY input answers every question with its default. */
function createPrompt({ input = process.stdin, output = process.stderr } = {}) {
  const tty = !!input.isTTY;
  function ask(question, { secret = false, def = '' } = {}) {
    if (!tty) return Promise.resolve(def);
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input, output, terminal: true });
      if (secret) {
        // Echo nothing while the value is typed.
        rl._writeToOutput = (s) => { if (s.includes(question)) output.write(question); };
      }
      rl.question(question, (a) => { rl.close(); if (secret) output.write('\n'); resolve(a === '' ? def : a); });
    });
  }
  return {
    tty,
    ask,
    secret: (q) => ask(q, { secret: true }),
    confirm: async (q) => /^(y|yes|예)$/i.test(String(await ask(`${q} [y/N] `, { def: 'n' })).trim()),
  };
}

function checkMode(path, { platform = process.platform } = {}) {
  const st = fs.statSync(path);
  if (!st.isFile()) throw new CredentialError(`${path} is not a file`);
  if (platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new CredentialError(`${path} must be mode 0600 (it is ${(st.mode & 0o777).toString(8).padStart(4, '0')}) — chmod 600 it`);
  }
}

/**
 * @param {object} o
 * @param {string} [o.path]       onboard-credentials.yaml
 * @param {boolean} [o.askMode]   --ask: prompt for what the file does not give
 * @param {object} [o.prompt]     createPrompt()
 * @param {object} [o.env]        process.env
 * @param {object} [o.redactor]
 */
async function loadCredentials({ path = null, askMode = false, prompt = null, env = process.env, redactor = createRedactor(), platform } = {}) {
  let doc = {};
  if (path) {
    checkMode(path, { platform });
    try { doc = loads(fs.readFileSync(path, 'utf8')) || {}; } catch (e) {
      // The loader's messages carry a line number, never the line itself.
      throw new CredentialError(`${path}: ${e.message}`);
    }
  } else if (!askMode) {
    throw new CredentialError('no credentials: give --credentials <onboard-credentials.yaml> or --ask');
  }

  async function resolve(v, what) {
    if (v == null || v === '') {
      if (!askMode || !prompt) return null;
      const got = await prompt.secret(`${what}: `);
      redactor.add(got);
      return got || null;
    }
    const s = String(v);
    const m = /^ref:([A-Za-z_][A-Za-z0-9_]*)$/.exec(s);
    if (!m) { redactor.add(s); return s; }
    if (env[m[1]] != null && env[m[1]] !== '') { redactor.add(env[m[1]]); return env[m[1]]; }
    if (askMode && prompt) {
      const got = await prompt.secret(`${what} (${m[1]}): `);
      redactor.add(got);
      return got || null;
    }
    throw new CredentialError(`${what}: environment variable ${m[1]} is not set (or use --ask)`);
  }

  const d = doc.defaults || {};
  const defaults = {
    id: 'defaults',
    user: d.user != null ? String(d.user) : (askMode && prompt ? await prompt.ask('NMC user (defaults): ') : null),
    password: await resolve(d.password, 'NMC password (defaults)'),
    transport: d.transport || 'ssh',
  };
  const overrides = new Map();
  for (const [ip, o] of Object.entries(doc.overrides || {})) {
    const r = o || {};
    overrides.set(ip, {
      id: `override:${ip}`,
      user: r.user != null ? String(r.user) : defaults.user,
      password: r.password != null ? await resolve(r.password, `NMC password (${ip})`) : defaults.password,
      transport: r.transport || defaults.transport,
      // An override that only changes the transport shares the defaults' log-in,
      // so its failures count against the same set (lock-out is per account).
      shared: r.user == null && r.password == null,
    });
  }
  const keyCache = new Map();
  async function v3Keys(site) {
    const k = site && doc.sites?.[site]?.snmpv3 ? `site:${site}` : 'snmpv3';
    if (keyCache.has(k)) return keyCache.get(k);
    const src = (site && doc.sites?.[site]?.snmpv3) || doc.snmpv3 || {};
    const out = {
      authKey: await resolve(src.auth_key, `SNMPv3 auth pass phrase${site ? ` (${site})` : ''}`),
      privKey: await resolve(src.priv_key, `SNMPv3 privacy pass phrase${site ? ` (${site})` : ''}`),
    };
    keyCache.set(k, out);
    return out;
  }
  const consoleLogin = doc.console ? { user: doc.console.user || null, password: await resolve(doc.console.password, 'console password') } : null;
  const scan = doc.scan ? { community: await resolve(doc.scan.community, 'scan SNMP community') } : null;

  // ── auth failures (spec 04 §2): 3 in a row with one set → stop using it ──
  const fails = new Map();
  const suspended = new Set();
  const setId = (c) => (c.shared ? 'defaults' : c.id);

  return {
    redactor,
    forTarget(ip) {
      const c = overrides.get(ip) || defaults;
      if (!c.user || c.password == null) throw new CredentialError(`no log-in for ${ip} (${c.id})`);
      return { ...c, set: setId(c) };
    },
    v3Keys,
    console: consoleLogin,
    scan,
    /** Factory account in use? Compared in memory, never printed. */
    isFactory: (c) => c.user === FACTORY.user && c.password === FACTORY.password,
    isSuspended: (set) => suspended.has(set),
    resume: (set) => { suspended.delete(set); fails.set(set, 0); },
    /** @returns {number} consecutive failures for that set, after this one */
    authFailed(set) {
      const n = (fails.get(set) || 0) + 1;
      fails.set(set, n);
      if (n >= AUTH_FAIL_LIMIT) suspended.add(set);
      return n;
    },
    authOk(set) { fails.set(set, 0); },
  };
}

module.exports = { loadCredentials, createRedactor, safeLog, createPrompt, checkMode, CredentialError, AUTH_FAIL_LIMIT, FACTORY };
