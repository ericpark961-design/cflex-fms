// APC Rack PDU — rPDU2 group of the PowerNet-MIB.
//
// This is the measurement the capacity module has been missing. Until now a
// rack's load was either a figure somebody typed into the ledger or the sum of
// catalogue planning estimates for whatever the inventory happened to list. A
// metered PDU reports what the rack is ACTUALLY drawing, per phase, which is
// the number every headroom figure above it should rest on.
//
// What comes out: device power, and per-phase current / voltage / load state.
// Outlet tables only when the ledger says the unit is switched or metered — a
// basic PDU has neither, and walking them produces a page of noSuchObject.
const read = require('../services/snmp-read');
const cat = require('../services/oid-catalog');

const metric = (name, entry, raw, extra = {}) => {
  const s = cat.scaled(entry, raw);
  return {
    metric: name, value: s.value, str_value: s.text, raw_value: s.raw,
    unit: entry.unit, oid: entry.oid || extra.oid || null,
    confidence: entry.confidence, source: 'measured', ...extra,
  };
};

/**
 * @param device { id, name, ip, kind, model, attrs: { pdu_type: 'basic'|'metered'|'switched' } }
 * @returns {{ok, metrics:[], error?}}
 */
async function pollPdu(device, opts = {}) {
  const metrics = [];
  const notes = [];

  // ── device level ──
  // rPDU2DeviceStatusEntry is a table indexed by device number. A rack PDU is
  // device 1, but a unit behind a shared NMC can have several, so every row is
  // reported and labelled rather than only the first.
  const dev = await read.walkTable(device, cat.APC_RPDU2.table, cat.APC_RPDU2.columns, opts);
  if (dev.error && !Object.keys(dev.rows || {}).length) notes.push(`device group: ${dev.error}`);
  const devRows = Object.entries(dev.rows || {});
  for (const [idx, row] of devRows) {
    for (const [col, entry] of Object.entries(cat.APC_RPDU2.columns)) {
      if (row[col] == null) continue;
      metrics.push(metric(col, entry, row[col], {
        oid: `${cat.APC_RPDU2.table}.${entry.sub}.${idx}`,
        label: devRows.length > 1 ? `dev${idx}` : undefined,
      }));
    }
  }

  // ── per phase ──
  const ph = await read.walkTable(device, cat.APC_RPDU2_PHASE.table, cat.APC_RPDU2_PHASE.columns, opts);
  const phaseLabels = [];
  for (const [idx, row] of Object.entries(ph.rows || {})) {
    const n = row.number ?? idx;
    const label = `L${n}`;
    phaseLabels.push(label);
    for (const [col, entry] of Object.entries(cat.APC_RPDU2_PHASE.columns)) {
      if (col === 'number' || row[col] == null) continue;
      metrics.push(metric(`phase_${col}`, entry, row[col], {
        oid: `${cat.APC_RPDU2_PHASE.table}.${entry.sub}.${idx}`,
        label,
      }));
    }
  }

  // A three-phase PDU whose phases are badly unbalanced trips a breaker long
  // before the total says anything is wrong, so the imbalance is derived here
  // rather than left for someone to notice.
  const currents = metrics.filter(m => m.metric === 'phase_current_a' && m.value != null).map(m => m.value);
  if (currents.length >= 2) {
    const max = Math.max(...currents), min = Math.min(...currents);
    const avg = currents.reduce((a, b) => a + b, 0) / currents.length;
    metrics.push({
      metric: 'phase_imbalance_pct',
      value: avg > 0 ? Math.round(((max - min) / avg) * 1000) / 10 : 0,
      raw_value: null, unit: '%', oid: null,
      // Derived from measurements, so it is not itself a measurement.
      confidence: 'verified', source: 'derived',
      label: phaseLabels.join('/'),
    });
  }

  // ── outlets, only where they exist ──
  const type = String(device.attrs?.pdu_type || device.pdu_type || '').toLowerCase()
    || (/switched/i.test(device.model || '') ? 'switched'
      : /metered/i.test(device.model || '') ? 'metered' : '');
  if (type === 'switched' || type === 'metered') {
    const spec = cat.APC_RPDU2_OUTLET[type];
    const out = await read.walkTable(device, spec.table, spec.columns, opts);
    let on = 0, total = 0;
    for (const [idx, row] of Object.entries(out.rows || {})) {
      for (const [col, entry] of Object.entries(spec.columns)) {
        if (row[col] == null) continue;
        const m = metric(`outlet_${col}`, entry, row[col], {
          oid: `${spec.table}.${entry.sub}.${idx}`, label: `outlet${idx}`,
        });
        metrics.push(m);
        if (col === 'state') { total++; if (m.str_value === 'on') on++; }
      }
    }
    if (total) {
      metrics.push({
        metric: 'outlets_on', value: on, raw_value: null, unit: 'count', oid: null,
        confidence: 'verified', source: 'derived', label: `${on}/${total}`,
      });
    }
  } else if (type === '') {
    notes.push('pdu_type not set — outlet tables not read');
  }

  return {
    ok: metrics.length > 0,
    metrics,
    error: metrics.length ? undefined : (ph.error || 'no readings'),
    notes: notes.length ? notes.join('; ') : undefined,
  };
}

module.exports = { pollPdu };
