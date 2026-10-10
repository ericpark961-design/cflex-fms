// node src/i18n.test.mjs
//
// Guards the dictionary against rot: a Korean string added to a template or to a
// *.logic.js sample would otherwise just stay Korean in EN mode, silently.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const screens = path.join(here, 'screens');

// i18n.js imports ./theme, which touches localStorage — read the literal instead.
const src = readFileSync(path.join(here, 'i18n.js'), 'utf8');
const body = src.slice(src.indexOf('export const EN'), src.indexOf('// Entity-decoded alias'));
const KEYS = new Set([...body.matchAll(/'((?:[^'\\]|\\.)*)'\s*:/g)].map(m => m[1].replace(/\\'/g, "'")));

const KO = /[가-힣]/;
const found = new Set();

for (const f of readdirSync(screens)) {
  const s = readFileSync(path.join(screens, f), 'utf8');
  if (f.endsWith('.tpl.html')) {
    for (const [, t] of s.matchAll(/>([^<>]*[가-힣][^<>]*)</g)) found.add(t.trim());
    for (const [, a] of s.matchAll(/(?:placeholder|title|aria-label)="([^"]*[가-힣][^"]*)"/g)) found.add(a.trim());
  } else if (f.endsWith('.logic.js')) {
    // the mockup stores each component as one escaped JS string
    const decoded = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    for (const [, t] of decoded.matchAll(/'([^'\n]{1,120})'/g)) if (KO.test(t)) found.add(t.trim());
  }
}

const missing = [...found].filter(k => k && !KEYS.has(k)).sort();
console.log(`dictionary keys : ${KEYS.size}`);
console.log(`strings in use  : ${found.size}`);
console.log(`untranslated    : ${missing.length}`);
missing.forEach(m => console.log('   -', m));

if (missing.length) {
  console.error('\nFAIL: add the strings above to src/i18n.js, or EN mode will show them in Korean.');
  process.exit(1);
}
console.log('\nok - every screen string has an English translation');
