// node tools/control-mcp/test/control.test.js
//
// What this file exists to prevent: a parser that silently reformats the board.
// The markdown is the source of truth for three agents and the manager reads it
// as a git diff, so a write that drops a row, reflows a cell, or clobbers
// another agent's STATUS block is worse than a crash — nobody would notice.
//
// Every case runs against a COPY of the real docs/control, never the originals.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..');
const SRC = path.join(REPO, 'docs', 'control');

let pass = 0;
const t = (name, fn) => {
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-control-'));
    fs.mkdirSync(path.join(tmp, 'docs', 'control'), { recursive: true });
    for (const f of ['TASKS.md', 'STATUS.md', 'DECISIONS.md', 'INTERFACE.md']) {
      const from = path.join(SRC, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(tmp, 'docs', 'control', f));
    }
    fn(tmp);
    pass++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
};

/** A server instance speaking for one agent, pointed at the temp copy. */
function serverAs(agent, root) {
  const before = { CFLEX_AGENT: process.env.CFLEX_AGENT, CFLEX_ROOT: process.env.CFLEX_ROOT };
  process.env.CFLEX_AGENT = agent;
  process.env.CFLEX_ROOT = root;
  for (const m of ['../server', '../control']) delete require.cache[require.resolve(m)];
  const s = require('../server');
  const restore = () => {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const m of ['../server', '../control']) delete require.cache[require.resolve(m)];
  };
  const call = (name, args = {}) => {
    const fn = s.HANDLERS[name];
    if (!fn) throw new Error(`no handler ${name}`);
    if (s.MANAGER_TOOLS.some(x => x.name === name) && !s.IS_MANAGER) {
      return { error: `${name} is manager-only` };
    }
    return fn(args);
  };
  return { call, srv: s, restore };
}
const read = (root, f) => fs.readFileSync(path.join(root, 'docs', 'control', f), 'utf8');

// ── round-trip, the load-bearing assertion ──────────────────────────

t('parse → serialize reproduces all three files byte for byte', (root) => {
  const C = require('../control');
  const b = C.load(root);
  assert.strictEqual(C.serializeTasks(b.tasks), b.raw.tasks, 'TASKS.md drifted');
  assert.strictEqual(C.serializeStatus(b.status), b.raw.status, 'STATUS.md drifted');
  assert.strictEqual(C.serializeDecisions(b.decisions), b.raw.decisions, 'DECISIONS.md drifted');
  delete require.cache[require.resolve('../control')];
});

t('a no-op save writes nothing — an idle session leaves no diff', (root) => {
  const C = require('../control');
  const b = C.load(root);
  assert.deepStrictEqual(C.save(b, ['tasks', 'status', 'decisions']), []);
  delete require.cache[require.resolve('../control')];
});

t('the real board parses into the shape the handlers assume', (root) => {
  const C = require('../control');
  const b = C.load(root);
  assert.strictEqual(b.tasks.sections.length, 2, 'expected sections A and B');
  const [a, bb] = b.tasks.sections;
  assert.strictEqual(a.owner, 'claude-code');
  assert.strictEqual(a.prefix, 'WO-INT');
  assert.strictEqual(bb.owner, 'codex');
  assert.strictEqual(bb.prefix, 'WO-PTL');
  assert.ok(a.rows.length >= 8, `expected ≥8 INT rows, got ${a.rows.length}`);
  for (const r of [...a.rows, ...bb.rows]) {
    assert.match(r.id, /^WO-(INT|PTL)-\d{3}[a-z]?$/);   // 004b is a real sub-task
    assert.ok(C.STATUSES.includes(r.status), `bad status "${r.status}" on ${r.id}`);
    assert.ok(r.acceptance.trim(), `${r.id} has no acceptance criteria`);
  }
  for (const n of ['Claude Code 블록', 'Codex 블록']) {
    assert.ok(b.status.blocks.some(x => x.name === n), `missing STATUS block ${n}`);
  }
  delete require.cache[require.resolve('../control')];
});

// ── the two defects this file failed to catch the first time ────────

t('an id with a letter suffix survives a write — WO-INT-004b', (root) => {
  // The first ROW pattern matched "WO-INT-004" out of "WO-INT-004b", the rest
  // of the line shifted, and the row was dropped. 19 rows in, 18 out.
  const C = require('../control');
  const b = C.load(root);
  const all = b.tasks.sections.flatMap(s => s.rows).map(r => r.id);
  const suffixed = (b.raw.tasks.match(/WO-[A-Z]+-\d+[a-z]/g) || [])
    .filter((v, i, a) => a.indexOf(v) === i);
  for (const id of suffixed) assert.ok(all.includes(id), `${id} was dropped by the parser`);
  // and a synthetic one, so the case stays covered when the board moves on
  const sec = b.tasks.sections.find(s => s.owner === 'claude-code');
  sec.rows.push({ priority: '9z', id: 'WO-INT-099z', status: '대기', work: 'x', acceptance: 'y', section: sec.key, owner: 'claude-code' });
  C.save(b, ['tasks']);
  delete require.cache[require.resolve('../control')];
  const C2 = require('../control');
  assert.ok(C2.load(root).tasks.sections.flatMap(s => s.rows).some(r => r.id === 'WO-INT-099z'),
    'a letter-suffixed id did not survive save → load');
  delete require.cache[require.resolve('../control')];
});

t('load refuses a file the parser cannot reproduce', (root) => {
  // The real hole: save() verified that its OWN output round-tripped, which a
  // stable loss passes — a dropped row serialises consistently for ever, so
  // the check said "fine" while the write deleted a task. Fidelity has to be
  // checked against what was read, at load.
  //
  // Finding an input that genuinely breaks fidelity took two tries. A row with
  // six columns does NOT: the lazy groups absorb the extra pipes into the last
  // cell and reproduce the line exactly. What does break is a non-row line
  // BETWEEN rows — it goes to `after`, which serialises after every row, so
  // the following row moves above it and the file comes back reordered.
  const f = path.join(root, 'docs', 'control', 'TASKS.md');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const rows = lines.map((l, i) => [l, i]).filter(([l]) => /^\| *[0-9]/.test(l));
  assert.ok(rows.length >= 2, 'need two rows to interleave');
  lines.splice(rows[1][1], 0, '<!-- 관리자 메모 -->');
  fs.writeFileSync(f, lines.join('\n'));

  const C = require('../control');
  assert.throws(() => C.load(root), /not understood by the parser/);
  // and the message points at the line, so it is fixable
  try { C.load(root); } catch (e) { assert.match(e.message, /line \d+; \d+ lines in, \d+ out/); }
  delete require.cache[require.resolve('../control')];
});

// ── ownership ───────────────────────────────────────────────────────

t('an agent cannot claim another agent\'s task', (root) => {
  const { call, restore } = serverAs('claude-code', root);
  const r = call('control_claim', { id: 'WO-PTL-002' });
  restore();
  assert.match(String(r.error), /belongs to codex/);
});

t('claiming sets 대기 → 진행 and returns the acceptance criteria', (root) => {
  const C = require('../control');
  const waiting = C.load(root).tasks.sections
    .find(x => x.owner === 'claude-code').rows.find(x => x.status === '대기');
  delete require.cache[require.resolve('../control')];
  assert.ok(waiting, 'no 대기 task on the board to claim');

  const { call, restore } = serverAs('claude-code', root);
  const r = call('control_claim', { id: waiting.id });
  restore();
  assert.strictEqual(r.was, '대기');
  assert.strictEqual(r.now, '진행');
  assert.ok(r.acceptance.trim(), 'acceptance not returned');
  assert.ok(new RegExp(`\\| *${waiting.id} *\\| *진행 *\\|`).test(read(root, 'TASKS.md')));
});

t('claiming out of priority order warns instead of staying silent', (root) => {
  const { call, restore } = serverAs('claude-code', root);
  const r = call('control_claim', { id: 'WO-INT-008' });
  restore();
  assert.ok(r.warn_higher_priority_waiting.length > 0, 'no warning for jumping the queue');
});

t('a 보류 task is refused', (root) => {
  const C = require('../control');
  const b = C.load(root);
  C.findTask(b, 'WO-INT-006').status = '보류';
  C.save(b, ['tasks']);
  delete require.cache[require.resolve('../control')];
  const { call, restore } = serverAs('claude-code', root);
  const r = call('control_claim', { id: 'WO-INT-006' });
  restore();
  assert.match(String(r.error), /보류/);
});

t('manager-only tools are refused to an agent', (root) => {
  const { call, restore } = serverAs('claude-code', root);
  const a = call('control_assign', { owner: 'codex', work: 'x', acceptance: 'y' });
  const b = call('control_answer', { id: 'Q-2026-10-25-01', answer: 'A' });
  restore();
  assert.match(String(a.error), /manager-only/);
  assert.match(String(b.error), /manager-only/);
});

t('a report does not reopen a 완료 task', (root) => {
  // Found by doing it. With no WO assigned for a piece of directed work, a
  // report filed against the nearest id moved WO-INT-002 from 완료 back to
  // 진행, erasing a manager approval and a merged PR.
  const C = require('../control');
  const done = C.load(root).tasks.sections
    .find(x => x.owner === 'claude-code').rows.find(x => x.status === '완료');
  delete require.cache[require.resolve('../control')];
  assert.ok(done, 'no 완료 task on the board to try this against');

  const { call, restore } = serverAs('claude-code', root);
  const r = call('control_report', { entries: [{ id: done.id, status: '진행', progress: '10%' }] });
  restore();

  assert.deepStrictEqual(r.tasks_updated, [`${done.id}: 완료 유지`]);
  assert.ok(new RegExp(`\\| *${done.id} *\\| *완료 *\\|`).test(read(root, 'TASKS.md')),
    'a 완료 task was reopened by an agent report');
  assert.match(read(root, 'STATUS.md'), /완료 상태다 — 상태를 바꾸지 않았다/);
});

t('the manager may reopen a 완료 task', (root) => {
  const C = require('../control');
  const done = C.load(root).tasks.sections
    .find(x => x.owner === 'claude-code').rows.find(x => x.status === '완료');
  delete require.cache[require.resolve('../control')];

  const m = serverAs('manager', root);
  const r = m.call('control_set_status', { id: done.id, status: '진행', note: '재개' });
  m.restore();
  assert.strictEqual(r.now.status, '진행');
});

// ── STATUS is append-only, and per-agent ────────────────────────────

t('a report appends to my block and leaves the other agent\'s untouched', (root) => {
  const before = read(root, 'STATUS.md');
  const codexBlock = before.slice(before.indexOf('## Codex 블록'));

  // A live row, picked from the board: WO-INT-002 is 완료 now and the
  // reopen guard correctly refuses it, which used to fail this test.
  const C = require('../control');
  const live = C.load(root).tasks.sections
    .find(x => x.owner === 'claude-code').rows.find(x => ['대기', '진행'].includes(x.status));
  delete require.cache[require.resolve('../control')];
  assert.ok(live, 'no live task on the board');

  const { call, restore } = serverAs('claude-code', root);
  const r = call('control_report', {
    entries: [{ id: live.id, status: '진행', progress: '40%', branch: 'wo/INT-002-x', tests: '12/12' }],
    next: 'schemas 생성',
  });
  restore();

  const after = read(root, 'STATUS.md');
  assert.strictEqual(r.appended_to, 'Claude Code 블록');
  assert.ok(after.includes(before.slice(0, before.indexOf('## Codex 블록'))
    .replace(/\n+$/, '')), 'existing Claude Code entries were altered');
  assert.ok(after.includes(codexBlock), 'Codex block changed');
  assert.ok(after.includes(live.id), 'entry not written');
  assert.ok(after.includes('진행 40%'));
  assert.ok(after.includes('다음 세션 계획: schemas 생성'));
  // and the task row moved with it
  assert.ok(new RegExp(`\\| *${live.id} *\\| *진행 *\\|`).test(read(root, 'TASKS.md')));
});

t('an agent reporting 완료 is recorded as 검토요청 — the manager closes it', (root) => {
  const C = require('../control');
  const live = C.load(root).tasks.sections
    .find(x => x.owner === 'claude-code').rows.find(x => ['대기', '진행'].includes(x.status));
  delete require.cache[require.resolve('../control')];

  const { call, restore } = serverAs('claude-code', root);
  const r = call('control_report', { entries: [{ id: live.id, status: '완료', commit: 'b087445' }] });
  restore();
  assert.deepStrictEqual(r.tasks_updated, [`${live.id}→검토요청`]);
  assert.ok(new RegExp(`\\| *${live.id} *\\| *검토요청 *\\|`).test(read(root, 'TASKS.md')));
  assert.match(read(root, 'STATUS.md'), /완료 처리는 관리자가 한다/);
});

t('codex reports into the Codex block only', (root) => {
  // Asserted structurally, not by searching for the WO id: the Claude Code
  // block legitimately *mentions* WO-PTL-001 in prose (its next-session plan
  // waits on the portal mock), and a first draft of this test read that
  // mention as a misroute. The invariant is that the other agent's block comes
  // back byte-identical.
  const before = read(root, 'STATUS.md');
  const ccBefore = before.slice(before.indexOf('## Claude Code 블록'), before.indexOf('## Codex 블록'));

  const { call, restore } = serverAs('codex', root);
  const r = call('control_report', { entries: [{ id: 'WO-PTL-001', status: '진행', progress: '20%' }] });
  restore();

  const after = read(root, 'STATUS.md');
  const ccAfter = after.slice(after.indexOf('## Claude Code 블록'), after.indexOf('## Codex 블록'));
  assert.strictEqual(r.appended_to, 'Codex 블록');
  assert.strictEqual(ccAfter, ccBefore, 'the Claude Code block was modified by a Codex report');
  assert.ok(after.slice(after.indexOf('## Codex 블록')).includes('진행 20%'), 'entry not written');
});

t('two reports in a row both survive — append, never overwrite', (root) => {
  for (const p of ['30%', '70%']) {
    const { call, restore } = serverAs('claude-code', root);
    call('control_report', { entries: [{ id: 'WO-INT-002', status: '진행', progress: p }] });
    restore();
  }
  const s = read(root, 'STATUS.md');
  assert.ok(s.includes('진행 30%') && s.includes('진행 70%'), 'a report was lost');
});

// ── questions ───────────────────────────────────────────────────────

t('asking allocates a non-colliding id and the file still round-trips', (root) => {
  const a = serverAs('claude-code', root);
  const q1 = a.call('control_ask', { title: '프록시 주소', body: '01 §6-3 미확정.\n\n- (A) …\n- (B) …' });
  a.restore();
  const b = serverAs('codex', root);
  const q2 = b.call('control_ask', { title: 'mTLS CA 위치', body: '…' });
  b.restore();

  assert.notStrictEqual(q1.id, q2.id, 'two agents got the same Q id');
  assert.match(q1.id, /^Q-\d{4}-\d{2}-\d{2}-\d{2}$/);
  assert.strictEqual(q1.owner, 'Claude Code');
  assert.strictEqual(q2.owner, 'Codex');

  const C = require('../control');
  const board = C.load(root);
  assert.strictEqual(C.serializeDecisions(board.decisions), board.raw.decisions, 'DECISIONS.md no longer round-trips');
  const q = board.decisions.open.find(x => x.id === q1.id);
  assert.ok(q, 'question not found after write');
  assert.strictEqual(C.answerOf(q), null, 'a fresh question should have no answer');
  delete require.cache[require.resolve('../control')];
});

t('the manager answers, and may promote it to a D decision', (root) => {
  const m = serverAs('manager', root);
  const r = m.call('control_answer', {
    id: 'Q-2026-10-25-01', answer: '(A) feat/twin-rack-elevation 를 main 으로 머지한다.',
    promote_as: 'WO 브랜치 base 는 main. 2026-10-25 에 피처 브랜치를 머지해 정상화.',
  });
  m.restore();
  assert.strictEqual(r.answered, true);
  assert.match(r.promoted, /^D-\d{2}$/);

  const a = serverAs('claude-code', root);
  const seen = a.call('control_answers', {});
  a.restore();
  const q = seen.questions.find(x => x.id === 'Q-2026-10-25-01');
  assert.match(q.answer, /feat\/twin-rack-elevation/);

  const d = read(root, 'DECISIONS.md');
  assert.ok(d.includes(`- ${r.promoted} WO 브랜치 base 는 main`), 'decision not added to the confirmed list');
  assert.ok(d.indexOf(`- ${r.promoted}`) < d.indexOf('## 열린 질문'), 'decision landed outside the confirmed section');
});

t('answers_only-mine filters by owner', (root) => {
  const a = serverAs('codex', root);
  const r = a.call('control_answers', { mine_only: true });
  a.restore();
  assert.ok(r.questions.every(q => !q.owner || q.owner === 'Codex'),
    `codex saw someone else's questions: ${r.questions.map(q => q.owner).join(',')}`);
});

// ── the direct Probe ↔ Portal channel ──────────────────────────────
// DECISIONS is the manager's queue; this is the one file two agents both
// write. So the assertions are about not trampling each other, and about the
// thing that makes it a channel rather than a noticeboard: one side writing a
// conclusion is not an agreement.

t('INTERFACE.md round-trips, and a sentence in bold is not a reply', (root) => {
  const C = require('../control');
  const b = C.load(root);
  assert.ok(b.hasInterface, 'INTERFACE.md should be present');
  assert.strictEqual(C.serializeInterface(b.interface), b.raw.interface, 'INTERFACE.md drifted');

  // The first repliedBy matched any line opening with bold text, so a sentence
  // like "**Probe 쪽에서는 증명할 수 없다.** …" read as a reply from an agent
  // of that name — and a one-sided thread looked settleable.
  for (const th of b.interface.open.filter(x => x.id)) {
    for (const name of C.repliedBy(th)) {
      assert.ok(['Claude Code', 'Codex', '관리자'].includes(name), `bogus replier "${name}" in ${th.id}`);
    }
  }
  delete require.cache[require.resolve('../control')];
});

t('a thread only one side answered cannot be settled', (root) => {
  const a = serverAs('claude-code', root);
  const threads = a.call('interface_threads', {});
  const mine = threads.open.find(x => x.replied_by.length === 1);
  assert.ok(mine, 'expected a thread with exactly one reply');
  const r = a.call('interface_settle', { id: mine.id, resolution: '내가 정했다' });
  a.restore();
  assert.match(String(r.error), /한쪽만 답한 스레드/);
  assert.ok(!read(root, 'INTERFACE.md').includes('내가 정했다'), 'a refused settle must not land');
});

t('the peer replies, then either side may settle', (root) => {
  const a = serverAs('claude-code', root);
  const id = a.call('interface_threads', {}).open[0].id;
  a.restore();

  const c = serverAs('codex', root);
  const rep = c.call('interface_reply', { id, body: '(A) 로 갑니다. 노드 3개 등록 가능합니다.' });
  assert.deepStrictEqual(rep.replied_by.sort(), ['Claude Code', 'Codex']);
  assert.strictEqual(rep.both_answered, true);
  const set = c.call('interface_settle', { id, resolution: '(A) 사이트별 노드 분리', commit: 'abc1234' });
  c.restore();

  assert.strictEqual(set.settled, true);
  const txt = read(root, 'INTERFACE.md');
  assert.match(txt, new RegExp(`- ${id} .* → \\(A\\) 사이트별 노드 분리 \\(abc1234\\)`));
  assert.ok(txt.indexOf(`- ${id}`) < txt.indexOf('## 열린 스레드'), '합의가 열린 스레드 밖에 놓였다');
  assert.ok(!txt.includes(`### ${id} —`), 'settled thread left open');

  const C = require('../control');
  const b = C.load(root);
  assert.strictEqual(C.serializeInterface(b.interface), b.raw.interface, 'settle broke the round trip');
  delete require.cache[require.resolve('../control')];
});

t('a reply appends and never rewrites the other side', (root) => {
  const before = read(root, 'INTERFACE.md');
  const c = serverAs('codex', root);
  const id = c.call('interface_threads', {}).open[0].id;
  c.call('interface_reply', { id, body: '첫 답' });
  c.call('interface_reply', { id, body: '두번째 답' });
  c.restore();
  const after = read(root, 'INTERFACE.md');
  assert.ok(after.includes('첫 답') && after.includes('두번째 답'), 'a reply was lost');
  // Everything that was there is still there, verbatim.
  for (const line of before.split('\n')) {
    if (line.trim()) assert.ok(after.includes(line), `existing line dropped: ${line.slice(0, 50)}`);
  }
});

t('asking allocates an id and addresses the peer', (root) => {
  const a = serverAs('claude-code', root);
  const q = a.call('interface_ask', { title: '멱등키 보존 기간', body: '24시간 맞나요?\n\n- (A) …' });
  a.restore();
  assert.match(q.id, /^I-\d{4}-\d{2}-\d{2}-\d{2}$/);
  assert.strictEqual(q.to, 'codex');

  const c = serverAs('codex', root);
  const seen = c.call('interface_threads', {});
  c.restore();
  const th = seen.open.find(x => x.id === q.id);
  assert.strictEqual(th.ask, 'Claude Code → Codex');
  assert.strictEqual(th.awaiting_me, true, 'codex should see it as its turn');
  assert.ok(seen.mine_to_answer.includes(q.id));
});

t('the manager may close a thread the two have not agreed on', (root) => {
  // An intervention, and it is the manager's to make — but an agent cannot.
  const m = serverAs('manager', root);
  const id = m.call('interface_threads', {}).open[0].id;
  const r = m.call('interface_settle', { id, resolution: '관리자 판단으로 (B)' });
  m.restore();
  assert.strictEqual(r.settled, true);
});

// ── manager writes ──────────────────────────────────────────────────

t('assigning allocates the next id in the right section', (root) => {
  const m = serverAs('manager', root);
  const r = m.call('control_assign', {
    owner: 'claude-code', work: '**시뮬레이터 장비 4대 제거**', acceptance: '운영 DB에 sim 장비 0건',
  });
  m.restore();
  // Derived, not hard-coded — the manager keeps adding rows.
  assert.match(r.id, /^WO-INT-\d{3}$/);
  const tasks = read(root, 'TASKS.md');
  const secA = tasks.slice(tasks.indexOf('## A.'), tasks.indexOf('## B.'));
  assert.ok(secA.includes(r.id), 'new row went into the wrong section');
  const secB = tasks.slice(tasks.indexOf('## B.'));
  assert.ok(!secB.includes(r.id), 'new row leaked into the Codex section');
});

t('set_status closes a task and can log the review', (root) => {
  const m = serverAs('manager', root);
  const r = m.call('control_set_status', { id: 'WO-INT-001', status: '완료', note: 'WO-INT-001 검토 완료, 머지.' });
  m.restore();
  assert.strictEqual(r.now.status, '완료');
  assert.match(read(root, 'TASKS.md'), /\| *WO-INT-001 *\| *완료 *\|/);
  assert.match(read(root, 'STATUS.md'), /관리자 검토 로그[\s\S]*WO-INT-001 검토 완료/);
});

t('an invalid status is refused', (root) => {
  const m = serverAs('manager', root);
  const r = m.call('control_set_status', { id: 'WO-INT-001', status: 'done' });
  m.restore();
  assert.match(String(r.error), /status must be one of/);
});

// ── board read ──────────────────────────────────────────────────────

t('board gives an agent its queue in priority order', (root) => {
  const a = serverAs('claude-code', root);
  const r = a.call('control_board', {});
  a.restore();
  assert.strictEqual(r.agent, 'claude-code');
  assert.ok(r.tasks.every(x => x.owner === 'claude-code'), 'board leaked the other agent\'s tasks');
  // Not a hard-coded id: the board advances and WO-INT-001 is 완료 now.
  // The invariant is that the queue is ordered and holds only live work.
  const live = r.tasks.filter(x => ['대기', '진행'].includes(x.status));
  assert.deepStrictEqual(r.mine_actionable, live
    .slice().sort((a, b) => (parseInt(a.priority, 10) || 99) - (parseInt(b.priority, 10) || 99))
    .map(x => x.id), 'queue is not in priority order');
  assert.ok(!r.mine_actionable.some(id => r.tasks.find(x => x.id === id)?.status === '완료'),
    'a 완료 task is still in the queue');
  assert.ok(r.decisions_confirmed.some(d => d.startsWith('D-05')), 'confirmed decisions missing');
  assert.ok(r.held.some(h => /WireGuard/.test(h)), 'the held list was not read');
});

// ── the lock ────────────────────────────────────────────────────────

t('a stale lock does not block the board forever', (root) => {
  const C = require('../control');
  const dir = path.join(root, 'docs', 'control');
  fs.mkdirSync(path.join(dir, '.control.lock'));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(path.join(dir, '.control.lock'), old, old);
  let ran = false;
  C.withLock(dir, () => { ran = true; }, { timeoutMs: 500, staleMs: 60_000 });
  assert.ok(ran, 'a stale lock was treated as live');
  assert.ok(!fs.existsSync(path.join(dir, '.control.lock')), 'lock not released');
  delete require.cache[require.resolve('../control')];
});

t('a live lock makes the next writer fail loudly, not corrupt', (root) => {
  const C = require('../control');
  const dir = path.join(root, 'docs', 'control');
  fs.mkdirSync(path.join(dir, '.control.lock'));
  assert.throws(
    () => C.withLock(dir, () => {}, { timeoutMs: 200, staleMs: 60_000 }),
    /locked/,
  );
  fs.rmSync(path.join(dir, '.control.lock'), { recursive: true });
  delete require.cache[require.resolve('../control')];
});

// ── the MCP surface ─────────────────────────────────────────────────

t('tools/list exposes manager tools only to the manager', (root) => {
  const a = serverAs('claude-code', root);
  const agentTools = a.srv.allTools().map(x => x.name);
  a.restore();
  const m = serverAs('manager', root);
  const mgrTools = m.srv.allTools().map(x => x.name);
  m.restore();

  assert.ok(!agentTools.includes('control_assign'), 'agent can see control_assign');
  assert.ok(mgrTools.includes('control_assign'));
  for (const n of ['control_board', 'control_claim', 'control_report', 'control_ask', 'control_answers']) {
    assert.ok(agentTools.includes(n), `agent is missing ${n}`);
  }
});

t('every tool schema is well-formed', (root) => {
  const a = serverAs('claude-code', root);
  const tools = [...a.srv.TOOLS, ...a.srv.MANAGER_TOOLS];
  for (const tool of tools) {
    // Two families: control_* is the manager's board, interface_* is the
    // direct Probe ↔ Portal channel. Nothing else.
    assert.match(tool.name, /^(control|interface)_[a-z_]+$/, `bad name ${tool.name}`);
    assert.ok(tool.description && tool.description.length > 20, `${tool.name}: thin description`);
    assert.strictEqual(tool.inputSchema.type, 'object', `${tool.name}: schema not an object`);
    for (const req of tool.inputSchema.required || []) {
      assert.ok(tool.inputSchema.properties[req], `${tool.name}: required "${req}" is not a property`);
    }
    assert.ok(a.srv.HANDLERS[tool.name], `${tool.name}: declared but no handler`);
  }
  assert.strictEqual(Object.keys(a.srv.HANDLERS).length, tools.length, 'handler/tool count mismatch');
  a.restore();
});

t('initialize and tools/list answer over JSON-RPC', (root) => {
  const a = serverAs('claude-code', root);
  const sent = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { sent.push(s); return true; };
  try {
    a.srv.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    a.srv.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    a.srv.dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'control_board', arguments: {} } });
  } finally {
    process.stdout.write = realWrite;
    a.restore();
  }
  const msgs = sent.map(s => JSON.parse(s));
  assert.strictEqual(msgs[0].result.protocolVersion, '2025-06-18', 'did not echo the client protocol version');
  assert.ok(msgs[0].result.instructions.includes('control_board'));
  assert.ok(msgs[1].result.tools.length >= 6);
  assert.ok(!msgs[2].result.isError, 'control_board errored over RPC');
  assert.ok(JSON.parse(msgs[2].result.content[0].text).mine_actionable.length > 0);
});

t('an unknown tool is an error, not a crash', (root) => {
  const a = serverAs('claude-code', root);
  const sent = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { sent.push(s); return true; };
  try {
    a.srv.dispatch({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'control_nope' } });
    a.srv.dispatch({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'control_assign', arguments: {} } });
  } finally { process.stdout.write = realWrite; a.restore(); }
  const msgs = sent.map(s => JSON.parse(s));
  assert.strictEqual(msgs[0].error.code, -32601);
  assert.match(msgs[1].error.message, /manager-only/);
});

// ── no dependencies, and no reach outside the control plane ─────────

t('zero runtime dependencies, no network, no git', (root) => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !/^\s*(\/\/|#)/.test(l)).join('\n');
  for (const f of ['control.js', 'server.js']) {
    const src = strip(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
    for (const r of reqs) {
      assert.ok(r.startsWith('node:') || r.startsWith('./'), `${f} requires "${r}" — must be node: or local`);
    }
    for (const bad of [/\bfetch\s*\(/, /\bhttps?\.(get|request)\b/, /child_process/, /execSync/]) {
      assert.ok(!bad.test(src), `${f} reaches outside the control plane: ${bad}`);
    }
  }
  const pkg = path.join(__dirname, '..', 'package.json');
  if (fs.existsSync(pkg)) {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(pkg, 'utf8')).dependencies || {}, {});
  }
});

console.log(`${pass} passed${process.exitCode ? ' — FAILURES ABOVE' : ''}`);
