// node probe-agent/test/collectors.test.js
//
// The collectors are SNMP, so the only thing worth testing without hardware is
// the part that goes wrong silently: SCALE, and which rows count.
//
//   · rPDU2PhaseStatusCurrent is tenths of an amp. Read as amps, a 16 A
//     circuit reports 160 A, every capacity figure above it is nonsense, and
//     nothing on the screen looks wrong.
//   · entPhySensorScale is an exponent ENUM and entPhySensorPrecision a digit
//     count. Applying either as a multiplier turns a 42 °C inlet into 42,000.
//   · IF-MIB lists loopbacks, VLANs and port-channels beside real ports.
//     Counting every row made a 48-port switch a 70-port one.
//   · An administratively shut port is not a fault.
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

// A fake SNMP layer, driven per test. Every collector goes through
// services/snmp-read, so that is the single seam.
let scalars = {};        // oid -> raw value
let tables = {};         // table oid -> { index: { colSub: raw } }
const origLoad = Module._load;
Module._load = function (request) {
  if (/snmp-read$/.test(request) || /snmp-read\.js$/.test(request)) {
    return {
      get: async (device, oidsByKey) => {
        const values = {}; const missing = [];
        for (const [k, oid] of Object.entries(oidsByKey)) {
          if (oid in scalars) values[k] = scalars[oid]; else missing.push(k);
        }
        // The real snmp-read reports ok when the REQUEST succeeded; an OID
        // that is absent lands in `missing`. Conflating the two here made a
        // PDU with no device-level scalars look like an unreachable PDU.
        return { ok: true, values, missing };
      },
      walkTable: async (device, table, columns) => {
        const t = tables[table];
        if (!t) return { ok: false, rows: {}, error: 'noSuchObject' };
        const rows = {};
        for (const [idx, cols] of Object.entries(t)) {
          for (const [name, c] of Object.entries(columns)) {
            if (cols[c.sub] !== undefined) (rows[idx] = rows[idx] || {})[name] = cols[c.sub];
          }
        }
        return { ok: true, rows };
      },
      normalize: (v) => v,
    };
  }
  return origLoad.apply(this, arguments);
};

const cat = require('../src/services/oid-catalog');
const { pollPdu } = require('../src/pollers/pdu');
const { pollNetbotz, stateKindFor } = require('../src/pollers/netbotz');
const { pollNetwork } = require('../src/pollers/network');
const { pollCrac } = require('../src/pollers/crac');
const registry = require('../src/pollers');

const find = (ms, metric, label) => ms.find(m => m.metric === metric && (label == null || m.label === label));

let fail = 0;
const t = async (name, fn) => {
  try { scalars = {}; tables = {}; await fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

(async () => {
  await t('a PDU phase current is tenths of an amp, and says so', async () => {
    tables[cat.APC_RPDU2_PHASE.table] = {
      1: { 3: 1, 4: 1, 5: 61, 6: 220 },     // 6.1 A, not 61 A
      2: { 3: 2, 4: 1, 5: 74, 6: 220 },
      3: { 3: 3, 4: 3, 5: 152, 6: 219 },    // nearOverload
    };
    tables[cat.APC_RPDU2.table] = { 1: { 1: 1, 3: 1, 5: 1234, 6: 1600, 11: 42 } };   // hundredths of kW
    const r = await pollPdu({ id: 1, name: 'PDU-A', model: 'Basic Rack PDU' });
    assert.equal(r.ok, true);

    const l1 = find(r.metrics, 'phase_current_a', 'L1');
    assert.equal(l1.value, 6.1, 'a 16 A circuit must not report 61 A');
    assert.equal(l1.raw_value, 61, 'the integer is kept so a wrong scale is correctable');
    assert.equal(l1.unit, 'A');
    assert.equal(l1.source, 'measured');
    assert.ok(l1.oid.endsWith('.5.1'), 'the OID travels with the reading');

    assert.equal(find(r.metrics, 'power_kw').value, 12.34);
    assert.equal(find(r.metrics, 'phase_load_state', 'L3').str_value, 'nearOverload');
  });

  await t('phase imbalance is derived, and marked as derived', async () => {
    tables[cat.APC_RPDU2_PHASE.table] = {
      1: { 3: 1, 5: 60 }, 2: { 3: 2, 5: 74 }, 3: { 3: 3, 5: 46 },
    };
    const r = await pollPdu({ id: 1, name: 'PDU-A' });
    const imb = find(r.metrics, 'phase_imbalance_pct');
    // (7.4 - 4.6) / 6.0 = 46.7 % — a breaker trips on this long before the
    // total says anything is wrong.
    assert.equal(imb.value, 46.7);
    assert.equal(imb.source, 'derived', 'a computed figure is not a measurement');
  });

  await t('outlet tables are only read where they exist', async () => {
    tables[cat.APC_RPDU2_PHASE.table] = { 1: { 3: 1, 5: 61 } };
    tables[cat.APC_RPDU2_OUTLET.switched.table] = { 1: { 5: 2 }, 2: { 5: 2 }, 3: { 5: 1 } };

    // A basic PDU has no outlet table; walking it returns noSuchObject per row.
    const basic = await pollPdu({ id: 1, name: 'PDU-A', model: 'Basic Rack PDU AP7900' });
    assert.equal(find(basic.metrics, 'outlets_on'), undefined);
    assert.match(basic.notes || '', /pdu_type not set/);

    const sw = await pollPdu({ id: 2, name: 'PDU-A02-L', model: 'Switched Rack PDU AP8959' });
    assert.equal(find(sw.metrics, 'outlets_on').value, 2, '2 of 3 outlets on');
    assert.equal(find(sw.metrics, 'outlets_on').label, '2/3');
  });

  await t('an ENTITY-SENSOR reading applies the exponent and the precision', async () => {
    tables[cat.IF_MIB.table] = { 1: { 2: 'Gi1/0/1', 3: 6, 7: 1, 8: 1 } };
    // 42 °C reported as 420 with precision 1: scale enum 9 = 10^0, precision 1
    // = 10^-1. Applying either as a multiplier gives 42,000 or 420.
    tables[cat.ENTITY_SENSOR.table] = { 1: { 1: 8, 2: 9, 3: 1, 4: 420, 5: 1 } };
    const r = await pollNetwork({ id: 3, name: 'ACC-A', kind: 'switch' });
    const temp = find(r.metrics, 'temp_c');
    assert.equal(temp.value, 42);
    assert.equal(temp.unit, '°C');
    assert.equal(temp.raw_value, 420);
    assert.equal(cat.sensorValue(420, 9, 1), 42);
    assert.equal(cat.sensorValue(42000, 8, 0), 42, 'milli-units scale down');
  });

  await t('a sensor reporting nonoperational has no reading', async () => {
    tables[cat.IF_MIB.table] = { 1: { 2: 'Gi1/0/1', 3: 6, 7: 1, 8: 1 } };
    tables[cat.ENTITY_SENSOR.table] = { 1: { 1: 8, 2: 9, 3: 0, 4: 0, 5: 3 } };
    const r = await pollNetwork({ id: 3, name: 'ACC-A', kind: 'switch' });
    assert.equal(find(r.metrics, 'temp_c'), undefined,
      'a dead sensor reads 0, and 0 °C is not the temperature');
  });

  await t('only physical ethernet rows are ports', async () => {
    tables[cat.IF_MIB.table] = {
      1: { 2: 'Vlan1', 3: 53, 7: 1, 8: 1 },          // propVirtual — not a port
      2: { 2: 'Lo0', 3: 24, 7: 1, 8: 1 },            // softwareLoopback
      3: { 2: 'Po1', 3: 161, 7: 1, 8: 1 },           // ieee8023adLag
      4: { 2: 'Gi1/0/1', 3: 6, 7: 1, 8: 1 },         // up
      5: { 2: 'Gi1/0/2', 3: 6, 7: 1, 8: 2 },         // down, admin up -> a fault
      6: { 2: 'Gi1/0/3', 3: 6, 7: 2, 8: 2 },         // administratively shut
    };
    const r = await pollNetwork({ id: 3, name: 'ACC-A', kind: 'switch' });
    assert.equal(find(r.metrics, 'ports_total').value, 3, 'VLANs and loopbacks are not ports');
    assert.equal(find(r.metrics, 'ports_up').value, 1);
    assert.equal(find(r.metrics, 'ports_admin_down').value, 1);
    // The only port count worth alarming on.
    assert.equal(find(r.metrics, 'ports_down_unexpected').value, 1,
      'a shut port is a configuration, not a fault');
    assert.equal(find(r.metrics, 'port_oper_status', 'Gi1/0/2').str_value, 'down');
  });

  await t('a power supply that is notPresent is not a failed supply', async () => {
    tables[cat.IF_MIB.table] = { 1: { 2: 'Gi1/0/1', 3: 6, 7: 1, 8: 1 } };
    tables[cat.CISCO_ENVMON.supply.table] = {
      1: { 2: 'Sw1 PS1', 3: 1 },
      2: { 2: 'Sw1 PS2', 3: 5 },      // the empty bay of a dual-supply chassis
    };
    const r = await pollNetwork({ id: 3, name: 'ACC-A', kind: 'switch' });
    const psus = r.metrics.filter(m => m.metric === 'psu_state');
    assert.equal(psus.length, 1);
    assert.equal(psus[0].str_value, 'normal');
  });

  await t('a NetBotz sensor is matched by its label, not its index', async () => {
    tables[cat.NETBOTZ.temp.table] = { 1: { 4: 'Rack A01 inlet', 7: 232 } };
    tables[cat.NETBOTZ.humidity.table] = { 1: { 4: 'CCR ambient', 7: 418 } };
    tables[cat.NETBOTZ.state.table] = {
      1: { 4: 'Leak cable north aisle', 7: 2 },
      2: { 4: 'Door CCR main', 7: 1 },
      3: { 4: 'Port 3', 7: 1 },                     // unlabelled: no claim made
    };
    const r = await pollNetbotz({ id: 4, name: 'NB-A02', kind: 'netbotz' });
    assert.equal(find(r.metrics, 'temp_c', 'Rack A01 inlet').value, 23.2);
    assert.equal(find(r.metrics, 'humidity_pct', 'CCR ambient').value, 41.8);
    assert.equal(find(r.metrics, 'leak', 'Leak cable north aisle').str_value, 'wet');
    assert.equal(find(r.metrics, 'door', 'Door CCR main').str_value, 'closed');
    // Which contact state is trouble depends on what is plugged in, so an
    // unrecognised label travels as a raw state rather than becoming an alarm.
    const raw = find(r.metrics, 'contact_state', 'Port 3');
    assert.equal(raw.str_value, 'state(1)');
    assert.match(r.notes, /unlabelled state sensor/);
    assert.equal(stateKindFor('누수 감지 케이블').metric, 'leak', 'Korean labels too');
    assert.equal(stateKindFor('whatever'), null);
  });

  await t('a CRAC in standby is not cooling, and the capacity module is told', async () => {
    for (const m of cat.LIEBERT_ICOM.measurements) {
      const v = { supply_temp_c: 183, return_temp_c: 265, humidity_pct: 450 }[m.metric];
      tables[m.table] = { 1: { 1: v } };
    }
    scalars[cat.LIEBERT_ICOM.scalars.state_cooling.oid] = 2;      // standby
    scalars[cat.LIEBERT_ICOM.scalars.alarm_count.oid] = 1;
    const r = await pollCrac({ id: 5, name: 'CRAC-2', kind: 'crac' });
    assert.equal(r.ok, true);
    assert.equal(find(r.metrics, 'supply_temp_c').value, 18.3);
    assert.equal(find(r.metrics, 'delta_t_c').value, 8.2, 'return minus supply');
    const avail = find(r.metrics, 'cooling_available');
    assert.equal(avail.value, 0, 'standby is not available cooling');
    assert.equal(avail.str_value, 'standby');
    assert.match(avail.label, /alarms 1/);
    // Nothing in this profile has been read off a unit's display yet, and the
    // data says so rather than the claim living in a commit message.
    assert.equal(find(r.metrics, 'supply_temp_c').confidence, 'documented');
    assert.match(r.notes, /confirm against the iCOM display/);
  });

  await t('a CRAC that speaks BACnet says so instead of timing out', async () => {
    const r = await pollCrac({ id: 6, name: 'CRAC-3', kind: 'crac', attrs: { protocol: 'bacnet' } });
    assert.equal(r.ok, false);
    assert.equal(r.unsupported, true, 'not a dead unit — an unimplemented protocol');
    assert.match(r.error, /not implemented/);
    assert.match(r.error, /KMX survey/);
  });

  await t('the registry routes by kind, and says why it skipped', async () => {
    assert.equal(registry.collectorFor({ kind: 'crac' }).name, 'pollCrac');
    assert.equal(registry.collectorFor({ kind: 'switch' }).name, 'pollNetwork');
    assert.equal(registry.collectorFor({ kind: 'netbotz' }).name, 'pollNetbotz');
    assert.equal(registry.collectorFor({ kind: 'pdu' }).name, 'pollPdu');
    // A UPS keeps its own path: routing it here would give ups_metrics two
    // writers.
    assert.equal(registry.collectorFor({ kind: 'ups' }), null);
    assert.match(registry.skipReason({ kind: 'ups' }), /own path/);
    // A patch panel has nothing to say, and asking produces a timeout per
    // cycle and a device that looks broken because it is a patch panel.
    assert.equal(registry.collectorFor({ kind: 'patch' }), null);
    assert.equal(registry.skipReason({ kind: 'patch' }), 'passive');
    assert.match(registry.skipReason({ kind: '' }), /kind not set/);
    assert.match(registry.skipReason({ kind: 'toaster' }), /no collector for kind "toaster"/);

    const skipped = await registry.pollOne({ id: 9, name: 'PP-A02', kind: 'patch' });
    assert.equal(skipped.skipped, true);
    assert.deepEqual(skipped.metrics, []);
  });

  await t('every catalogue entry declares its confidence and its scale', async () => {
    const walk = (o, where) => {
      for (const [k, v] of Object.entries(o)) {
        if (!v || typeof v !== 'object') continue;
        if (v.oid || v.sub) {
          assert.ok(v.confidence || v.unit === 'text',
            `${where}.${k} has no confidence`);
          if (v.confidence) {
            assert.ok(['verified', 'documented'].includes(v.confidence),
              `${where}.${k} confidence "${v.confidence}" is not verified|documented`);
          }
          assert.ok(v.unit, `${where}.${k} has no unit`);
          if (v.unit !== 'text' && v.unit !== 'state' && v.unit !== 'enum' && v.unit !== 'raw') {
            assert.ok(v.scale != null, `${where}.${k} has a unit but no scale`);
          }
        } else if (v.columns) {
          walk(v.columns, `${where}.${k}`);
        } else {
          walk(v, `${where}.${k}`);
        }
      }
    };
    walk({ device: cat.APC_RPDU2 }, 'cat.RPDU2');
    walk({ phase: cat.APC_RPDU2_PHASE }, 'cat');
    walk(cat.APC_RPDU2_OUTLET, 'cat.OUTLET');
    walk(cat.NETBOTZ, 'cat.NETBOTZ');
    walk(cat.CISCO_ENVMON, 'cat.ENVMON');
    walk({ scalars: cat.LIEBERT_ICOM.scalars }, 'cat.LIEBERT');
    for (const m of cat.LIEBERT_ICOM.measurements) {
      assert.ok(m.confidence && m.unit && m.scale != null && m.table && m.metric,
        `LIEBERT measurement ${m.metric} is incomplete`);
    }
    // IF-MIB is the one group that needs no on-site confirmation.
    for (const [k, v] of Object.entries(cat.IF_MIB.columns)) {
      assert.equal(v.confidence, 'verified', `IF-MIB.${k} should be verified`);
    }
  });

  console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - the collectors scale correctly and count the right rows');
  process.exit(fail ? 1 : 0);
})();
