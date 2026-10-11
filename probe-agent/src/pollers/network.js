// Switches and routers — IF-MIB port state, plus whatever the box will say
// about its own temperature and power supplies.
//
// The twin draws port LEDs on every switch faceplate from `ports_up` /
// `ports_total`, and those two numbers have been coming from the ledger —
// which is to say, from whatever was typed in at survey time. This replaces
// them with the switch's own answer.
//
// IF-MIB is the one group in the catalogue that needs no on-site confirmation.
// The trap is not the OIDs, it is WHICH ROWS COUNT: a 48-port switch reports
// loopbacks, VLAN interfaces, port-channels and tunnels in the same table, so
// counting every row made a 48-port switch a 70-port one. Only physical
// ethernet types are ports.
const read = require('../services/snmp-read');
const cat = require('../services/oid-catalog');

/**
 * @param device { id, name, ip, kind: 'switch'|'router'|'sbc'|'server' }
 * @returns {{ok, metrics:[], error?}}
 */
async function pollNetwork(device, opts = {}) {
  const metrics = [];
  const notes = [];

  // ── ports ──
  const ifs = await read.walkTable(device, cat.IF_MIB.table, cat.IF_MIB.columns, opts);
  const rows = Object.entries(ifs.rows || {});
  if (!rows.length) {
    return { ok: false, metrics, error: ifs.error || 'IF-MIB returned nothing' };
  }

  let total = 0, up = 0, adminDown = 0;
  for (const [idx, row] of rows) {
    const type = Number(row.type);
    if (!cat.IF_TYPE_PHYSICAL.has(type)) continue;        // not a port
    total++;
    const oper = Number(row.oper_status);
    const admin = Number(row.admin_status);
    if (oper === 1) up++;
    if (admin === 2) adminDown++;

    // Per-port state, so a specific dead port can be found rather than only
    // "two of 48 are down".
    metrics.push({
      metric: 'port_oper_status', value: oper,
      str_value: cat.IF_MIB.columns.oper_status.map[oper] || `unknown(${oper})`,
      raw_value: oper, unit: 'state',
      oid: `${cat.IF_MIB.table}.${cat.IF_MIB.columns.oper_status.sub}.${idx}`,
      confidence: 'verified', source: 'measured',
      label: row.descr != null ? String(row.descr) : `if${idx}`,
    });
  }

  if (!total) {
    notes.push('no physical ethernet interfaces in IF-MIB — all rows were virtual');
  } else {
    // An administratively shut port is not a fault, and counting it as one
    // makes a correctly configured switch look half broken. It is reported
    // separately so the twin can show "44 up / 2 shut / 48".
    metrics.push({ metric: 'ports_total', value: total, raw_value: total, unit: 'count', oid: null, confidence: 'verified', source: 'measured' });
    metrics.push({ metric: 'ports_up', value: up, raw_value: up, unit: 'count', oid: null, confidence: 'verified', source: 'measured' });
    metrics.push({ metric: 'ports_admin_down', value: adminDown, raw_value: adminDown, unit: 'count', oid: null, confidence: 'verified', source: 'derived' });
    metrics.push({
      metric: 'ports_down_unexpected',
      // Down while administratively up — the only port count worth alarming on.
      value: Math.max(0, total - up - adminDown),
      raw_value: null, unit: 'count', oid: null, confidence: 'verified', source: 'derived',
    });
  }

  // ── ENTITY-SENSOR: temperatures, fans, supplies ──
  const es = await read.walkTable(device, cat.ENTITY_SENSOR.table, cat.ENTITY_SENSOR.columns, opts);
  for (const [idx, row] of Object.entries(es.rows || {})) {
    if (row.value == null) continue;
    const typeName = cat.ENTITY_SENSOR.columns.type.map[Number(row.type)] || 'other';
    const operOk = row.oper_status == null || Number(row.oper_status) === 1;
    if (!operOk) continue;                                 // a sensor reporting nonoperational has no reading
    // The scale is an exponent enum and the precision a digit count; applying
    // either as a plain multiplier is how a 42 °C inlet reads as 42,000.
    const v = cat.sensorValue(row.value, row.scale_exp, row.precision);
    if (v == null) continue;
    const unit = { celsius: '°C', voltsDC: 'V', voltsAC: 'V', amperes: 'A', watts: 'W', percentRH: '%RH', rpm: 'rpm' }[typeName];
    if (!unit) continue;                                   // a type we cannot name, we do not report
    metrics.push({
      metric: typeName === 'celsius' ? 'temp_c' : `sensor_${typeName}`,
      value: v, raw_value: Number(row.value), unit,
      oid: `${cat.ENTITY_SENSOR.table}.${cat.ENTITY_SENSOR.columns.value.sub}.${idx}`,
      confidence: 'verified', source: 'measured', label: `sensor${idx}`,
    });
  }

  // ── CISCO-ENVMON, for boxes that do not implement ENTITY-SENSOR ──
  if (!metrics.some(m => m.metric === 'temp_c')) {
    const t = await read.walkTable(device, cat.CISCO_ENVMON.temperature.table, cat.CISCO_ENVMON.temperature.columns, opts);
    for (const [idx, row] of Object.entries(t.rows || {})) {
      if (row.value == null) continue;
      metrics.push({
        metric: 'temp_c', value: Number(row.value), raw_value: Number(row.value), unit: '°C',
        oid: `${cat.CISCO_ENVMON.temperature.table}.3.${idx}`,
        confidence: 'verified', source: 'measured',
        label: row.descr != null ? String(row.descr) : `temp${idx}`,
      });
    }
  }
  const sup = await read.walkTable(device, cat.CISCO_ENVMON.supply.table, cat.CISCO_ENVMON.supply.columns, opts);
  for (const [idx, row] of Object.entries(sup.rows || {})) {
    if (row.state == null) continue;
    const st = Number(row.state);
    // notPresent on a dual-supply chassis with one supply fitted is normal and
    // must not read as a failed supply.
    if (st === 5) continue;
    metrics.push({
      metric: 'psu_state', value: st,
      str_value: cat.CISCO_ENVMON.supply.columns.state.map[st] || `unknown(${st})`,
      raw_value: st, unit: 'state',
      oid: `${cat.CISCO_ENVMON.supply.table}.3.${idx}`,
      confidence: 'verified', source: 'measured',
      label: row.descr != null ? String(row.descr) : `psu${idx}`,
    });
  }

  return {
    ok: metrics.length > 0, metrics,
    error: metrics.length ? undefined : 'no readings',
    notes: notes.length ? notes.join('; ') : undefined,
  };
}

module.exports = { pollNetwork };
