// node src/twin/canvas.test.mjs [url]
//
// Regression for the canvas height feedback loop: a canvas with no CSS size
// takes its box from its width/height attributes, which setSize writes, and a
// ResizeObserver on an auto-height parent then reads that back. On the live site
// it reached 16,777,216px — the canvas maximum — and the scene went black.
//
// Asserts the canvas never exceeds the viewport, and that it has settled.
import { createRequire } from 'node:module';

// puppeteer-core is a local dev tool, not an app dependency — the CI build must
// not have to install a browser driver. Skip cleanly when it is not around.
const require_ = createRequire(import.meta.url);
let puppeteer;
for (const p of ['puppeteer-core', '/tmp/twin-verify/node_modules/puppeteer-core', process.env.PUPPETEER_CORE].filter(Boolean)) {
  try { puppeteer = require_(p); break; } catch { /* keep looking */ }
}
if (!puppeteer) {
  console.log('skip - puppeteer-core not installed (set PUPPETEER_CORE=<path> to run this check)');
  process.exit(0);
}

const URL = process.argv[2] || 'http://localhost:5174/twin/#/twin';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 950 },
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
await new Promise(r => setTimeout(r, 3000));   // let the scene build

const measure = () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  return { attrH: c.height, cssH: c.clientHeight, wrapH: c.parentElement?.clientHeight ?? null, viewH: innerHeight };
});

const samples = [];
for (let i = 0; i < 4; i++) {
  await new Promise(r => setTimeout(r, 1500));
  samples.push(await measure());
}
// A resize is what kicks the loop off, so provoke one.
await page.setViewport({ width: 1280, height: 800 });
for (let i = 0; i < 3; i++) {
  await new Promise(r => setTimeout(r, 1200));
  samples.push(await measure());
}

let fail = 0;
for (const s of samples) {
  if (!s) { console.error('FAIL: no canvas'); fail++; break; }
  const over = s.cssH > s.viewH || s.attrH > s.viewH * 2 || s.wrapH > s.viewH;
  console.log(`${over ? 'FAIL' : 'ok  '} canvas attr ${s.attrH}px, css ${s.cssH}px, wrapper ${s.wrapH}px, viewport ${s.viewH}px`);
  if (over) fail++;
}
const last = samples.slice(-2);
if (last.length === 2 && last[0] && last[1] && last[0].cssH !== last[1].cssH) {
  console.error(`FAIL: canvas still changing after the resize settled (${last[0].cssH} → ${last[1].cssH})`);
  fail++;
}

await browser.close();
if (fail) { console.error(`\n${fail} failure(s) — the canvas is growing again.`); process.exit(1); }
console.log('\nok - canvas stays within the viewport and settles');
