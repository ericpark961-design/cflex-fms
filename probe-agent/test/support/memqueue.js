// The buffer.js interface in memory, so forwarder tests need no sqlite.
function memQueue() {
  let seq = 0;
  const rows = [];
  return {
    rows,
    enqueue(kind, payload) { rows.push({ id: ++seq, ts: Date.now(), kind, payload: JSON.stringify(payload), attempts: 0 }); },
    dequeue(limit = 100) { return rows.slice(0, limit).map(r => ({ ...r })); },
    ack(ids) { for (const id of ids) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1); } },
    fail(id, error) { const r = rows.find(x => x.id === id); if (r) { r.attempts++; r.last_error = error; } },
    stats() { return { pending: rows.length, oldest_ts: rows[0]?.ts ?? null }; },
  };
}

module.exports = { memQueue };
