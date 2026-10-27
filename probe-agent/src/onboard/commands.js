// onboard/commands.js — every NMC CLI line cflex-onboard may send, and the
// check that every line passes before it reaches the wire (spec 04 §5-1).
//
// transport-ssh.js calls check() inside run(); there is no other way to put a
// line on the SSH channel. A line is allowed only if it matches one of the
// fixed forms below, and a write form only on a session opened for writing
// with the policy flag that form needs. Everything else — output control,
// self-test, reboot, accounts, network, firmware, file transfer — is refused,
// whether or not it is on the explicit deny list (the deny list only gives the
// clearer reason). No SNMP SET exists anywhere in cflex-onboard: SNMP is the
// verifier's v3 GET only (verifier.js).
//
// Syntax source: APC NMC2 / NMC3 CLI guides (public documents). NOT CONFIRMED
// ON A REAL CARD — docs/onboard/NMC_CLI_COMMANDS.md; checked on site before SAT.

const IPV4 = '(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
// A v3 user name we create: no spaces, so the line splits unambiguously. A
// name we restore on rollback may be the card's default "apc snmp profile1",
// so quoted names with spaces are allowed there.
const NAME = '[A-Za-z0-9_.-]{1,32}';
const QNAME = `(?:${NAME}|"[A-Za-z0-9 _.-]{1,32}")`;
// NMC auth / privacy pass phrases: 15–32 printable characters, no space or quote.
const PHRASE = '[!#-~]{15,32}';
const PHRASE_RE = new RegExp(`^${PHRASE}$`);
const NAME_RE = new RegExp(`^${NAME}$`);
const IPV4_RE = new RegExp(`^${IPV4}$`);

/** Reads (spec 04 §4.1). Exact lines only — a read command with arguments is not a read. */
const READ = [
  /^about$/, /^upsabout$/, /^tcpip$/, /^ntp$/, /^date$/, /^snmp$/, /^snmpv3$/, /^snmptrap$/,
  /^web$/, /^console$/, new RegExp(`^user -n ${NAME}$`),
];

/** Writes (spec 04 §4.3), each with the policy flag it needs (null = apply itself). */
const WRITE = [
  { id: 'snmpv3_enable', re: /^snmpv3 -S (enable|disable)$/, needs: null },
  { id: 'snmpv3_user', re: new RegExp(`^snmpv3 -u([1-4]) ${QNAME}(?: -a\\1 ${PHRASE} -c\\1 ${PHRASE})? -ap\\1 (sha|md5|none) -pp\\1 (aes|des|none)$`), needs: null },
  { id: 'snmpv3_access', re: new RegExp(`^snmpv3 -ac([1-4]) (enable|disable) -au\\1 ${QNAME} -n\\1 ${IPV4}$`), needs: null },
  { id: 'snmptrap_receiver', re: new RegExp(`^snmptrap -r([1-6]) ${IPV4} -t\\1 (snmpV1|snmpV3) -g\\1 (enable|disable) -a\\1 (enable|disable)(?: -u\\1 profile[1-4])?$`), needs: null },
  { id: 'legacy_snmp', re: /^snmp -S (enable|disable)$/, needs: 'legacy' },
  { id: 'ntp', re: new RegExp(`^ntp -OM (enable|disable)(?: -p ${IPV4})?(?: -s ${IPV4})?$`), needs: 'ntp' },
];

/**
 * Known commands that change something outside the fixed scope. Listed so the
 * refusal says why; anything unlisted is refused anyway.
 */
const DENY = [
  [/^ups\b/i, 'UPS output control / self-test'],
  [/^(reboot|resettodef|clrrst|format|boot)\b/i, 'reboot / reset / format'],
  [/^(user|userdflt|radius|session)\b/i, 'accounts'],
  [/^(tcpip6?|dns|portspeed|eapol|web|console|ftp|smtp|email|system|prompt)\b.*-/i, 'network / services'],
  [/^(firmware|upload|xferini|xferstatus|delete|logzip)\b/i, 'firmware / file transfer'],
  [/^(cfgshutdn|cfgpower|bypass|outlet|olon|oloff|olreboot|alarmcount)\b/i, 'power configuration'],
];

class CommandRefused extends Error {
  constructor(reason) { super(`command refused: ${reason}`); this.code = 'command_refused'; }
}

/**
 * Throws CommandRefused unless `line` may be sent on this session.
 * @param {string} line
 * @param {{write?: boolean, policy?: {legacy?: boolean, ntp?: boolean}}} [mode]
 * @returns {{kind: 'read'|'write', id: string}}
 */
function check(line, { write = false, policy = {} } = {}) {
  if (typeof line !== 'string' || !line || /[\r\n\0]/.test(line) || line !== line.trim()) {
    throw new CommandRefused('not a single command line');
  }
  if (READ.some(re => re.test(line))) return { kind: 'read', id: line.split(' ')[0] };
  const w = WRITE.find(f => f.re.test(line));
  if (w) {
    if (!write) throw new CommandRefused(`${w.id} on a read-only session`);
    if (w.needs && !policy[w.needs]) throw new CommandRefused(`${w.id} needs --${w.needs === 'legacy' ? 'disable-legacy' : 'set-ntp'}`);
    return { kind: 'write', id: w.id };
  }
  const deny = DENY.find(([re]) => re.test(line));
  // The reason names the category, never the line: a refused line may carry a phrase.
  throw new CommandRefused(deny ? `${line.split(' ')[0]} — ${deny[1]} is outside the write scope` : `${line.split(' ')[0]} is not on the whitelist`);
}

/** The line with every pass phrase replaced, for logs, prompts and reports. */
function display(line) {
  const s = String(line);
  // Only `snmpv3 -u<n>` carries phrases (-a<n> auth, -c<n> privacy); snmptrap's -a<n> is a flag.
  return /^snmpv3 -u[1-4] /.test(s) ? s.replace(/ (-[ac][1-4]) \S+/g, ' $1 ***') : s;
}

/** NMC CLI result code: "E000: Success" → {code:'E000', ok:true}. */
function resultOf(out) {
  const m = /\b(E\d{3}):\s*([^\r\n]*)/.exec(String(out || ''));
  if (!m) return { code: null, ok: false, text: '' };
  // E000 Success, E001 Successfully Issued, E002 Success / reboot required (never asked for).
  return { code: m[1], ok: ['E000', 'E001'].includes(m[1]), text: m[2].trim() };
}

// ── builders: the only way planner.js makes a write line ───────────────────
const q = (name) => (/\s/.test(name) ? `"${name}"` : name);
const build = {
  v3Enable: (on = true) => `snmpv3 -S ${on ? 'enable' : 'disable'}`,
  v3User: (n, { name, authKey, privKey, auth = 'sha', priv = 'aes' }) =>
    `snmpv3 -u${n} ${q(name)}${authKey != null ? ` -a${n} ${authKey} -c${n} ${privKey}` : ''} -ap${n} ${auth} -pp${n} ${priv}`,
  v3Access: (n, { on = true, name, nms }) => `snmpv3 -ac${n} ${on ? 'enable' : 'disable'} -au${n} ${q(name)} -n${n} ${nms}`,
  trapReceiver: (n, { ip, type = 'snmpV3', on = true, auth = true, profile }) =>
    `snmptrap -r${n} ${ip} -t${n} ${type} -g${n} ${on ? 'enable' : 'disable'} -a${n} ${auth ? 'enable' : 'disable'}${profile ? ` -u${n} profile${profile}` : ''}`,
  legacy: (on) => `snmp -S ${on ? 'enable' : 'disable'}`,
  ntp: ({ on = true, primary, secondary }) => `ntp -OM ${on ? 'enable' : 'disable'}${primary ? ` -p ${primary}` : ''}${secondary ? ` -s ${secondary}` : ''}`,
};

module.exports = { check, display, resultOf, build, CommandRefused, READ, WRITE, DENY, PHRASE_RE, NAME_RE, IPV4_RE };
