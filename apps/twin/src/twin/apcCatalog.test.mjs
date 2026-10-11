// node src/twin/apcCatalog.test.mjs
//
// The catalogue exists because iconIdForModel() returned 'srt5000' for anything
// it did not recognise, so five of the fleet's own units were drawn as a
// different machine and an unknown model was indistinguishable from a match.
import assert from 'node:assert';
import { APC_CATALOG, apcModel, rackUnits, specLine } from './apcCatalog.js';
import { deviceFace } from './deviceFaces.js';

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

t('every model in the live fleet resolves, and to the right unit', () => {
  // Exactly what ups_devices holds today.
  const fleet = {
    'Smart-UPS SRT 5000': 'srt5000',
    'Smart-UPS SRT 8000': 'srt8000',
    'Smart-UPS SRT 3000': 'srt3000',
    'Smart-UPS SRT 3000VA RM': 'srt3000',
    'Smart-UPS SRT 5000VA RM': 'srt5000',
    'SRYL15K15RMXLT': 'modular15k',          // was drawn as an SRT 5000
    'Smart-UPS Modular Ultra 20kW': 'modular20k',
    'Smart-UPS Modular Ultra 15kW': 'modular15k',
    'Symmetra PX 40kW': 'symmetra_px',       // was drawn as a Symmetra LX
    'Symmetra LX 16000 RM': 'symmetra_lx',
    'Smart-UPS X 3000': 'smx',               // was drawn as an SRT 5000
  };
  for (const [model, id] of Object.entries(fleet)) {
    const e = apcModel(model);
    assert.ok(e, `${model} resolves`);
    assert.equal(e.id, id, `${model} → ${id}, got ${e.id}`);
  }
});

t('an unknown model resolves to nothing rather than to some other machine', () => {
  for (const junk of ['Totally Unknown UPS 9000', 'Eaton 9PX', '', null, undefined, '   ']) {
    assert.equal(apcModel(junk), null, `${junk} must not match`);
  }
  // …and the drawing says so instead of showing an APC unit.
  const f = deviceFace({ kind: 'ups', label: 'X', model: 'Eaton 9PX 3000' });
  assert.match(f.caption, /카탈로그에 없는 모델/);
  assert.ok(!f.entry);
});

t('rack height comes from the catalogue and drives the drawing', () => {
  assert.equal(rackUnits('Smart-UPS SRT 3000'), 2);
  assert.equal(rackUnits('Smart-UPS SRT 5000'), 3);
  assert.equal(rackUnits('Smart-UPS SRT 8000'), 4);
  assert.equal(rackUnits('Smart-UPS Modular Ultra 20kW'), 7);
  assert.equal(rackUnits('Symmetra PX 40kW'), null, 'a cabinet has no rack height');

  const h = (m) => deviceFace({ kind: 'ups', label: 'X', model: m }).h;
  assert.ok(h('Smart-UPS SRT 3000') < h('Smart-UPS SRT 5000'), '2U is drawn shorter than 3U');
  assert.ok(h('Smart-UPS SRT 5000') < h('Smart-UPS SRT 8000'), '3U shorter than 4U');
  assert.ok(h('Smart-UPS SRT 8000') < h('Smart-UPS Modular Ultra 20kW'), '4U shorter than 7U');
});

t('a PDU draws the outlets the sheet lists', () => {
  const e = apcModel('AP8959');
  assert.equal(e.id, 'pdu_switched');
  assert.equal(e.outlets_c13, 20);
  assert.equal(e.outlets_c19, 4);
  assert.equal(e.rating_kw, 7.4);
  const f = deviceFace({ kind: 'ups', label: 'PDU', model: 'AP8959' });
  // 24 outlet rectangles, each drawn with the thin bezel stroke.
  const outlets = (f.svg.match(/rx="1\.5"[^>]*stroke-width="\.6"/g) || []).length;
  assert.equal(outlets, 24, `20 C13 + 4 C19, got ${outlets}`);
  assert.match(f.caption, /C13 20 · C19 4/);
});

t('the monitoring and sensor line is covered', () => {
  for (const [model, id] of [['NBES7550', 'netbotz750'], ['AP9640', 'nmc3'],
    ['AP9335T', 'sensor_th'], ['AP9335W', 'sensor_leak'], ['AP9335D', 'sensor_door'],
    ['AP4423A', 'rack_ats'], ['AP7552', 'pdu_basic'], ['AP8858', 'pdu_metered']]) {
    assert.equal(apcModel(model)?.id, id, `${model} → ${id}`);
  }
  assert.equal(apcModel('NBES7550').ports.sensor, 4, 'NetBotz 750 has 4 sensor ports');
  assert.equal(apcModel('NBES7550').sensors_max, 78);
});

t('battery packs are their own unit, not a UPS', () => {
  const e = apcModel('SRT192RMBP');
  assert.equal(e.id, 'srt192xbp');
  assert.equal(e.family, 'xbp');
  assert.equal(e.u, 3);
  // An XBP has no display, so its drawing has no LCD text.
  const f = deviceFace({ kind: 'ups', label: 'XBP', model: 'SRT192RMBP', status: 'ok' });
  assert.ok(!/Output/.test(f.svg), 'a battery pack shows no output reading');
});

t('the LCD reads out only when the device is actually reporting', () => {
  const live = deviceFace({ kind: 'ups', label: 'X', model: 'Smart-UPS SRT 5000', status: 'ok' });
  const dark = deviceFace({ kind: 'ups', label: 'X', model: 'Smart-UPS SRT 5000', status: 'nodata' });
  assert.match(live.svg, /Online/, 'a reporting unit shows a reading');
  assert.ok(!/Online/.test(dark.svg), 'a unit with no data does not show one');
  assert.match(dark.svg, /no data/);
});

t('where the sheets disagree, the entry carries both figures', () => {
  // The per-SKU sheet puts the SRT 8000 at 4U; the lineup sheet shows 5U with
  // the battery pack included. Picking one silently would be a guess.
  const srt8 = apcModel('Smart-UPS SRT 8000');
  assert.equal(srt8.u, 4);
  assert.equal(srt8.u_with_xbp, 5);
  assert.match(srt8.u_note, /4U.*5U|5U.*4U/);
  const m15 = apcModel('Smart-UPS Modular Ultra 15kW');
  assert.equal(m15.u, 7);
  assert.ok(m15.u_note, '15 kW is 7U on the dimensioned sheet and 5U on the lineup sheet');
  // and the screen shows the note
  assert.ok(deviceFace({ kind: 'ups', label: 'X', model: 'Smart-UPS SRT 8000' }).note);
});

t('specs transcribed from the sheets survive', () => {
  const srt3 = apcModel('Smart-UPS SRT 3000');
  assert.deepEqual([srt3.va, srt3.w, srt3.width_mm, srt3.height_mm, srt3.depth_mm], [3000, 2700, 482.6, 88.9, 635]);
  const m20 = apcModel('Smart-UPS Modular Ultra 20kW');
  assert.deepEqual([m20.kw, m20.module_kw, m20.modules, m20.depth_mm], [20, 10, 2, 700]);
  assert.match(specLine(srt3), /3,000 VA \/ 2,700 W · 2U/);
});

t('matching is ordered so a specific model wins over its family', () => {
  // 'Symmetra PX' must not be swallowed by the looser /Symmetra/ rule, and
  // SRTL (Li-ion) must not be taken by the SRT rule.
  assert.equal(apcModel('Symmetra PX 40kW').id, 'symmetra_px');
  assert.equal(apcModel('SRTL 5000RMXLI').id, 'srtl5000');
  assert.equal(apcModel('SRT 5000RMXLI').id, 'srt5000');
  assert.equal(apcModel('SRVRM 3000A').id, 'srvrm');
  assert.equal(apcModel('SRV 3000RLI').id, 'srv');
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - every catalogued model draws as itself');
process.exit(fail ? 1 : 0);
