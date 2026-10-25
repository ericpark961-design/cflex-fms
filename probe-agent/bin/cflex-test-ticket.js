#!/usr/bin/env node
// cflex-test-ticket — the SOW acceptance "ITSM eBonding test ticket".
//
// Opens a ServiceNow incident with the configured credentials, adds a work
// note, resolves it, and prints the INC number for the acceptance record.
// The Local Console button (WO-INT-004) calls the same testTicket().
//
//   cflex-test-ticket --config /opt/app/cflex/config/notify.json [--keep-open] [--json]
//
// Exit: 0 ticket created (and resolved), 1 a step failed, 2 usage.
// Credentials come from the config file (…File keys preferred); never from argv.
const path = require('path');
const { createLocalNotifier, loadNotifyConfig } = require('../src/alarms/local-notify');
const transport = require('../src/portal/transport');

function args(argv) {
  const a = { json: false, keepOpen: false, config: process.env.CFLEX_NOTIFY_CONFIG || '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') a.config = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--keep-open') a.keepOpen = true;
    else if (argv[i] === '-h' || argv[i] === '--help') a.help = true;
    else { a.bad = argv[i]; }
  }
  return a;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help || a.bad || !a.config) {
    console.error(`${a.bad ? `unknown argument: ${a.bad}\n` : ''}usage: cflex-test-ticket --config notify.json [--keep-open] [--json]`);
    return 2;
  }
  const config = loadNotifyConfig(path.resolve(a.config));
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  const ca = transport.loadTls({ caPath: process.env.CFLEX_PROXY_CA || '' }).ca;
  const n = createLocalNotifier({ config, request: transport.request, proxy, noProxy, ca });
  const r = await n.testTicket({ resolve: !a.keepOpen });
  if (a.json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`OK  ServiceNow test ticket ${r.number} created${r.resolved ? ', updated and resolved' : ' and updated (left open)'}`);
  else console.log(`FAIL at ${r.step || 'config'}: ${r.error}${r.number ? ` (ticket ${r.number})` : ''}`);
  return r.ok ? 0 : 1;
}

if (require.main === module) {
  main().then(code => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}

module.exports = { main, args };
