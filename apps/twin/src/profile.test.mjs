// node src/profile.test.mjs
//
// WO-INT-004c / DECISIONS Q-2026-10-25-09 (B): the HAEA Local Console build
// (`npm run build:console`, CONSOLE_PROFILE=internal) has no route, menu entry
// or API call for a portal screen — 3D twin, NOC wall, power chain, alarm map,
// Copilot. Checked on the real templates, then on a real build of each
// console profile: the internal one must be clean, and the portal one must
// not be — otherwise the scan would be proving nothing.
import assert from 'node:assert';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PORTAL_ROUTES } from './profile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (f) => readFileSync(path.join(here, f), 'utf8');

let fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

// What counts as a way into a portal screen, in templates and in the bundle.
const ROUTE = new RegExp(`#/(?:${PORTAL_ROUTES.join('|')})(?=[?/"'\`]|$)`, 'g');
const COPILOT = /panel=copilot/g;
// An API path as a call site writes it — quoted, at the start of the string —
// not a message that mentions one ("no endpoint (/v1/fms/copilot) yet").
// (/v1/incidents is the alarm workbench's, an internal screen; the console
// answers 404 and the workbench shows the raw alarm.)
const PORTAL_API = /["'`]\/v1\/fms\/(?:copilot|power-chain|topology|sites-map|routes|control)\b/g;
// Libraries only the portal screens use.
const PORTAL_LIBS = /maplibre|WebGLRenderer|OrbitControls/g;

const { internalTemplate } = await import(path.join(root, 'vite.console.config.js'));
const TEMPLATES = readdirSync(path.join(here, 'screens')).filter(f => f.endsWith('.tpl.html'));

await t('templates: the internal profile removes every link and form into a portal screen', () => {
  for (const f of ['Main.tpl.html', 'Device.tpl.html', 'Alarms.tpl.html']) {
    const raw = read(`screens/${f}`);
    assert.ok(raw.match(ROUTE)?.length, `${f}: the portal build has them (the check is live)`);
    const out = internalTemplate(raw);
    assert.deepStrictEqual(out.match(ROUTE) || [], [], `${f}: ${(out.match(ROUTE) || []).join(', ')}`);
    assert.deepStrictEqual(out.match(COPILOT) || [], [], f);
    assert.ok(!/<form\b[^>]*action="#\//.test(out), `${f}: the ask-the-AI form`);
    // What stays: the internal screens and the console's Settings in place of FMS 1.x.
    for (const keep of ['href="#/dashboard"', 'href="#/devices"', 'href="#/alarms"', 'href="/settings"']) assert.ok(out.includes(keep), `${f}: ${keep}`);
    assert.ok(!out.includes('href="/fms"'), `${f}: no FMS 1.x link`);
    // Only whole elements are removed: as many closing tags go as opening ones.
    const count = (s, re) => (s.match(re) || []).length;
    for (const tag of ['a', 'form', 'div', 'section', 'svg']) {
      const opened = count(raw, new RegExp(`<${tag}\\b`, 'g')) - count(out, new RegExp(`<${tag}\\b`, 'g'));
      const closed = count(raw, new RegExp(`</${tag}>`, 'g')) - count(out, new RegExp(`</${tag}>`, 'g'));
      assert.strictEqual(opened, closed, `${f}: removed <${tag}> ${opened} vs </${tag}> ${closed}`);
    }
  }
  assert.ok(TEMPLATES.length >= 5);
});

async function buildProfile(profile) {
  const { build } = await import('vite');
  const out = mkdtempSync(path.join(tmpdir(), `twin-${profile}-`));
  process.env.CONSOLE_PROFILE = profile;
  try {
    await build({ root, configFile: path.join(root, 'vite.console.config.js'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
  } finally { delete process.env.CONSOLE_PROFILE; }
  const assets = path.join(out, 'assets');
  const text = readdirSync(assets).filter(f => /\.(js|css)$/.test(f)).map(f => readFileSync(path.join(assets, f), 'utf8')).join('\n')
    + readFileSync(path.join(out, 'index.html'), 'utf8');
  rmSync(out, { recursive: true, force: true });
  const hits = (re) => [...new Set(text.match(re) || [])];
  return { routes: hits(ROUTE), copilot: hits(COPILOT), api: hits(PORTAL_API), libs: hits(PORTAL_LIBS), size: text.length };
}

let portal;
await t('build, CONSOLE_PROFILE=portal: the portal screens are there (the scan can see them)', async () => {
  portal = await buildProfile('portal');
  assert.ok(portal.routes.length >= 4, portal.routes.join(' '));
  assert.ok(portal.api.length > 0 && portal.libs.length > 0, JSON.stringify(portal));
});

await t('build, CONSOLE_PROFILE=internal: 0 routes, 0 menu links, 0 API calls to a portal screen; three/maplibre not bundled', async () => {
  const internal = await buildProfile('internal');
  assert.deepStrictEqual(internal.routes, [], 'routes/links');
  assert.deepStrictEqual(internal.copilot, [], 'copilot panel links');
  assert.deepStrictEqual(internal.api, [], 'portal API calls');
  assert.deepStrictEqual(internal.libs, [], 'portal-only libraries');
  assert.ok(portal && internal.size < portal.size / 2, `internal ${Math.round(internal.size / 1024)} KB vs portal ${Math.round((portal?.size || 0) / 1024)} KB`);
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - the internal console build has no portal screen: no route, no menu entry, no API call');
process.exit(fail ? 1 : 0);
