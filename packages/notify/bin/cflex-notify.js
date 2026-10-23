#!/usr/bin/env node
// cflex-notify — the command `cflex-install verify --send-test` calls.
//
// Spec §5.2 requires the installer to test SMTP / Teams / ServiceNow
// connectivity, and to be able to actually send on request. That is this.
//
//   cflex-notify check  --config site.json            # configuration only, sends nothing
//   cflex-notify test   --config site.json --channel teams --deliver
//   cflex-notify send   --config site.json --priority P1 --title "On battery" --where "HMA · IDF2"
//
// The config file holds endpoints and keys. It is read from disk by the
// caller's chosen path and never from the environment, so the installer can
// keep it 0600 under /opt/app/cflex/config and nothing leaks into a process
// listing.
const fs = require('fs');
const path = require('path');
const notify = require('../src');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

function die(msg, code = 2) { console.error(msg); process.exit(code); }

if (!cmd || flag('help') || !['check', 'test', 'send'].includes(cmd)) {
  console.log(`cflex-notify <check|test|send> --config <file> [options]

  check                       report which routes would fire and which cannot, send nothing
  test   --channel <name>     one test message; add --deliver to actually send it
  send   --priority P1..P4 --title <text> [--where <text>] [--detail <text>] [--channel <name>]

  --config <file>   JSON: { "config": {...}, "routes": [...] }
  --json            machine-readable output
  --deliver         for 'test', actually send (default: configuration check only)

Exit: 0 all good · 1 a delivery or check failed · 2 bad usage`);
  process.exit(cmd ? 0 : 2);
}

const cfgPath = arg('config');
if (!cfgPath) die('--config <file> is required');
let file;
try { file = JSON.parse(fs.readFileSync(path.resolve(cfgPath), 'utf8')); }
catch (e) { die(`cannot read ${cfgPath}: ${e.message}`); }

const config = file.config || file.notify || {};
let routes = file.routes || [];
const only = arg('channel');
if (only) routes = routes.filter(r => r.channel === only);

// An SMTP transport needs a sender, and this package deliberately has no mail
// dependency. If the config names a command, use it; otherwise say so plainly
// rather than reporting a failure that looks like the relay is down.
const deps = {};
if (config.email?.transport === 'smtp' && config.email?.sendmailPath) {
  const { execFileSync } = require('child_process');
  deps.smtpSend = async ({ to, from, subject, text }) => {
    const raw = `From: ${from}\nTo: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${text}`;
    execFileSync(config.email.sendmailPath, ['-t', '-i'], { input: raw, timeout: 20000 });
    return { messageId: null };
  };
}

const out = (o) => console.log(flag('json') ? JSON.stringify(o, null, 2) : null);

(async () => {
  if (cmd === 'check') {
    const probe = { priority: 'P1', title: 'configuration check', where: config.siteName || null };
    const { willSend, skipped } = notify.plan(probe, routes, config);
    if (flag('json')) { out({ willSend, skipped }); }
    else {
      console.log(`routes configured: ${routes.length}`);
      for (const r of willSend) console.log(`  OK      ${r.channel.padEnd(11)} ${String(r.target).slice(0, 56)}`);
      for (const s of skipped) console.log(`  SKIP    ${s.route.channel.padEnd(11)} ${s.why}`);
      console.log(`\nwould send: ${willSend.length} · skipped: ${skipped.length}`);
    }
    // A config where nothing at all can fire is a failed check: an install
    // with no working alarm path is not an install.
    process.exit(willSend.length ? 0 : 1);
  }

  if (cmd === 'test') {
    const ch = arg('channel');
    if (!ch) die("test needs --channel <name>");
    const route = routes.find(r => r.channel === ch);
    if (!route) die(`no route configured for channel "${ch}"`, 1);
    const r = await notify.test(ch, route.target, config, { deliver: flag('deliver'), ...deps });
    if (flag('json')) out(r);
    else console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${ch}` +
      `${r.delivered ? ' (delivered)' : ' (config only — add --deliver to send)'}` +
      `${r.id ? ' id=' + r.id : ''}${r.dryRun ? ' DRY_RUN — gateway did not send' : ''}` +
      `${r.error ? ' — ' + r.error : ''}`);
    process.exit(r.ok ? 0 : 1);
  }

  // send
  const priority = arg('priority', 'P3');
  const title = arg('title');
  if (!title) die('send needs --title <text>');
  const res = await notify.send({
    priority, title, where: arg('where'), detail: arg('detail'), id: arg('id'),
    at: Date.now(),
  }, routes, config, deps);
  if (flag('json')) out(res);
  else {
    for (const r of res.results) {
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.channel.padEnd(11)} ${r.ms}ms` +
        `${r.id ? ' id=' + r.id : ''}${r.dryRun ? ' DRY_RUN' : ''}${r.error ? ' — ' + r.error : ''}`);
    }
    for (const s of res.skipped) console.log(`SKIP ${s.channel.padEnd(11)} ${s.why}`);
    console.log(`\nsent ${res.sent} · failed ${res.failed} · skipped ${res.skipped.length}`);
  }
  process.exit(res.failed ? 1 : 0);
})().catch((e) => die(`unexpected: ${e.stack}`, 3));
