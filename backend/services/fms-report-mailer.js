// services/fms-report-mailer.js — render + email FMS monthly report.
const axios = require('axios');
const fs = require('fs');
const db = require('../config/database');
const { renderFmsMonthlyPdf } = require('./fms-pdf-gen');

const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM = 'RingOn FMS <fms-report@ringonservice.net>';

async function sendFmsMonthlyReport({ tenantId, year, month, recipients }) {
  const tenant = db.prepare('SELECT display_name AS name FROM tenants WHERE id=?').get(tenantId) || { name: `tenant ${tenantId}` };
  const { filepath, filename, stats } = await renderFmsMonthlyPdf({
    tenantId, tenantName: tenant.name, year, month,
  });

  if (!RESEND_KEY) {
    logSend(tenantId, year, month, recipients, false, 'RESEND_API_KEY not set');
    throw new Error('RESEND_API_KEY not set');
  }

  const pdfBytes = fs.readFileSync(filepath);
  const subject = `[${tenant.name}] ${year}년 ${month}월 FMS 운영 리포트`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:560px;padding:24px;">
    <div style="font-size:11px;letter-spacing:0.6px;color:#da1e28;font-weight:700;text-transform:uppercase;">RingOn FMS · 월간 리포트</div>
    <h2 style="margin:8px 0 4px;font-size:20px;">${tenant.name} · ${year}년 ${month}월</h2>
    <div style="color:#525252;font-size:13px;margin-bottom:16px;">PDF 첨부를 확인해 주세요.</div>
    <div style="background:#f4f4f4;border-left:3px solid #0f62fe;padding:12px 14px;font-size:13px;color:#161616;">
      <div>· 폴링 장치 <b>${stats.devices.polling}</b> / 전체 ${stats.devices.total}</div>
      <div>· 월간 알람 <b>${stats.alerts.total}</b> (P1 ${stats.alerts.byPriority.P1})</div>
      <div>· 월간 티켓 <b>${stats.tickets.total}</b> · 해결 ${stats.tickets.resolved} · MTTR ${stats.tickets.mttrSec != null ? Math.round(stats.tickets.mttrSec / 60) + 'm' : '—'}</div>
      <div>· 가용성 <b>${stats.availability != null ? stats.availability + '%' : '—'}</b></div>
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:11px;color:#8d8d8d;">
      C-Flex FMS · <a href="https://cflex.runless.co.uk/fms" style="color:#0f62fe;">대시보드 열기</a>
    </div></div>`;

  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: FROM, to: recipients, subject, html,
      attachments: [{ filename, content: pdfBytes.toString('base64') }],
    }, { headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
    logSend(tenantId, year, month, recipients, true, null, r.data?.id);
    return { messageId: r.data?.id, filename, stats };
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    logSend(tenantId, year, month, recipients, false, msg);
    throw new Error(msg);
  }
}

function logSend(tenantId, year, month, recipients, ok, error, messageId) {
  try {
    db.prepare(`INSERT INTO fms_report_log (tenant_id, year, month, recipients, ok, error, message_id, sent_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(tenantId, year, month, recipients.join(','), ok ? 1 : 0, error || null, messageId || null, Date.now());
  } catch (_) {}
}

// ─── Run for every FMS tenant ── used by cron ────────────────────
async function sendForAllTenants(year, month) {
  const tenants = db.prepare(`SELECT DISTINCT t.id, t.display_name AS name FROM tenants t
                              JOIN users u ON u.tenant_id = t.id
                              WHERE u.role LIKE 'fms_%'`).all();
  const results = [];
  for (const t of tenants) {
    const recipients = db.prepare(`SELECT DISTINCT email FROM users WHERE tenant_id=? AND role LIKE 'fms_%'`)
      .all(t.id).map(r => r.email).filter(Boolean);
    if (!recipients.length) { results.push({ tenant: t.name, skipped: 'no recipients' }); continue; }
    try {
      const r = await sendFmsMonthlyReport({ tenantId: t.id, year, month, recipients });
      results.push({ tenant: t.name, ok: true, recipients, messageId: r.messageId });
    } catch (e) {
      results.push({ tenant: t.name, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { sendFmsMonthlyReport, sendForAllTenants };
