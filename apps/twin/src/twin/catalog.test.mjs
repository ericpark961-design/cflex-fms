// node src/twin/catalog.test.mjs
//
// One lookup over three vendor catalogues. The thing that must not happen is a
// model resolving to a different machine — that is what the whole catalogue
// effort is for.
import assert from 'node:assert';
import { catalogModel, catalogSpecLine, catalogNote, catalogUnits } from './catalog.js';
import { CISCO_CATALOG } from './ciscoCatalog.js';
import { VERTIV_CATALOG } from './vertivCatalog.js';
import { APC_CATALOG } from './apcCatalog.js';
import { deviceFace } from './deviceFaces.js';

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

t('every model in the live inventory resolves to the right vendor', () => {
  const live = {
    // ups_devices
    'Smart-UPS SRT 5000': 'APC', 'Smart-UPS SRT 8000': 'APC', 'SRYL15K15RMXLT': 'APC',
    'Symmetra PX 40kW': 'APC', 'Smart-UPS X 3000': 'APC',
    // fms_devices
    'Catalyst 9300-48P': 'Cisco', 'Catalyst 9500-48Y4C': 'Cisco',
    'UCS C220 M6': 'Cisco', 'ISR 4451 CUBE': 'Cisco', 'Patch Panel 24': 'Cisco',
  };
  for (const [model, vendor] of Object.entries(live)) {
    const e = catalogModel(model);
    assert.ok(e, `${model} resolves`);
    assert.equal(e.vendor, vendor, `${model} → ${vendor}, got ${e.vendor}`);
  }
});

t('a model outside every sheet resolves to nothing', () => {
  // Dell is in the fleet but not in any uploaded sheet.
  assert.equal(catalogModel('PowerEdge R650'), null);
  assert.equal(catalogModel('PowerEdge R750'), null);
  for (const junk of ['', null, undefined, '   ', 'Acme Widget 1']) assert.equal(catalogModel(junk), null);
});

t('vendors cannot steal each other’s models', () => {
  // Cisco runs first because its families are distinctive; check the loose
  // APC/Vertiv patterns do not swallow them.
  assert.equal(catalogModel('Catalyst 9500').vendor, 'Cisco');
  assert.equal(catalogModel('Nexus 9300').vendor, 'Cisco');
  assert.equal(catalogModel('Liebert PSI5').vendor, 'Vertiv');
  assert.equal(catalogModel('Liebert GXT5 10kVA').vendor, 'Vertiv');
  assert.equal(catalogModel('Smart-UPS SRT 5000').vendor, 'APC');
  assert.equal(catalogModel('Symmetra PX').vendor, 'APC');
});

t('rack height is a model fact, not a kind guess', () => {
  // A per-kind default made a 7U chassis and a 1U access switch the same size.
  assert.equal(catalogUnits('Nexus 9500'), 7);
  assert.equal(catalogUnits('Catalyst 9600'), 7);
  assert.equal(catalogUnits('MDS 9700'), 4);
  assert.equal(catalogUnits('Catalyst 9300-48P'), 1);
  assert.equal(catalogUnits('UCS C220 M6'), 1);
  assert.equal(catalogUnits('UCS C240 M6'), 2);
  assert.equal(catalogUnits('ISR 4451 CUBE'), 2);
  assert.equal(catalogUnits('48-Port Patch Panel'), 2);
  assert.equal(catalogUnits('Liebert EXM2'), null, 'a floor cabinet has no U');
});

t('a chassis keeps the height options the sheet lists', () => {
  const n9500 = catalogModel('Nexus 9500');
  assert.ok(Array.isArray(n9500.u_options) && n9500.u_options.length > 1);
  assert.ok(n9500.u_note, 'and says the two sheets disagree about them');
  assert.equal(catalogNote(n9500), n9500.u_note);
});

t('where sheets disagree the note survives to the caller', () => {
  for (const model of ['Smart-UPS SRT 8000', 'Liebert PSI5', 'Liebert APM2', 'Liebert ITA2', 'Nexus 9500']) {
    assert.ok(catalogNote(catalogModel(model)), `${model} carries a discrepancy note`);
  }
  // And a model the sheets agree on carries none.
  assert.equal(catalogNote(catalogModel('Catalyst 9300-48P')), null);
});

t('a front and a rear view exist for anything with a rear in the sheets', () => {
  for (const model of ['Smart-UPS SRT 5000', 'Liebert GXT5 10kVA', 'AP4423A', 'NBES7550', 'Liebert EXM2']) {
    const front = deviceFace({ kind: 'ups', label: 'X', model, view: 'front' });
    const rear = deviceFace({ kind: 'ups', label: 'X', model, view: 'rear' });
    assert.equal(front.view, 'front');
    assert.equal(rear.view, 'rear', `${model} has a rear view`);
    assert.ok(rear.hasRear);
    assert.notEqual(front.svg, rear.svg, `${model}'s rear is not its front`);
    assert.match(rear.svg, /aria-label="[^"]*후면부"/);
  }
});

t('cooling is drawn as cooling, not as a rack UPS', () => {
  const crac = deviceFace({ kind: 'crac', label: 'CRAC-2', model: 'Liebert PDX' });
  assert.equal(crac.entry.class, 'cooling');
  assert.ok(crac.h > deviceFace({ kind: 'ups', label: 'X', model: 'Smart-UPS SRT 3000' }).h,
    'a floor-standing CRAC is taller than a 2U UPS');
  assert.match(crac.caption, /항온항습/);
  const chiller = deviceFace({ kind: 'other', label: 'CH-1', model: 'Air-Cooled Chiller' });
  assert.match(chiller.caption, /칠러/);
});

t('every catalogue entry is well formed', () => {
  for (const [name, cat] of [['Cisco', CISCO_CATALOG], ['Vertiv', VERTIV_CATALOG], ['APC', APC_CATALOG]]) {
    const ids = new Set();
    for (const e of cat) {
      assert.ok(e.id, `${name}: every entry has an id`);
      assert.ok(!ids.has(e.id), `${name}: ${e.id} is unique`);
      ids.add(e.id);
      assert.ok(e.match instanceof RegExp, `${name}/${e.id} has a matcher`);
      assert.ok(e.label, `${name}/${e.id} has a label`);
      assert.ok(e.u == null || (Number.isInteger(e.u) && e.u >= 0), `${name}/${e.id} has a sane U`);
      // Its own label must resolve back to it, or the matcher is wrong.
      const back = catalogModel(e.label);
      assert.ok(back, `${name}/${e.id}: its own label "${e.label}" resolves`);
    }
  }
});

t('spec lines are built from the entry, never empty for a real model', () => {
  for (const model of ['Catalyst 9300-48P', 'Smart-UPS SRT 5000', 'Liebert EXM2', 'Liebert PDX', 'AP8959']) {
    const s = catalogSpecLine(catalogModel(model));
    assert.ok(s && s.length > 3, `${model} has a spec line, got ${s}`);
  }
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - three vendors, one lookup, no model drawn as another');
process.exit(fail ? 1 : 0);
