// onboard/report.js — what a run leaves behind (spec 04 §4.1, §4.6, §5-6):
//   onboard/<site>/<ip>/read-<ts>.json, config-<ts>.ini   per card (0600)
//   onboard/report-<ts>.md / .csv                          per run
//   onboard/audit.log                                      append-only, every run
// Every byte written goes through the redactor; config.ini backups are the
// one exception — they are the card's own file, kept 0600 and never printed.
const fs = require('fs');
const path = require('path');

const STATUSES = ['ok', 'skipped', 'auth_failed', 'unreachable', 'failed'];
const stamp = (t = new Date()) => t.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const safeName = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }

function deviceDir(out, t) { return ensureDir(path.join(out, safeName(t.site), safeName(t.ip))); }

/** Write a file as 0600 (created that way, never widened). */
function writePrivate(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function createAudit(out, redactor, { now = () => new Date() } = {}) {
  ensureDir(out);
  const file = path.join(out, 'audit.log');
  return {
    file,
    write(action, detail = {}) {
      const line = redactor.redact(JSON.stringify({ ts: now().toISOString(), action, ...detail }));
      fs.appendFileSync(file, line + '\n', { mode: 0o600, flag: 'a' });
    },
  };
}

/**
 * Inventory against what answered (spec 04 §4.1): serial / model / firmware
 * mismatches, inventory cards that did not answer, answering cards that are
 * not in the inventory (only possible from a scan — option 1 talks to
 * inventory addresses only).
 */
function compareInventory(targets, results, { scanned = [] } = {}) {
  const out = { mismatches: [], no_answer: [], not_in_inventory: [] };
  const byIp = new Map(results.map(r => [r.ip, r]));
  for (const t of targets) {
    const r = byIp.get(t.ip);
    if (!r || ['unreachable', 'auth_failed'].includes(r.status) || !r.read) { out.no_answer.push({ ip: t.ip, label: t.label || null, status: r?.status || 'not_run' }); continue; }
    const ups = r.read.ups || {};
    const checks = [
      ['serial', t.serial, ups.serial],
      ['model', t.model, ups.sku || ups.model],
      ['firmware', t.firmware, ups.firmware],
    ];
    for (const [field, want, got] of checks) {
      if (!want || !got) continue;
      const a = String(want).replace(/\s+/g, '').toUpperCase(), b = String(got).replace(/\s+/g, '').toUpperCase();
      if (a !== b && !b.includes(a) && !a.includes(b)) out.mismatches.push({ ip: t.ip, label: t.label || null, field, inventory: want, card: got });
    }
  }
  const inv = new Set(targets.map(t => t.ip));
  for (const s of scanned) if (!inv.has(s.ip)) out.not_in_inventory.push({ ip: s.ip, ports: s.ports || [] });
  return out;
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const mdCell = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function summaryRows(results) {
  return results.map(r => ({
    ip: r.ip, site: r.site || '', label: r.label || '', status: r.status, reason: r.reason || '',
    nmc: [r.read?.family, r.read?.nmc?.model, r.read?.nmc?.app_version].filter(Boolean).join(' '),
    ups: [r.read?.ups?.sku || r.read?.ups?.model, r.read?.ups?.serial, r.read?.ups?.firmware].filter(Boolean).join(' / '),
    snmp: r.read ? `v1:${r.read.snmp_v1?.enabled ? 'on' : 'off'} v3:${r.read.snmp_v3?.enabled ? 'on' : r.read.snmp_v3?.supported === false ? 'n/a' : 'off'}` : '',
    changes: (r.changes || []).length, verify: r.verify ? `snmpv3:${r.verify.snmp?.ok ? 'pass' : r.verify.snmp ? 'fail' : '-'} trap:${r.verify.trap?.status || '-'}` : '',
    rolled_back: r.rolled_back ? 'yes' : '',
  }));
}

/** report-<ts>.md / .csv. Returns the paths. */
function writeReport(out, { command, ts = stamp(), results, inventory, redactor, flags = {} }) {
  ensureDir(out);
  const rows = summaryRows(results);
  const cols = ['ip', 'site', 'label', 'status', 'reason', 'nmc', 'ups', 'snmp', 'changes', 'verify', 'rolled_back'];
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
  const count = Object.fromEntries(STATUSES.map(s => [s, results.filter(r => r.status === s).length]));
  const md = [];
  md.push(`# cflex-onboard ${command} — ${ts}`, '');
  md.push(`- 대상: ${results.length}대 (옵션 ${flags.scan ? '2 스캔 후보' : '1 인벤토리'})`);
  md.push(`- 결과: ${STATUSES.map(s => `${s} ${count[s]}`).join(' · ')}`);
  if (flags.dryRun) md.push('- dry-run: 장비에 아무것도 쓰지 않았다');
  md.push('', '## 장비별 결과', '', `| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`);
  for (const r of rows) md.push(`| ${cols.map(c => mdCell(r[c])).join(' | ')} |`);
  const withDiff = results.filter(r => (r.diff || []).length);
  if (withDiff.length) {
    md.push('', '## 변경 전 → 후 (diff 요약)', '');
    for (const r of withDiff) {
      md.push(`### ${r.ip}${r.label ? ` (${r.label})` : ''} — ${r.status}`);
      for (const d of r.diff) md.push(`- ${d.field}: ${d.from} → ${d.to}`);
      if ((r.changes || []).length) md.push('', '```', ...r.changes, '```');
      md.push('');
    }
  }
  if (inventory) {
    md.push('', '## 인벤토리 대조', '');
    md.push(`- 불일치 ${inventory.mismatches.length} · 응답 없음 ${inventory.no_answer.length} · 인벤토리에 없음 ${inventory.not_in_inventory.length}`);
    for (const m of inventory.mismatches) md.push(`- 불일치 ${m.ip}${m.label ? ` (${m.label})` : ''} ${m.field}: 인벤토리 ${m.inventory} / 카드 ${m.card}`);
    for (const m of inventory.no_answer) md.push(`- 응답 없음 ${m.ip}${m.label ? ` (${m.label})` : ''}: ${m.status}`);
    for (const m of inventory.not_in_inventory) md.push(`- 인벤토리에 없음 ${m.ip} (ports ${m.ports.join(',')})`);
  }
  const recs = results.filter(r => (r.recommendations || []).length || (r.warnings || []).length);
  if (recs.length) {
    md.push('', '## 권고·경고', '');
    for (const r of recs) for (const x of [...(r.warnings || []), ...(r.recommendations || [])]) md.push(`- ${r.ip}: ${x}`);
  }
  md.push('', '_비밀값(자격증명·커뮤니티·키)은 이 리포트에 없다. 실장비 CLI 구문은 현장 확인 전(docs/onboard/NMC_CLI_COMMANDS.md)._', '');
  const mdPath = writePrivate(path.join(out, `report-${ts}.md`), redactor.redact(md.join('\n')));
  const csvPath = writePrivate(path.join(out, `report-${ts}.csv`), redactor.redact(csv));
  return { md: mdPath, csv: csvPath };
}

/** Terminal summary table. */
function table(results) {
  const rows = summaryRows(results);
  const cols = ['ip', 'label', 'status', 'reason', 'nmc', 'snmp', 'changes', 'verify'];
  const w = cols.map(c => Math.min(28, Math.max(c.length, ...rows.map(r => String(r[c]).length))));
  const fmt = (r) => cols.map((c, i) => String(r[c]).slice(0, w[i]).padEnd(w[i])).join('  ');
  return [fmt(Object.fromEntries(cols.map(c => [c, c]))), ...rows.map(fmt)].join('\n');
}

module.exports = { createAudit, compareInventory, writeReport, writePrivate, deviceDir, ensureDir, table, stamp, STATUSES };
