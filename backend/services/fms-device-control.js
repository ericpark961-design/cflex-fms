// services/fms-device-control.js — UPS device control adapter (multi-channel).
//
// Three back-ends, picked per-action via priority:
//   1) ecostruxure  — preferred when partner credentials are configured
//   2) nmc_http     — direct NMC RESTful (some actions only; needs nmc_http creds)
//   3) snmp         — universal fallback (PowerNet-MIB SET, needs v3 rw creds)
//
// Everything is gated by `fms_control_config.control_enabled` (per tenant) and the
// per-channel sub-flag. When OFF the call is logged as `dry_run=1` and returns the
// intended SNMP/HTTP payload without touching the device — that way the UI can be
// exercised end-to-end before any real wire is opened.
//
// Each action has a hard whitelist:
//   self_test      — start UPS self-test (low risk)
//   mute_alarms    — silence audible alarm (low risk)
//   battery_calib  — battery runtime calibration (low risk)
//   shutdown_delay — set shutdown delay seconds (medium risk)
//   outlet_on / outlet_off / outlet_reboot — outlet group control (medium)
//   output_off     — disable UPS output (HIGH risk — confirm + 2FA recommended)
//   firmware_push  — push firmware via SFTP/SCP (HIGH risk)
//
// Risk is shipped in metadata so the UI can choose to ask for confirmation /
// re-auth before sending.

const db = require('../config/database');

// ─── Action catalogue ────────────────────────────────────────────────
// Keys are stable identifiers used by the API. `risk` is low|medium|high.
const ACTIONS = {
  self_test: {
    risk: 'low', label: '자가진단 시작 (Self-test)',
    snmp: { oid: '1.3.6.1.4.1.318.1.1.1.7.2.2.0', type: 'INTEGER', value: 2 /* 2=start */ },
    nmcPath: '/REST/ups/{deviceIdx}/test/start',
    ecostruxureOp: 'device.test.start',
  },
  mute_alarms: {
    risk: 'low', label: '알람 음소거 (Mute)',
    snmp: { oid: '1.3.6.1.4.1.318.1.1.1.8.1.0', type: 'INTEGER', value: 2 /* 2=mute */ },
    nmcPath: '/REST/ups/{deviceIdx}/alarms/mute',
    ecostruxureOp: 'device.alarms.mute',
  },
  battery_calib: {
    risk: 'low', label: '배터리 캘리브레이션 (Runtime calibration)',
    snmp: { oid: '1.3.6.1.4.1.318.1.1.1.7.2.5.0', type: 'INTEGER', value: 2 },
    nmcPath: '/REST/ups/{deviceIdx}/battery/calibrate',
  },
  shutdown_delay: {
    risk: 'medium', label: '셧다운 지연 (sec)',
    paramSchema: { seconds: 'integer 0..600' },
    snmp: { oid: '1.3.6.1.4.1.318.1.1.1.5.2.2.0', type: 'INTEGER', valueFrom: p => Math.max(0, Math.min(600, parseInt(p.seconds, 10))) },
    nmcPath: '/REST/ups/{deviceIdx}/shutdown/delay',
  },
  outlet_on: {
    risk: 'medium', label: '아웃렛 그룹 ON',
    paramSchema: { group: 'integer 1..8' },
    snmp: { oid: '1.3.6.1.4.1.318.1.1.4.4.2.1.3.{group}', type: 'INTEGER', value: 2 },
    nmcPath: '/REST/outlet/{group}/on',
  },
  outlet_off: {
    risk: 'medium', label: '아웃렛 그룹 OFF',
    paramSchema: { group: 'integer 1..8' },
    snmp: { oid: '1.3.6.1.4.1.318.1.1.4.4.2.1.3.{group}', type: 'INTEGER', value: 3 },
    nmcPath: '/REST/outlet/{group}/off',
  },
  outlet_reboot: {
    risk: 'medium', label: '아웃렛 그룹 재부팅',
    paramSchema: { group: 'integer 1..8' },
    snmp: { oid: '1.3.6.1.4.1.318.1.1.4.4.2.1.3.{group}', type: 'INTEGER', value: 4 },
    nmcPath: '/REST/outlet/{group}/reboot',
  },
  output_off: {
    risk: 'high', label: '⚠ 마스터 출력 차단',
    snmp: { oid: '1.3.6.1.4.1.318.1.1.1.6.2.1.0', type: 'INTEGER', value: 3 },
    nmcPath: '/REST/ups/{deviceIdx}/output/off',
  },
  firmware_push: {
    risk: 'high', label: '⚠ 펌웨어 업그레이드',
    paramSchema: { url: 'sftp://... or scp://...', sha256: 'optional checksum' },
    nmcPath: '/REST/firmware/upgrade',
    snmp: null, // not directly SNMP-settable
  },
};

function getConfig(tenantId) {
  return db.prepare('SELECT * FROM fms_control_config WHERE tenant_id=?').get(tenantId)
      || { control_enabled: 0, snmp_enabled: 0, nmc_http_enabled: 0, ecostruxure_enabled: 0, allowed_actions: '[]' };
}

function isActionAllowed(cfg, actionKey) {
  let allow = [];
  try { allow = JSON.parse(cfg.allowed_actions || '[]'); } catch (_) {}
  return allow.includes(actionKey);
}

// Pick the highest-priority enabled channel for a given action.
function pickChannel(cfg, action) {
  if (cfg.ecostruxure_enabled && action.ecostruxureOp) return 'ecostruxure';
  if (cfg.nmc_http_enabled    && action.nmcPath)       return 'nmc_http';
  if (cfg.snmp_enabled        && action.snmp)          return 'snmp';
  return null;
}

// Materialise an SNMP SET payload (for dry-run preview AND real execution).
function buildSnmpSetPayload(device, action, params) {
  if (!action.snmp) return null;
  let oid = action.snmp.oid;
  for (const k of Object.keys(params || {})) {
    oid = oid.replace(`{${k}}`, String(params[k]));
  }
  const value = typeof action.snmp.valueFrom === 'function'
    ? action.snmp.valueFrom(params)
    : action.snmp.value;
  return {
    target: device.ip,
    port: device.snmp_port || 161,
    user: device.snmp_v3_rw_user || null,
    auth_protocol: device.snmp_v3_auth_protocol || null,
    priv_protocol: device.snmp_v3_priv_protocol || null,
    auth_password: device.snmp_v3_rw_auth_password ? '[REDACTED]' : null,
    priv_password: device.snmp_v3_rw_priv_password ? '[REDACTED]' : null,
    oid, type: action.snmp.type, value,
  };
}

function buildNmcHttpPayload(device, action, params) {
  if (!action.nmcPath) return null;
  let path = action.nmcPath;
  for (const k of Object.keys(params || {})) {
    path = path.replace(`{${k}}`, String(params[k]));
  }
  return {
    url: `https://${device.ip}${path}`,
    method: 'POST',
    auth: device.nmc_http_user ? `Basic ${device.nmc_http_user}:[REDACTED]` : null,
    body: params || {},
  };
}

function buildEcostruxurePayload(device, action, params) {
  if (!action.ecostruxureOp || !device.ecostruxure_device_id) return null;
  return {
    op: action.ecostruxureOp,
    device_id: device.ecostruxure_device_id,
    params: params || {},
  };
}

// ─── Real wire (stubs — connect when credentials arrive) ────────────
async function executeSnmp(payload) {
  // TODO: integrate net-snmp v3 SET when v3 rw creds available
  throw new Error('SNMP SET executor not wired yet');
}
async function executeNmcHttp(payload, device) {
  // TODO: integrate axios + NMC HTTP basic auth when nmc_http creds available
  throw new Error('NMC HTTP executor not wired yet');
}
async function executeEcostruxure(payload, cfg) {
  // TODO: integrate EcoStruxure IT REST API (OAuth2 client_credentials) when
  // ecostruxure_client_id/secret/org_id are provisioned. Endpoint base will
  // come from /opt/cflex-shared/ecostruxure.config.json once published.
  throw new Error('EcoStruxure executor not wired yet (awaiting partner SDK)');
}

// ─── Public entry point ─────────────────────────────────────────────
async function performAction({ tenantId, deviceId, actionKey, params = {}, user }) {
  const cfg = getConfig(tenantId);
  const action = ACTIONS[actionKey];
  if (!action) {
    return { ok: false, error: 'unknown action', actions: Object.keys(ACTIONS) };
  }
  if (!isActionAllowed(cfg, actionKey)) {
    return { ok: false, error: `action '${actionKey}' is not in tenant's allow-list` };
  }
  const device = db.prepare('SELECT * FROM ups_devices WHERE id=? AND tenant_id=?').get(deviceId, tenantId);
  if (!device) return { ok: false, error: 'device not found' };

  const channel = pickChannel(cfg, action);

  // Build all candidate payloads so the UI / log keep a clear trace even when
  // we don't actually execute.
  const payloadPreview = {
    snmp:        buildSnmpSetPayload(device, action, params),
    nmc_http:    buildNmcHttpPayload(device, action, params),
    ecostruxure: buildEcostruxurePayload(device, action, params),
  };

  // Master kill: control_enabled OFF → dry-run regardless
  const dryRun = !cfg.control_enabled || !channel;
  let ok = false, error = null, result = null;

  if (!dryRun) {
    try {
      if (channel === 'snmp')        result = await executeSnmp(payloadPreview.snmp);
      if (channel === 'nmc_http')    result = await executeNmcHttp(payloadPreview.nmc_http, device);
      if (channel === 'ecostruxure') result = await executeEcostruxure(payloadPreview.ecostruxure, cfg);
      ok = true;
    } catch (e) {
      error = e.message;
    }
  } else {
    result = { skipped: true, reason: !cfg.control_enabled ? 'control_disabled' : 'no_channel_enabled' };
  }

  // Audit log — every attempt, real or dry
  db.prepare(`INSERT INTO fms_control_log
    (tenant_id, device_id, device_label, action, channel, params, ok, result, error,
     user_email, user_id, dry_run, executed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId, deviceId, device.label, actionKey, channel || 'none',
      JSON.stringify(params), ok ? 1 : 0,
      JSON.stringify(result), error,
      user?.email || null, user?.userId || null,
      dryRun ? 1 : 0, Date.now(),
    );

  return {
    ok: ok || dryRun, dry_run: dryRun, channel, action: actionKey,
    risk: action.risk, label: action.label,
    payload: payloadPreview, result, error,
  };
}

function listActions() {
  return Object.entries(ACTIONS).map(([key, a]) => ({
    key, label: a.label, risk: a.risk,
    paramSchema: a.paramSchema || null,
    supports: {
      snmp: !!a.snmp,
      nmc_http: !!a.nmcPath,
      ecostruxure: !!a.ecostruxureOp,
    },
  }));
}

module.exports = { performAction, listActions, ACTIONS };
