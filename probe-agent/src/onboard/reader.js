// onboard/reader.js — `cflex-onboard read` (spec 04 §4.1): the card's
// settings, from the read commands only. Nothing here can write: the session
// is opened read-only and commands.check() refuses any write line on it.
//
// Parsers follow the output layout in the NMC2/NMC3 CLI guides — "Key: value"
// lines grouped under section titles or "Index:" entries. Labels differ a
// little between NMC2 and NMC3 (both are accepted). NOT CONFIRMED ON A REAL
// CARD; the simulator (test/sim/nmc-cli-sim.js) reproduces the guide layout.
//
// Community names and trap communities are never kept: only whether one is
// set, its length and whether it is a factory name (public/private). The
// values are registered with the redactor so they cannot appear later either.

const READ_ORDER = ['about', 'upsabout', 'tcpip', 'date', 'ntp', 'snmp', 'snmpv3', 'snmptrap', 'web', 'console'];
const FACTORY_COMMUNITIES = new Set(['public', 'private']);

const norm = (k) => k.trim().toLowerCase().replace(/[^a-z0-9#]+/g, '_').replace(/^_|_$/g, '');
const onOff = (v) => (v == null ? null : /^(enabled?|on|yes)$/i.test(String(v).trim()) ? true : /^(disabled?|off|no)$/i.test(String(v).trim()) ? false : null);
const ip0 = (v) => (!v || v === '0.0.0.0' ? null : v);

/** "Key: value" lines → [{section, key, value}] (section = the title above a dashed rule). */
function kvLines(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*-{3,}\s*$/.test(lines[i + 1] || '') && l.trim() && !l.includes(':')) { section = norm(l); i++; continue; }
    if (/^E\d{3}:/.test(l.trim())) continue;
    const m = /^\s*([^:]+?)\s*:\s*(.*)$/.exec(l);
    if (m) out.push({ section, key: norm(m[1]), value: m[2].trim() });
    else if (l.trim() && !/^-+$/.test(l.trim())) { section = norm(l); }
  }
  return out;
}

const pick = (kv, keys, section = null) => {
  for (const k of keys) {
    const hit = kv.find(e => e.key === k && (section == null || e.section.includes(section)));
    if (hit) return hit.value;
  }
  return null;
};

/** Entries that start at a given key ("Index", "Access Control #"). */
function entries(kv, startKeys) {
  const out = [];
  let cur = null;
  for (const e of kv) {
    if (startKeys.includes(e.key)) { cur = { _section: e.section, index: parseInt(e.value, 10) }; out.push(cur); continue; }
    if (cur) cur[e.key] = e.value;
  }
  return out;
}

function familyOf(model) {
  const m = String(model || '').toUpperCase();
  if (/^AP963\d/.test(m)) return 'NMC2';
  if (/^AP964\d/.test(m)) return 'NMC3';
  return null;
}

function parseAbout(text) {
  const kv = kvLines(text);
  const model = pick(kv, ['model_number', 'model'], 'hardware');
  return {
    family: familyOf(model),
    model,
    serial: pick(kv, ['serial_number'], 'hardware'),
    hw_rev: pick(kv, ['hardware_revision'], 'hardware'),
    mfg_date: pick(kv, ['manufacture_date'], 'hardware'),
    mac: pick(kv, ['mac_address'], 'hardware'),
    app_name: pick(kv, ['name'], 'application'),
    app_version: pick(kv, ['version'], 'application'),
    aos_version: pick(kv, ['version'], 'aos') || pick(kv, ['version'], 'apc_os'),
  };
}

function parseUpsAbout(text) {
  const kv = kvLines(text);
  return {
    model: pick(kv, ['model']),
    sku: pick(kv, ['sku']),
    serial: pick(kv, ['serial_number']),
    mfg_date: pick(kv, ['manufacture_date']),
    firmware: pick(kv, ['firmware_revision', 'firmware']),
  };
}

function parseTcpip(text) {
  const kv = kvLines(text);
  return {
    ip: pick(kv, ['active_ipv4_address', 'ipv4_address', 'system_ip']),
    mask: pick(kv, ['active_ipv4_subnet_mask', 'subnet_mask']),
    gateway: pick(kv, ['active_ipv4_gateway', 'gateway', 'default_gateway']),
    hostname: pick(kv, ['host_name', 'hostname']),
    domain: pick(kv, ['domain_name']),
  };
}

function parseDate(text) {
  const kv = kvLines(text);
  return { date: pick(kv, ['date']), time: pick(kv, ['time']), format: pick(kv, ['format']), tz: pick(kv, ['time_zone']) };
}

function parseNtp(text) {
  const kv = kvLines(text);
  return {
    enabled: onOff(pick(kv, ['ntp_status', 'ntp', 'status', 'override_manual_settings'])),
    primary: ip0(pick(kv, ['primary_ntp_server', 'primary_server'])),
    secondary: ip0(pick(kv, ['secondary_ntp_server', 'secondary_server'])),
  };
}

function maskCommunity(v, redactor) {
  const s = v == null ? '' : String(v);
  if (redactor && s) redactor.add(s);
  return { set: !!s, length: s.length, factory: FACTORY_COMMUNITIES.has(s.toLowerCase()) };
}

function parseSnmp(text, redactor) {
  const kv = kvLines(text);
  const access = entries(kv, ['access_control_#', 'access_control']).map(e => ({
    index: e.index, community: maskCommunity(e.community, redactor), access: e.access_type || null, nms: e.nms_ip_host_name || e.nms_ip || null,
  }));
  return { enabled: onOff(pick(kv, ['snmpv1', 'snmp', 'snmpv1_access'])), access };
}

function parseSnmpv3(text) {
  const kv = kvLines(text);
  const all = entries(kv, ['index']);
  const users = all.filter(e => e._section.includes('profile')).map(e => ({
    index: e.index, name: e.user_name || null, auth: (e.authentication || 'none').toLowerCase(), priv: (e.encryption || e.privacy || 'none').toLowerCase(),
  }));
  const access = all.filter(e => e._section.includes('access')).map(e => ({
    index: e.index, name: e.user_name || null, enabled: onOff(e.access), nms: e.nms_ip_host_name || e.nms_ip || null,
  }));
  return { supported: true, enabled: onOff(pick(kv, ['snmpv3', 'snmpv3_access'])), users, access };
}

function parseSnmptrap(text, redactor) {
  const kv = kvLines(text);
  return entries(kv, ['index', 'receiver']).map(e => ({
    index: e.index,
    receiver: ip0(e.receiver_ip || e.nms_ip || e.receiver_nms_ip),
    type: (e.trap_type || '').toLowerCase() || null,
    generation: onOff(e.generation),
    auth_traps: onOff(e.auth_traps),
    user: e.user_name || e.profile || null,
    community: maskCommunity(e.community, redactor),
  }));
}

function parseWeb(text) {
  const kv = kvLines(text);
  return { http: onOff(pick(kv, ['http'])), https: onOff(pick(kv, ['https'])), http_port: pick(kv, ['http_port']), https_port: pick(kv, ['https_port']) };
}

function parseConsole(text) {
  const kv = kvLines(text);
  return { telnet: onOff(pick(kv, ['telnet'])), ssh: onOff(pick(kv, ['ssh'])), ssh_port: pick(kv, ['ssh_port']) };
}

function parseUser(text) {
  const kv = kvLines(text);
  return { access: onOff(pick(kv, ['access'])), permission: pick(kv, ['user_permission', 'permission', 'user_type']) };
}

/**
 * Every read command, parsed.
 * @param {object} session     transport-ssh open() (read-only)
 * @param {object} o
 * @param {object} o.cred      credentials.forTarget()
 * @param {boolean} o.factory  credentials.isFactory(cred)
 * @param {object} o.redactor
 */
async function readDevice(session, { cred, factory = false, redactor = null } = {}) {
  const raw = {};
  const errors = {};
  for (const cmd of READ_ORDER) {
    const r = await session.run(cmd);
    if (r.result.ok) raw[cmd] = r.out;
    else errors[cmd] = r.result.code || 'no_result';
  }
  let account = null;
  if (cred?.user && /^[A-Za-z0-9_.-]{1,32}$/.test(cred.user)) {
    const r = await session.run(`user -n ${cred.user}`);
    if (r.result.ok) account = parseUser(r.out);
  }
  const v3 = raw.snmpv3 != null ? parseSnmpv3(raw.snmpv3)
    // E101 "Command not supported": firmware too old for SNMPv3.
    : { supported: errors.snmpv3 !== 'E101' ? null : false, enabled: false, users: [], access: [] };
  const nmc = raw.about != null ? parseAbout(raw.about) : {};
  return {
    family: nmc.family || null,
    nmc,
    ups: raw.upsabout != null ? parseUpsAbout(raw.upsabout) : null,
    network: raw.tcpip != null ? parseTcpip(raw.tcpip) : null,
    date: raw.date != null ? parseDate(raw.date) : null,
    ntp: raw.ntp != null ? parseNtp(raw.ntp) : null,
    snmp_v1: raw.snmp != null ? parseSnmp(raw.snmp, redactor) : null,
    snmp_v3: v3,
    traps: raw.snmptrap != null ? parseSnmptrap(raw.snmptrap, redactor) : [],
    web: raw.web != null ? parseWeb(raw.web) : null,
    console: raw.console != null ? parseConsole(raw.console) : null,
    login_account: account,
    factory_account: !!factory,
    errors,
  };
}

/**
 * config.ini → the same shape, as far as config.ini says it (the HTTPS read
 * fallback, spec 04 §3 priority 2). Key names follow the NMC config.ini
 * layout in the guides; NOT CONFIRMED ON A REAL CARD.
 */
function fromConfigIni(text, { redactor = null } = {}) {
  const sec = {};
  let cur = null;
  for (const l of String(text || '').replace(/\r/g, '').split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith(';')) continue;
    const s = /^\[(.+)\]$/.exec(t);
    if (s) { cur = sec[s[1]] = sec[s[1]] || {}; continue; }
    const kv = /^([^=]+)=(.*)$/.exec(t);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  const net = sec['NetworkTCP/IP'] || {};
  const snmp = sec.NetworkSNMP || {};
  const ntp = sec.SystemDate || sec['SystemDate/Time'] || {};
  const access = [];
  for (let n = 1; n <= 4; n++) {
    if (snmp[`AccessControl${n}Community`] == null) continue;
    access.push({ index: n, community: maskCommunity(snmp[`AccessControl${n}Community`], redactor), access: snmp[`AccessControl${n}AccessType`] || null, nms: snmp[`AccessControl${n}NMSIP`] || null });
  }
  const users = [], v3access = [];
  for (let n = 1; n <= 4; n++) {
    if (snmp[`SNMPv3User${n}UserName`] != null) users.push({ index: n, name: snmp[`SNMPv3User${n}UserName`], auth: (snmp[`SNMPv3User${n}AuthProtocol`] || 'none').toLowerCase(), priv: (snmp[`SNMPv3User${n}PrivProtocol`] || 'none').toLowerCase() });
    if (snmp[`SNMPv3Access${n}Enable`] != null) v3access.push({ index: n, name: snmp[`SNMPv3Access${n}UserName`] || null, enabled: onOff(snmp[`SNMPv3Access${n}Enable`]), nms: snmp[`SNMPv3Access${n}NMSIP`] || null });
  }
  const traps = [];
  for (let n = 1; n <= 6; n++) {
    if (snmp[`TrapReceiver${n}NMSIP`] == null) continue;
    traps.push({ index: n, receiver: ip0(snmp[`TrapReceiver${n}NMSIP`]), type: (snmp[`TrapReceiver${n}Type`] || '').toLowerCase() || null, generation: onOff(snmp[`TrapReceiver${n}Generation`]), auth_traps: onOff(snmp[`TrapReceiver${n}AuthTraps`]), user: snmp[`TrapReceiver${n}Profile`] || null, community: maskCommunity(snmp[`TrapReceiver${n}Community`], redactor) });
  }
  return {
    family: null, nmc: {}, ups: null,
    network: { ip: net.SystemIP || null, mask: net.SubnetMask || null, gateway: net.DefaultGateway || null, hostname: net.HostName || null, domain: net.DomainName || null },
    date: null,
    ntp: { enabled: onOff(ntp.NTPEnable), primary: ip0(ntp.NTPPrimaryServer), secondary: ip0(ntp.NTPSecondaryServer) },
    snmp_v1: { enabled: onOff(snmp.SNMPv1Enable || snmp.Access), access },
    snmp_v3: { supported: snmp.SNMPv3Enable != null ? true : null, enabled: onOff(snmp.SNMPv3Enable), users, access: v3access },
    traps, web: null, console: null, login_account: null, factory_account: false, errors: {}, via: 'config.ini',
  };
}

module.exports = {
  readDevice, fromConfigIni, READ_ORDER, familyOf,
  parse: { kvLines, parseAbout, parseUpsAbout, parseTcpip, parseDate, parseNtp, parseSnmp, parseSnmpv3, parseSnmptrap, parseWeb, parseConsole, parseUser },
};
