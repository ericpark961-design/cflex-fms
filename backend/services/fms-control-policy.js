// services/fms-control-policy.js — the write ban, as code.
//
// WHY THIS FILE EXISTS. "전원 조작·설정·펌웨어 자동 변경 금지" was policy in a
// document and nothing else. The control adapter already carries nine write
// actions, two routes already mount it, and the incident route already feeds a
// successful action back into the re-evaluation loop. The only reason nothing
// reached a device was that three executor functions are unimplemented stubs
// with `// TODO: integrate …` above them.
//
// That is not a ban. It is a half-built on-ramp with an invitation to finish
// it. Whoever wires those three TODOs — us, or Codex during the RHEL work —
// removes the ban silently, and the routes are already open.
//
// So the ban lives here, ABOVE the tenant configuration, and the adapter
// consults it first. `fms_control_config.control_enabled` is a default; this
// is a prohibition. A tenant row cannot lift it.
//
// ── The distinction that matters ──
//
// The rule is about AUTOMATIC change. The operating model is that AI watches,
// classifies, tickets, analyses, responds and follows up, and hands exceptions
// to a person. Device writes are not in that list, and "후속 조치" means
// ticketing, notifying and dispatching — not touching an outlet.
//
// So: automation may perform NO device write, ever, with no override. A human
// administrator keeps the existing gates, and for the power/config/firmware
// classes additionally needs a named per-action opt-in via the environment —
// two deliberate keys, not one config toggle.
//
// Fails closed: a caller that forgets to say who it is counts as automation.

// What each action actually changes. Nothing here is cosmetic: `self_test` and
// `battery_calib` transfer a live UPS onto battery, and `mute_alarms` changes a
// device setting — which is why automation gets none of them either.
const WRITE_CLASS = {
  self_test:      'diagnostic',   // transfers to battery briefly
  mute_alarms:    'config',       // silences the audible alarm
  battery_calib:  'diagnostic',   // deliberate battery discharge
  shutdown_delay: 'config',
  outlet_on:      'power',
  outlet_off:     'power',
  outlet_reboot:  'power',
  output_off:     'power',
  firmware_push:  'firmware',
};

// Classes a human administrator may not run unless explicitly un-banned.
const BANNED_FOR_HUMANS = new Set(['power', 'config', 'firmware']);

const ORIGINS = ['human', 'automation'];

/**
 * Per-action opt-in for a human operator, e.g.
 *   FMS_CONTROL_UNBAN=outlet_reboot,shutdown_delay
 *
 * Read per call rather than at module load, so a test can set it and so an
 * operator restarting with a changed value does not need a code deploy. `*` is
 * deliberately NOT a wildcard — a blanket un-ban should require naming each
 * action, because that is the point of the list.
 */
function unbanned() {
  const raw = String(process.env.FMS_CONTROL_UNBAN || '');
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * May this actor run this action?
 *
 * @param {object} a
 * @param {string} a.actionKey
 * @param {'human'|'automation'} a.origin  missing / unknown ⇒ automation
 * @returns {{allowed: boolean, why: string, cls: string|null, origin: string}}
 */
function check({ actionKey, origin } = {}) {
  const cls = WRITE_CLASS[actionKey] || null;
  // An action we do not recognise is not thereby safe.
  const o = ORIGINS.includes(origin) ? origin : 'automation';

  if (!cls) {
    return { allowed: false, cls: null, origin: o, why: `unknown action '${actionKey}' — not in the write-class table` };
  }
  if (o !== 'human') {
    return {
      allowed: false, cls, origin: o,
      why: 'automation may not write to a device (감시·분류·티켓·분석·응답·후속조치 only); hand this to a person',
    };
  }
  if (!BANNED_FOR_HUMANS.has(cls)) {
    return { allowed: true, cls, origin: o, why: `${cls} action, permitted for an operator` };
  }
  if (unbanned().has(actionKey)) {
    return { allowed: true, cls, origin: o, why: `${cls} action, un-banned by FMS_CONTROL_UNBAN` };
  }
  return {
    allowed: false, cls, origin: o,
    why: `${cls} changes are banned by policy (전원·설정·펌웨어); add '${actionKey}' to FMS_CONTROL_UNBAN to permit an operator`,
  };
}

/** Every action the policy would currently permit, for a UI or an installer. */
function permitted(origin) {
  return Object.keys(WRITE_CLASS).filter(k => check({ actionKey: k, origin }).allowed);
}

module.exports = { check, permitted, WRITE_CLASS, BANNED_FOR_HUMANS, ORIGINS };
