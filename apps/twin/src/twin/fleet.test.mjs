// node src/twin/fleet.test.mjs
//
// The real fleet, from the Q3 2026 PM survey (spec v1.2 appendix C). 48 units
// across HMA / KUS / HAEA HQ.
//
// This exists because the catalogue resolved 7 of those 48. APC labels
// hardware with PART NUMBERS — the chassis, Exhibit 1 and the PM reports all
// say 'SRT5KRMXLT', never 'Smart-UPS SRT 5000' — and the matchers only knew
// the marketing form. 41 units therefore had no rack height, no kW rating, no
// photograph and no battery-life family: the 3D rack drew them as slabs and
// the capacity module reported 정격 미상 for most of the site.
//
// A catalogue that cannot name the customer's own hardware is not a catalogue,
// so the customer's hardware is the test.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { catalogModel, normalizeModel, MODEL_TYPOS } from './catalog.js';
import { photoFor } from './equipmentPhoto.js';
import { upsRating, deviceU } from './capacity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const csv = readFileSync(path.join(here, 'haea_q3_2026_fleet.csv'), 'utf8').trim().split('\n');
const head = csv[0].split(',');
// Quoted fields contain commas (battery_status), so split respecting quotes.
const parse = (line) => {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return Object.fromEntries(head.map((h, i) => [h.trim(), (out[i] || '').trim()]));
};
const fleet = csv.slice(1).map(parse);

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

t('the survey is the 48 units the SOW and the site actually have', () => {
  assert.equal(fleet.length, 48);
  const bySite = {};
  for (const r of fleet) bySite[r.site] = (bySite[r.site] || 0) + 1;
  assert.deepEqual(bySite, { HMA: 35, KUS: 7, HAEA: 6 },
    'HMA is 35 on site against 31 in Exhibit 1 — the inventory must carry both');
  assert.equal(fleet.filter(r => r.exhibit1 !== 'Y').length, 2, 'two units are outside the SOW');
});

t('every model in the fleet resolves to a catalogue entry', () => {
  const unresolved = [];
  for (const r of fleet) {
    if (!catalogModel(r.model)) unresolved.push(`${r.unit} (${r.model})`);
  }
  assert.deepEqual(unresolved, [],
    `${unresolved.length} of ${fleet.length} units have no catalogue entry`);
});

t('part numbers are read, not just marketing names', () => {
  // The four that failed before, with the figure each one must produce.
  const cases = [
    ['SRT5KRMXLT', 'Smart-UPS SRT 5000', 3, 4500],
    ['SRT8KRMXLT', 'Smart-UPS SRT 8000', 4, 7200],
    ['SRYLF15KRMT', 'Smart-UPS Modular Ultra 15 kW', 7, 15000],
    ['SRYLF20KRMT', 'Smart-UPS Modular Ultra 20 kW', 7, 20000],
  ];
  for (const [part, label, u, watts] of cases) {
    const e = catalogModel(part);
    assert.ok(e, `${part} unresolved`);
    assert.equal(e.label, label);
    assert.equal(e.u, u, `${part} rack height`);
    assert.equal(upsRating({ model: part })?.watts, watts, `${part} rating`);
  }
  // And the marketing form still works — both spellings are in the field.
  assert.equal(catalogModel('Smart-UPS SRT 5000VA RM')?.id, 'srt5000');
  // A 10 kVA part number must not be read as a 1 kVA one.
  assert.equal(catalogModel('SRT10KRMXLT')?.id, 'srt10000');
  assert.equal(catalogModel('SRT1KRMXLA')?.id, 'srt1000');
});

t('a family with a kVA range takes its rating from the part number', () => {
  // Symmetra LX is "8–16 kVA" in the catalogue, so the entry cannot say which
  // frame is installed. SYAF16KRMT can: it is a 16 kVA frame.
  const e = catalogModel('SYAF16KRMT');
  assert.equal(e.id, 'symmetra_lx');
  assert.equal(e.u, null, 'the catalogue still does not claim a rack height it cannot know');
  const r = upsRating({ model: 'SYAF16KRMT' });
  assert.equal(r.watts, 14400, '16 kVA at 0.9 power factor');
  assert.match(r.basis, /부품번호 16 kVA/, 'and says where the figure came from');
  // The bare family name has no rating anywhere, and must not invent one.
  assert.equal(upsRating({ model: 'Symmetra LX' }), null);
});

t('a mistyped model is corrected, and the correction is visible', () => {
  // SRT300RMXLA-NC appears three times beside SRT3000RMXLA-NC three times.
  // There is no APC part number SRT300, so the reading is unambiguous — but
  // the fix must not pass as the record.
  const e = catalogModel('SRT300RMXLA-NC');
  assert.equal(e.id, 'srt3000');
  assert.equal(e.model_corrected_from, 'SRT300RMXLA-NC');
  assert.match(e.model_correction_why, /0 누락/);
  // A correct string carries no correction.
  assert.equal(catalogModel('SRT3000RMXLA-NC').model_corrected_from, undefined);
  assert.equal(normalizeModel('SRT5KRMXLT').corrected, false);
  // The typo map stays small and justified — it is not a dumping ground.
  assert.ok(Object.keys(MODEL_TYPOS).length <= 10);
  for (const [, v] of Object.entries(MODEL_TYPOS)) assert.ok(v.to && v.why);
});

t('the fleet is photographed and has a rack height', () => {
  const noPhoto = [], noU = [];
  for (const r of fleet) {
    if (!photoFor(r.model).photoId) noPhoto.push(`${r.unit} (${r.model})`);
    // Symmetra LX is a floor cabinet, so a U height is genuinely not a thing.
    const e = catalogModel(r.model);
    if (e?.form !== 'cabinet' && deviceU({ model: r.model, kind: 'ups' }) === 1) {
      noU.push(`${r.unit} (${r.model})`);
    }
  }
  assert.deepEqual(noPhoto, [], 'every surveyed unit has a photograph of its own model');
  assert.deepEqual(noU, [], 'and a rack height that is not the 1U default');
});

t('every surveyed unit has a usable rating for the capacity module', () => {
  const noRating = [];
  for (const r of fleet) if (!upsRating({ model: r.model })) noRating.push(`${r.unit} (${r.model})`);
  assert.deepEqual(noRating, [],
    'a UPS with no rating makes every headroom figure above it unanswerable');
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - the catalogue can name the customer\'s own hardware');
process.exit(fail ? 1 : 0);
