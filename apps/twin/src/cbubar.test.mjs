// node src/cbubar.test.mjs
//
// The CBU selector used to exist only in the dashboard template, so every other
// screen silently showed a different site than the one the user had picked. It
// is now injected from one place — this asserts the injection point actually
// exists in every screen, and that no screen has re-grown its own copy.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const here = path.dirname(fileURLToPath(import.meta.url));
const screens = path.join(here, 'screens');
const tpls = readdirSync(screens).filter(f => f.endsWith('.tpl.html'));

// Mirrors mountCbuBar()'s host lookup. Kept in sync by eye; the point of the
// test is that each template HAS such a host, not that the selector is shared.
const hostOf = (doc) => doc.querySelector('main > div') || doc.querySelector('header') || doc.firstElementChild;

let fail = 0;
for (const f of tpls) {
  const raw = readFileSync(path.join(screens, f), 'utf8');
  const { document } = parseHTML(`<!doctype html><html><body>${raw}</body></html>`);
  const host = hostOf(document.body);
  const own = raw.match(/aria-label="CBU[^"]*"/g) || [];
  const ok = !!host && own.length === 0;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.padEnd(22)} host=${host ? `<${host.tagName.toLowerCase()}> ${host.children.length} children` : 'NONE'} own-bar=${own.length}`);
}

// The React screens have no template; assert they render the shared component.
for (const f of ['MapScreen.jsx', 'TwinScreen.jsx']) {
  const s = readFileSync(path.join(here, f), 'utf8');
  const ok = /<CbuBar\b/.test(s) && /from '\.\/cbubar'/.test(s);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.padEnd(22)} renders <CbuBar/>`);
}

// And that the shell mounts it for the template screens and the wall.
const app = readFileSync(path.join(here, 'App.jsx'), 'utf8');
const mounts = (app.match(/mountCbuBar\(/g) || []).length;
const okApp = mounts >= 2;
if (!okApp) fail++;
console.log(`${okApp ? 'ok  ' : 'FAIL'} App.jsx${' '.repeat(15)} mountCbuBar calls=${mounts} (wire + wall)`);

console.log(fail ? `\nFAIL: ${fail} screen(s) would show no CBU selector.` : '\nok - every screen gets the shared CBU selector');
process.exit(fail ? 1 : 0);
