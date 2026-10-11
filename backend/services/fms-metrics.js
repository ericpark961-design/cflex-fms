// Narrow metrics: what the PDU / NetBotz / network / CRAC collectors write,
// and how a screen reads it back with its provenance attached.
//
// Roadmap item 6: every metric response is `{value, ts, source}`. The reason is
// the trust rule — measured beats nameplate beats library — and a number on a
// screen that cannot say which of the three it is cannot be acted on. A rack
// showing "6.4 kW" means something different if it came from a branch meter
// than if it came from adding up catalogue estimates, and until now the screen
// could not tell you.
//
// Two columns here exist because of scale, not because of provenance:
// `raw_value` keeps the integer the device returned, and `confidence` says
// whether the scale that turned it into a value has been confirmed against
// hardware. rPDU2PhaseStatusCurrent is tenths of an amp; read as amps, a 16 A
// circuit reports 160 A and nothing on screen looks wrong. Keeping the raw
// integer makes that a correction in place rather than a month of history
// thrown away.

const SOURCES = new Set(['measured', 'nameplate', 'library', 'simulated', 'derived']);
const CONFIDENCE = new Set(['verified', 'documented']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null)));

/**
 * Store a batch of readings from one subject.
 *
 * @param db
 * @param subject {type:'device'|'object', id?, name?, tenant_id, cbu?}
 * @param metrics [{metric, value, str_value?, raw_value?, unit?, oid?, confidence?, source, label?}]
 * @param meta {ts?, probe_id?, notes?}
 * @returns {{written:number, rejected:[{metric,why}]}}
 */
function record(db, subject, metrics = [], meta = {}) {
  if (!subject || !subject.tenant_id) throw new Error('tenant_id required');
  const type = subject.type === 'object' ? 'object' : 'device';
  if (type === 'device' && subject.id == null) throw new Error('device subject needs an id');
  if (type === 'object' && !subject.name) throw new Error('object subject needs a name');

  const ts = num(meta.ts) || Date.now();
  const ins = db.prepare(`INSERT INTO fms_metrics
      (tenant_id, cbu, subject_type, subject_id, subject_name, metric, value, unit,
       str_value, source, probe_id, ts, raw_value, oid, confidence, label, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const rejected = [];
  let written = 0;
  for (const m of metrics) {
    if (!m || !m.metric) { rejected.push({ metric: null, why: 'no metric name' }); continue; }
    // A row with no source is not allowed to exist: the whole point of the
    // table is that a number can say where it came from, and a blank there
    // would be read as measured by anything that renders it.
    if (!SOURCES.has(m.source)) {
      rejected.push({ metric: m.metric, why: `source "${m.source}" is not one of ${[...SOURCES].join('|')}` });
      continue;
    }
    const value = num(m.value);
    const str = m.str_value != null ? String(m.str_value).slice(0, 200) : null;
    // A reading that is neither a number nor a state is not a reading.
    if (value == null && str == null) {
      rejected.push({ metric: m.metric, why: 'neither value nor str_value' });
      continue;
    }
    if (m.confidence != null && !CONFIDENCE.has(m.confidence)) {
      rejected.push({ metric: m.metric, why: `confidence "${m.confidence}" unknown` });
      continue;
    }
    ins.run(
      subject.tenant_id, subject.cbu ?? null, type,
      type === 'device' ? subject.id : null,
      type === 'object' ? subject.name : (subject.name ?? null),
      String(m.metric).slice(0, 64), value, m.unit ? String(m.unit).slice(0, 16) : null,
      str, m.source, meta.probe_id ?? null, ts,
      num(m.raw_value), m.oid ? String(m.oid).slice(0, 128) : null,
      m.confidence ?? null, m.label ? String(m.label).slice(0, 64) : null,
      meta.notes ? String(meta.notes).slice(0, 500) : null,
    );
    written++;
  }
  return { written, rejected };
}

/**
 * The newest reading per metric for one subject, with its provenance.
 *
 * `stale_s` is how old it is, not whether it is acceptable — the caller owns
 * the freshness policy. But a reading older than the gate is returned with
 * `fresh:false` rather than withheld, because "23 °C, 40 minutes ago" is
 * useful and an empty box is not. What must never happen is 23 °C presented as
 * current.
 */
function latest(db, { tenantId, type = 'device', id = null, name = null, staleMs = 5 * 60 * 1000, at = Date.now() }) {
  const rows = type === 'device'
    ? db.prepare(`SELECT * FROM fms_metrics
                  WHERE tenant_id=? AND subject_type='device' AND subject_id=?
                  ORDER BY ts DESC LIMIT 2000`).all(tenantId, id)
    : db.prepare(`SELECT * FROM fms_metrics
                  WHERE tenant_id=? AND subject_name=?
                  ORDER BY ts DESC LIMIT 2000`).all(tenantId, name);

  // One row per (metric, label): a PDU has three phase currents and a switch
  // 48 port states, and they are different readings, not one overwritten.
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${r.metric}|${r.label || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const age = at - r.ts;
    out.push({
      metric: r.metric, label: r.label || null,
      value: r.value, str_value: r.str_value, unit: r.unit,
      // Item 6's contract: value, ts, source. The rest is what made the
      // collectors trustworthy enough to print.
      ts: r.ts, source: r.source,
      raw_value: r.raw_value, oid: r.oid, confidence: r.confidence,
      stale_s: Math.floor(age / 1000), fresh: age <= staleMs,
      notes: r.notes || null,
    });
  }
  return out;
}

/** A series for one metric, for a chart. */
function series(db, { tenantId, type = 'device', id = null, name = null, metric, label = null, sinceMs = 24 * 3600 * 1000, at = Date.now() }) {
  const since = at - sinceMs;
  const where = ['tenant_id=?', 'metric=?', 'ts>=?'];
  const params = [tenantId, metric, since];
  if (type === 'device') { where.push("subject_type='device'", 'subject_id=?'); params.push(id); }
  else { where.push('subject_name=?'); params.push(name); }
  if (label != null) { where.push('label=?'); params.push(label); }
  return db.prepare(
    `SELECT ts, value, raw_value, source, confidence, unit FROM fms_metrics
     WHERE ${where.join(' AND ')} ORDER BY ts ASC`,
  ).all(...params);
}

/**
 * Correct a scale that proved wrong, in place.
 *
 * This is why raw_value is stored. Without it, discovering that a NetBotz
 * reports whole degrees rather than tenths means a month of history is simply
 * wrong and the only remedy is to delete it.
 */
function rescale(db, { tenantId, metric, oid = null, factor, note = null }) {
  if (!Number.isFinite(factor) || factor === 0) throw new Error('factor must be a non-zero number');
  const where = ['tenant_id=?', 'metric=?', 'raw_value IS NOT NULL'];
  const params = [tenantId, metric];
  if (oid) { where.push('oid=?'); params.push(oid); }
  const r = db.prepare(
    `UPDATE fms_metrics SET value = raw_value * ?, confidence='verified',
            notes = COALESCE(?, notes)
     WHERE ${where.join(' AND ')}`,
  ).run(factor, note, ...params);
  return { updated: r.changes };
}

/** Retention. fms_metrics grows by a few thousand rows an hour. */
function prune(db, { keepDays = 30, at = Date.now() } = {}) {
  const r = db.prepare('DELETE FROM fms_metrics WHERE ts < ?').run(at - keepDays * 24 * 3600 * 1000);
  return { deleted: r.changes };
}

module.exports = { record, latest, series, rescale, prune, SOURCES, CONFIDENCE };
