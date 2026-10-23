// node backend/services/fms-pdf-gen.test.js
//
// The monthly Executive Report is SOW Deliverable 6, and the way it breaks is
// the problem: pdfkit's built-in Helvetica has no Korean glyphs, so a missing
// Korean font produces a PDF with blank cells and no error at all.
//
// The font path used to be hard-coded to the Debian layout. That exists on the
// Ubuntu host it was written on and does not exist on RHEL 8 (which installs
// Nanum under /usr/share/fonts/naver-nanum/) or inside a UBI8 container, which
// ships almost no fonts — and spec v1.4 §5-B.2 makes a UBI8 container the
// default deployment. So the report would have shipped silently broken.
//
// pdfkit and the DB are not importable here, so the font-resolution block is
// evaluated in isolation. That is the whole surface under test.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SRC = fs.readFileSync(path.join(__dirname, 'fms-pdf-gen.js'), 'utf8');
const BLOCK = SRC.slice(SRC.indexOf('const FONT_DIRS'), SRC.indexOf('// IBM Carbon palette'));

/** Evaluate the font block with a chosen env and __dirname. */
function resolve({ env = {}, dir = '/nonexistent-dir' } = {}) {
  const logs = [];
  const fake = { error: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) };
  const fn = new Function('process', 'fs', 'path', '__dirname', 'console',
    BLOCK + '; return { HAS_KO, FONT_REG, FONT_BOLD, FONT_DIRS };');
  return { ...fn({ env }, fs, path, dir, fake), logs };
}

let fail = 0;
const t = (name, f) => {
  try { f(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

t('the search order is explicit setting, then bundle, then distro layouts', () => {
  const { FONT_DIRS } = resolve();
  assert.ok(FONT_DIRS.some(d => d.includes('shared/fonts')), 'the bundle path is searched');
  assert.ok(FONT_DIRS.includes('/opt/app/cflex/shared/fonts'), 'the RHEL on-prem bundle path (§5-B)');
  assert.ok(FONT_DIRS.includes('/usr/share/fonts/naver-nanum'), 'the RHEL 8 package layout');
  assert.ok(FONT_DIRS.includes('/usr/share/fonts/truetype/nanum'), 'the Debian layout still works');
  // RHEL must come before Debian only in the sense that both are present; what
  // matters is that neither is the single hard-coded answer it used to be.
  assert.ok(!/const FONT_REG *= *'\/usr\/share/.test(SRC), 'no hard-coded absolute font path remains');
});

t('a missing font says so loudly instead of rendering blanks quietly', () => {
  const r = resolve({ env: { FMS_FONT_DIR: '/nonexistent' } });
  assert.equal(r.HAS_KO, false);
  assert.equal(r.FONT_REG, null);
  assert.equal(r.logs.length, 1, 'exactly one message, at load');
  assert.match(r.logs[0], /NO KOREAN FONT FOUND/);
  assert.match(r.logs[0], /BLANK/, 'it names the consequence, not just the condition');
  assert.match(r.logs[0], /FMS_FONT_DIR/, 'and how to fix it');
  for (const d of r.FONT_DIRS) assert.ok(r.logs[0].includes(d), `the message lists ${d}`);
});

t('an explicit setting wins, and a bold variant falls back to regular', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fontcheck-'));
  try {
    fs.writeFileSync(path.join(tmp, 'NanumGothic.ttf'), 'not a real font, only a path');
    const r = resolve({ env: { FMS_FONT_DIR: tmp } });
    assert.equal(r.HAS_KO, true);
    assert.equal(r.FONT_REG, path.join(tmp, 'NanumGothic.ttf'));
    // Bold is absent here. Falling back to regular keeps the report readable;
    // leaving it null would throw inside registerFont.
    assert.equal(r.FONT_BOLD, r.FONT_REG, 'bold falls back to regular rather than null');
    assert.deepEqual(r.logs, [], 'and nothing is logged when a font was found');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

t('the BarunGothic variant is accepted — it is what RHEL and Ubuntu both ship', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fontcheck2-'));
  try {
    fs.writeFileSync(path.join(tmp, 'NanumBarunGothic.ttf'), 'x');
    fs.writeFileSync(path.join(tmp, 'NanumBarunGothicBold.ttf'), 'x');
    const r = resolve({ env: { FMS_FONT_DIR: tmp } });
    assert.equal(r.HAS_KO, true);
    assert.match(r.FONT_REG, /NanumBarunGothic\.ttf$/);
    assert.match(r.FONT_BOLD, /NanumBarunGothicBold\.ttf$/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

t('the report does not need headless Chrome — v1.4 §5-B.2 forbids it', () => {
  assert.match(SRC, /require\('pdfkit'\)/, 'pdfkit, a library');
  for (const bad of ['puppeteer', 'playwright', 'chrome-launcher', 'chromium']) {
    assert.ok(!new RegExp(`require\\(['"\`][^'"\`]*${bad}`).test(SRC), `${bad} is not required`);
  }
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - a report with no font complains instead of lying');
process.exit(fail ? 1 : 0);
