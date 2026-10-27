// onboard/applier.js — `cflex-onboard apply` (spec 04 §4.3) and the session
// handling `read` and `verify` share with it.
//
// Per card, strictly in this order, one card at a time:
//   confirm (unless --yes-all) → backup config.ini (SCP) → apply the plan's
//   lines → verify (read back + SNMPv3 GET + trap test if asked) →
//   only then legacy SNMPv1/v2c off (--disable-legacy) and verify again.
// Any failed line or failed verify → the applied lines' undo lines, newest
// first, and the card is `failed`. A card already in the desired state gets
// no write (idempotent). No backup, no write.
//
// Rollback uses the undo lines, which are inside the same fixed write scope.
// Uploading the config.ini backup back to the card would rewrite every
// setting on it (accounts, network …), so it is not done here; the backup
// stays on disk (0600) for an engineer's manual restore.
const path = require('path');
const { readDevice } = require('./reader');
const { desiredFor, plan } = require('./planner');
const { writePrivate, deviceDir, stamp } = require('./report');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Open a session under the auth-failure rule (spec 04 §2): a failure marks the
 * card auth_failed and moves on; three in a row with one credential set stop
 * that set, and the operator is asked whether to go on with it.
 * @returns {Promise<{session}|{result}>}
 */
async function openCard(ctx, target, mode) {
  const { creds, ssh, prompt, audit, log } = ctx;
  let cred;
  try { cred = creds.forTarget(target.ip); } catch (e) { return { result: { status: 'skipped', reason: 'no_credentials' } }; }
  if (creds.isSuspended(cred.set)) return { result: { status: 'auth_failed', reason: `credential set ${cred.set} suspended after 3 failures` } };
  try {
    const session = await ssh.open(target, cred, mode);
    creds.authOk(cred.set);
    return { session, cred };
  } catch (e) {
    if (e.code === 'auth_failed') {
      const n = creds.authFailed(cred.set);
      audit.write('auth_failed', { ip: target.ip, set: cred.set, consecutive: n });
      if (creds.isSuspended(cred.set)) {
        log.warn(`[onboard] ${cred.set}: ${n} authentication failures in a row — stopped using it (account lock-out)`);
        if (await prompt.confirm(`${cred.set}: 3 authentication failures in a row. Keep trying this credential set?`)) creds.resume(cred.set);
      }
      return { result: { status: 'auth_failed', reason: 'authentication failed' } };
    }
    if (e.code === 'not_in_inventory') return { result: { status: 'skipped', reason: 'not_in_inventory' } };
    return { result: { status: 'unreachable', reason: e.code === 'host_key_mismatch' ? 'host key changed — refused' : (e.code || 'unreachable') } };
  }
}

/** Save config.ini (0600) from an open session. */
async function backup(ctx, target, session, ts) {
  const buf = await session.scpGet('config.ini');
  const file = writePrivate(path.join(deviceDir(ctx.out, target), `config-${ts}.ini`), buf);
  ctx.audit.write('backup', { ip: target.ip, file: path.relative(ctx.out, file), bytes: buf.length });
  return file;
}

/** SNMPv3 GET with a few tries (a card may take a moment to apply v3 settings). */
async function v3get(ctx, ip, desired) {
  let r = null;
  for (let i = 0; i < (ctx.getTries || 3); i++) {
    r = await ctx.verifier.snmpV3Get(ip, desired);
    if (r.ok) return r;
    if (i + 1 < (ctx.getTries || 3)) await sleep(ctx.settleMs ?? 3000);
  }
  return r;
}

async function applyOne(ctx, target, siteConf, flags, ts) {
  const { creds, prompt, audit, log, verifier, emit = () => {} } = ctx;
  const base = { ip: target.ip, site: target.site || null, label: target.label || null };
  let desired;
  try {
    desired = desiredFor(target, { siteConf, keys: await creds.v3Keys(target.site), flags });
  } catch (e) { return { ...base, status: 'skipped', reason: e.code === 'plan_error' || e.code === 'credential_error' ? e.message : 'plan_error' }; }
  const policy = { legacy: desired.legacy, ntp: !!desired.ntp?.write };

  const o = await openCard(ctx, target, { write: true, policy });
  if (o.result) return { ...base, ...o.result };
  const { session, cred } = o;
  const applied = [];
  const result = { ...base, changes: [], diff: [] };
  try {
    const before = await readDevice(session, { cred, factory: creds.isFactory(cred), redactor: creds.redactor });
    result.read = before;
    const p = plan(before, desired);
    Object.assign(result, { diff: p.diff, warnings: p.warnings, recommendations: p.recommendations });
    if (p.status === 'blocked') return { ...result, status: 'skipped', reason: p.reason };

    let steps = p.steps;
    const cond = steps.find(s => s.ifKeysDiffer);
    if (cond) {
      // The user is there with the right protocols; the keys decide.
      const pre = await verifier.snmpV3Get(target.ip, desired);
      if (pre.ok) steps = steps.filter(s => s !== cond);
      else result.diff.push({ field: `snmpv3.user[${p.slots.profile}].keys`, from: 'differ / unknown', to: 'site keys' });
    }
    if (!steps.length && !p.post.length) {
      audit.write('in_sync', { ip: target.ip });
      return { ...result, status: 'skipped', reason: 'already in the desired state' };
    }
    const lines = [...steps, ...p.post].map(s => s.display);
    result.changes = lines;
    if (!flags.yesAll) {
      log.log(`\n${target.ip}${target.label ? ` (${target.label})` : ''}: ${lines.length} change(s)\n  ${lines.join('\n  ')}`);
      if (!await prompt.confirm(`Apply these to ${target.ip}?`)) { audit.write('declined', { ip: target.ip }); return { ...result, status: 'skipped', reason: 'declined by operator' }; }
    }

    // 1. backup — no backup, no write
    emit('backup', target.ip);
    try { result.backup = await backup(ctx, target, session, ts); } catch (e) {
      audit.write('backup_failed', { ip: target.ip, error: e.code || 'error' });
      return { ...result, status: 'failed', reason: 'backup_failed (nothing written)' };
    }

    const undo = async (why) => {
      emit('rollback', target.ip);
      audit.write('rollback', { ip: target.ip, why, steps: applied.length });
      let ok = true;
      for (const s of [...applied].reverse()) {
        const r = await session.run(s.undo).catch(() => ({ result: { ok: false } }));
        audit.write('rollback_step', { ip: target.ip, step: s.id, line: s.undoDisplay, ok: r.result.ok });
        if (!r.result.ok) ok = false;
      }
      return ok;
    };

    // 2. apply
    for (const s of steps) {
      emit('apply', target.ip, s.id);
      const r = await session.run(s.line);
      audit.write('apply_step', { ip: target.ip, step: s.id, line: s.display, result: r.result.code });
      if (!r.result.ok) {
        const rb = await undo(`step ${s.id} returned ${r.result.code || 'no result'}`);
        return { ...result, status: 'failed', reason: `${s.id}: ${r.result.code || 'no result'}`, rolled_back: rb };
      }
      applied.push(s);
    }

    // 3. verify
    emit('verify', target.ip);
    const after = await readDevice(session, { cred, factory: creds.isFactory(cred), redactor: creds.redactor });
    const again = plan(after, desired);
    const left = again.steps.filter(s => !s.ifKeysDiffer).map(s => s.id);
    const snmpR = await v3get(ctx, target.ip, desired);
    const trapR = await verifier.trapTest(target.ip, desired);
    result.verify = { readback: left.length ? `not applied: ${left.join(',')}` : 'ok', snmp: snmpR, trap: trapR };
    audit.write('verify', { ip: target.ip, readback: result.verify.readback, snmp: snmpR.ok, trap: trapR.status });
    if (left.length || !snmpR.ok || trapR.status === 'fail') {
      const rb = await undo('verify failed');
      return { ...result, status: 'failed', reason: `verify failed (${left.length ? 'read-back' : !snmpR.ok ? `snmpv3 ${snmpR.error}` : 'trap'})`, rolled_back: rb };
    }

    // 4. legacy off — only after SNMPv3 is proven, only with --disable-legacy
    for (const s of p.post) {
      emit('apply', target.ip, s.id);
      const r = await session.run(s.line);
      audit.write('apply_step', { ip: target.ip, step: s.id, line: s.display, result: r.result.code });
      if (!r.result.ok) { const rb = await undo(`${s.id} returned ${r.result.code}`); return { ...result, status: 'failed', reason: `${s.id}: ${r.result.code}`, rolled_back: rb }; }
      applied.push(s);
      emit('verify', target.ip);
      const r2 = await v3get(ctx, target.ip, desired);
      if (!r2.ok) { const rb = await undo('verify after legacy off failed'); return { ...result, status: 'failed', reason: 'verify after legacy off failed', rolled_back: rb }; }
    }
    audit.write('applied', { ip: target.ip, steps: applied.map(s => s.id) });
    return { ...result, status: 'ok', reason: `${applied.length} change(s) applied and verified` };
  } catch (e) {
    const code = e.code || 'error';
    audit.write('error', { ip: target.ip, error: code });
    if (applied.length) {
      emit('rollback', target.ip);
      for (const s of [...applied].reverse()) await session.run(s.undo).catch(() => {});
      return { ...result, status: 'failed', reason: code, rolled_back: true };
    }
    return { ...result, status: code === 'timeout' ? 'unreachable' : 'failed', reason: code };
  } finally {
    session.close();
  }
}

/**
 * @param {object} ctx  {creds, ssh, verifier, prompt, audit, log, out, consoleApi?, emit?, settleMs?}
 * @param {object[]} targets
 * @param {object} siteConf
 * @param {object} flags {yesAll, disableLegacy, setNtp, v3Profile, maintenanceMinutes}
 */
async function applyAll(ctx, targets, siteConf, flags) {
  const ts = stamp();
  const results = [];
  const windows = new Map();
  const sites = [...new Set(targets.map(t => t.site).filter(Boolean))];
  if (ctx.consoleApi) {
    for (const s of sites) {
      try {
        const w = await ctx.consoleApi.setMaintenance(s, flags.maintenanceMinutes || 120, 'cflex-onboard apply (SNMP onboarding)');
        windows.set(s, w.id);
        ctx.audit.write('maintenance_set', { site: s, id: w.id });
      } catch (e) { ctx.log.warn(`[onboard] maintenance window for ${s} not set: ${e.message}`); }
    }
  }
  try {
    for (const t of targets) { // concurrency 1 (spec 04 §5-5)
      const r = await applyOne(ctx, t, siteConf, flags, ts);
      ctx.log.log(`[onboard] ${t.ip}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
      results.push(r);
    }
  } finally {
    for (const [s, id] of windows) {
      try { await ctx.consoleApi.endMaintenance(id); ctx.audit.write('maintenance_end', { site: s, id }); } catch (e) { ctx.log.warn(`[onboard] maintenance window ${id} for ${s} not ended: ${e.message}`); }
    }
  }
  return results;
}

module.exports = { applyAll, applyOne, openCard, backup };
