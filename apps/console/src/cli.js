#!/usr/bin/env node
// cli.js — the two things that have to happen before anyone can log in.
//
//   node src/cli.js create-user <username> <admin|operator|viewer>   password on stdin
//   node src/cli.js collector-key <node-id>                          prints the key once
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
  } else if (cmd === 'collector-key') {
    if (!a) throw new Error('usage: collector-key <node-id>');
    const k = settings.issueCollectorKey(a);
    audit('collector_key_issued', k.node_id);
    process.stdout.write(`${k.key}\n`);
  } else {
    console.log('commands: create-user <username> <role> | collector-key <node-id>');
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error(e.code ? `${e.code}: ${e.message}` : e.message); process.exit(1); });
