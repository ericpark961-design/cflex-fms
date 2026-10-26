#!/usr/bin/env node
// server.js — the C-Flex control plane as an MCP server (stdio).
//
// WHY. The board lives in docs/control/{TASKS,STATUS,DECISIONS}.md and three
// agents share it: Cowork Claude as manager, Claude Code on the internal
// probe, Codex on the portal. With files alone, every agent has to remember to
// read them, hand-format a STATUS entry, and not clobber another agent's block
// — and a concurrent write silently loses one report.
//
// This exposes the board as tools instead. The files stay the source of truth
// (see control.js for why), so the manager still reviews a git diff and a human
// still reads markdown. What changes is that the format is enforced, writes are
// locked, and an agent cannot touch another agent's block.
//
// Raw JSON-RPC over stdio, no SDK, zero dependencies — same rule as
// packages/notify, so it runs on a host with no npm install.
//
//   claude mcp add cflex-control -- node /Users/macstudio/work/cflex-fms/tools/control-mcp/server.js
//
// Env:
//   CFLEX_ROOT   repository root (default: two levels up from this file)
//   CFLEX_AGENT  who this server instance speaks for — claude-code | codex |
//                manager. Write tools refuse to act as anyone else.
const C = require('./control');

const ROOT = process.env.CFLEX_ROOT || undefined;
const AGENT = (process.env.CFLEX_AGENT || 'claude-code').trim();
const IS_MANAGER = AGENT === 'manager';
const BLOCK = { 'claude-code': 'Claude Code 블록', codex: 'Codex 블록', manager: '관리자 검토 로그' }[AGENT];

if (!BLOCK) {
  process.stderr.write(`CFLEX_AGENT must be claude-code | codex | manager (got "${AGENT}")\n`);
  process.exit(2);
}

// ─── tools ──────────────────────────────────────────────────────────

const S = (desc, props, required = []) => ({ type: 'object', description: desc, properties: props, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

const TOOLS = [
  {
    name: 'control_board',
    description: '작업지시판 전체를 읽는다. 세션 시작 시 가장 먼저 호출한다. 내게 배정된 대기/진행 작업, 열린 질문, 확정된 결정을 한 번에 돌려준다.',
    inputSchema: S('', {
      owner: str('claude-code | codex | all (기본: 이 서버의 CFLEX_AGENT)'),
      status: str('대기 | 진행 | 검토요청 | 완료 | 보류 로 필터'),
    }),
  },
  {
    name: 'control_task',
    description: '작업지시 하나를 전문으로 읽는다 — 작업 내용과 완료 기준(Acceptance) 전체.',
    inputSchema: S('', { id: str('예: WO-INT-002') }, ['id']),
  },
  {
    name: 'control_claim',
    description: '작업지시를 집는다 (대기 → 진행). 내 소유 섹션의 지시만 집을 수 있고, 이미 진행 중인 다른 지시가 있으면 경고한다.',
    inputSchema: S('', { id: str('예: WO-INT-002') }, ['id']),
  },
  {
    name: 'control_report',
    description: 'STATUS.md의 내 블록에 보고를 추가한다 (덮어쓰지 않음). 세션 종료 시 반드시 호출. 완료 기준을 전부 충족했을 때만 status를 검토요청으로 올린다 — 완료 처리는 관리자가 한다.',
    inputSchema: S('', {
      entries: {
        type: 'array',
        description: '작업별 보고',
        items: S('', {
          id: str('WO 번호'),
          status: str('검토요청 | 진행 | 보류'),
          progress: str('진행일 때 "60%" 등'),
          branch: str('브랜치명'),
          commit: str('커밋 해시'),
          tests: str('테스트 명령과 결과. 지시서에 테스트가 명시돼 있으면 필수'),
          acceptance: str('충족한 완료 기준을 항목별로'),
          note: str('비고'),
          blocker: str('블로커. 없으면 생략'),
        }, ['id', 'status']),
      },
      questions: { type: 'array', description: '이번에 올린 Q 번호', items: { type: 'string' } },
      next: str('다음 세션 계획'),
    }, ['entries']),
  },
  {
    name: 'control_ask',
    description: '모호한 요구를 추측하지 않고 질문으로 남긴다. Q 번호를 자동 발급(같은 날 충돌 없음)하고 DECISIONS.md에 추가한다.',
    inputSchema: S('', {
      title: str('한 줄 제목'),
      body: str('본문. 선택지가 있으면 (A)/(B)/(C)로 제시하고 권고를 밝힌다'),
    }, ['title', 'body']),
  },
  {
    name: 'interface_threads',
    description: 'Probe ↔ Portal 직접 채널(INTERFACE.md)을 읽는다. 상대가 내 질문에 답했는지, 내가 답해야 할 스레드가 있는지. 세션 시작 시 control_answers 와 함께 본다.',
    inputSchema: S('', { open_only: { type: 'boolean', description: '기본 true' } }),
  },
  {
    name: 'interface_ask',
    description: '상대 구현에게 직접 묻는다 — DECISIONS 와 달리 관리자를 기다리지 않는다. 계약서 docs/spec/00 의 버전·스키마를 바꿔야 하는 건 여기가 아니라 control_ask 로 올린다. 질문만 적지 말고 자기 권고를 같이 적는다.',
    inputSchema: S('', {
      title: str('한 줄 제목'),
      body: str('본문. 선택지는 (A)/(B) 로, 권고를 밝힌다'),
      to: str('claude-code | codex (기본: 상대편)'),
    }, ['title', 'body']),
  },
  {
    name: 'interface_reply',
    description: '스레드에 내 이름으로 답을 덧붙인다. 남의 블록은 건드리지 않는다.',
    inputSchema: S('', { id: str('I-날짜-번호'), body: str('답') }, ['id', 'body']),
  },
  {
    name: 'interface_propose',
    description: '최종안을 번호 붙여 올린다. 합의는 \'둘 다 말했다\'가 아니라 **같은 번호의 최종안에 양측이 명시 동의**한 것이다. 내용을 고쳤으면 새 번호로 올린다 — 이전 동의는 무효가 된다.',
    inputSchema: S('', {
      id: str('I-날짜-번호'),
      text: str('최종안 본문. 상대가 그대로 동의할 수 있을 만큼 구체적으로'),
      version: str('번호. 생략하면 최신+1'),
    }, ['id', 'text']),
  },
  {
    name: 'interface_agree',
    description: '특정 번호의 최종안에 **명시 동의**한다. 번호가 최신안과 다르면 거부된다 — 상대가 그 뒤에 고쳤다는 뜻이다.',
    inputSchema: S('', {
      id: str('I-날짜-번호'), version: str('동의하는 최종안 번호'),
      note: str('조건이나 단서 (있으면)'),
    }, ['id', 'version']),
  },
  {
    name: 'interface_settle',
    description: '스레드를 합의로 내린다. **양측이 같은 최신 최종안에 명시 동의**해야 한다 — 양쪽이 답했다는 것만으로는 안 된다. 코드에 반영됐으면 커밋 해시를 적는다.',
    inputSchema: S('', {
      id: str('I-날짜-번호'), resolution: str('합의 내용 한 줄'),
      commit: str('반영 커밋 해시 (있으면)'),
    }, ['id', 'resolution']),
  },
  {
    name: 'control_answers',
    description: '내가 올린 질문에 답이 달렸는지 확인한다. 세션 시작 시 control_board 다음으로 호출.',
    inputSchema: S('', { mine_only: { type: 'boolean', description: '기본 true' } }),
  },
];

const MANAGER_TOOLS = [
  {
    name: 'control_set_status',
    description: '(관리자) 작업지시 상태를 바꾼다. 검토요청 → 완료 처리, 보류, 우선순위 변경.',
    inputSchema: S('', {
      id: str('WO 번호'), status: str('대기 | 진행 | 검토요청 | 완료 | 보류'),
      priority: str('우선순위 번호'), note: str('관리자 검토 로그에 남길 한 줄'),
    }, ['id', 'status']),
  },
  {
    name: 'control_assign',
    description: '(관리자) 새 작업지시를 만든다. ID는 섹션 접두어로 자동 발급.',
    inputSchema: S('', {
      owner: str('claude-code | codex'), work: str('작업 내용'),
      acceptance: str('완료 기준 — 전부 충족해야 완료다'),
      priority: str('우선순위. 생략하면 맨 뒤'),
      status: str('대기 | 진행 (기본 대기)'),
    }, ['owner', 'work', 'acceptance']),
  },
  {
    name: 'control_answer',
    description: '(관리자) 열린 질문에 답한다. 확정된 결정으로 승격하려면 promote_as에 D 번호 설명을 준다.',
    inputSchema: S('', {
      id: str('Q 번호'), answer: str('답'),
      promote_as: str('확정 결정으로 올릴 때의 한 줄 (D-xx 로 추가됨)'),
    }, ['id', 'answer']),
  },
];

const allTools = () => (IS_MANAGER ? [...TOOLS, ...MANAGER_TOOLS] : TOOLS);

// ─── handlers ───────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function hBoard({ owner, status }) {
  const b = C.load(ROOT);
  const want = owner || (IS_MANAGER ? 'all' : AGENT);
  const rows = [];
  for (const s of b.tasks.sections) {
    if (want !== 'all' && s.owner !== want) continue;
    for (const r of s.rows) {
      if (status && r.status !== status) continue;
      rows.push({ id: r.id, priority: r.priority, status: r.status, owner: s.owner, work: r.work });
    }
  }
  const open = b.decisions.open.filter(q => q.id).map(q => ({
    id: q.id, title: q.title, owner: q.owner, answered: !!C.answerOf(q),
  }));
  return {
    agent: AGENT,
    tasks: rows,
    mine_actionable: rows.filter(r => (want === 'all' || r.owner === want) && ['대기', '진행'].includes(r.status))
      .sort((a, b2) => (parseInt(a.priority, 10) || 99) - (parseInt(b2.priority, 10) || 99))
      .map(r => r.id),
    decisions_confirmed: b.decisions.confirmed.filter(c => c.id).map(c => `${c.id} ${c.text}`),
    questions_open: open,
    held: b.tasks.trailing.filter(l => /^- /.test(l)).map(l => l.slice(2)),
  };
}

function hTask({ id }) {
  const b = C.load(ROOT);
  const r = C.findTask(b, id);
  if (!r) return { error: `no such task: ${id}` };
  return r;
}

function hClaim({ id }) {
  const b = C.load(ROOT);
  const r = C.findTask(b, id);
  if (!r) return { error: `no such task: ${id}` };
  if (!IS_MANAGER && r.owner !== AGENT) {
    return { error: `${id} belongs to ${r.owner}, not ${AGENT} — 배정되지 않은 일은 하지 않는다` };
  }
  if (r.status === '완료') return { error: `${id} is already 완료` };
  if (r.status === '보류') return { error: `${id} is 보류 — 관리자 지시 없이 집지 않는다` };

  // Priority order is a rule, not a suggestion: taking #3 while #2 waits is
  // how a queue stops meaning anything.
  const ahead = b.tasks.sections
    .filter(s => s.owner === r.owner).flatMap(s => s.rows)
    .filter(x => ['대기', '진행'].includes(x.status)
      && (parseInt(x.priority, 10) || 99) < (parseInt(r.priority, 10) || 99));

  const already = b.tasks.sections
    .filter(s => s.owner === r.owner).flatMap(s => s.rows)
    .filter(x => x.status === '진행' && x.id !== id).map(x => x.id);

  const was = r.status;
  if (r.status === '대기') r.status = '진행';
  const written = C.save(b, ['tasks']);
  return {
    id, was, now: r.status, written,
    work: r.work, acceptance: r.acceptance,
    warn_higher_priority_waiting: ahead.map(x => `${x.priority} ${x.id} (${x.status})`),
    warn_also_in_progress: already,
  };
}

function hReport({ entries, questions, next }) {
  const b = C.load(ROOT);
  const blk = b.status.blocks.find(x => x.name === BLOCK);
  if (!blk) return { error: `no block "${BLOCK}" in STATUS.md` };

  const lines = [];
  const stamp = new Date().toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  });
  lines.push(`### ${C.todayISO()} ${stamp} PDT — ${C.AGENTS[AGENT] || '관리자'}`);

  const touched = [];
  for (const e of entries) {
    const bits = [];
    if (e.status === '진행' && e.progress) bits.push(`진행 ${e.progress}`);
    if (e.branch) bits.push(`브랜치 \`${e.branch}\``);
    if (e.commit) bits.push(`커밋 \`${e.commit}\``);
    if (e.tests) bits.push(`테스트 ${e.tests}`);
    if (e.note) bits.push(`비고 ${e.note}`);
    lines.push(`- ${e.id}: **${e.status}**${bits.length ? ' | ' + bits.join(' | ') : ''}`);
    if (e.acceptance) lines.push(`  - 완료 기준: ${e.acceptance}`);
    if (e.blocker) lines.push(`  - 블로커: ${e.blocker}`);

    const r = C.findTask(b, e.id);
    if (r && (IS_MANAGER || r.owner === AGENT) && C.STATUSES.includes(e.status)) {
      // A closed WO is not reopened by a report. Found the hard way: with no
      // WO assigned for a piece of directed work, a report filed against the
      // nearest id moved WO-INT-002 from 완료 back to 진행 — erasing a
      // manager approval and a merged PR. Reopening is the manager's call.
      if (r.status === '완료' && !IS_MANAGER) {
        lines.push(`  - (${e.id} 는 완료 상태다 — 상태를 바꾸지 않았다. 재개는 관리자가 한다)`);
        touched.push(`${e.id}: 완료 유지`);
      } else if (e.status === '완료' && !IS_MANAGER) {
        // An agent may raise to 검토요청 but never to 완료 — CLAUDE.md says a
        // WO without a PR is not complete.
        lines.push('  - (완료 처리는 관리자가 한다 — 검토요청으로 기록)');
        r.status = '검토요청';
        touched.push(`${e.id}→${r.status}`);
      } else {
        r.status = e.status;
        touched.push(`${e.id}→${r.status}`);
      }
    }
  }
  if (questions?.length) lines.push(`- 질문: ${questions.join(' · ')}`);
  if (!entries.some(e => e.blocker)) lines.push('- 블로커: 없음');
  if (next) lines.push(`- 다음 세션 계획: ${next}`);

  // Append, never overwrite. Keep exactly one blank line before the entry.
  while (blk.lines.length && blk.lines[blk.lines.length - 1].trim() === '') blk.lines.pop();
  blk.lines.push('', ...lines);

  const written = C.save(b, ['status', 'tasks']);
  return { appended_to: BLOCK, entries: entries.length, tasks_updated: touched, written };
}

function hAsk({ title, body }) {
  const b = C.load(ROOT);
  if (b.decisions.openHead === null) return { error: 'DECISIONS.md has no 열린 질문 section' };
  const id = C.nextQuestionId(b);
  const owner = C.AGENTS[AGENT] || '관리자';

  // Drop a placeholder "(없음)" if that is all the section holds.
  b.decisions.open = b.decisions.open.filter(q => q.id || !/^\(없음\)$/.test((q.raw || '').trim()));

  const bodyLines = ['', ...String(body).split('\n'), '', 'A:', ''];
  b.decisions.open.push({ id, title, owner, body: bodyLines });
  const written = C.save(b, ['decisions']);
  return { id, title, owner, written, note: '추측하지 말고 다음 WO로 넘어간다' };
}

function hAnswers({ mine_only = true }) {
  const b = C.load(ROOT);
  const me = C.AGENTS[AGENT] || '관리자';
  return {
    questions: b.decisions.open.filter(q => q.id)
      .filter(q => !mine_only || !q.owner || q.owner === me)
      .map(q => ({ id: q.id, title: q.title, owner: q.owner, answer: C.answerOf(q) })),
  };
}


// ── the direct Probe ↔ Portal channel ──────────────────────────────

const PEER = { 'claude-code': 'codex', codex: 'claude-code' };

function requireInterface(b) {
  if (!b.hasInterface) {
    return { error: 'docs/control/INTERFACE.md 가 없다 — 이 체크아웃에는 직접 채널이 아직 없다' };
  }
  return null;
}

function hInterfaceThreads({ open_only = true }) {
  const b = C.load(ROOT);
  const miss = requireInterface(b); if (miss) return miss;
  const me = C.AGENTS[AGENT] || '관리자';
  const open = b.interface.open.filter(t => t.id).map((t) => {
    const by = C.repliedBy(t);
    const c = C.consensus(t);
    return {
      id: t.id, title: t.title, ask: t.ask,
      replied_by: by,
      latest_version: c.latest_version,
      agreed_by: c.agreed_by,
      missing_agreement: c.missing,
      stale_agreements: c.stale,
      // Flagged, not counted: a hand edit can claim any author.
      unknown_authors: c.unknown_authors,
      settleable: c.settleable,
      // What this agent has to do next, which is the only thing it needs.
      awaiting_me: c.latest_version
        ? c.missing.includes(me)
        : !by.includes(me),
      body: t.body.join('\n').trim(),
    };
  });
  return {
    agent: AGENT, peer: PEER[AGENT] || null,
    open,
    mine_to_answer: open.filter(t => t.awaiting_me).map(t => t.id),
    ready_to_settle: open.filter(t => t.settleable).map(t => t.id),
    settled: open_only ? undefined : b.interface.settled.filter(c => c.id).map(c => `${c.id} ${c.text}`),
  };
}

function hInterfaceAsk({ title, body, to }) {
  const b = C.load(ROOT);
  const miss = requireInterface(b); if (miss) return miss;
  if (b.interface.openHead === null) return { error: 'INTERFACE.md has no 열린 스레드 section' };
  const me = C.AGENTS[AGENT] || '관리자';
  const peerKey = to && C.AGENTS[to] ? to : PEER[AGENT];
  const peer = C.AGENTS[peerKey] || 'Codex';
  const id = C.nextInterfaceId(b);

  b.interface.open = b.interface.open.filter(t => t.id || !/^\(없음\)$/.test((t.raw || '').trim()));
  b.interface.open.push({
    id, title, ask: `${me} → ${peer}`,
    body: ['', ...String(body).split('\n'), ''],
  });
  return { id, to: peerKey, written: C.save(b, ['interface']), note: '관리자를 기다리지 않는다 — 상대가 답하면 interface_settle' };
}

function hInterfaceReply({ id, body }) {
  const b = C.load(ROOT);
  const miss = requireInterface(b); if (miss) return miss;
  const t = b.interface.open.find(x => x.id === id);
  if (!t) return { error: `no such thread: ${id}` };
  const me = C.AGENTS[AGENT] || '관리자';

  // Append only. Another agent's block is not ours to touch, and this is the
  // one place two agents write the same file.
  while (t.body.length && t.body[t.body.length - 1].trim() === '') t.body.pop();
  t.body.push('', `**${me}** ${C.todayISO()}`, ...String(body).split('\n'), '');
  const by = C.repliedBy(t);
  return {
    id, by: me, replied_by: by,
    both_answered: by.filter(n => n !== '관리자').length >= 2,
    written: C.save(b, ['interface']),
  };
}

function hInterfacePropose({ id, text, version }) {
  const b = C.load(ROOT);
  const miss = requireInterface(b); if (miss) return miss;
  const t = b.interface.open.find(x => x.id === id);
  if (!t) return { error: `no such thread: ${id}` };
  const me = C.AGENTS[AGENT] || '관리자';
  const c = C.consensus(t);
  const v = version != null ? parseInt(version, 10) : c.latest_version + 1;
  if (!Number.isFinite(v) || v < 1) return { error: 'version must be a positive integer' };
  if (c.proposals.some(pr => pr.v === v)) {
    return { error: `v${v} 는 이미 있다 — 고쳤으면 v${c.latest_version + 1} 로 올린다` };
  }

  while (t.body.length && t.body[t.body.length - 1].trim() === '') t.body.pop();
  // The author is stamped by the server from its own identity; it is never an
  // argument. A hand edit can still claim anyone, which `unknown_authors` and
  // the name whitelist surface rather than silently count.
  t.body.push('', `제안 v${v} (${me}) ${C.todayISO()}`, ...String(text).split('\n'), '');
  const after = C.consensus(t);
  return {
    id, version: v, by: me,
    // Saying this plainly: a new proposal invalidates consent to the old one.
    invalidated: c.agreed_by.length ? `v${c.latest_version} 동의 무효: ${c.agreed_by.join(', ')}` : null,
    needs_agreement_from: after.missing,
    written: C.save(b, ['interface']),
  };
}

function hInterfaceAgree({ id, version, note }) {
  const b = C.load(ROOT);
  const miss = requireInterface(b); if (miss) return miss;
  const t = b.interface.open.find(x => x.id === id);
  if (!t) return { error: `no such thread: ${id}` };
  const me = C.AGENTS[AGENT] || '관리자';
  const c = C.consensus(t);
  const v = parseInt(version, 10);

  if (!c.latest_version) return { error: '올라온 최종안이 없다 — interface_propose 가 먼저다' };
  if (!c.proposals.some(pr => pr.v === v)) return { error: `v${v} 라는 최종안이 없다 (최신 v${c.latest_version})` };
  // Agreeing to a superseded revision is the failure this whole mechanism
  // exists to prevent: one side amends the plan, the other agrees to what it
  // read earlier, and both believe they settled the same thing.
  if (v !== c.latest_version) {
    return { error: `v${v} 는 최신이 아니다 — v${c.latest_version} 가 올라와 있다. 읽고 그 번호로 동의하라`, latest: c.latest_version };
  }
  if (c.agrees.some(a => a.v === v && a.by === me)) return { id, version: v, by: me, unchanged: true };

  while (t.body.length && t.body[t.body.length - 1].trim() === '') t.body.pop();
  t.body.push('', `동의 v${v} (${me}) ${C.todayISO()}`, ...(note ? [String(note)] : []), '');
  const after = C.consensus(t);
  return {
    id, version: v, by: me,
    agreed_by: after.agreed_by, missing: after.missing,
    settleable: after.settleable,
    written: C.save(b, ['interface']),
  };
}

function hInterfaceSettle({ id, resolution, commit }) {
  const b = C.load(ROOT);
  const miss = requireInterface(b); if (miss) return miss;
  const i = b.interface.open.findIndex(x => x.id === id);
  if (i < 0) return { error: `no such thread: ${id}` };
  const t = b.interface.open[i];
  const c = C.consensus(t);

  // "Both replied" is not agreement — two agents can write at length and mean
  // different things. What counts is explicit consent, from both, to the SAME
  // and LATEST proposal. The manager may close a thread unilaterally; that is
  // an intervention and it is theirs to make.
  if (!c.settleable && !IS_MANAGER) {
    return {
      error: c.latest_version
        ? `v${c.latest_version} 에 명시 동의하지 않은 쪽이 있다: ${c.missing.join(', ')}`
        : '올라온 최종안이 없다 — interface_propose → 양측 interface_agree 순서다',
      latest_version: c.latest_version,
      agreed_by: c.agreed_by,
      missing: c.missing,
      stale_agreements: c.stale,
      need: c.latest_version ? '상대의 interface_agree' : 'interface_propose',
    };
  }
  const by = c.agreed_by;

  b.interface.open.splice(i, 1);
  // The version is part of the record: "we agreed" without saying to what is
  // how a settled thread gets re-argued.
  const stamp = c.latest_version ? `v${c.latest_version}` : 'manager';
  const line = `- ${id} ${esc(t.title)} → ${esc(resolution)} [${stamp}${by.length ? ` · ${by.join(' + ')}` : ''}${commit ? ` · ${esc(commit)}` : ''}]`;
  b.interface.settled = b.interface.settled.filter(c => c.id || !/^\(없음\)$/.test((c.raw || '').trim()));
  let at = b.interface.settled.length;
  while (at > 0 && (b.interface.settled[at - 1].raw || '').trim() === '') at--;
  b.interface.settled.splice(at, 0, { id, text: `${t.title} → ${resolution}`, raw: line });
  return { id, settled: true, by, commit: commit || null, written: C.save(b, ['interface']) };
}

// ── manager-only ──

function hSetStatus({ id, status, priority, note }) {
  const b = C.load(ROOT);
  const r = C.findTask(b, id);
  if (!r) return { error: `no such task: ${id}` };
  if (!C.STATUSES.includes(status)) return { error: `status must be one of ${C.STATUSES.join(' | ')}` };
  const was = { status: r.status, priority: r.priority };
  r.status = status;
  if (priority) r.priority = String(priority);
  const files = ['tasks'];
  if (note) {
    const log = b.status.blocks.find(x => /관리자 검토 로그/.test(x.name));
    if (log) { log.lines.push(`- ${C.todayISO()}: ${note}`); files.push('status'); }
  }
  return { id, was, now: { status: r.status, priority: r.priority }, written: C.save(b, files) };
}

function hAssign({ owner, work, acceptance, priority, status = '대기' }) {
  const b = C.load(ROOT);
  const sec = b.tasks.sections.find(s => s.owner === owner);
  if (!sec) return { error: `no section for owner ${owner}` };
  const nums = sec.rows.map(r => parseInt(r.id.split('-').pop(), 10)).filter(Number.isFinite);
  const id = `${sec.prefix}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`;
  const prio = priority != null ? String(priority)
    : String((sec.rows.map(r => parseInt(r.priority, 10)).filter(Number.isFinite).reduce((a, c) => Math.max(a, c), 0)) + 1);
  sec.rows.push({ priority: prio, id, status, work: esc(work), acceptance: esc(acceptance), section: sec.key, owner });
  return { id, owner, priority: prio, status, written: C.save(b, ['tasks']) };
}

function hAnswer({ id, answer, promote_as }) {
  const b = C.load(ROOT);
  const q = b.decisions.open.find(x => x.id === id);
  if (!q) return { error: `no such question: ${id}` };
  const i = q.body.findIndex(l => /^A:/.test(l));
  const text = String(answer).split('\n');
  if (i < 0) q.body.push('', `A: ${text[0]}`, ...text.slice(1));
  else q.body.splice(i, 1, `A: ${text[0]}`, ...text.slice(1));

  let promoted = null;
  if (promote_as) {
    const ids = b.decisions.confirmed.map(c => c.id).filter(Boolean)
      .map(x => parseInt(x.slice(2), 10)).filter(Number.isFinite);
    promoted = `D-${String((ids.length ? Math.max(...ids) : 0) + 1).padStart(2, '0')}`;
    const line = `- ${promoted} ${esc(promote_as)}`;
    // Keep it inside the bullet list, above any trailing blank lines.
    let at = b.decisions.confirmed.length;
    while (at > 0 && (b.decisions.confirmed[at - 1].raw || '').trim() === '') at--;
    b.decisions.confirmed.splice(at, 0, { id: promoted, text: esc(promote_as), raw: line });
  }
  return { id, answered: true, promoted, written: C.save(b, ['decisions']) };
}

const HANDLERS = {
  control_board: hBoard, control_task: hTask, control_claim: hClaim,
  control_report: hReport, control_ask: hAsk, control_answers: hAnswers,
  interface_threads: hInterfaceThreads, interface_ask: hInterfaceAsk,
  interface_reply: hInterfaceReply, interface_propose: hInterfacePropose,
  interface_agree: hInterfaceAgree, interface_settle: hInterfaceSettle,
  control_set_status: hSetStatus, control_assign: hAssign, control_answer: hAnswer,
};

// ─── JSON-RPC over stdio ────────────────────────────────────────────
// Content-Length framing is not used by the stdio transport; messages are
// newline-delimited JSON.

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

let clientProtocol = '2024-11-05';

function dispatch(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    clientProtocol = params?.protocolVersion || clientProtocol;
    return ok(id, {
      protocolVersion: clientProtocol,
      capabilities: { tools: {} },
      serverInfo: { name: 'cflex-control', version: '1.0.0' },
      instructions: `C-Flex 작업지시판. 이 서버는 "${AGENT}"로 동작한다.\n`
        + '세션 시작: control_board → control_answers → interface_threads.\n'
        + '작업 집을 때: control_claim. 세션 종료: control_report (필수).\n'
        + '관리자 판단이 필요하면 control_ask. 상대 구현(Probe↔Portal)에게 직접\n'
        + '물을 일이면 interface_ask — 그쪽은 관리자를 기다리지 않는다. 다만 계약서\n'
        + 'docs/spec/00 의 버전·스키마를 바꾸는 건 control_ask 로 올린다.\n'
        + '완료 처리는 관리자만 한다 — 에이전트는 검토요청까지.',
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: allTools() });
  if (method === 'resources/list') return ok(id, { resources: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });

  if (method === 'tools/call') {
    const name = params?.name;
    const fn = HANDLERS[name];
    if (!fn) return err(id, -32601, `unknown tool: ${name}`);
    if (MANAGER_TOOLS.some(t => t.name === name) && !IS_MANAGER) {
      return err(id, -32600, `${name} is manager-only (CFLEX_AGENT=manager); this instance is ${AGENT}`);
    }
    let out;
    try { out = fn(params?.arguments || {}); } catch (e) { out = { error: e.message }; }
    return ok(id, {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      isError: !!out?.error,
    });
  }
  if (id !== undefined) err(id, -32601, `unknown method: ${method}`);
}

// Only wire stdio when run as the server. A test requires this file for
// `dispatch` and must not inherit a stdin listener that never ends.
function serve() {
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try { dispatch(msg); } catch (e) {
      if (msg?.id !== undefined) err(msg.id, -32603, e.message);
      else process.stderr.write(`[cflex-control] ${e.stack}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) serve();

module.exports = { TOOLS, MANAGER_TOOLS, HANDLERS, dispatch, allTools, serve, AGENT, IS_MANAGER };
