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

test('better-sqlite3: built from source in the image, loaded before packaging, one driver (WO-INT-007)', () => {
  // No linux-x64 prebuild loads on RHEL 8's glibc 2.28, so the node images compile it and prove it loads.
  for (const f of ['images/collector/Containerfile', 'images/app/Containerfile']) {
    const run = read(f).match(/^RUN cd (?:probe-agent|apps\/console) \\\n(?: .*\\\n)* .*$/m)[0];
    assert.match(run, /npm_config_build_from_source=true npm install --omit=dev/, f);
    assert.match(run, /node -e "require\('better-sqlite3'\)\(':memory:'\)\.close\(\)[;"]/, f);
  }
  // The bundle is Node 20's ABI and the bare profile accepts nothing but Node 20.
  assert.match(read('install/lib/cflex_install/bundle.py'), /^NODE_ABI = "115"$/m);
  assert.match(read('install/lib/cflex_install/preflight.py'), /v\[0\] == 20/);
  assert.match(read('docs/install/CONTAINER_PROFILE.md'), /NODE_MODULE_VERSION 115/);
  // Production and tests open SQLite with the same driver: no node:sqlite anywhere in what ships or tests it.
  for (const dir of ['apps/console/src', 'apps/console/test', 'probe-agent/src', 'probe-agent/test', 'probe-agent/bin']) {
    for (const fn of fs.readdirSync(path.join(REPO, dir), { recursive: true })) {
      if (!/\.(c|m)?js$/.test(fn)) continue;
      const code = read(path.join(dir, fn)).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
      assert.doesNotMatch(code, /node:sqlite|DatabaseSync/, `${dir}/${fn}`);
    }
  }
  assert.ok(JSON.parse(read('apps/console/package.json')).dependencies['better-sqlite3']);
  assert.ok(JSON.parse(read('probe-agent/package.json')).dependencies['better-sqlite3']);
});

test('PostgreSQL 16 (WO-INT-008): pg the one new driver, no extension/pg_partman/repmgr, schema shipped in image and bundle, backup wired', () => {
  const pkg = JSON.parse(read('apps/console/package.json'));
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ['better-sqlite3', 'pg'], 'pg added, nothing else');
  assert.deepStrictEqual(Object.keys(pkg.devDependencies || {}), ['embedded-postgres'], 'the test PostgreSQL is a devDependency only');
  assert.match(pkg.devDependencies['embedded-postgres'], /^16\./, 'PostgreSQL 16 in the tests, as on db01');
  // The app image's npm install drops devDependencies, so embedded-postgres never ships.
  assert.match(read('images/app/Containerfile'), /npm install --omit=dev/);
  assert.match(read('images/app/Containerfile'), /require\('pg'\)/);
  assert.match(read('images/app/Containerfile'), /^COPY --chown=0:0 apps\/console\/migrations apps\/console\/migrations$/m);
  assert.match(read('install/lib/cflex_install/bundle.py'), /"requires": \["pg"\]/);
  const migs = fs.readdirSync(path.join(REPO, 'apps/console/migrations')).filter(f => f.endsWith('.sql'));
  assert.ok(migs.length >= 1 && migs.every(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)), migs.join());
  const sql = migs.map(f => read(path.join('apps/console/migrations', f))).join('\n');
  const code = ['db.js', 'partitions.js'].map(f => read(path.join('apps/console/src', f))).join('\n');
  for (const bad of [/CREATE\s+EXTENSION/i, /pg_partman/i, /repmgr/i, /\bcitext\b/i, /pgcrypto/i]) {
    assert.doesNotMatch(sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n'), bad, String(bad));
    assert.doesNotMatch(code.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'), bad, String(bad));
  }
  assert.match(sql, /PARTITION BY RANGE \(ts\)/);
  // db01: the fragment mounted where rhel8/postgresql-16 reads it; replica WAL + archiving; the timer daily.
  assert.match(read('install/templates/quadlet/cflex-postgres.container'), /^Volume=@@PG_CFG_DIR@@:\/opt\/app-root\/src\/postgresql-cfg:ro,Z$/m);
  const conf = read('install/templates/postgres/cflex-postgresql.conf');
  for (const k of [/^wal_level = replica$/m, /^archive_mode = on$/m, /^archive_command = /m]) assert.match(conf, k);
  assert.match(read('install/templates/systemd/cflex-pg-backup.timer'), /^OnCalendar=\*-\*-\* 02:30:00$/m);
  assert.match(read('install/scripts/cflex-pg-backup.sh'), /-X stream/);
  // The Collector's buffer stays SQLite.
  assert.match(read('probe-agent/src/buffer.js'), /require\('better-sqlite3'\)/);
  assert.doesNotMatch(read('probe-agent/src/buffer.js'), /require\('pg'\)/);
  // Secrets: the app reads db01's password from a file; the env template carries no value.
  assert.match(read('install/templates/env/app.env'), /^CFLEX_DB_PASSWORD_FILE=@@SECRETS_DIR@@\/pg\.pass$/m);
  assert.doesNotMatch(read('install/templates/env/app.env'), /^CFLEX_DB_URL=.*:[^@/]+@/m);
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

test('nginx, both profiles: between the app nodes only 443 — the app is reached on 127.0.0.1:8080 and nowhere else (Q-2026-10-25-10)', () => {
  for (const f of ['install/templates/nginx/cflex-console.conf', 'deploy/console/nginx-cflex-console.conf']) {
    const code = read(f).split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    const to8080 = [...code.matchAll(/(?:server|proxy_pass)\s+(?:https?:\/\/)?([^\s;:]+):8080/g)].map(m => m[1]);
    assert.deepStrictEqual([...new Set(to8080)], ['127.0.0.1'], `${f}: ${to8080.join(', ')}`);
    assert.doesNotMatch(code, /\bbackup;/, `${f}: no 8080 backup upstream on the peer`);
  }
  // The peer hop itself is rendered into @@PEER_LOCATION@@ (render.py); the reference copy shows it.
  const ref = read('deploy/console/nginx-cflex-console.conf');
  assert.match(ref, /error_page 502 504 = @peer;/);
  assert.match(ref, /proxy_pass https:\/\/10\.138\.14\.68:443;/);
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
