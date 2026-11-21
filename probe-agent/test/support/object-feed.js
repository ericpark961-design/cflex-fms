// Test-only preload: `node -r test/support/object-feed.js src/index.js`.
//
// The Local Console has no feed for non-UPS devices yet — forwarder.js
// fetchObjectConfig() returns [] (Q-2026-10-26-14) — so a collector started
// against it never polls a CRAC or a contact module. modbus.e2e.test.js needs
// the real cycle to poll two, so this hands the unchanged agent its object list
// from E2E_OBJECTS (JSON). Everything else — the cycle, the collectors, the
// forwarder, the console client — is the production code, unmodified.
//
// Never loaded outside tests: nothing in src/ or the installer references it.
const forwarder = require('../../src/forwarder');

const objects = JSON.parse(process.env.E2E_OBJECTS || '[]');
forwarder.fetchObjectConfig = async () => objects;
