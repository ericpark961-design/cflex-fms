#!/usr/bin/env node
// cflex-onboard — NMC onboarding (spec 04, D-15, WO-INT-014).
//
// An operator-run utility, not part of the probe runtime (D-12a): it talks to
// cards only while it runs, only to inventory addresses (option 1) or inside
// an explicit --scan CIDR (option 2), and its writes are the fixed SNMP scope
// in src/onboard/commands.js. Runs the same on a collector VM or an engineer
// laptop on the site LAN (the default advice — firewall v3 Form A has no
// collector → NMC TCP 22; docs/onboard/README.md).
//
//   cflex-onboard read    [--targets f] [--inventory csv] [--console url] (--credentials f | --ask)
//   cflex-onboard plan    … (dry-run; nothing is written)
//   cflex-onboard apply   … [--yes-all] [--disable-legacy] [--set-ntp]
//   cflex-onboard verify  … [--trap-test]
//   cflex-onboard scan    --scan <cidr>
const fs = require('fs');
const path = require('path');
const targetsLib = require('../src/onboard/targets');
const credsLib = require('../src/onboard/credentials');
const { createSshTransport } = require('../src/onboard/transport-ssh');
const { createHttpsTransport } = require('../src/onboard/transport-https');
const { readDevice, fromConfigIni } = require('../src/onboard/reader');
const { desiredFor, plan, recommendationsOf } = require('../src/onboard/planner');
const { applyAll, openCard, backup } = require('../src/onboard/applier');
const { createVerifier } = require('../src/onboard/verifier');
const { scan } = require('../src/onboard/scanner');
const report = require('../src/onboard/report');

const DEFAULT_SITE_YAML = '/opt/app/cflex/config/site.yaml';
const COMMANDS = ['read', 'plan', 'apply', 'verify', 'scan'];
const FLAGS = new Set(['ask', 'yes-all', 'disable-legacy', 'set-ntp', 'trap-test', 'ssh-legacy-algorithms', 'https-fallback', 'dry-run', 'help']);

const USAGE = `usage: cflex-onboard <read|plan|apply|verify|scan> [options]
  targets (option 1, default):  --targets <ip list|csv>  --inventory <csv>  --console <url> [--console-ca <pem>]
                                --site-yaml <path> (default ${DEFAULT_SITE_YAML}; nmc.targets_file, collectors, onboard:)
                                --site <SITE>  --ip <a,b>  --max-devices <n> (64)
  credentials:                  --credentials <onboard-credentials.yaml (0600)>  |  --ask
  apply:                        --yes-all  --disable-legacy  --set-ntp  --v3-profile <1-4>  --trap-receiver <ip>
  verify:                       --trap-test [--trap-port 162] [--trap-wait 60]
  scan (option 2):              --scan <cidr>  [--scan-rate 20]
  other:                        --out <dir> (./onboard)  --timeout <s> (30)  --https-fallback  --ssh-legacy-algorithms
                                --sim-map <json>  (simulator only: ip → 127.0.0.1 ports)`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith('--')) { a._.push(s); continue; }
    const k = s.slice(2);
    if (FLAGS.has(k)) a[k] = true;
    else if (i + 1 < argv.length) a[k] = argv[++i];
    else throw new Error(`--${k} needs a value`);
  }
  return a;
}

/** --sim-map: test simulators on loopback only — never a way to point at another host. */
function loadSimMap(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [ip, e] of Object.entries(m)) if (e.host !== '127.0.0.1') throw new Error(`--sim-map ${ip}: host must be 127.0.0.1`);
  return m;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] {prompt, log, env, simMap}
 * @returns {Promise<{code: number, results?, files?}>}
 */
async function main(argv, deps = {}) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const base = deps.log || console;
  if (a.help || !COMMANDS.includes(cmd)) { base.log(USAGE); return { code: a.help ? 0 : 2 }; }
  const env = deps.env || process.env;
  const prompt = deps.prompt || credsLib.createPrompt();
  const out = path.resolve(a.out || './onboard');
  report.ensureDir(out);
  const redactor = credsLib.createRedactor();
  const log = credsLib.safeLog(redactor, base);
  const audit = report.createAudit(out, redactor);
  const ts = report.stamp();
  const timeoutMs = (parseInt(a.timeout || '30', 10) || 30) * 1000;
  const simMap = deps.simMap || (a['sim-map'] ? loadSimMap(a['sim-map']) : null);

  try {
    // ── option 2 ──
    if (cmd === 'scan') {
      if (!a.scan) { log.error('scan needs --scan <cidr> (option 2 runs only on an explicit range)'); return { code: 2 }; }
      let community = null;
      if (a.credentials || a.ask) community = (await credsLib.loadCredentials({ path: a.credentials || null, askMode: !!a.ask, prompt, env, redactor })).scan?.community || null;
      audit.write('scan_start', { cidr: a.scan });
      const r = await scan({ cidr: a.scan, prompt, yes: !!a['yes-all'], community, rate: parseInt(a['scan-rate'] || '20', 10), log,
        endpoint: simMap ? (ip) => (simMap[ip] ? { host: '127.0.0.1', ssh: simMap[ip].ssh, https: simMap[ip].https, snmp: simMap[ip].snmp } : { host: ip, ssh: 22, https: 443, snmp: 161 }) : null,
        probeHost: deps.probeHost || null });
      const file = report.writePrivate(path.join(out, `scan-${ts}.json`), redactor.redact(JSON.stringify({ cidr: r.cidr, hosts: r.hosts, rate: r.rate, declined: !!r.declined, candidates: r.candidates }, null, 2)));
      audit.write('scan_end', { cidr: a.scan, candidates: r.candidates.length, declined: !!r.declined });
      log.log(`[onboard] ${r.declined ? 'scan declined' : `${r.candidates.length} candidate(s)`} → ${file}\n  candidates are not targets: add them to the inventory first (option 1)`);
      return { code: 0, scan: r, files: { scan: file } };
    }

    // ── option 1: the inventory ──
    const siteYamlPath = a['site-yaml'] || (fs.existsSync(DEFAULT_SITE_YAML) ? DEFAULT_SITE_YAML : null);
    const siteConf = siteYamlPath ? targetsLib.loadSiteYaml(siteYamlPath) : { collectors: [], onboard: {} };
    const creds = await credsLib.loadCredentials({ path: a.credentials || null, askMode: !!a.ask, prompt, env, redactor });
    const lists = [];
    const targetsFile = a.targets || siteConf.targetsFile;
    if (targetsFile && fs.existsSync(targetsFile)) lists.push(targetsLib.parseTargetsFile(fs.readFileSync(targetsFile, 'utf8'), { source: path.basename(targetsFile) }));
    if (a.inventory) lists.push(targetsLib.parseTargetsFile(fs.readFileSync(a.inventory, 'utf8'), { source: path.basename(a.inventory) }));
    let consoleApi = null;
    if (a.console) {
      if (!creds.console?.user) throw new Error('--console needs console: { user, password } in the credentials file');
      consoleApi = (deps.consoleApi || targetsLib.createConsoleApi)({ url: a.console, login: creds.console, ca: a['console-ca'] ? fs.readFileSync(a['console-ca']) : null });
      await consoleApi.login();
      lists.push(targetsLib.fromConsole(await consoleApi.devices()));
    }
    if (!lists.length) throw new Error('no inventory: give --targets, --inventory, --console or a site.yaml with nmc.targets_file');
    const targets = targetsLib.mergeTargets(lists, { site: a.site || null, only: a.ip ? a.ip.split(',').map(s => s.trim()) : null, maxDevices: parseInt(a['max-devices'] || '64', 10) });
    if (a.site == null) for (const t of targets) if (!t.site && env.CFLEX_ONBOARD_SITE) t.site = env.CFLEX_ONBOARD_SITE;
    const gate = targetsLib.createGate(targets);
    const endpoint = (ip) => (simMap?.[ip] ? { host: '127.0.0.1', port: simMap[ip].ssh, snmpPort: simMap[ip].snmp, httpsPort: simMap[ip].https } : { host: ip, port: 22, snmpPort: 161, httpsPort: 443 });
    const knownHostsPath = path.join(out, 'known_hosts.json');
    const ssh = createSshTransport({ gate, redactor, log, timeoutMs, knownHostsPath, endpoint, legacyAlgorithms: !!a['ssh-legacy-algorithms'],
      onCommand: (ip, line, kind) => audit.write('cli', { ip, kind, line }) });
    const web = createHttpsTransport({ gate, log, timeoutMs, endpoint, knownHostsPath });
    const verifier = createVerifier({ gate, endpoint, log, timeoutMs: deps.snmpTimeoutMs || 5000, retries: deps.snmpRetries ?? 1, trap: a['trap-test'] ? { port: parseInt(a['trap-port'] || '162', 10), waitMs: (parseInt(a['trap-wait'] || '60', 10)) * 1000 } : null });
    const flags = { yesAll: !!a['yes-all'], disableLegacy: !!a['disable-legacy'], setNtp: !!a['set-ntp'], v3Profile: a['v3-profile'] || null, trapReceiver: a['trap-receiver'] || null, dryRun: cmd === 'plan' || !!a['dry-run'] };
    const ctx = { creds, ssh, verifier, prompt, audit, log, out, consoleApi, settleMs: deps.settleMs, getTries: deps.getTries, emit: deps.emit };
    audit.write('run_start', { command: cmd, targets: targets.length, flags });
    log.log(`[onboard] ${cmd}: ${targets.length} target(s) from ${[...new Set(targets.flatMap(t => t.sources))].join(', ')}`);

    let results = [];
    if (cmd === 'read' || cmd === 'plan' || (cmd === 'apply' && flags.dryRun)) {
      for (const t of targets) {
        const r = { ip: t.ip, site: t.site || null, label: t.label || null };
        let cred = null;
        try { cred = creds.forTarget(t.ip); } catch { results.push({ ...r, status: 'skipped', reason: 'no_credentials' }); continue; }
        let read = null;
        if (cred.transport !== 'https') {
          const o = await openCard(ctx, t, { write: false, policy: {} });
          if (o.session) {
            try {
              read = await readDevice(o.session, { cred, factory: creds.isFactory(cred), redactor });
              if (cmd === 'read') r.backup = await backup(ctx, t, o.session, ts).catch(() => null);
            } catch (e) { Object.assign(r, { status: e.code === 'timeout' ? 'unreachable' : 'failed', reason: e.code || 'read_failed' }); } finally { o.session.close(); }
          } else Object.assign(r, o.result);
        }
        if (!read && (cred.transport === 'https' || (a['https-fallback'] && r.status === 'unreachable'))) {
          try {
            const ini = await web.readConfigIni(t, cred);
            read = fromConfigIni(ini.toString('utf8'), { redactor });
            read.factory_account = creds.isFactory(cred);
            if (cmd === 'read') r.backup = report.writePrivate(path.join(report.deviceDir(out, t), `config-${ts}.ini`), ini);
            delete r.reason;
          } catch (e) { Object.assign(r, { status: e.code === 'auth_failed' ? 'auth_failed' : 'unreachable', reason: `https: ${e.code || 'error'}` }); }
        }
        if (read) {
          r.read = read;
          r.status = 'ok';
          report.writePrivate(path.join(report.deviceDir(out, t), `read-${ts}.json`), redactor.redact(JSON.stringify({ target: t, read }, null, 2)));
          if (cmd !== 'read') {
            try {
              const p = plan(read, desiredFor(t, { siteConf, keys: await creds.v3Keys(t.site), flags }));
              Object.assign(r, { diff: p.diff, changes: [...p.steps, ...p.post].map(s => s.display), warnings: p.warnings, recommendations: p.recommendations, reason: p.status === 'blocked' ? p.reason : p.status });
              if (p.status === 'blocked') r.status = 'skipped';
            } catch (e) { Object.assign(r, { status: 'skipped', reason: e.message }); }
          } else r.recommendations = recommendationsOf(read);
        }
        results.push(r);
      }
    } else if (cmd === 'apply') {
      results = await applyAll(ctx, targets, siteConf, { ...flags, maintenanceMinutes: parseInt(a['maintenance-minutes'] || '120', 10) });
    } else if (cmd === 'verify') {
      for (const t of targets) {
        const r = { ip: t.ip, site: t.site || null, label: t.label || null };
        try {
          const d = desiredFor(t, { siteConf, keys: await creds.v3Keys(t.site), flags });
          const snmpR = await verifier.snmpV3Get(t.ip, d);
          const trapR = await verifier.trapTest(t.ip, d);
          r.verify = { snmp: snmpR, trap: trapR };
          r.status = snmpR.ok && trapR.status !== 'fail' ? 'ok' : 'failed';
          r.reason = snmpR.ok ? `PASS ${snmpR.model || ''}`.trim() : `FAIL snmpv3 ${snmpR.error}`;
        } catch (e) { Object.assign(r, { status: 'skipped', reason: e.message }); }
        audit.write('verify', { ip: t.ip, status: r.status, reason: r.reason });
        results.push(r);
      }
    }

    const inventory = report.compareInventory(targets, results);
    const files = report.writeReport(out, { command: cmd, ts, results, inventory, redactor, flags });
    log.log('\n' + report.table(results));
    log.log(`\n[onboard] report → ${files.md}\n[onboard] csv    → ${files.csv}`);
    audit.write('run_end', { command: cmd, results: Object.fromEntries(report.STATUSES.map(s => [s, results.filter(r => r.status === s).length])) });
    return { code: results.some(r => r.status === 'failed') ? 1 : 0, results, files, inventory };
  } catch (e) {
    const msg = redactor.redact(e.message);
    audit.write('run_error', { command: cmd, error: msg });
    log.error(`[onboard] ${msg}`);
    return { code: 2, error: msg };
  }
}

module.exports = { main, parseArgs, USAGE };

if (require.main === module) {
  main(process.argv.slice(2)).then((r) => { process.exitCode = r.code; });
}
