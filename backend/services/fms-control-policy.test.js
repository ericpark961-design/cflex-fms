// node backend/services/fms-control-policy.test.js
//
// What this file exists to prevent: the ban going back to being a sentence in
// a document. Before this, "전원 조작·설정·펌웨어 자동 변경 금지" held only
// because three executor functions were unimplemented stubs. Finishing those
// TODOs — a reasonable thing for the next person to do — would have removed
// the ban without touching anything that looked like policy.
//
// So the assertions are deliberately hostile to the adapter: they turn every
// tenant gate ON, put every action in the tenant allow-list, and then require
// the refusal anyway. Wiring an executor leaves these passing. Moving the
// policy check below the tenant check fails them.
//
// ── why the loader hook ──
// `fms-device-control.js` takes its handle from `require('../config/database')`
// at module scope, and backend/config/ lives in the deployed cflex-api tree,
// not in this repository. Every other test here sidesteps that by testing
// functions that receive `db` as an argument. This one cannot: the point is to
// exercise the adapter's own gate ordering. So the module loader is
// intercepted for that one specifier, and restored afterwards.
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { statements } = require('../migrations/apply');

const P = require('./fms-control-policy');

// ── a database the adapter will accept ──────────────────────────────
const d = new DatabaseSync(':memory:');
{
  const root = path.join(__dirname, '..', 'migrations');
  for (const f of fs.readdirSync(root).filter(x => /^0\d\d_.*\.sql$/.test(x)).sort()) {
    let stmts;
    try { stmts = statements(fs.readFileSync(path.join(root, f), 'utf8')); } catch { continue; }
    for (const s of stmts) {
      try { d.exec(s); } catch (e) {
        if (!/duplicate column|already exists|no such table|no such column/i.test(e.message)) throw e;
      }
    }
  }
  // The most permissive tenant row that could exist: control on, all three
  // channels on, every action in the allow-list. If the ban held only because
  // of those flags, this row would expose it.
  const all = JSON.stringify(Object.keys(P.WRITE_CLASS));
  d.exec(`INSERT INTO fms_control_config
    (tenant_id, control_enabled, snmp_enabled, nmc_http_enabled, ecostruxure_enabled, allowed_actions)
    VALUES (1,1,1,1,1,'${all}')`);
  try {
    d.exec(`INSERT INTO ups_devices (id, tenant_id, label, ip) VALUES (7,1,'TEST UPS','10.0.0.9')`);
  } catch (_) { /* the policy refuses before the device lookup, so this is optional */ }
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === '../config/database') return d;
  return realLoad.apply(this, arguments);
};
const restoreLoader = () => { Module._load = realLoad; };

const ctl = require('./fms-device-control');

// ── runner ──────────────────────────────────────────────────────────
let pass = 0;
const fail = (name, e) => { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; };
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail(name, e); } };

const ENV0 = process.env.FMS_CONTROL_UNBAN;
const resetEnv = () => {
  if (ENV0 === undefined) delete process.env.FMS_CONTROL_UNBAN;
  else process.env.FMS_CONTROL_UNBAN = ENV0;
};
const withUnban = (v, fn) => {
  if (v === null) delete process.env.FMS_CONTROL_UNBAN;
  else process.env.FMS_CONTROL_UNBAN = v;
  try { fn(); } finally { resetEnv(); }
};

// ── the table itself ────────────────────────────────────────────────
// Drift guard: a tenth action added to the adapter with no write class would
// be refused by `check` (it refuses what it does not recognise) — correct, but
// it should fail loudly here rather than surprise someone at a customer site.
t('every adapter action has a write class, and vice versa', () => {
  const missing = Object.keys(ctl.ACTIONS).filter(k => !P.WRITE_CLASS[k]);
  assert.deepStrictEqual(missing, [], `actions with no write class: ${missing.join(', ')}`);
  const extra = Object.keys(P.WRITE_CLASS).filter(k => !ctl.ACTIONS[k]);
  assert.deepStrictEqual(extra, [], `classes for actions that no longer exist: ${extra.join(', ')}`);
});

// ── automation ──────────────────────────────────────────────────────
t('automation is refused every single action', () => {
  withUnban(null, () => {
    for (const k of Object.keys(P.WRITE_CLASS)) {
      const v = P.check({ actionKey: k, origin: 'automation' });
      assert.strictEqual(v.allowed, false, `automation was allowed '${k}'`);
      assert.match(v.why, /automation may not write/);
    }
    assert.deepStrictEqual(P.permitted('automation'), []);
  });
});

t('FMS_CONTROL_UNBAN does not lift the ban for automation', () => {
  // The un-ban is an operator affordance. If it reached automation, an AI
  // rebooting an outlet would be one environment variable away.
  withUnban(Object.keys(P.WRITE_CLASS).join(','), () => {
    for (const k of Object.keys(P.WRITE_CLASS)) {
      assert.strictEqual(P.check({ actionKey: k, origin: 'automation' }).allowed, false,
        `un-ban leaked to automation for '${k}'`);
    }
  });
});

t('a caller that omits origin counts as automation', () => {
  withUnban(null, () => {
    for (const bad of [undefined, null, '', 'ai', 'system', 'robot', 'HUMAN', 0, {}]) {
      const v = P.check({ actionKey: 'outlet_off', origin: bad });
      assert.strictEqual(v.allowed, false, `origin ${JSON.stringify(bad)} was allowed`);
      assert.strictEqual(v.origin, 'automation');
    }
  });
});

// ── humans ──────────────────────────────────────────────────────────
t('power, config and firmware are refused for an operator by default', () => {
  withUnban(null, () => {
    for (const k of ['outlet_on', 'outlet_off', 'outlet_reboot', 'output_off',
                     'shutdown_delay', 'mute_alarms', 'firmware_push']) {
      const v = P.check({ actionKey: k, origin: 'human' });
      assert.strictEqual(v.allowed, false, `operator was allowed '${k}' with no un-ban`);
      assert.match(v.why, /banned by policy/);
    }
  });
});

t('an operator may run a diagnostic', () => {
  withUnban(null, () => {
    for (const k of ['self_test', 'battery_calib']) {
      assert.strictEqual(P.check({ actionKey: k, origin: 'human' }).allowed, true, k);
    }
  });
});

t('un-ban is per-action and "*" is not a wildcard', () => {
  withUnban('outlet_reboot', () => {
    assert.strictEqual(P.check({ actionKey: 'outlet_reboot', origin: 'human' }).allowed, true);
    assert.strictEqual(P.check({ actionKey: 'outlet_off',    origin: 'human' }).allowed, false);
    assert.strictEqual(P.check({ actionKey: 'firmware_push', origin: 'human' }).allowed, false);
  });
  withUnban('*', () => {
    for (const k of Object.keys(P.WRITE_CLASS)) {
      const expected = !P.BANNED_FOR_HUMANS.has(P.WRITE_CLASS[k]);
      assert.strictEqual(P.check({ actionKey: k, origin: 'human' }).allowed, expected,
        `'*' behaved as a wildcard for '${k}'`);
    }
  });
});

t('an unknown action is refused, not waved through', () => {
  for (const o of ['human', 'automation']) {
    const v = P.check({ actionKey: 'rm_rf_slash', origin: o });
    assert.strictEqual(v.allowed, false);
    assert.match(v.why, /unknown action/);
  }
});

// ── the adapter honours it, tenant gates wide open ──────────────────
async function adapterCases() {
  delete process.env.FMS_CONTROL_UNBAN;

  const got = [];
  for (const k of Object.keys(P.WRITE_CLASS)) {
    const r = await ctl.performAction({ tenantId: 1, deviceId: 7, actionKey: k, origin: 'automation' });
    if (r.ok || !r.denied) got.push(`${k} → ok=${r.ok} denied=${r.denied}`);
  }
  assert.deepStrictEqual(got, [], `automation got through: ${got.join(' · ')}`);

  // A refusal is an auditable fact, not just a return value.
  const n = Number(d.prepare(`SELECT COUNT(*) n FROM fms_control_log WHERE channel='denied'`).get().n);
  assert.strictEqual(n, Object.keys(P.WRITE_CLASS).length, 'every refusal should reach fms_control_log');

  // A banned action is refused for a human too, with the tenant fully open.
  const h = await ctl.performAction({
    tenantId: 1, deviceId: 7, actionKey: 'output_off', origin: 'human',
    user: { email: 'op@haeaus.com' },
  });
  assert.strictEqual(h.denied, true, 'output_off should be denied for an operator with no un-ban');
  assert.match(h.error, /banned by policy/);

  // And the refusal happens BEFORE the tenant allow-list: an action absent
  // from the allow-list must still report the policy reason, not the tenant
  // one. That ordering is the whole point of this file.
  d.exec(`UPDATE fms_control_config SET allowed_actions='[]' WHERE tenant_id=1`);
  const o = await ctl.performAction({ tenantId: 1, deviceId: 7, actionKey: 'outlet_off', origin: 'automation' });
  assert.strictEqual(o.denied, true);
  assert.doesNotMatch(String(o.error), /allow-list/,
    'policy check must run before the tenant allow-list check');
}

adapterCases()
  .then(() => { pass++; })
  .catch((e) => fail('adapter honours the policy with tenant gates open', e))
  .finally(() => {
    resetEnv();
    restoreLoader();
    console.log(`${pass} passed${process.exitCode ? ' — FAILURES ABOVE' : ''}`);
  });
