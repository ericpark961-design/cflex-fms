// node backend/services/fms-metrics.test.js
//
// What this table exists to prevent: a number on a screen that cannot say
// where it came from. The trust rule ranks measured above nameplate above
// library, so a row with no source is worse than no row — anything rendering
// it would read it as measured.
//
// And the scale. rPDU2PhaseStatusCurrent is tenths of an amp: read as amps, a
// 16 A circuit reports 160 A and nothing on screen looks wrong. Keeping the
// raw integer is what makes that a correction rather than a loss.
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { statements } = require('../migrations/apply');
const M = require('./fms-metrics');

const T0 = 1_760_000_000_000;

function db0() {
  const d = new DatabaseSync(':memory:');
  const root = path.join(__dirname, '..', 'migrations');
  for (const f of fs.readdirSync(root).filter(x => /^00[1-8]_.*\.sql$/.test(x)).sort()) {
    let stmts;
    try { stmts = statements(fs.readFileSync(path.join(root, f), 'utf8')); } catch { continue; }
    for (const s of stmts) {
      try { d.exec(s); } catch (e) {
        if (!/duplicate column name|already exists|no such table|no such column/i.test(e.message)) throw e;
      }
    }
  }
  return d;
}

const subj = { type: 'device', id: 7, tenant_id: 10, cbu: 'KMX' };

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

t('a reading carries value, ts and source — item 6s contract', () => {
  const d = db0();
  const r = M.record(d, subj, [
    { metric: 'phase_current_a', value: 6.1, raw_value: 61, unit: 'A', oid: '1.3.6.1.4.1.318.1.1.26.6.3.1.5.1', confidence: 'documented', source: 'measured', label: 'L1' },
  ], { ts: T0, probe_id: 'p_kmx_1' });
  assert.equal(r.written, 1);
  assert.deepEqual(r.rejected, []);

  const [m] = M.latest(d, { tenantId: 10, id: 7, at: T0 });
  assert.equal(m.value, 6.1);
  assert.equal(m.ts, T0);
  assert.equal(m.source, 'measured');
  // The scale is not confirmed against hardware, and the row says so.
  assert.equal(m.confidence, 'documented');
  assert.equal(m.raw_value, 61, 'the integer the device returned is kept');
  assert.equal(m.unit, 'A');
  assert.equal(m.label, 'L1');
  assert.equal(m.fresh, true);
});

t('a row with no source is refused', () => {
  const d = db0();
  const r = M.record(d, subj, [
    { metric: 'temp_c', value: 23.4, unit: '°C' },                     // no source
    { metric: 'temp_c', value: 23.4, unit: '°C', source: 'guess' },     // not a source
    { metric: 'temp_c', value: 23.4, unit: '°C', source: 'measured' },
  ], { ts: T0 });
  assert.equal(r.written, 1, 'only the one that said where it came from');
  assert.equal(r.rejected.length, 2);
  assert.match(r.rejected[0].why, /source/);
  assert.match(r.rejected[1].why, /source "guess"/);
});

t('a reading that is neither a number nor a state is not a reading', () => {
  const d = db0();
  const r = M.record(d, subj, [
    { metric: 'door', source: 'measured' },
    { metric: 'door', str_value: 'closed', source: 'measured' },
    { metric: 'ports_up', value: 0, source: 'measured' },
  ], { ts: T0 });
  assert.equal(r.written, 2, 'a state with no number counts; zero counts');
  assert.equal(r.rejected.length, 1);
  // Zero is a reading. Dropping it would make "0 ports up" look like no data,
  // which is the opposite of what it means.
  const zero = M.latest(d, { tenantId: 10, id: 7, at: T0 }).find(m => m.metric === 'ports_up');
  assert.equal(zero.value, 0);
});

t('readings with the same name but different labels are different readings', () => {
  const d = db0();
  M.record(d, subj, [
    { metric: 'phase_current_a', value: 6.1, source: 'measured', label: 'L1' },
    { metric: 'phase_current_a', value: 7.4, source: 'measured', label: 'L2' },
    { metric: 'phase_current_a', value: 5.2, source: 'measured', label: 'L3' },
  ], { ts: T0 });
  const out = M.latest(d, { tenantId: 10, id: 7, at: T0 });
  assert.equal(out.length, 3, 'three phases are three readings, not one overwritten');
  assert.deepEqual(out.map(m => m.label).sort(), ['L1', 'L2', 'L3']);

  // And the newest of each wins.
  M.record(d, subj, [{ metric: 'phase_current_a', value: 9.9, source: 'measured', label: 'L1' }], { ts: T0 + 60000 });
  const after = M.latest(d, { tenantId: 10, id: 7, at: T0 + 60000 });
  assert.equal(after.find(m => m.label === 'L1').value, 9.9);
  assert.equal(after.find(m => m.label === 'L2').value, 7.4, 'the others are untouched');
  assert.equal(after.length, 3);
});

t('a stale reading comes back marked stale, not withheld', () => {
  const d = db0();
  M.record(d, subj, [{ metric: 'temp_c', value: 23, source: 'measured' }], { ts: T0 });
  const fresh = M.latest(d, { tenantId: 10, id: 7, at: T0 + 60_000 });
  assert.equal(fresh[0].fresh, true);
  // "23 °C, 40 minutes ago" is useful; an empty box is not. What must never
  // happen is 23 °C presented as current.
  const old = M.latest(d, { tenantId: 10, id: 7, at: T0 + 40 * 60_000 });
  assert.equal(old[0].fresh, false);
  assert.equal(old[0].stale_s, 2400);
  assert.equal(old[0].value, 23);
});

t('a scale that proves wrong is corrected in place', () => {
  const d = db0();
  // Collected believing tenths of a degree; the unit reports whole degrees.
  M.record(d, subj, [
    { metric: 'temp_c', value: 2.3, raw_value: 23, unit: '°C', oid: '1.3.6.1.4.1.5528.100.4.1.1.1.7.1', confidence: 'documented', source: 'measured' },
  ], { ts: T0 });
  M.record(d, subj, [
    { metric: 'temp_c', value: 2.4, raw_value: 24, unit: '°C', oid: '1.3.6.1.4.1.5528.100.4.1.1.1.7.1', confidence: 'documented', source: 'measured' },
  ], { ts: T0 + 60000 });

  const r = M.rescale(d, { tenantId: 10, metric: 'temp_c', factor: 1, note: 'survey: whole degrees' });
  assert.equal(r.updated, 2, 'the history is corrected, not discarded');
  const out = M.latest(d, { tenantId: 10, id: 7, at: T0 + 60000 });
  assert.equal(out[0].value, 24);
  assert.equal(out[0].confidence, 'verified', 'and it is now confirmed');
  assert.match(out[0].notes, /whole degrees/);

  assert.throws(() => M.rescale(d, { tenantId: 10, metric: 'temp_c', factor: 0 }), /non-zero/);
});

t('an object is addressed by name, a device by id', () => {
  const d = db0();
  // CRACs live in fms_racks as room objects: they have a name and a position,
  // not a rack-mounted id.
  M.record(d, { type: 'object', name: 'CRAC-1', tenant_id: 10, cbu: 'KMX' }, [
    { metric: 'supply_temp_c', value: 18.3, raw_value: 183, unit: '°C', confidence: 'documented', source: 'measured' },
    { metric: 'cooling_available', value: 1, str_value: 'cooling', unit: 'state', confidence: 'documented', source: 'derived' },
  ], { ts: T0 });
  const out = M.latest(d, { tenantId: 10, type: 'object', name: 'CRAC-1', at: T0 });
  assert.equal(out.length, 2);
  assert.equal(out.find(m => m.metric === 'supply_temp_c').value, 18.3);
  // A derived figure is not a measurement and does not claim to be.
  assert.equal(out.find(m => m.metric === 'cooling_available').source, 'derived');

  assert.throws(() => M.record(d, { type: 'object', tenant_id: 10 }, []), /needs a name/);
  assert.throws(() => M.record(d, { type: 'device', tenant_id: 10 }, []), /needs an id/);
  assert.throws(() => M.record(d, { type: 'device', id: 1 }, []), /tenant_id required/);
});

t('a series comes back in order, with its provenance', () => {
  const d = db0();
  for (let i = 0; i < 5; i++) {
    M.record(d, subj, [{ metric: 'phase_current_a', value: 6 + i, raw_value: 60 + i * 10, source: 'measured', confidence: 'documented', label: 'L1' }],
      { ts: T0 + i * 60000 });
  }
  const s = M.series(d, { tenantId: 10, id: 7, metric: 'phase_current_a', label: 'L1', at: T0 + 5 * 60000 });
  assert.equal(s.length, 5);
  assert.deepEqual(s.map(x => x.value), [6, 7, 8, 9, 10]);
  assert.ok(s.every(x => x.source === 'measured' && x.confidence === 'documented'));
  // A label filter keeps L2 out of L1's chart.
  M.record(d, subj, [{ metric: 'phase_current_a', value: 99, source: 'measured', label: 'L2' }], { ts: T0 });
  assert.equal(M.series(d, { tenantId: 10, id: 7, metric: 'phase_current_a', label: 'L1', at: T0 + 5 * 60000 }).length, 5);
});

t('retention has a cutoff', () => {
  const d = db0();
  M.record(d, subj, [{ metric: 'temp_c', value: 1, source: 'measured' }], { ts: T0 - 40 * 24 * 3600 * 1000 });
  M.record(d, subj, [{ metric: 'temp_c', value: 2, source: 'measured' }], { ts: T0 });
  assert.equal(M.prune(d, { keepDays: 30, at: T0 }).deleted, 1);
  assert.equal(M.latest(d, { tenantId: 10, id: 7, at: T0 })[0].value, 2);
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - every number can say where it came from');
process.exit(fail ? 1 : 0);
