// services/fms-pdf-gen.js — render FMS monthly report PDF.
// Style: IBM Carbon palette, multi-page (cover + executive + breakdown).
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

const MEDIA_DIR = process.env.FMS_MEDIA_DIR || '/opt/cflex-v2/cflex-api/data/fms-reports';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const FONT_REG  = '/usr/share/fonts/truetype/nanum/NanumGothic.ttf';
const FONT_BOLD = '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf';
const HAS_KO = fs.existsSync(FONT_REG);

// IBM Carbon palette
const C = {
  ink: '#161616', muted: '#525252', subtle: '#8d8d8d', soft: '#a8a8a8',
  primary: '#0f62fe', primarySoft: '#edf5ff', primaryDark: '#0043ce',
  critical: '#da1e28', criticalSoft: '#fff1f1', criticalDark: '#a2191f',
  warn: '#f1c21b', warnSoft: '#fff8e1',
  ok: '#24a148', okSoft: '#defbe6',
  hairline: '#e0e0e0', bg: '#f4f4f4', card: '#ffffff', deepBg: '#161616',
  accent: '#393939',
};

// Page geometry (A4 portrait)
const PAGE = { w: 595, h: 842, mLeft: 40, mRight: 40, mTop: 50, mBottom: 60 };
const innerW = PAGE.w - PAGE.mLeft - PAGE.mRight;

function rangeOfMonth(year, month) {
  return { start: new Date(year, month - 1, 1).getTime(), end: new Date(year, month, 1).getTime() };
}

function collectStats(tenantId, year, month) {
  const { start, end } = rangeOfMonth(year, month);

  const totalDevices = db.prepare('SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND decommissioned_at IS NULL').get(tenantId).c;
  const pollingDevices = db.prepare('SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND polling_enabled=1').get(tenantId).c;

  const alerts = db.prepare(`SELECT priority, metric, device_id FROM alerts
                             WHERE tenant_id=? AND received_at >= ? AND received_at < ?`).all(tenantId, start, end);
  const alertsByPriority = { P1: 0, P2: 0, P3: 0, P4: 0 };
  alerts.forEach(a => { if (alertsByPriority[a.priority] != null) alertsByPriority[a.priority]++; });

  const tickets = db.prepare(`SELECT priority, status, created_at, resolved_at, mttr_seconds, device_id
                              FROM tickets WHERE tenant_id=? AND created_at >= ? AND created_at < ?`).all(tenantId, start, end);
  const ticketsByPriority = { P1: 0, P2: 0, P3: 0, P4: 0 };
  tickets.forEach(t => { if (ticketsByPriority[t.priority] != null) ticketsByPriority[t.priority]++; });
  const resolved = tickets.filter(t => t.resolved_at);
  const mttrSec = resolved.length ? Math.round(resolved.reduce((s, t) => s + (t.mttr_seconds || 0), 0) / resolved.length) : null;

  // Top 10 noisiest devices
  const noisy = {};
  alerts.forEach(a => { noisy[a.device_id] = (noisy[a.device_id] || 0) + 1; });
  const topNoisy = Object.entries(noisy)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([deviceId, count]) => {
      const numericId = parseInt(String(deviceId).replace(/^ups-/, ''), 10);
      const dev = numericId ? db.prepare('SELECT label, room, rack, cbu FROM ups_devices WHERE id=?').get(numericId) : null;
      return { device_id: deviceId, label: dev?.label || deviceId, room: dev?.room, rack: dev?.rack, cbu: dev?.cbu, count };
    });

  // CBU breakdown
  const cbus = db.prepare(`SELECT cbu, COUNT(*) AS total,
                                  SUM(CASE WHEN polling_enabled=1 THEN 1 ELSE 0 END) AS polling
                           FROM ups_devices WHERE tenant_id=? AND cbu IS NOT NULL AND decommissioned_at IS NULL
                           GROUP BY cbu ORDER BY cbu`).all(tenantId);
  // Per-CBU alarm + ticket counts
  const byCbu = cbus.map(c => {
    const cbuAlerts = alerts.filter(a => {
      const numId = parseInt(String(a.device_id || '').replace(/^ups-/, ''), 10);
      if (!numId) return false;
      const dev = db.prepare('SELECT cbu FROM ups_devices WHERE id=?').get(numId);
      return dev?.cbu === c.cbu;
    });
    const cbuTickets = tickets.filter(t => {
      const numId = parseInt(String(t.device_id || '').replace(/^ups-/, ''), 10);
      if (!numId) return false;
      const dev = db.prepare('SELECT cbu FROM ups_devices WHERE id=?').get(numId);
      return dev?.cbu === c.cbu;
    });
    return {
      cbu: c.cbu, total: c.total, polling: c.polling,
      alerts: cbuAlerts.length,
      tickets: cbuTickets.length,
      p1Tickets: cbuTickets.filter(t => t.priority === 'P1').length,
    };
  });

  const unreachable = db.prepare("SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND status='unreachable'").get(tenantId).c;
  const availability = pollingDevices > 0 ? ((1 - unreachable / pollingDevices) * 100).toFixed(2) : null;

  return {
    period: { year, month, start, end },
    devices: { total: totalDevices, polling: pollingDevices, unreachable },
    alerts: { total: alerts.length, byPriority: alertsByPriority },
    tickets: {
      total: tickets.length, byPriority: ticketsByPriority,
      resolved: resolved.length, mttrSec,
    },
    topNoisy,
    byCbu,
    availability,
  };
}

function fmtMttr(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

const CBU_DISPLAY = {
  HMA:     { full: 'Hyundai Motor America',    city: 'Fountain Valley, CA' },
  KUS:     { full: 'Kia America',              city: 'Irvine, CA' },
  HAEA_HQ: { full: 'HAEA HQ',                   city: 'Irvine, CA' },
};

// ─── Renderers ─────────────────────────────────────────────────────
function drawCoverPage(doc, FB, FR, { tenantName, year, month, stats }) {
  // Top dark band with brand
  doc.rect(0, 0, PAGE.w, 240).fillColor(C.deepBg).fill();
  doc.rect(0, 236, PAGE.w, 4).fillColor(C.critical).fill();

  // Brand mark
  doc.font(FB).fontSize(9).fillColor('#9f9f9f').text('RINGON SERVICE', PAGE.mLeft, 60, { characterSpacing: 3 });
  doc.font(FB).fontSize(32).fillColor('#ffffff').text('C-Flex FMS', PAGE.mLeft, 78);

  doc.rect(PAGE.mLeft, 130, 36, 3).fillColor(C.critical).fill();

  // Report type pill
  doc.font(FB).fontSize(9).fillColor('#ffffff').text('MONTHLY OPERATIONS REPORT', PAGE.mLeft, 150, { characterSpacing: 1.5 });

  // Big period
  doc.font(FB).fontSize(46).fillColor('#ffffff').text(`${year}년 ${month}월`, PAGE.mLeft, 175);

  // Tenant block
  doc.rect(PAGE.mLeft, 290, innerW, 90).fillColor('#fafafa').fill();
  doc.rect(PAGE.mLeft, 290, 4, 90).fillColor(C.primary).fill();
  doc.font(FR).fontSize(9).fillColor(C.subtle).text('REPORTING TO', PAGE.mLeft + 18, 306, { characterSpacing: 1.2 });
  doc.font(FB).fontSize(22).fillColor(C.ink).text(tenantName, PAGE.mLeft + 18, 322);
  doc.font(FR).fontSize(10).fillColor(C.muted).text(`전체 ${stats.devices.total}대 UPS · ${stats.byCbu.length} CBU · 폴링 ${stats.devices.polling}대`, PAGE.mLeft + 18, 354);

  // KPI strip — vivid numbers on cover for at-a-glance summary
  const kpis = [
    { label: '월간 알람', value: stats.alerts.total,   sub: `P1 ${stats.alerts.byPriority.P1}`,        color: C.warn },
    { label: '월간 티켓', value: stats.tickets.total,  sub: `${stats.tickets.resolved} 해결`,         color: C.critical },
    { label: 'MTTR',     value: fmtMttr(stats.tickets.mttrSec), sub: '평균 해결시간',                    color: C.primary },
    { label: '가용성',    value: stats.availability != null ? stats.availability + '%' : '—', sub: '운영', color: C.ok },
  ];
  const cardW = (innerW - 12 * 3) / 4;
  kpis.forEach((k, i) => {
    const x = PAGE.mLeft + i * (cardW + 12);
    const y = 420;
    doc.rect(x, y, cardW, 110).fillColor('#ffffff').fill();
    doc.rect(x, y, cardW, 4).fillColor(k.color).fill();
    doc.font(FR).fontSize(8).fillColor(C.subtle).text(k.label.toUpperCase(), x + 14, y + 18, { characterSpacing: 1.2 });
    doc.font(FB).fontSize(30).fillColor(k.color).text(String(k.value), x + 14, y + 36);
    doc.font(FR).fontSize(9).fillColor(C.muted).text(k.sub, x + 14, y + 82);
  });

  // CBU strip on cover
  const stripY = 560;
  doc.font(FR).fontSize(9).fillColor(C.subtle).text('OPERATED CBUs', PAGE.mLeft, stripY, { characterSpacing: 1.2 });
  let cy = stripY + 16;
  stats.byCbu.forEach((c, i) => {
    const display = CBU_DISPLAY[c.cbu] || { full: c.cbu, city: '' };
    const rowY = cy + i * 38;
    doc.rect(PAGE.mLeft, rowY, innerW, 30).strokeColor(C.hairline).lineWidth(0.5).stroke();
    doc.font(FB).fontSize(11).fillColor(C.ink).text(c.cbu.replace('_', ' '), PAGE.mLeft + 12, rowY + 10, { width: 80 });
    doc.font(FR).fontSize(10).fillColor(C.muted).text(display.full, PAGE.mLeft + 100, rowY + 11, { width: 200 });
    doc.font(FR).fontSize(9).fillColor(C.subtle).text(display.city, PAGE.mLeft + 305, rowY + 12, { width: 110 });
    doc.font(FB).fontSize(13).fillColor(C.ink).text(`${c.total}`, PAGE.mLeft + innerW - 70, rowY + 9, { width: 30, align: 'right' });
    doc.font(FR).fontSize(8).fillColor(C.subtle).text('대 UPS', PAGE.mLeft + innerW - 38, rowY + 14, { width: 30 });
  });

  // Bottom footer
  doc.font(FR).fontSize(8).fillColor(C.subtle)
     .text(`작성일 ${new Date().toLocaleString('ko-KR', { timeZone: 'America/Los_Angeles' })} PT  ·  C-Flex FMS · cflex.runless.co.uk`,
       PAGE.mLeft, PAGE.h - 40, { width: innerW, align: 'center' });
}

function drawPageChrome(doc, FB, FR, { tenantName, year, month, pageNo, totalPages }) {
  // Top header
  doc.font(FR).fontSize(8).fillColor(C.subtle)
     .text('C-FLEX FMS · MONTHLY REPORT', PAGE.mLeft, 28, { characterSpacing: 1.5 });
  doc.font(FB).fontSize(8).fillColor(C.ink)
     .text(`${tenantName} · ${year}년 ${month}월`, 0, 28, { width: PAGE.w - PAGE.mRight, align: 'right' });
  doc.moveTo(PAGE.mLeft, 44).lineTo(PAGE.w - PAGE.mRight, 44).strokeColor(C.hairline).lineWidth(0.5).stroke();
  // Bottom footer with page numbers
  doc.font(FR).fontSize(8).fillColor(C.subtle)
     .text(`${pageNo} / ${totalPages}`, 0, PAGE.h - 30, { width: PAGE.w - PAGE.mRight, align: 'right' });
  doc.font(FR).fontSize(8).fillColor(C.subtle)
     .text('cflex.runless.co.uk', PAGE.mLeft, PAGE.h - 30);
}

function drawExecutivePage(doc, FB, FR, stats) {
  let y = 60;
  // Section title
  doc.font(FB).fontSize(20).fillColor(C.ink).text('운영 요약', PAGE.mLeft, y);
  doc.rect(PAGE.mLeft, y + 30, 36, 3).fillColor(C.critical).fill();
  y += 50;

  // KPI cards row
  const tiles = [
    { label: '전체 장치', value: stats.devices.total,    sub: '등록 UPS',          color: C.primary },
    { label: '폴링 장치', value: stats.devices.polling,  sub: '실시간 모니터',    color: C.ok },
    { label: '월간 알람', value: stats.alerts.total,     sub: `P1 ${stats.alerts.byPriority.P1}건 포함`,  color: C.warn },
    { label: '월간 티켓', value: stats.tickets.total,    sub: `${stats.tickets.resolved} 해결`,            color: C.critical },
  ];
  const cardW = (innerW - 12 * 3) / 4;
  tiles.forEach((t, i) => {
    const x = PAGE.mLeft + i * (cardW + 12);
    doc.rect(x, y, cardW, 86).fillColor('#fafafa').fill();
    doc.rect(x, y, cardW, 5).fillColor(t.color).fill();
    doc.font(FR).fontSize(8).fillColor(C.subtle).text(t.label.toUpperCase(), x + 12, y + 18, { characterSpacing: 1.2 });
    doc.font(FB).fontSize(28).fillColor(C.ink).text(String(t.value), x + 12, y + 34);
    doc.font(FR).fontSize(9).fillColor(C.muted).text(t.sub, x + 12, y + 68);
  });
  y += 106;

  // Availability bar
  sectionHeader(doc, FB, FR, '운영 가용성', y);
  y += 28;
  const av = stats.availability != null ? parseFloat(stats.availability) : null;
  const avColor = av == null ? C.subtle : av >= 99 ? C.ok : av >= 95 ? C.warn : C.critical;
  doc.font(FB).fontSize(36).fillColor(avColor).text(av != null ? av + '%' : '—', PAGE.mLeft, y);
  doc.font(FR).fontSize(9).fillColor(C.muted).text('운영 종료 시점 unreachable / polling 기준', PAGE.mLeft + 130, y + 14);
  // Availability bar visual
  const barW = innerW - 130;
  doc.rect(PAGE.mLeft + 130, y + 32, barW, 8).fillColor(C.bg).fill();
  if (av != null) doc.rect(PAGE.mLeft + 130, y + 32, (av / 100) * barW, 8).fillColor(avColor).fill();
  y += 70;

  // Alarm distribution — stacked horizontal bar by priority
  sectionHeader(doc, FB, FR, '알람 분포 (우선순위별)', y);
  y += 28;
  const ap = stats.alerts.byPriority;
  const apTotal = Math.max(1, ap.P1 + ap.P2 + ap.P3 + ap.P4);
  const apColors = { P1: C.critical, P2: C.warn, P3: C.primary, P4: C.soft };
  ['P1', 'P2', 'P3', 'P4'].forEach((p, idx) => {
    const ry = y + idx * 26;
    doc.font(FB).fontSize(10).fillColor(C.ink).text(p, PAGE.mLeft, ry + 4);
    const barX = PAGE.mLeft + 36;
    const trackW = innerW - 76;
    doc.rect(barX, ry, trackW, 16).fillColor(C.bg).fill();
    const w = (ap[p] / apTotal) * trackW;
    if (w > 0) doc.rect(barX, ry, w, 16).fillColor(apColors[p]).fill();
    doc.font(FR).fontSize(10).fillColor(C.muted).text(String(ap[p]), barX + trackW + 6, ry + 4, { width: 30 });
  });
  y += 4 * 26 + 14;

  // Ticket box
  sectionHeader(doc, FB, FR, '티켓 처리', y);
  y += 28;
  const pairs = [
    ['총 티켓', String(stats.tickets.total)],
    ['해결', `${stats.tickets.resolved} / ${stats.tickets.total}`],
    ['P1 티켓', String(stats.tickets.byPriority.P1)],
    ['평균 MTTR', fmtMttr(stats.tickets.mttrSec)],
  ];
  pairs.forEach((p, i) => {
    const col = i % 2;
    const rowY = y + Math.floor(i / 2) * 30;
    const x = PAGE.mLeft + col * (innerW / 2);
    doc.rect(x, rowY, innerW / 2 - 6, 24).fillColor('#fafafa').fill();
    doc.font(FR).fontSize(9).fillColor(C.subtle).text(p[0], x + 10, rowY + 7);
    doc.font(FB).fontSize(11).fillColor(C.ink).text(p[1], x + innerW / 2 - 16 - 100, rowY + 6, { width: 100, align: 'right' });
  });
}

function drawBreakdownPage(doc, FB, FR, stats) {
  let y = 60;
  doc.font(FB).fontSize(20).fillColor(C.ink).text('CBU 별 분석', PAGE.mLeft, y);
  doc.rect(PAGE.mLeft, y + 30, 36, 3).fillColor(C.critical).fill();
  y += 50;

  // CBU breakdown cards (3 rows)
  stats.byCbu.forEach((c, i) => {
    const display = CBU_DISPLAY[c.cbu] || { full: c.cbu, city: '' };
    const cardY = y + i * 96;
    // Card background
    doc.rect(PAGE.mLeft, cardY, innerW, 84).fillColor('#fafafa').fill();
    // CBU accent stripe (color rotates)
    const accentColor = [C.primary, C.ok, C.warn][i % 3];
    doc.rect(PAGE.mLeft, cardY, 5, 84).fillColor(accentColor).fill();
    // Header
    doc.font(FB).fontSize(16).fillColor(C.ink).text(c.cbu.replace('_', ' '), PAGE.mLeft + 18, cardY + 14);
    doc.font(FR).fontSize(10).fillColor(C.muted).text(`${display.full} · ${display.city}`, PAGE.mLeft + 18, cardY + 36);

    // KPIs right side, 4 numbers
    const metrics = [
      { l: '장치', v: c.total },
      { l: '폴링', v: c.polling },
      { l: '알람', v: c.alerts },
      { l: 'P1 티켓', v: c.p1Tickets },
    ];
    metrics.forEach((m, j) => {
      const cellX = PAGE.mLeft + 230 + j * 70;
      doc.font(FR).fontSize(8).fillColor(C.subtle).text(m.l.toUpperCase(), cellX, cardY + 18, { width: 64, characterSpacing: 1, align: 'right' });
      doc.font(FB).fontSize(22).fillColor(C.ink).text(String(m.v), cellX, cardY + 34, { width: 64, align: 'right' });
    });
  });
  y += stats.byCbu.length * 96 + 20;

  // Top 10 noisiest devices table
  sectionHeader(doc, FB, FR, 'TOP 10 알람 발생 장치', y);
  y += 28;
  if (stats.topNoisy.length === 0) {
    doc.font(FR).fontSize(10).fillColor(C.muted).text('이번 달 알람이 발생한 장치가 없습니다.', PAGE.mLeft, y);
    return;
  }
  // Table header
  doc.rect(PAGE.mLeft, y, innerW, 22).fillColor(C.bg).fill();
  doc.font(FB).fontSize(8).fillColor(C.muted)
    .text('#', PAGE.mLeft + 10, y + 7).text('CBU', PAGE.mLeft + 30, y + 7)
    .text('장치', PAGE.mLeft + 90, y + 7).text('룸 · 랙', PAGE.mLeft + 290, y + 7)
    .text('알람', 0, y + 7, { width: PAGE.w - PAGE.mRight - 12, align: 'right' });
  y += 22;
  stats.topNoisy.forEach((n, i) => {
    doc.rect(PAGE.mLeft, y, innerW, 22).strokeColor(C.hairline).lineWidth(0.3).stroke();
    doc.font(FR).fontSize(9).fillColor(C.ink)
       .text(String(i + 1), PAGE.mLeft + 10, y + 7)
       .text(n.cbu || '—', PAGE.mLeft + 30, y + 7, { width: 56 })
       .text(n.label, PAGE.mLeft + 90, y + 7, { width: 196, ellipsis: true })
       .text(`${n.room || '—'} · ${n.rack || '—'}`, PAGE.mLeft + 290, y + 7, { width: 180, ellipsis: true });
    doc.font(FB).fillColor(C.critical).text(String(n.count), 0, y + 7, { width: PAGE.w - PAGE.mRight - 12, align: 'right' });
    y += 22;
  });
}

function sectionHeader(doc, FB, FR, title, y) {
  doc.font(FB).fontSize(9).fillColor(C.critical).text(title, PAGE.mLeft, y, { width: innerW, characterSpacing: 1.2 });
  doc.moveTo(PAGE.mLeft, y + 16).lineTo(PAGE.w - PAGE.mRight, y + 16).strokeColor(C.hairline).lineWidth(0.5).stroke();
}

function renderFmsMonthlyPdf({ tenantId, tenantName, year, month }) {
  const stats = collectStats(tenantId, year, month);
  const filename = `fms-monthly-${tenantId}-${year}-${String(month).padStart(2, '0')}.pdf`;
  const filepath = path.join(MEDIA_DIR, filename);

  // bufferPages so we can stamp page numbers after the fact
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const stream = fs.createWriteStream(filepath);
  doc.pipe(stream);

  if (HAS_KO) {
    doc.registerFont('reg', FONT_REG);
    doc.registerFont('bold', FONT_BOLD);
  }
  const FB = HAS_KO ? 'bold' : 'Helvetica-Bold';
  const FR = HAS_KO ? 'reg' : 'Helvetica';

  // Page 1 — Cover (no chrome)
  drawCoverPage(doc, FB, FR, { tenantName, year, month, stats });

  // Page 2 — Executive summary
  doc.addPage({ size: 'A4', margin: 0 });
  drawExecutivePage(doc, FB, FR, stats);

  // Page 3 — CBU breakdown
  doc.addPage({ size: 'A4', margin: 0 });
  drawBreakdownPage(doc, FB, FR, stats);

  // Stamp page chrome on pages 2..end (cover is page 1, no chrome)
  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let i = 1; i < totalPages; i++) {
    doc.switchToPage(i);
    drawPageChrome(doc, FB, FR, { tenantName, year, month, pageNo: i + 1, totalPages });
  }

  doc.end();

  return new Promise((resolve) => {
    stream.on('finish', () => resolve({ filename, filepath, stats }));
  });
}

module.exports = { renderFmsMonthlyPdf, collectStats, MEDIA_DIR };
