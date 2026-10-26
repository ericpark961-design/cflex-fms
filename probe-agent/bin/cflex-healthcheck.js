#!/usr/bin/env node
// cflex-healthcheck — container HEALTHCHECK for the collector (images/collector).
// Exit 0 healthy, 1 unhealthy. Reads only the local stamp; no network, no config file.
'use strict';
const { check } = require('../src/health');

const r = check({ pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10) });
console.log(`${r.ok ? 'healthy' : 'unhealthy'}: ${r.reason}`);
process.exit(r.ok ? 0 : 1);
