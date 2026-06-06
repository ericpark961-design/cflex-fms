// services/fms-report-scheduler.js — daily tick: on the 1st of the month at 09:00 UTC,
// send previous month's FMS report to every tenant. Idempotent: writes a marker row.
const db = require('../config/database');
const { sendForAllTenants } = require('./fms-report-mailer');

const DAY_MS = 24 * 3600 * 1000;
const TICK_MS = 60 * 60 * 1000; // 1 hour — cheap; only fires on the right day+hour

function startFmsReportScheduler() {
  console.log('[fms-report] scheduler armed (hourly tick, fires on day=1 hour=9 UTC for previous month)');
  setInterval(tick, TICK_MS);
  setTimeout(tick, 30 * 1000); // first check 30s after boot
}

async function tick() {
  const now = new Date();
  const isFireWindow = now.getUTCDate() === 1 && now.getUTCHours() === 9;
  if (!isFireWindow) return;
  // Previous month
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const y = prev.getUTCFullYear(), m = prev.getUTCMonth() + 1;
  // Idempotency: skip if any row in fms_report_log for this y/m within last 25h
  const already = db.prepare(`SELECT COUNT(*) c FROM fms_report_log
                              WHERE year=? AND month=? AND sent_at > ?`)
    .get(y, m, Date.now() - 25 * 3600 * 1000).c;
  if (already > 0) return;
  console.log(`[fms-report] firing for ${y}-${String(m).padStart(2, '0')}`);
  try {
    const results = await sendForAllTenants(y, m);
    console.log('[fms-report] results:', JSON.stringify(results));
  } catch (e) {
    console.error('[fms-report] error:', e.message);
  }
}

module.exports = { startFmsReportScheduler };
