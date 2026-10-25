// control.js — read and write docs/control/{TASKS,STATUS,DECISIONS}.md
//
// WHY THE MARKDOWN STAYS THE SOURCE OF TRUTH. The obvious move is to put the
// control plane in SQLite and render the markdown as a view. That would be
// easier to parse and it would be wrong here: CLAUDE.md and AGENTS.md tell
// three agents to read and write these exact files, the manager reviews them as
// a git diff, and a human reads them. Replacing the store means rewriting the
// rules and losing the diff.
//
// So this module parses the markdown and writes it back, and the price is
// fragility. The price is paid with a round-trip test: parse → serialize must
// reproduce the file byte-for-byte for every file in the repository. A change
// to the format breaks the test instead of silently corrupting the board.
//
// Zero dependencies, same as packages/notify, so this runs on a locked-down
// host with no npm install.
const fs = require('node:fs');
const path = require('node:path');

const STATUSES = ['대기', '진행', '검토요청', '완료', '보류'];
const AGENTS = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** Resolve docs/control relative to the repository this file lives in. */
function controlDir(root) {
  return path.join(root || path.join(__dirname, '..', '..'), 'docs', 'control');
}

const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * Atomic write with a lock, because two agents reporting at once would
 * otherwise interleave and lose one of them.
 *
 * The lock is a directory: mkdir is atomic on every filesystem we care about,
 * where a lockfile+O_EXCL is not on NFS. A lock older than the timeout is
 * treated as abandoned — a crashed agent must not block the board forever.
 */
function withLock(dir, fn, { timeoutMs = 10_000, staleMs = 60_000 } = {}) {
  const lock = path.join(dir, '.control.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = Infinity; }
      if (age > staleMs) { try { fs.rmSync(lock, { recursive: true }); } catch {} continue; }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`control plane locked for ${Math.round(age / 1000)}s by another agent`);
      }
      // Busy-wait briefly. A real sleep needs async, and every caller here is
      // sync so that a tool call cannot half-apply.
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true }); } catch {} }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ─── TASKS.md ───────────────────────────────────────────────────────
// Sections are `## A. Claude Code — 내부 (WO-INT)` with a five-column table,
// plus a trailing `## C.` that is a bullet list, not a table.

// The id may carry a letter suffix — WO-INT-004b is a sub-task the manager
// registered against WO-INT-004. Without the suffix this pattern matched
// "WO-INT-004" out of it, the rest of the line shifted, and the row was
// dropped on the next write.
const ROW = /^\|\s*([^|]*?)\s*\|\s*(WO-[A-Z]+-\d+[a-z]?)\s*\|\s*([^|]*?)\s*\|\s*([\s\S]*?)\s*\|\s*([\s\S]*?)\s*\|\s*$/;

function parseTasks(text) {
  const lines = text.split('\n');
  const out = { preamble: [], sections: [], trailing: [] };
  let cur = null;
  let where = 'pre';

  for (const line of lines) {
    const h = /^## +([A-Z])\. +(.+)$/.exec(line);
    if (h) {
      const owner = /Claude Code/.test(h[2]) ? 'claude-code' : /Codex/.test(h[2]) ? 'codex' : null;
      const prefix = (/\((WO-[A-Z]+)\)/.exec(h[2]) || [])[1] || null;
      if (owner && prefix) {
        cur = { key: h[1], title: h[2], owner, prefix, head: [], rows: [], after: [] };
        out.sections.push(cur);
        where = 'section';
      } else {
        // `## C. 보류 / 결정 대기` and anything else — kept verbatim.
        cur = null; where = 'trail';
        out.trailing.push(line);
      }
      continue;
    }
    if (where === 'pre') { out.preamble.push(line); continue; }
    if (where === 'trail') { out.trailing.push(line); continue; }
    const m = ROW.exec(line);
    if (m) {
      cur.rows.push({
        priority: m[1], id: m[2], status: m[3], work: m[4], acceptance: m[5],
        section: cur.key, owner: cur.owner,
      });
    } else if (cur.rows.length) {
      cur.after.push(line);
    } else {
      cur.head.push(line);   // the header row and `|---|` separator
    }
  }
  return out;
}

function serializeTasks(t) {
  const parts = [...t.preamble];
  for (const s of t.sections) {
    parts.push(`## ${s.key}. ${s.title}`);
    parts.push(...s.head);
    for (const r of s.rows) {
      parts.push(`| ${r.priority} | ${r.id} | ${r.status} | ${r.work} | ${r.acceptance} |`);
    }
    parts.push(...s.after);
  }
  parts.push(...t.trailing);
  return parts.join('\n');
}

// ─── STATUS.md ──────────────────────────────────────────────────────
// Append-only per agent. CLAUDE.md is explicit: 추가(덮어쓰지 않음). So the
// only mutation offered is "append an entry to my own block", and a block
// belonging to another agent is never touched.

function parseStatus(text) {
  const lines = text.split('\n');
  const out = { preamble: [], blocks: [] };
  let cur = null;
  for (const line of lines) {
    const h = /^## +(.+?) *$/.exec(line);
    if (h) { cur = { name: h[1], lines: [] }; out.blocks.push(cur); continue; }
    if (!cur) out.preamble.push(line);
    else cur.lines.push(line);
  }
  return out;
}

function serializeStatus(s) {
  const parts = [...s.preamble];
  for (const b of s.blocks) { parts.push(`## ${b.name}`); parts.push(...b.lines); }
  return parts.join('\n');
}

// ─── DECISIONS.md ───────────────────────────────────────────────────

function parseDecisions(text) {
  const lines = text.split('\n');
  const out = { preamble: [], confirmedHead: null, confirmed: [], openHead: null, open: [] };
  let where = 'pre';
  let q = null;

  for (const line of lines) {
    if (/^## +확정된 결정/.test(line)) { out.confirmedHead = line; where = 'confirmed'; continue; }
    if (/^## +열린 질문/.test(line)) { out.openHead = line; where = 'open'; continue; }
    if (where === 'pre') { out.preamble.push(line); continue; }
    if (where === 'confirmed') {
      const d = /^- +(D-\d+) +([\s\S]*)$/.exec(line);
      if (d) out.confirmed.push({ id: d[1], text: d[2], raw: line });
      else out.confirmed.push({ id: null, text: null, raw: line });
      continue;
    }
    const h = /^### +(Q-\d{4}-\d{2}-\d{2}-\d+) +— +(.+?)(?: +\(([^)]+)\))? *$/.exec(line);
    if (h) { q = { id: h[1], title: h[2], owner: h[3] || null, body: [] }; out.open.push(q); continue; }
    if (q) q.body.push(line);
    else out.open.push({ id: null, raw: line });
  }
  return out;
}

function serializeDecisions(d) {
  const parts = [...d.preamble];
  if (d.confirmedHead !== null) { parts.push(d.confirmedHead); for (const c of d.confirmed) parts.push(c.raw); }
  if (d.openHead !== null) {
    parts.push(d.openHead);
    for (const q of d.open) {
      if (!q.id) { parts.push(q.raw); continue; }
      parts.push(`### ${q.id} — ${q.title}${q.owner ? ` (${q.owner})` : ''}`);
      parts.push(...q.body);
    }
  }
  return parts.join('\n');
}

/** The answer to an open question, or null — `A:` with nothing after it. */
function answerOf(q) {
  const i = q.body.findIndex(l => /^A: *$|^A: +\S/.test(l));
  if (i < 0) return null;
  const first = q.body[i].replace(/^A: */, '').trim();
  const rest = [];
  for (let j = i + 1; j < q.body.length; j++) {
    if (/^#{3} /.test(q.body[j])) break;
    rest.push(q.body[j]);
  }
  const all = [first, ...rest].join('\n').trim();
  return all || null;
}

// ─── the whole board ────────────────────────────────────────────────

function load(root) {
  const dir = controlDir(root);
  const files = {
    tasks: path.join(dir, 'TASKS.md'),
    status: path.join(dir, 'STATUS.md'),
    decisions: path.join(dir, 'DECISIONS.md'),
  };
  for (const [k, p] of Object.entries(files)) {
    if (!fs.existsSync(p)) throw new Error(`missing ${k}: ${p}`);
  }
  const raw = {
    tasks: read(files.tasks), status: read(files.status), decisions: read(files.decisions),
  };
  const board = {
    dir, files, raw,
    tasks: parseTasks(raw.tasks),
    status: parseStatus(raw.status),
    decisions: parseDecisions(raw.decisions),
  };

  // Fidelity, checked here and not only in save(). save() used to verify that
  // its own output round-tripped, and a STABLE loss passes that: a row the
  // parser drops serialises consistently for ever, so the check said "fine"
  // while the write deleted a task. WO-INT-004b is exactly how that was found.
  //
  // So: if parse → serialize cannot reproduce the file byte for byte, the
  // parser does not understand it, and nothing may be read or written through
  // it. Loud, with the first differing line, beats a quietly shortened board.
  const ser = { tasks: serializeTasks, status: serializeStatus, decisions: serializeDecisions };
  for (const k of ['tasks', 'status', 'decisions']) {
    const back = ser[k](board[k]);
    if (back === raw[k]) continue;
    const a = raw[k].split('\n');
    const b = back.split('\n');
    let i = 0;
    while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
    throw new Error(
      `${path.basename(board.files[k])} is not understood by the parser `
      + `(line ${i + 1}; ${a.length} lines in, ${b.length} out). `
      + `Refusing to operate on it — fix the parser or the file, do not write.\n`
      + `  file: ${JSON.stringify(a[i] ?? null)}\n`
      + `  ours: ${JSON.stringify(b[i] ?? null)}`,
    );
  }
  return board;
}

/**
 * Write back only what changed, under the lock, and refuse to write a file
 * that does not round-trip. A parser bug must not be able to flatten the board.
 */
function save(board, which) {
  const ser = { tasks: serializeTasks, status: serializeStatus, decisions: serializeDecisions };
  return withLock(board.dir, () => {
    const written = [];
    for (const k of which) {
      const text = ser[k](board[k]);
      const reparsed = { tasks: parseTasks, status: parseStatus, decisions: parseDecisions }[k](text);
      // Defence in depth. The load-time fidelity check is the one that
      // catches a lossy parse; this catches a serialiser that emits something
      // it cannot itself read back.
      if (ser[k](reparsed) !== text) {
        throw new Error(`refusing to write ${k}: output does not re-parse (serialiser bug)`);
      }
      if (text !== board.raw[k]) { writeAtomic(board.files[k], text); written.push(k); }
    }
    return written;
  });
}

const findTask = (board, id) => {
  for (const s of board.tasks.sections) {
    const r = s.rows.find(x => x.id === id);
    if (r) return r;
  }
  return null;
};

const todayISO = (now = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
};

/** Next free Q id for today, so two agents asking on one day do not collide. */
function nextQuestionId(board, day = todayISO()) {
  const used = board.decisions.open
    .filter(q => q.id && q.id.startsWith(`Q-${day}-`))
    .map(q => parseInt(q.id.slice(-2), 10))
    .filter(Number.isFinite);
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return `Q-${day}-${String(n).padStart(2, '0')}`;
}

module.exports = {
  STATUSES, AGENTS,
  load, save, findTask, answerOf, nextQuestionId, todayISO, controlDir,
  parseTasks, serializeTasks, parseStatus, serializeStatus, parseDecisions, serializeDecisions,
  withLock,
};
