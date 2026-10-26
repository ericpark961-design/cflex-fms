// static.test.js — checks on the install bundle's static parts that need no Python and no Podman:
//   node --test install/test/static.test.js
// The installer's own unit tests are Python:  python3 -m unittest discover -s install/test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const SPEC = read('docs/spec/01_SPEC_INTERNAL_Probe-OnPrem_for-ClaudeCode_v1.md');

function specNetworkRows() {
  const after = SPEC.split('### 네트워크')[1].split('\n').slice(1);
  const table = [];
  for (const l of after) {
    if (l.startsWith('|')) table.push(l);
    else if (table.length) break;
  }
  return table.slice(2).map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim().replace(/\*\*/g, '')));
}

test('netmatrix.json = spec 01 §1 network table, row for row, verbatim', () => {
  const m = JSON.parse(read('install/netmatrix.json'));
  const rows = specNetworkRows();
  assert.strictEqual(rows.length, 8);
  assert.deepStrictEqual(m.rows.map(r => [r.direction, r.port, r.purpose]), rows);
  assert.deepStrictEqual(m.rows.map(r => r.id), rows.map((_, i) => `FW-${i + 1}`));
  for (const r of m.rows) {
    assert.ok(r.checks.length, r.id);
    for (const c of r.checks) {
      assert.ok(['listen', 'out'].includes(c.type), r.id);
      assert.ok(c.roles.every(x => ['collector', 'app', 'db'].includes(x)), r.id);
    }
  }
});

test('site.example.yaml carries spec §3.4 verbatim', () => {
  const block = SPEC.split('### 3.4')[1].split('```yaml\n')[1].split('```')[0];
  const ex = read('install/site.example.yaml');
  for (const line of block.trim().split('\n')) assert.ok(ex.includes(line), `missing: ${line}`);
});

test('nmc-targets.example.txt = the 41 NMC IPs of spec 부록 B', () => {
  const appendix = SPEC.split('## 부록 B')[1].split('## 부록 C')[0];
  // Expand the appendix shorthand: "10.119.141.25 / .142.237" and "IDF3 .220".
  const ips = [];
  let last = null;
  for (const tok of appendix.match(/(\d{1,3}(?:\.\d{1,3}){3}|(?<![\d.])\.\d{1,3}(?:\.\d{1,3})*)/g)) {
    if (tok.startsWith('.')) {
      const tail = tok.slice(1).split('.');
      const head = last.split('.').slice(0, 4 - tail.length);
      last = [...head, ...tail].join('.');
    } else last = tok;
    ips.push(last);
  }
  const listed = read('install/nmc-targets.example.txt').split('\n').map(l => l.split('#')[0].trim()).filter(Boolean);
  assert.strictEqual(new Set(listed).size, 41, 'firewall count (spec 부록 A: 41)');
  assert.deepStrictEqual([...listed].sort(), [...new Set(ips)].sort());
});

const QUADLETS = fs.readdirSync(path.join(REPO, 'install/templates/quadlet')).map(f => `install/templates/quadlet/${f}`);

test('Quadlet templates: rootless hardening, offline, SELinux :Z', () => {
  assert.deepStrictEqual(QUADLETS.map(q => path.basename(q)).sort(),
    ['cflex-app.pod', 'cflex-collector.container', 'cflex-console.container', 'cflex-postgres.container', 'cflex-redis.container', 'cflex-web.container']);
  for (const q of QUADLETS) {
    const t = read(q);
    assert.doesNotMatch(t, /privileged|^Network=host|AddCapability|PodmanArgs/im, q);
    assert.match(t, /^WantedBy=default\.target$/m, q);
    if (q.endsWith('.pod')) { assert.match(t, /^\[Pod\]$/m); continue; }
    for (const k of ['Pull=never', 'ReadOnly=true', 'NoNewPrivileges=true', 'DropCapability=ALL', 'LogDriver=journald'])
      assert.ok(t.includes(`\n${k}\n`), `${q}: ${k}`);
    assert.match(t, /^UserNS=keep-id:uid=(1001|26),gid=(1001|26)$/m, q);
    assert.match(t, /^Image=localhost\/cflex\/[a-z]+:@@VERSION@@$/m, q);
    for (const k of ['HealthCmd', 'HealthInterval', 'HealthTimeout', 'HealthStartPeriod', 'HealthRetries'])
      assert.match(t, new RegExp(`^${k}=`, 'm'), `${q}: ${k}`);
    // '$' and '%' meet systemd expansion in the generated unit.
    assert.doesNotMatch(t.match(/^HealthCmd=.*$/m)[0], /[$%]/, q);
    const vols = t.match(/^Volume=.*$/gm) || [];
    assert.ok(vols.length, q);
    for (const v of vols) assert.match(v, /:(ro,)?Z$/, `${q}: ${v}`);
  }
});

test('every @@PLACEHOLDER@@ in a template is supplied by render.py', () => {
  const render = read('install/lib/cflex_install/render.py');
  const walk = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);
  const seen = new Set();
  for (const f of walk('install/templates')) for (const m of read(f).matchAll(/@@([A-Z0-9_]+)@@/g)) seen.add(m[1]);
  assert.ok(seen.size > 20);
  for (const k of seen) assert.ok(render.includes(`"${k}"`), `render.py never sets ${k}`);
});

const CONTAINERFILES = ['collector', 'app', 'web'].map(n => `images/${n}/Containerfile`);

test('Containerfiles: UBI8 base by build arg, UID 1001, HEALTHCHECK, no latest, no Docker Hub', () => {
  const bases = Object.fromEntries(read('images/base-images.env').split('\n')
    .map(l => l.split('#')[0].trim()).filter(l => l.includes('=')).map(l => l.split('=')));
  assert.deepStrictEqual(Object.keys(bases).sort(), ['RHEL8_POSTGRESQL_16', 'RHEL8_REDIS_6', 'UBI8_NGINX_122', 'UBI8_NODEJS_20']);
  assert.match(bases.UBI8_NODEJS_20, /redhat\.(com|io)\/ubi8\/nodejs-20:/);
  assert.match(bases.UBI8_NGINX_122, /redhat\.(com|io)\/ubi8\/nginx-122:/);
  assert.match(bases.RHEL8_REDIS_6, /registry\.redhat\.io\/rhel8\/redis-6:/);
  assert.match(bases.RHEL8_POSTGRESQL_16, /registry\.redhat\.io\/rhel8\/postgresql-16:/);
  for (const f of CONTAINERFILES) {
    const t = read(f);
    const def = t.match(/^ARG BASE_IMAGE=(.+)$/m)[1];
    assert.ok(Object.values(bases).includes(def), `${f}: default base ${def} not in base-images.env`);
    assert.ok(t.split('\n').filter(l => /^FROM /.test(l)).every(l => /^FROM \$\{BASE_IMAGE\}( AS \w+)?$/.test(l)), `${f}: every FROM is the pinned base`);
    const final = t.slice(t.lastIndexOf('\nFROM '));
    assert.match(final, /^USER 1001$/m, `${f}: final stage runs as 1001`);
    assert.ok(final.lastIndexOf('USER 1001') > final.lastIndexOf('USER 0'), `${f}: last USER is 1001`);
    assert.match(final, /^HEALTHCHECK .*\n\s+CMD \[/m, f);
    assert.match(final, /^CMD \[/m, f);
    assert.doesNotMatch(t, /:latest|docker\.io|apt-get|nodesource|curl .*\| *(ba)?sh/i, f);
  }
  // Every file a Containerfile COPYs from the repo exists.
  for (const f of CONTAINERFILES) {
    for (const m of read(f).matchAll(/^COPY (?!--from)(?:--chown=\S+ )?(.+) (\S+)$/gm)) {
      for (const src of m[1].split(/\s+/)) assert.ok(fs.existsSync(path.join(REPO, src)), `${f}: COPY ${src}`);
    }
  }
});

test('nginx: no port 80, no default site, no off-origin log of bodies', () => {
  const main = read('images/web/nginx.conf');
  const srv = read('install/templates/nginx/cflex-console.conf');
  assert.doesNotMatch(main + srv, /listen\s+80\b/);
  assert.match(main, /^\s*include \/opt\/cflex\/nginx\.d\/\*\.conf;$/m);
  assert.match(main, /^pid \/tmp\/nginx\.pid;$/m);
  assert.doesNotMatch(main, /\$request_body|\$http_cookie|\$args|\$request_uri/);
  assert.match(srv, /listen @@LISTEN_PORT@@ ssl http2;/);
});

test('RHEL only: install.sh has no apt/NodeSource/git clone; bare path uses AppStream nodejs:20', () => {
  const sh = read('probe-agent/install.sh');
  const code = sh.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /apt-get|\bapt\b|nodesource|deb\.|git clone|curl /i);
  assert.match(sh, /cflex-install/);
  assert.match(sh, /rhel:8\.10/);
  const deploy = read('install/lib/cflex_install/deploy.py');
  assert.match(deploy, /"nodejs:20"/);
  assert.match(deploy, /"dnf", "-y", "module", "enable"/);
});

test('cflex/app HEALTHCHECK script: 200 healthy, 503 and down unhealthy', async () => {
  const http = require('http');
  const { execFile } = require('child_process');
  let code = 200;
  const server = http.createServer((q, r) => { r.writeHead(q.url === '/healthz' ? code : 404); r.end(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const run = () => new Promise(res => execFile(process.execPath, [path.join(REPO, 'images/app/healthcheck.js')],
    { env: { ...process.env, CONSOLE_PORT: String(port) } }, (e) => res(e ? e.code : 0)));
  assert.strictEqual(await run(), 0);
  code = 503;
  assert.strictEqual(await run(), 1);
  await new Promise(r => server.close(r));
  assert.strictEqual(await run(), 1);
});

test('env templates hold no secret values', () => {
  for (const f of ['install/templates/env/collector.env', 'install/templates/env/app.env']) {
    const t = read(f);
    assert.doesNotMatch(t, /^\s*[A-Z_]*(PASSWORD|COMMUNITY|TOKEN|SECRET|WEBHOOK)[A-Z_]*=(?!@@|\/)/m, f);
  }
});

test('launchers are executable in git and pass bash -n', () => {
  const { execFileSync } = require('child_process');
  for (const f of ['install/cflex-install', 'install/build-bundle', 'probe-agent/install.sh']) {
    execFileSync('bash', ['-n', path.join(REPO, f)]);
    const mode = execFileSync('git', ['-C', REPO, 'ls-files', '-s', f], { encoding: 'utf8' }).split(' ')[0];
    if (mode) assert.strictEqual(mode, '100755', `${f} must be committed executable`);
  }
});
