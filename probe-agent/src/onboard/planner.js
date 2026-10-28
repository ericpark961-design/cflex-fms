// onboard/planner.js — `cflex-onboard plan` (spec 04 §4.2): the desired
// state, the difference from what `read` found, and the CLI lines apply would
// send — each with the line that undoes it. Writes nothing.
//
// Desired state comes from site.yaml (`onboard:` block, per-site overrides)
// and the run's flags; the SNMPv3 pass phrases come from the credentials
// store, never from site.yaml:
//
//   onboard:
//     snmpv3: { user: cflex-ro, auth: sha, priv: aes }
//     trap_receiver: <collector IP>        # default: the collector for the site (hosts.collectors)
//     ntp: { servers: [<ip>, <ip>] }       # written only with --set-ntp
//     sites: { HMA-FV: { snmpv3: { user: … } } }
//
// Scope is fixed (spec 04 §4.3): SNMPv3 on/user/access control, one trap
// receiver, legacy SNMPv1/v2c off (--disable-legacy, after verify), NTP
// (--set-ntp). Every line is made by commands.build and checked with
// commands.check() here, so a plan never shows a line apply would refuse.
const commands = require('./commands');

const { build } = commands;
const proto = (v) => {
  const s = String(v || 'none').toLowerCase();
  if (s.startsWith('sha')) return 'sha';
  if (s.startsWith('md5')) return 'md5';
  if (s.startsWith('aes')) return 'aes';
  if (s.startsWith('des')) return 'des';
  return 'none';
};
const isDefaultProfile = (name) => !name || /^apc snmp profile\d$/i.test(name);

class PlanError extends Error { constructor(m) { super(m); this.code = 'plan_error'; } }

/** The collector that should receive this site's traps. */
function collectorFor(siteConf, site) {
  const ob = siteConf?.onboard || {};
  const per = site && ob.sites?.[site];
  if (per?.trap_receiver) return per.trap_receiver;
  if (ob.trap_receiver) return ob.trap_receiver;
  const cs = siteConf?.collectors || [];
  const own = cs.find(c => site && c.sites.map(s => s.toUpperCase()).includes(String(site).toUpperCase()));
  return (own || cs[0] || {}).ip || null;
}

/**
 * @param {object} target
 * @param {object} o
 * @param {object} o.siteConf    targets.loadSiteYaml()
 * @param {{authKey, privKey}} o.keys
 * @param {object} o.flags       {disableLegacy, setNtp, v3Profile, trapReceiver}
 */
function desiredFor(target, { siteConf = {}, keys = {}, flags = {} } = {}) {
  const ob = siteConf.onboard || {};
  const per = (target.site && ob.sites?.[target.site]) || {};
  const v3 = { auth: 'sha', priv: 'aes', ...(ob.snmpv3 || {}), ...(per.snmpv3 || {}) };
  const nms = flags.trapReceiver || collectorFor(siteConf, target.site);
  if (!v3.user) throw new PlanError('site.yaml onboard.snmpv3.user is not set');
  if (!commands.NAME_RE.test(String(v3.user))) throw new PlanError('onboard.snmpv3.user: 1–32 of A-Z a-z 0-9 _ . - (no spaces)');
  if (!['sha', 'md5'].includes(proto(v3.auth)) || !['aes', 'des'].includes(proto(v3.priv))) throw new PlanError('onboard.snmpv3: auth sha|md5 and priv aes|des');
  if (!nms || !commands.IPV4_RE.test(nms)) throw new PlanError('no trap receiver: set hosts.collectors[].ip or onboard.trap_receiver');
  // Messages name the field, never the value.
  if (!keys.authKey || !commands.PHRASE_RE.test(keys.authKey)) throw new PlanError('SNMPv3 auth pass phrase: 15–32 printable characters, no space or quote');
  if (!keys.privKey || !commands.PHRASE_RE.test(keys.privKey)) throw new PlanError('SNMPv3 privacy pass phrase: 15–32 printable characters, no space or quote');
  const servers = (per.ntp?.servers || ob.ntp?.servers || []).filter(Boolean);
  return {
    v3: { user: String(v3.user), auth: proto(v3.auth), priv: proto(v3.priv), authKey: keys.authKey, privKey: keys.privKey },
    nms,
    legacy: !!flags.disableLegacy,
    ntp: servers.length ? { servers, write: !!flags.setNtp } : null,
    v3Profile: flags.v3Profile ? parseInt(flags.v3Profile, 10) : null,
  };
}

/** What the report recommends from a read alone (spec 04 §4.6) — advice, never a write. */
function recommendationsOf(read) {
  const out = [];
  if (read.factory_account) out.push('factory account (apc) in use — change it through the customer security team (spec 04 §2; this tool does not change accounts)');
  const fc = (read.snmp_v1?.access || []).find(a => a.community.factory);
  if (fc) out.push(`SNMPv1 access #${fc.index} uses a factory community name`);
  if (read.console?.telnet) out.push('Telnet is enabled on the card');
  if (read.web?.http) out.push('HTTP (unencrypted) web access is enabled on the card');
  if (read.snmp_v3?.supported === false) out.push('firmware does not offer SNMPv3 (E101) — a firmware upgrade is needed first (not done by this tool)');
  return out;
}

/**
 * @param {object} read      reader.readDevice()
 * @param {object} desired   desiredFor()
 * @returns {{status, reason?, diff, steps, post, warnings, recommendations, slots}}
 */
function plan(read, desired) {
  const policy = { legacy: desired.legacy, ntp: !!desired.ntp?.write };
  const diff = [], steps = [], post = [], warnings = [], recommendations = [];
  const step = (list, id, line, undo, extra = {}) => {
    commands.check(line, { write: true, policy });
    if (undo) commands.check(undo, { write: true, policy: { legacy: true, ntp: true } });
    list.push({ id, line, display: commands.display(line), undo, undoDisplay: undo ? commands.display(undo) : null, ...extra });
  };

  recommendations.push(...recommendationsOf(read));

  const v3 = read.snmp_v3 || {};
  if (v3.supported === false) {
    return { status: 'blocked', reason: 'firmware_without_snmpv3', diff, steps, post, warnings, recommendations, slots: {} };
  }
  if (v3.supported == null && !v3.users?.length) {
    return { status: 'blocked', reason: 'snmpv3_unreadable', diff, steps, post, warnings, recommendations, slots: {} };
  }

  // ── slots ──
  const users = v3.users || [];
  let n = desired.v3Profile;
  if (!n) n = (users.find(u => u.name === desired.v3.user) || users.find(u => isDefaultProfile(u.name)) || {}).index;
  if (!n) return { status: 'blocked', reason: 'no_free_snmpv3_profile', diff, steps, post, warnings, recommendations: [...recommendations, 'all four SNMPv3 user profiles are in use — choose one with --v3-profile'], slots: {} };
  const traps = read.traps || [];
  const r = (traps.find(t => t.receiver === desired.nms) || traps.find(t => !t.receiver) || {}).index;
  if (!r) return { status: 'blocked', reason: 'no_free_trap_receiver', diff, steps, post, warnings, recommendations, slots: { profile: n } };

  // ── SNMPv3 on ──
  if (v3.enabled !== true) {
    diff.push({ field: 'snmpv3.enabled', from: v3.enabled, to: true });
    step(steps, 'snmpv3_enable', build.v3Enable(true), build.v3Enable(false));
  }
  // ── user profile n ──
  const u = users.find(x => x.index === n) || { index: n, name: null, auth: 'none', priv: 'none' };
  const sameUser = u.name === desired.v3.user && proto(u.auth) === desired.v3.auth && proto(u.priv) === desired.v3.priv;
  const undoUser = build.v3User(n, { name: u.name || `apc snmp profile${n}`, auth: proto(u.auth), priv: proto(u.priv) });
  if (!sameUser) diff.push({ field: `snmpv3.user[${n}]`, from: `${u.name || '-'} ${proto(u.auth)}/${proto(u.priv)}`, to: `${desired.v3.user} ${desired.v3.auth}/${desired.v3.priv}` });
  // Pass phrases cannot be read back. When the user is already there, apply
  // first tries an SNMPv3 GET with the run's keys and skips this step if it works.
  step(steps, 'snmpv3_user', build.v3User(n, { ...desired.v3, name: desired.v3.user }), undoUser, sameUser ? { ifKeysDiffer: true } : {});
  // ── access control n ──
  const a = (v3.access || []).find(x => x.index === n) || { index: n, name: null, enabled: false, nms: null };
  if (!(a.enabled === true && a.name === desired.v3.user && a.nms === desired.nms)) {
    diff.push({ field: `snmpv3.access[${n}]`, from: `${a.enabled ? 'enabled' : 'disabled'} ${a.name || '-'} ${a.nms || '-'}`, to: `enabled ${desired.v3.user} ${desired.nms}` });
    step(steps, 'snmpv3_access', build.v3Access(n, { on: true, name: desired.v3.user, nms: desired.nms }),
      build.v3Access(n, { on: !!a.enabled, name: a.name || `apc snmp profile${n}`, nms: a.nms && commands.IPV4_RE.test(a.nms) ? a.nms : '0.0.0.0' }));
  }
  // ── trap receiver r ──
  const t = traps.find(x => x.index === r) || { index: r, receiver: null, type: null, generation: false, auth_traps: false };
  if (!(t.receiver === desired.nms && t.type === 'snmpv3' && t.generation === true)) {
    diff.push({ field: `snmptrap[${r}]`, from: `${t.receiver || '-'} ${t.type || '-'} ${t.generation ? 'on' : 'off'}`, to: `${desired.nms} snmpv3 on` });
    step(steps, 'snmptrap_receiver', build.trapReceiver(r, { ip: desired.nms, type: 'snmpV3', on: true, auth: true, profile: n }),
      build.trapReceiver(r, { ip: t.receiver || '0.0.0.0', type: t.type === 'snmpv3' ? 'snmpV3' : 'snmpV1', on: !!t.generation, auth: !!t.auth_traps }));
  }
  // ── NTP: read and warn by default; write only with --set-ntp (spec 04 §8-4) ──
  if (desired.ntp) {
    const [p, s] = desired.ntp.servers;
    const ok = read.ntp?.enabled === true && read.ntp.primary === p && (!s || read.ntp.secondary === s);
    if (!ok) {
      diff.push({ field: 'ntp', from: `${read.ntp?.enabled ? 'on' : 'off'} ${read.ntp?.primary || '-'} ${read.ntp?.secondary || '-'}`, to: `on ${p} ${s || '-'}` });
      if (desired.ntp.write) {
        step(steps, 'ntp', build.ntp({ on: true, primary: p, secondary: s }),
          build.ntp({ on: !!read.ntp?.enabled, primary: read.ntp?.primary || '0.0.0.0', secondary: read.ntp?.secondary || '0.0.0.0' }));
      } else warnings.push('NTP differs from site.yaml onboard.ntp — not changed (use --set-ntp)');
    }
  } else if (read.ntp && read.ntp.enabled !== true) warnings.push('NTP is off on the card');
  // ── legacy SNMPv1/v2c off: after verify, only with --disable-legacy (spec 04 §8-3) ──
  if (read.snmp_v1?.enabled) {
    if (desired.legacy) {
      diff.push({ field: 'snmpv1.enabled', from: true, to: false });
      step(post, 'legacy_off', build.legacy(false), build.legacy(true));
    } else recommendations.push('SNMPv1 is still enabled — rerun apply with --disable-legacy once SNMPv3 is verified');
  }

  const writes = steps.filter(s => !s.ifKeysDiffer).length + post.length;
  return { status: writes || steps.length ? (writes ? 'changes' : 'check_keys') : 'in_sync', diff, steps, post, warnings, recommendations, slots: { profile: n, trap: r }, policy };
}

module.exports = { desiredFor, plan, recommendationsOf, collectorFor, PlanError };
