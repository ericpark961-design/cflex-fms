// node src/twin/equipmentPhoto.test.mjs
//
// The photo layer must never show a picture of a different machine. It maps a
// catalogue id to a crop from the same sheet the catalogue was transcribed
// from; anything it cannot map falls back to the generated faceplate.
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PHOTO_OF, photoIdFor, VIEW_LABEL, orderViews } from './equipmentPhoto.js';
import { catalogModel } from './catalog.js';
import { APC_CATALOG } from './apcCatalog.js';
import { VERTIV_CATALOG } from './vertivCatalog.js';
import { CISCO_CATALOG } from './ciscoCatalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = new Set(
  readdirSync(path.join(here, '..', 'assets', 'equipment'))
    .filter(f => f.endsWith('.webp'))
    .map(f => f.replace(/\.webp$/, '')),
);
const viewsOf = (pid) => ['front', 'side', 'rear', 'internal', 'top', 'hero'].filter(v => files.has(`${pid}_${v}`));

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

t('every mapped photo id actually has files on disk', () => {
  for (const [catId, photoId] of Object.entries(PHOTO_OF)) {
    const v = viewsOf(photoId);
    assert.ok(v.length, `${catId} → ${photoId} has no image files`);
    assert.ok(v.includes('front') || v.includes('hero'), `${photoId} has at least a front or hero view`);
  }
});

t('every mapping points at a catalogue id that exists', () => {
  const ids = new Set([...APC_CATALOG, ...VERTIV_CATALOG, ...CISCO_CATALOG].map(e => e.id));
  for (const catId of Object.keys(PHOTO_OF)) {
    assert.ok(ids.has(catId), `${catId} is not a catalogue id`);
  }
});

t('the live fleet is photographed, with the right unit', () => {
  const fleet = {
    'Smart-UPS SRT 5000': 'srt5000_rm',
    'Smart-UPS SRT 8000': 'srt8000_rm',
    'Smart-UPS SRT 3000VA RM': 'srt3000_rm',
    'Symmetra PX 40kW': 'symmetra_px',
    'Symmetra LX 16000 RM': 'symmetra_lx',
    'Smart-UPS Modular Ultra 20kW': 'modular20k',
    'SRYL15K15RMXLT': 'modular15k',
    'Smart-UPS X 3000': 'smx_rm',
    'Catalyst 9300-48P': 'cisco_c9300',
    'Catalyst 9500-48Y4C': 'cisco_c9500',
    'UCS C220 M6': 'cisco_ucs_c220',
    'ISR 4451 CUBE': 'cisco_isr4451',
    'Patch Panel 24': 'patch24_photo',
  };
  for (const [model, photoId] of Object.entries(fleet)) {
    const got = photoIdFor(catalogModel(model));
    assert.equal(got, photoId, `${model} → ${photoId}, got ${got}`);
    assert.ok(viewsOf(got).includes('front'), `${model} has a front photo`);
  }
});

t('a model with no photograph returns null, not a near miss', () => {
  // The three small Modular Ultra variants are catalogued but not photographed.
  for (const id of ['modular5k', 'modular8k', 'modular12k']) {
    assert.equal(PHOTO_OF[id], undefined, `${id} has no photo mapping`);
  }
  assert.equal(photoIdFor(catalogModel('Smart-UPS Modular Ultra 8 kW')), null);
  // And a model outside every catalogue has nothing at all.
  assert.equal(photoIdFor(catalogModel('PowerEdge R650')), null);
  assert.equal(photoIdFor(null), null);
});

t('no two unrelated models share a photo by accident', () => {
  // Deliberate sharing is fine (a 9300 and a 9300-48P are the same chassis);
  // sharing across families is not.
  const byPhoto = {};
  for (const [catId, photoId] of Object.entries(PHOTO_OF)) (byPhoto[photoId] ||= []).push(catId);
  const families = (ids) => new Set(ids.map(id => {
    const e = [...APC_CATALOG, ...VERTIV_CATALOG, ...CISCO_CATALOG].find(x => x.id === id);
    return e?.family;
  }));
  for (const [photoId, ids] of Object.entries(byPhoto)) {
    if (ids.length < 2) continue;
    assert.equal(families(ids).size, 1, `${photoId} is shared across families: ${ids.join(', ')}`);
  }
});

t('the detail screen prefers a photograph over a drawing', () => {
  const src = readFileSync(path.join(here, '..', 'deviceFace.js'), 'utf8');
  assert.match(src, /photoFor\(/, 'it asks for a photo first');
  const photoAt = src.indexOf('photoFor(');
  const drawAt = src.indexOf('deviceFace({');
  assert.ok(photoAt > 0 && photoAt < drawAt, 'and does so before falling back to the generated faceplate');
});

t('every view has a label, and the picker order is stable', () => {
  const seen = new Set();
  for (const photoId of new Set(Object.values(PHOTO_OF))) viewsOf(photoId).forEach(v => seen.add(v));
  for (const v of seen) assert.ok(VIEW_LABEL[v], `view "${v}" has a label`);
  // front always comes first, whatever order the files were listed in.
  assert.deepEqual(orderViews(['rear', 'front', 'side']), ['front', 'side', 'rear']);
  assert.deepEqual(orderViews([]), []);
});

t('the photo set covers the catalogue broadly', () => {
  const all = [...APC_CATALOG, ...VERTIV_CATALOG, ...CISCO_CATALOG];
  const covered = all.filter(e => PHOTO_OF[e.id]).length;
  assert.ok(covered / all.length > 0.9, `${covered}/${all.length} catalogued models are photographed`);
});

t('one decision point feeds the panel, the elevation and the 3D box', () => {
  const vis = readFileSync(path.join(here, 'deviceVisual.js'), 'utf8');
  // photo → generated faceplate → generic, in that order and nowhere else.
  const photoAt = vis.indexOf('photoFor(');
  const faceAt = vis.indexOf('deviceFace({');
  assert.ok(photoAt > 0 && photoAt < faceAt, 'a photograph is preferred over a drawing');
  assert.match(vis, /source: 'photo'/);
  assert.match(vis, /source: entry \? 'faceplate' : 'generic'/);

  // and the 3D units go through it rather than resolving models themselves
  const models = readFileSync(path.join(here, 'upsModels.js'), 'utf8');
  assert.match(models, /applyPhotoFace\(face, d\)/, 'the 3D front is textured from it');
  assert.match(models, /export function setDeviceVisual/, 'injected, because deviceVisual needs kindOf from here');
  assert.ok(!/from '\.\/deviceVisual'/.test(models), 'and not imported directly, which would be a cycle');

  const scene = readFileSync(path.join(here, 'LedgerScene.js'), 'utf8');
  assert.match(scene, /setDeviceVisual\(deviceVisual\)/, 'the scene wires the two together');
  assert.match(scene, /function rackView/, 'and can stand in front of a rack');
  assert.match(scene, /rackView\s*\}/, 'exposing it on the scene handle');
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - every photograph is of the model it is attached to');
process.exit(fail ? 1 : 0);
