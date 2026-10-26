#!/usr/bin/env node
// cli.js — the two things that have to happen before anyone can log in, and
// the SOW test ticket for the installer's `verify --send-test`.
//
//   node src/cli.js create-user <username> <admin|operator|viewer>   password on stdin
//   node src/cli.js set-password <username>                          password on stdin
//   node src/cli.js list-users
//   node src/cli.js collector-key <node-id>                          prints the key once
//   node src/cli.js test-ticket [--keep-open]                        ServiceNow create → update → resolve
//                                                                    with the channels in Settings (exit 0 ok, 1 failed)
//
// The password is read from stdin (no echo when it is a terminal), never from
// argv — argv is visible in `ps` and in shell history.
const readline = require('readline');
const config = require('./config').load();
const db = require('./db').open(config.dbPath);
const { createSettings } = require('./settings');
const { createSealer } = require('./seal');

function readSecret(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let s = '';
      process.stdin.on('data', (c) => { s += c; });
      process.stdin.on('end', () => resolve(s.replace(/\r?\n$/, '')));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const settings = createSettings(db, { sealer: createSealer(config.secretKey), tenant: config.tenant });
  const audit = (action, target, detail) => db.prepare('INSERT INTO audit_log (ts, actor, action, target, detail, ip, node) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), `cli:${require('os').userInfo().username}`, action, target, detail ? JSON.stringify(detail) : null, null, config.nodeId);

  if (cmd === 'create-user') {
    if (!a || !b) throw new Error('usage: create-user <username> <admin|operator|viewer>');
    const password = await readSecret('password: ');
    const u = settings.createUser({ username: a, role: b, password, must_change: true });
    audit('user_create', u.username, { role: u.role });
    console.log(`created ${u.username} (${u.role}); the password must be changed at first login`);
  } else if (cmd === 'set-password') {
    // 잊은 비밀번호를 복구하는 유일한 경로. 이게 없어서 2026-10-26 에
    // haeaadmin 으로 로그인할 방법이 사라졌다 — create-user 는 새 계정만
    // 만들고, 기존 계정의 해시를 고칠 공식 수단이 없었다.
    //
    // must_change 는 settings.updateUser 가 강제로 1 로 올린다. 여기서 넣는
    // 값은 임시 비밀번호이고, 본인이 첫 로그인에서 자기 것으로 바꾼다 —
    // 복구를 수행한 사람이 그 계정의 상시 비밀번호를 알지 못하게 한다.
    if (!a) throw new Error('usage: set-password <username>');
    const u = settings.listUsers().find((x) => x.username === a);
    if (!u) throw new Error(`no such user: ${a} (list-users 로 확인하라)`);
    const password = await readSecret('new password: ');
    settings.updateUser(u.id, { password });
    audit('user_password_reset', u.username, { role: u.role, by: 'cli' });
    console.log(`${u.username} 의 비밀번호를 바꿨다; 첫 로그인에서 본인이 다시 바꿔야 한다`);
  } else if (cmd === 'list-users') {
    for (const u of settings.listUsers()) {
      console.log([
        String(u.username).padEnd(22), String(u.role).padEnd(9),
        `disabled=${u.disabled ? 1 : 0}`, `must_change=${u.must_change ? 1 : 0}`,
        `last_login=${u.last_login_at ? new Date(u.last_login_at).toISOString() : '없음'}`,
      ].join(' '));
    }
  } else if (cmd === 'collector-key') {
    if (!a) throw new Error('usage: collector-key <node-id>');
    const k = settings.issueCollectorKey(a);
    audit('collector_key_issued', k.node_id);
    process.stdout.write(`${k.key}\n`);
  } else if (cmd === 'test-ticket') {
    // The Settings button's code path (notify.js), from a shell on the app node.
    const { createConsoleNotify, netFrom } = require('./notify');
    const quiet = { log() {}, warn() {}, error() {} };
    const n = createConsoleNotify({ db, settings, net: netFrom(config.notify), log: quiet });
    const r = await n.testTicket({ resolve: a !== '--keep-open' });
    audit('test_ticket', r.number || null, { ok: !!r.ok, step: r.step || null });
    console.log(r.ok
      ? `OK  ServiceNow test ticket ${r.number} created, updated${r.resolved ? ' and resolved' : ' (left open)'}`
      : `FAIL ServiceNow test ticket at ${r.step || 'config'}: ${r.error}`);
    process.exitCode = r.ok ? 0 : 1;
  } else {
    console.log('commands: create-user <username> <role> | set-password <username> | list-users | collector-key <node-id> | test-ticket [--keep-open]');
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error(e.code ? `${e.code}: ${e.message}` : e.message); process.exit(1); });
