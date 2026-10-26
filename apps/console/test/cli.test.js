// node --test apps/console/test/cli.test.js
//
// 비밀번호를 잊은 관리자 계정을 복구하는 경로. 이게 없어서 2026-10-26 에
// 콘솔에 로그인할 방법이 사라졌다 — create-user 는 새 계정만 만들고, 기존
// 계정의 해시를 고칠 공식 수단이 없었다. 임시 스크립트로 때우지 않도록
// CLI 에 넣고 여기서 고정한다.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function run(args, { stdin = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const p = execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env }, timeout: 20_000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    p.stdin.end(stdin);
  });
}

let tmp, env;
test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-cli-'));
  env = {
    CONSOLE_DB: path.join(tmp, 'c.db'),
    CONSOLE_DB_PATH: path.join(tmp, 'c.db'),
    CONSOLE_SECRET_KEY: 'a'.repeat(64),
  };
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const GOOD = 'Cflex2026!FMS';

test('create-user → set-password → 로그인 가능한 해시로 바뀐다', async () => {
  const c = await run(['create-user', 'opsadmin', 'admin'], { stdin: GOOD, env });
  assert.strictEqual(c.code, 0, c.stderr);
  assert.match(c.stdout, /created opsadmin/);

  // 복구: 새 임시 비밀번호로 바꾼다
  const NEXT = 'Recover2026!X';
  const r = await run(['set-password', 'opsadmin'], { stdin: NEXT, env });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /비밀번호를 바꿨다/);

  // 바뀐 해시로 검증되고, 옛 것으로는 안 된다
  const auth = require('../src/auth');
  const db = require('../src/db').open(env.CONSOLE_DB);
  const row = db.prepare('SELECT pw_hash, must_change FROM users WHERE username = ?').get('opsadmin');
  assert.ok(auth.verifyPassword(NEXT, row.pw_hash), '새 비밀번호로 검증되지 않는다');
  assert.ok(!auth.verifyPassword(GOOD, row.pw_hash), '옛 비밀번호가 아직 통한다');
  // 복구한 사람이 그 계정의 상시 비밀번호를 알고 있어서는 안 된다.
  assert.strictEqual(row.must_change, 1, '첫 로그인에서 본인이 다시 바꾸도록 강제해야 한다');
});

test('없는 계정이면 분명히 거절한다', async () => {
  const r = await run(['set-password', 'nobody'], { stdin: GOOD, env });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /no such user/);
});

test('약한 비밀번호는 거절한다 — 인터넷에 열린 관리 UI 다', async () => {
  // cflex2026 은 9자다. 2026-10-26 에 이걸 쓰려다 막혔다.
  const r = await run(['set-password', 'opsadmin'], { stdin: 'cflex2026', env });
  assert.notStrictEqual(r.code, 0, '9자 비밀번호가 통과했다');
  assert.match(r.stderr + r.stdout, /12 characters|weak_password/);
});

test('list-users 가 계정 상태를 보여준다', async () => {
  const r = await run(['list-users'], { env });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /opsadmin\s+admin/);
  assert.match(r.stdout, /must_change=1/);
});

test('모르는 명령은 사용법을 알려준다', async () => {
  const r = await run(['nope'], { env });
  assert.strictEqual(r.code, 2);
  assert.match(r.stdout, /set-password/);
});
