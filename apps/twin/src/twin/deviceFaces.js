// Front-panel drawings for non-UPS gear.
//
// The APC units already have photo-traced SVGs (upsIcons.js). Everything else in
// a rack — switches, servers, SBCs, patch panels, PDUs — had no picture at all,
// so the detail screen showed a name and a table.
//
// These are generated rather than stored as files, because the thing that makes
// a faceplate useful is that it matches the unit in front of you: a 24-port
// switch draws 24 ports and a 48-port draws 48, and the ports the device
// reports as up are lit. A static image would be a picture of some other switch.
//
// They are functional depictions — port layout, LEDs, uplink bay, drive bays —
// with the model text taken from the database. No vendor logos or wordmarks:
// the point is to recognise the unit, not to reproduce a brand.

const C = {
  face: '#2b2f36',        // faceplate
  faceEdge: '#15181c',
  bezel: '#1b1e23',
  port: '#14171b',        // unlit RJ45 cavity
  portRim: '#3c424b',
  portUp: '#2bd07a',      // link up
  portIdle: '#3a4049',
  led: '#2bd07a',
  ledWarn: '#f1c21b',
  ledOff: '#3a4049',
  ink: '#c7ccd4',
  inkDim: '#7f8792',
  screw: '#4a5058',
  drive: '#1e2227',
  driveLed: '#4589ff',
};

import { catalogModel, catalogSpecLine, catalogNote } from './catalog.js';

const APC = {
  bezel: '#0d1117',       // perforated front bezel
  bezelEdge: '#2a3038',
  vent: '#161b22',
  lcd: '#0d2a1d',         // the status LCD is green on these units
  lcdInk: '#7ad7a0',
  lcdOff: '#1a1f26',
  key: '#20262e',
  keyInk: '#8d96a3',
  mark: '#d8dee6',
  module: '#e8eaed',      // Modular Ultra power modules are light grey
  moduleEdge: '#b9bec5',
  moduleLed: '#2bd07a',
  outlet: '#101418',
  outletC19: '#141a20',
};

/** 1U is 44.45 mm; the drawing keeps the real proportion so 7U looks like 7U. */
const U_PX = 17;

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** Rack-ear screws and the faceplate itself, shared by every 19" unit. */
function chassis(w, h, label, sub) {
  return `
    <rect x="0" y="0" width="${w}" height="${h}" rx="3" fill="${C.face}" stroke="${C.faceEdge}" stroke-width="2"/>
    <rect x="0" y="0" width="${w}" height="${h}" rx="3" fill="none" stroke="#000" stroke-opacity=".35"/>
    ${[10, h - 10].map(cy => [12, w - 12].map(cx =>
      `<circle cx="${cx}" cy="${cy}" r="3.2" fill="${C.screw}" opacity=".9"/>`).join('')).join('')}
    <text x="26" y="${h / 2 - 3}" font-family="system-ui,sans-serif" font-size="${Math.min(13, h / 4)}"
          font-weight="600" fill="${C.ink}">${esc(label)}</text>
    ${sub ? `<text x="26" y="${h / 2 + 12}" font-family="system-ui,sans-serif" font-size="9" fill="${C.inkDim}">${esc(sub)}</text>` : ''}`;
}

/** Status LED stack on the left, as every managed switch has. */
function leds(x, y, states) {
  return states.map((st, i) =>
    `<circle cx="${x}" cy="${y + i * 9}" r="2.6" fill="${st === 'ok' ? C.led : st === 'warn' ? C.ledWarn : C.ledOff}"/>`
  ).join('');
}

/**
 * RJ45 ports in the standard two-row block, numbered the way the faceplate is
 * (odd on top). `up` lights the first `up` ports — the device reports a count,
 * not which ones, so this is explicitly a count and the caption says so.
 */
function portBlock(x, y, total, up, { pw = 11, ph = 9, gap = 2.5 } = {}) {
  const perRow = Math.ceil(total / 2);
  let out = '';
  let lit = 0;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < perRow; i++) {
      const n = row === 0 ? i * 2 + 1 : i * 2 + 2;   // 1,3,5… / 2,4,6…
      if (n > total) continue;
      const px = x + i * (pw + gap);
      const py = y + row * (ph + gap);
      const isUp = lit < up;
      if (isUp) lit++;
      out += `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="1" fill="${C.port}" stroke="${C.portRim}" stroke-width=".7"/>`
        + `<rect x="${px + 2}" y="${py + ph - 2.6}" width="${pw - 4}" height="1.6" rx=".8" fill="${isUp ? C.portUp : C.portIdle}"/>`;
      // every 6th port gets a group separator, as on a real faceplate
      if ((i + 1) % 6 === 0 && i < perRow - 1) {
        out += `<line x1="${px + pw + gap / 2}" y1="${y - 2}" x2="${px + pw + gap / 2}" y2="${y + 2 * ph + gap + 2}" stroke="${C.faceEdge}" stroke-width="1"/>`;
      }
    }
  }
  return out;
}

/** The perforated vent that covers most of an SRT front panel. */
function ventPanel(x, y, w, h) {
  const cols = Math.max(6, Math.floor(w / 9));
  const rows = Math.max(2, Math.floor(h / 9));
  const dx = w / cols, dy = h / rows;
  let dots = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ox = x + dx * (c + 0.5) + (r % 2 ? dx / 2 : 0);
      if (ox > x + w - 2) continue;
      dots += `<circle cx="${ox.toFixed(1)}" cy="${(y + dy * (r + 0.5)).toFixed(1)}" r="${Math.min(2.2, dx / 3.2).toFixed(1)}" fill="${APC.vent}"/>`;
    }
  }
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${APC.bezel}" stroke="${APC.bezelEdge}" stroke-width="1"/>${dots}`;
}

/** The status LCD with the ESC / ▲ / OK / ▼ keypad, as every SRT carries. */
function lcdPanel(x, y, w, h, lines) {
  const kw = 22, kh = (h - 10) / 2;
  const sw = w - kw - 10;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${APC.key}" stroke="${APC.bezelEdge}" stroke-width="1"/>
    <rect x="${x + 4}" y="${y + 4}" width="${sw}" height="${h - 8}" rx="1" fill="${APC.lcd}"/>
    ${lines.map((ln, i) => `<text x="${x + 8}" y="${y + 15 + i * 11}" font-family="ui-monospace,monospace" font-size="8" fill="${APC.lcdInk}">${esc(ln)}</text>`).join('')}
    ${['ESC', 'OK'].map((k, i) => `
      <rect x="${x + sw + 7}" y="${y + 4 + i * (kh + 2)}" width="${kw}" height="${kh}" rx="1" fill="${APC.key}" stroke="${APC.bezelEdge}" stroke-width=".6"/>
      <text x="${x + sw + 7 + kw / 2}" y="${y + 4 + i * (kh + 2) + kh / 2 + 3}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="6" fill="${APC.keyInk}">${k}</text>`).join('')}`;
}

/** Rack ears with mounting holes, both sides. */
function rackEars(w, h) {
  const n = Math.max(2, Math.round(h / 18));
  let out = '';
  for (const ex of [0, w - 14]) {
    out += `<rect x="${ex}" y="0" width="14" height="${h}" rx="2" fill="${C.face}" stroke="${C.faceEdge}" stroke-width="1"/>`;
    for (let i = 0; i < n; i++) {
      out += `<circle cx="${ex + 7}" cy="${(h / (n + 1)) * (i + 1)}" r="2.4" fill="${APC.vent}" stroke="${APC.bezelEdge}" stroke-width=".6"/>`;
    }
  }
  return out;
}

/**
 * An APC unit drawn from its catalogue entry. Height follows the rack units, so
 * a 7U Modular Ultra is drawn three and a half times the height of a 2U SRT
 * rather than every UPS being one generic box.
 */
function apcFace({ entry, status }) {
  const e = entry;
  // Never a hard-coded wordmark: a Cisco switch routed through here was drawn
  // with "APC" on its faceplate.
  const brand = (e.vendor || 'APC').toUpperCase();
  const w = 470;
  // A floor-standing cabinet, a CRAC and a chiller are not 2U. Falling back to
  // the rack default drew a 2,000 mm EXM2 the same height as an SRT 3000.
  const u = e.u || (e.form === 'cabinet' ? 8 : e.form === 'crac' ? 6 : e.form === 'chiller' || e.form === 'outdoor' ? 5 : e.form === 'tower' ? 4 : 2);
  const h = Math.max(44, u * U_PX + 10);
  const inner = { x: 16, y: 5, w: w - 32, h: h - 10 };
  const st = ['ok', 'warn', 'critical'].includes(status) ? status : 'nodata';
  const live = st !== 'nodata';
  const lcdLines = live
    ? [`Output ${e.volts || '208.0 v'}`, '~ Online']
    : ['— — —', 'no data'];

  let body;
  if (e.family === 'modular') {
    // Power modules in bays, each with its own status LEDs, plus the colour
    // display these carry instead of the SRT's monochrome LCD.
    const bays = Math.max(2, e.modules || 3);
    const bayH = (inner.h - 22) / bays;
    body = `
      <rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" rx="2" fill="${APC.bezel}" stroke="${APC.bezelEdge}" stroke-width="1"/>
      <rect x="${inner.x + 6}" y="${inner.y + 5}" width="${inner.w - 130}" height="12" rx="1" fill="${APC.vent}"/>
      <text x="${inner.x + 10}" y="${inner.y + 14}" font-family="system-ui,sans-serif" font-size="8" font-weight="700" fill="${APC.mark}">${esc(brand)}</text>
      ${lcdPanel(inner.x + inner.w - 118, inner.y + 4, 112, 26, lcdLines)}
      ${Array.from({ length: bays }, (_, i) => {
        const by = inner.y + 22 + i * bayH;
        return `<rect x="${inner.x + 6}" y="${by}" width="${inner.w - 12}" height="${bayH - 3}" rx="1.5" fill="${APC.module}" stroke="${APC.moduleEdge}" stroke-width=".8"/>`
          + [0, 1, 2].map(j => `<circle cx="${inner.x + 14 + j * 7}" cy="${by + (bayH - 3) / 2}" r="1.8" fill="${j === 0 && live ? APC.moduleLed : '#aeb4bb'}"/>`).join('');
      }).join('')}
      <text x="${inner.x + 8}" y="${h - 8}" font-family="system-ui,sans-serif" font-size="7" fill="${C.inkDim}">${e.module_kw ? `${e.modules} × ${e.module_kw} kW · N+1` : 'MODULAR'}</text>`;
  } else if (e.family === 'xbp') {
    // A battery pack is the same bezel with no display.
    body = `${ventPanel(inner.x, inner.y, inner.w, inner.h)}
      <text x="${inner.x + 10}" y="${inner.y + 16}" font-family="system-ui,sans-serif" font-size="8" font-weight="700" fill="${APC.mark}">${esc(brand)}</text>
      <text x="${inner.x + 10}" y="${inner.y + 27}" font-family="system-ui,sans-serif" font-size="7" fill="${C.inkDim}">Smart-UPS XBP${e.vdc ? ` · ${e.vdc} VDC` : ''}</text>`;
  } else if (e.family === 'pdu') {
    // 0U vertical strip, drawn lying down so it fits the panel.
    const n = (e.outlets_c13 || 0) + (e.outlets_c19 || 0);
    const ow = (inner.w - 90) / Math.max(1, n);
    body = `
      <rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" rx="2" fill="${APC.bezel}" stroke="${APC.bezelEdge}" stroke-width="1"/>
      <text x="${inner.x + 8}" y="${inner.y + inner.h / 2 + 3}" font-family="system-ui,sans-serif" font-size="8" font-weight="700" fill="${APC.mark}">${esc(brand)}</text>
      ${e.metered ? lcdPanel(inner.x + 34, inner.y + 4, 46, inner.h - 8, ['230 V', '11.2 A']) : ''}
      ${Array.from({ length: n }, (_, i) => {
        const ox = inner.x + (e.metered ? 86 : 40) + i * ow;
        const isC19 = i >= (e.outlets_c13 || 0);
        return `<rect x="${ox}" y="${inner.y + inner.h / 2 - 7}" width="${Math.max(3, ow - 1.5)}" height="14" rx="1.5"
                      fill="${isC19 ? APC.outletC19 : APC.outlet}" stroke="${APC.bezelEdge}" stroke-width=".6"/>`
          + (e.switched ? `<rect x="${ox + 0.5}" y="${inner.y + inner.h / 2 + 8}" width="${Math.max(2, ow - 2.5)}" height="2" rx="1" fill="${live ? APC.moduleLed : '#3a4049'}"/>` : '');
      }).join('')}`;
  } else if (e.family === 'ats') {
    body = `
      <rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" rx="2" fill="${APC.bezel}" stroke="${APC.bezelEdge}" stroke-width="1"/>
      <text x="${inner.x + 8}" y="${inner.y + inner.h / 2 + 3}" font-family="system-ui,sans-serif" font-size="8" font-weight="700" fill="${APC.mark}">${esc(brand)}</text>
      ${lcdPanel(inner.x + 36, inner.y + 3, 120, inner.h - 6, ['Source A  230 V', 'Source B  231 V'])}
      ${Array.from({ length: e.outlets_c13 || 8 }, (_, i) =>
        `<rect x="${inner.x + 168 + i * 17}" y="${inner.y + inner.h / 2 - 7}" width="13" height="14" rx="1.5" fill="${APC.outlet}" stroke="${APC.bezelEdge}" stroke-width=".6"/>`).join('')}`;
  } else if (e.family === 'netbotz') {
    body = `${ventPanel(inner.x, inner.y, inner.w - 130, inner.h)}
      <text x="${inner.x + 10}" y="${inner.y + 16}" font-family="system-ui,sans-serif" font-size="8" font-weight="700" fill="${APC.mark}">${esc(brand)}</text>
      ${lcdPanel(inner.x + inner.w - 124, inner.y + 3, 118, inner.h - 6, ['NetBotz 750', '✓ Normal'])}`;
  } else if (e.family === 'nmc' || e.family === 'sensor') {
    body = `
      <rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" rx="2" fill="${APC.bezel}" stroke="${APC.bezelEdge}" stroke-width="1"/>
      <text x="${inner.x + 10}" y="${inner.y + inner.h / 2 + 3}" font-family="system-ui,sans-serif" font-size="8" font-weight="700" fill="${APC.mark}">${esc(brand)}</text>
      <text x="${inner.x + 44}" y="${inner.y + inner.h / 2 + 3}" font-family="system-ui,sans-serif" font-size="8" fill="${C.inkDim}">${esc(e.label)}</text>
      ${Object.keys(e.ports || {}).map((_, i) =>
        `<rect x="${inner.x + inner.w - 30 - i * 18}" y="${inner.y + inner.h / 2 - 6}" width="14" height="12" rx="1" fill="${C.port}" stroke="${C.portRim}" stroke-width=".7"/>`).join('')}`;
  } else if (e.class === 'cooling' || e.class === 'heat_rejection') {
    // A CRAC is a tall cabinet with a control display and a filter face; a
    // chiller or dry cooler is a frame with a fan bank on top. Drawing either
    // as a rack UPS was the reason all three CRACs in the ledger looked alike.
    const isOutdoor = e.form === 'chiller' || e.form === 'outdoor';
    body = `
      <rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" rx="2" fill="${APC.bezel}" stroke="${APC.bezelEdge}" stroke-width="1"/>
      ${isOutdoor
        ? fanBank(inner.x + 10, inner.y + 6, Math.min(26, inner.h / 2 - 4), Math.min(6, Math.floor((inner.w - 20) / 30)))
          + `<rect x="${inner.x + 10}" y="${inner.y + inner.h / 2 + 4}" width="${inner.w - 20}" height="${inner.h / 2 - 10}" rx="2" fill="${APC.vent}" stroke="${APC.bezelEdge}" stroke-width=".8"/>`
        : ventPanel(inner.x + 6, inner.y + 24, inner.w - 12, inner.h - 30)
          + lcdPanel(inner.x + 8, inner.y + 4, 92, 18, [e.label.replace(/^Liebert\s*/, '')])
          + `<text x="${inner.x + 108}" y="${inner.y + 16}" font-family="system-ui,sans-serif" font-size="7" fill="${C.inkDim}">${esc(e.airflow || '')}</text>`}
      <text x="${inner.x + 8}" y="${h - 7}" font-family="system-ui,sans-serif" font-size="7" fill="${C.inkDim}">${esc(e.cooling || '')}${e.capacity ? ` · ${esc(e.capacity)}` : ''}</text>`;
  } else {
    // SRT and the other rack UPS: vent bezel with the LCD on the right.
    body = `${ventPanel(inner.x, inner.y, inner.w - 130, inner.h)}
      <text x="${inner.x + 12}" y="${inner.y + inner.h - 10}" font-family="system-ui,sans-serif" font-size="9" font-weight="700" fill="${APC.mark}">${esc(brand)}</text>
      <text x="${inner.x + 12}" y="${inner.y + inner.h - 2}" font-family="system-ui,sans-serif" font-size="6" fill="${C.inkDim}">${esc(e.family === 'smx' ? 'Smart-UPS X' : 'Smart-UPS')}</text>
      ${lcdPanel(inner.x + inner.w - 124, inner.y + Math.max(2, (inner.h - 30) / 2), 118, Math.min(30, inner.h - 4), lcdLines)}`;
  }

  return { w, h, svg: `
    <rect x="0" y="0" width="${w}" height="${h}" rx="3" fill="${C.face}" stroke="${C.faceEdge}" stroke-width="2"/>
    ${rackEars(w, h)}
    ${body}` };
}

// ── rear views ───────────────────────────────────────────────────────
// What the sheets show on the back: the inlet, the outlet groups, the fans,
// the management ports, the battery connector, the bypass switch. Drawn from
// the same catalogue fields, so the rear of an 8-outlet unit has 8 outlets.

const IEC = { c13: { w: 13, h: 11, label: 'C13' }, c19: { w: 17, h: 13, label: 'C19' } };

function outletGroup(x, y, kind, n, groups) {
  const g = IEC[kind];
  const perGroup = groups > 1 ? Math.ceil(n / groups) : n;
  let out = '';
  let i = 0;
  for (let gi = 0; gi < Math.max(1, groups); gi++) {
    const gx = x + gi * (perGroup * (g.w + 3) + 14);
    for (let k = 0; k < perGroup && i < n; k++, i++) {
      const ox = gx + k * (g.w + 3);
      out += `<rect x="${ox}" y="${y}" width="${g.w}" height="${g.h}" rx="1.5" fill="${APC.outlet}" stroke="${APC.bezelEdge}" stroke-width=".7"/>`
        + `<rect x="${ox + 3}" y="${y + 2.5}" width="${g.w - 6}" height="${g.h - 5}" rx="1" fill="#000" opacity=".55"/>`;
    }
    if (groups > 1 && i <= n) {
      out += `<text x="${gx}" y="${y - 3}" font-family="system-ui,sans-serif" font-size="5.5" fill="${C.inkDim}">GROUP ${gi + 1}</text>`;
    }
  }
  return { svg: out, width: groups > 1 ? groups * (perGroup * (g.w + 3) + 14) : n * (g.w + 3) };
}

function fanBank(x, y, size, n) {
  return Array.from({ length: n }, (_, i) => {
    const cx = x + size / 2 + i * (size + 4);
    const cy = y + size / 2;
    const r = size / 2 - 1;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${APC.vent}" stroke="${APC.bezelEdge}" stroke-width=".8"/>`
      + Array.from({ length: 5 }, (_, b) => {
        const a = (b / 5) * Math.PI * 2;
        return `<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * r * 0.85).toFixed(1)}" y2="${(cy + Math.sin(a) * r * 0.85).toFixed(1)}" stroke="${APC.bezelEdge}" stroke-width=".9"/>`;
      }).join('')
      + `<circle cx="${cx}" cy="${cy}" r="${(r * 0.22).toFixed(1)}" fill="${APC.bezelEdge}"/>`;
  }).join('');
}

const PORT_LABEL = { network: 'NETWORK', serial: 'SERIAL', epo: 'EPO', usb: 'USB', console: 'CONSOLE',
  sensor: 'SENSOR', alink: 'A-LINK', dry: 'DRY', intellislot: 'INTELLISLOT' };

function portStrip(x, y, ports) {
  let out = '';
  let cx = x;
  for (const [k, n] of Object.entries(ports || {})) {
    for (let i = 0; i < n; i++) {
      const round = k === 'usb';
      out += round
        ? `<rect x="${cx}" y="${y + 2}" width="11" height="7" rx="1" fill="${C.port}" stroke="${C.portRim}" stroke-width=".7"/>`
        : `<rect x="${cx}" y="${y}" width="12" height="11" rx="1" fill="${C.port}" stroke="${C.portRim}" stroke-width=".7"/>`;
      cx += 15;
    }
    out += `<text x="${cx - (n * 15) + 1}" y="${y - 3}" font-family="system-ui,sans-serif" font-size="5" fill="${C.inkDim}">${PORT_LABEL[k] || k.toUpperCase()}</text>`;
    cx += 6;
  }
  return { svg: out, width: cx - x };
}

/** The back of a unit, from its catalogue entry's `rear` block. */
function rearFace({ entry }) {
  const r = entry.rear || {};
  const w = 470;
  const u = entry.u || (entry.form === 'cabinet' ? 8 : 2);
  const h = Math.max(48, u * U_PX + 10);
  const ix = 16, iy = 5, iw = w - 32, ih = h - 10;
  let body = `<rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" rx="2" fill="${APC.bezel}" stroke="${APC.bezelEdge}" stroke-width="1"/>`;
  let cx = ix + 8;
  const midY = iy + ih / 2;

  if (r.fans) {
    const size = Math.min(ih - 10, 30);
    body += fanBank(cx, midY - size / 2, size, Math.min(r.fans, Math.floor((iw - 160) / (size + 4))));
    cx += Math.min(r.fans, Math.floor((iw - 160) / (size + 4))) * (size + 4) + 8;
  }
  if (r.inlet) {
    body += `<rect x="${cx}" y="${midY - 8}" width="20" height="16" rx="2" fill="${APC.outlet}" stroke="${APC.bezelEdge}" stroke-width=".8"/>`
      + `<text x="${cx}" y="${midY - 11}" font-family="system-ui,sans-serif" font-size="5" fill="${C.inkDim}">INPUT</text>`
      + `<text x="${cx}" y="${midY + 19}" font-family="system-ui,sans-serif" font-size="5" fill="${C.inkDim}">${esc(r.inlet)}</text>`;
    cx += 30;
  }
  if (r.sources) {
    for (let i = 0; i < r.sources; i++) {
      body += `<rect x="${cx}" y="${midY - 8}" width="18" height="16" rx="2" fill="${APC.outlet}" stroke="${APC.bezelEdge}" stroke-width=".8"/>`
        + `<text x="${cx}" y="${midY - 11}" font-family="system-ui,sans-serif" font-size="5" fill="${C.inkDim}">SRC ${String.fromCharCode(65 + i)}</text>`;
      cx += 24;
    }
    cx += 4;
  }
  if (r.bypass) {
    body += `<circle cx="${cx + 11}" cy="${midY}" r="11" fill="#2b2f36" stroke="${APC.bezelEdge}" stroke-width="1"/>`
      + `<circle cx="${cx + 11}" cy="${midY}" r="7" fill="#b02a2a"/>`
      + `<rect x="${cx + 10}" y="${midY - 6}" width="2" height="8" rx="1" fill="#f2f2f2"/>`
      + `<text x="${cx}" y="${midY + 20}" font-family="system-ui,sans-serif" font-size="5" fill="${C.inkDim}">BYPASS</text>`;
    cx += 30;
  }
  for (const term of r.terminals || []) {
    body += `<rect x="${cx}" y="${midY - 10}" width="34" height="20" rx="2" fill="#1a1f26" stroke="${APC.bezelEdge}" stroke-width=".8"/>`
      + [0, 1, 2, 3].map(i => `<circle cx="${cx + 6 + i * 7}" cy="${midY}" r="2.4" fill="${APC.outlet}" stroke="${APC.bezelEdge}" stroke-width=".5"/>`).join('')
      + `<text x="${cx}" y="${midY - 13}" font-family="system-ui,sans-serif" font-size="4.6" fill="${C.inkDim}">${esc(term)}</text>`;
    cx += 40;
  }
  if (r.outlets) {
    for (const kind of ['c13', 'c19']) {
      const n = r.outlets[kind];
      if (!n) continue;
      const g = outletGroup(cx, midY - IEC[kind].h / 2, kind, n, kind === 'c13' ? (r.groups || 1) : 1);
      body += g.svg;
      cx += g.width + 10;
    }
  }
  if (r.ports) {
    const p = portStrip(cx, midY - 5, r.ports);
    body += p.svg;
    cx += p.width + 6;
  }
  if (r.battery) {
    body += `<rect x="${cx}" y="${midY - 9}" width="26" height="18" rx="2" fill="#1a1f26" stroke="#b02a2a" stroke-width="1"/>`
      + `<circle cx="${cx + 8}" cy="${midY}" r="4" fill="#b02a2a"/><circle cx="${cx + 18}" cy="${midY}" r="4" fill="#2b2f36"/>`
      + `<text x="${cx}" y="${midY + 20}" font-family="system-ui,sans-serif" font-size="5" fill="${C.inkDim}">BATTERY</text>`;
    cx += 34;
  }
  if (r.piping) {
    for (const pipe of r.piping) {
      body += `<circle cx="${cx + 9}" cy="${midY}" r="9" fill="none" stroke="#b8860b" stroke-width="3"/>`
        + `<text x="${cx - 2}" y="${midY + 22}" font-family="system-ui,sans-serif" font-size="4.6" fill="${C.inkDim}">${esc(pipe)}</text>`;
      cx += 26;
    }
  }
  if (r.mounting) {
    body += Array.from({ length: 8 }, (_, i) =>
      `<circle cx="${ix + 30 + i * 46}" cy="${midY}" r="3" fill="${APC.vent}" stroke="${APC.bezelEdge}" stroke-width=".7"/>`).join('');
  }

  return { w, h, svg: `
    <rect x="0" y="0" width="${w}" height="${h}" rx="3" fill="${C.face}" stroke="${C.faceEdge}" stroke-width="2"/>
    ${rackEars(w, h)}
    ${body}` };
}

function switchFace({ label, model, ports = 0, up = 0, kind = 'switch' }) {
  // An unknown port count draws no ports. Filling the bezel with a default 48
  // would make the picture assert a number nothing measured — the same reason
  // an empty trend is not drawn as a flat line.
  const known = ports > 0;
  const perRow = known ? Math.ceil(ports / 2) : 0;
  const blockW = known ? perRow * 13.5 : 150;
  const w = Math.max(430, 150 + blockW + 90);
  const h = 56;
  return { w, h, svg: `
    ${chassis(w, h, label, model)}
    ${leds(136, 16, ['ok', 'ok', 'off', 'off'])}
    <text x="144" y="19" font-family="system-ui,sans-serif" font-size="6" fill="${C.inkDim}">SYST</text>
    <text x="144" y="28" font-family="system-ui,sans-serif" font-size="6" fill="${C.inkDim}">ACT</text>
    <rect x="152" y="${h / 2 - 16}" width="${blockW + 8}" height="32" rx="2" fill="${C.bezel}"/>
    ${known
      ? portBlock(156, h / 2 - 12, ports, up)
      : `<text x="${152 + blockW / 2}" y="${h / 2 + 3}" text-anchor="middle"
               font-family="system-ui,sans-serif" font-size="9" fill="${C.inkDim}">포트 수 미수집</text>`}
    <rect x="${w - 80}" y="${h / 2 - 14}" width="68" height="28" rx="2" fill="${C.bezel}"/>
    <text x="${w - 76}" y="${h / 2 - 5}" font-family="system-ui,sans-serif" font-size="6" fill="${C.inkDim}">UPLINK</text>
    ${[0, 1, 2, 3].map(i => `<rect x="${w - 75 + i * 15}" y="${h / 2 - 1}" width="12" height="11" rx="1" fill="${C.port}" stroke="${C.portRim}" stroke-width=".7"/>`).join('')}
    <text x="26" y="${h - 7}" font-family="system-ui,sans-serif" font-size="8" fill="${C.inkDim}">${kind === 'router' ? 'ROUTER' : 'SWITCH'}${known ? ` · ${ports}P` : ''}</text>` };
}

function serverFace({ label, model, bays = 8 }) {
  const w = 430, h = 56;
  const bw = 18, bh = 34;
  return { w, h, svg: `
    ${chassis(w, h, label, model)}
    <rect x="140" y="${(h - bh) / 2}" width="${bays * (bw + 3) + 6}" height="${bh}" rx="2" fill="${C.bezel}"/>
    ${Array.from({ length: bays }, (_, i) => {
      const x = 143 + i * (bw + 3);
      return `<rect x="${x}" y="${(h - bh) / 2 + 3}" width="${bw}" height="${bh - 6}" rx="1.5" fill="${C.drive}" stroke="${C.portRim}" stroke-width=".7"/>`
        + `<rect x="${x + 3}" y="${(h - bh) / 2 + 6}" width="2" height="${bh - 12}" rx="1" fill="${C.driveLed}" opacity="${i < 2 ? 0.9 : 0.25}"/>`;
    }).join('')}
    <circle cx="${w - 46}" cy="${h / 2 - 6}" r="5.5" fill="${C.bezel}" stroke="${C.portRim}" stroke-width=".8"/>
    <circle cx="${w - 46}" cy="${h / 2 - 6}" r="2" fill="${C.led}"/>
    <text x="${w - 58}" y="${h / 2 + 12}" font-family="system-ui,sans-serif" font-size="6" fill="${C.inkDim}">PWR</text>
    <text x="26" y="${h - 7}" font-family="system-ui,sans-serif" font-size="8" fill="${C.inkDim}">SERVER · ${bays} BAY</text>` };
}

function sbcFace({ label, model, ports = 0, up = 0 }) {
  const known = ports > 0;
  const w = 430, h = 48;
  return { w, h, svg: `
    ${chassis(w, h, label, model)}
    ${leds(136, 14, ['ok', 'ok', 'off'])}
    <rect x="150" y="${h / 2 - 12}" width="${(known ? ports * 13.5 : 140) + 8}" height="26" rx="2" fill="${C.bezel}"/>
    ${known
      ? portBlock(154, h / 2 - 9, ports, up, { pw: 11, ph: 8, gap: 2.5 })
      : `<text x="224" y="${h / 2 + 3}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="${C.inkDim}">포트 수 미수집</text>`}
    <rect x="${w - 92}" y="${h / 2 - 9}" width="80" height="18" rx="2" fill="${C.bezel}"/>
    <text x="${w - 88}" y="${h / 2 + 3}" font-family="system-ui,sans-serif" font-size="7" fill="${C.inkDim}">CONSOLE · MGMT</text>
    <text x="26" y="${h - 6}" font-family="system-ui,sans-serif" font-size="8" fill="${C.inkDim}">SBC${known ? ` · ${ports}P` : ''}</text>` };
}

function patchFace({ label, model, ports = 24 }) {
  const w = 430, h = 44;
  const perRow = ports > 24 ? Math.ceil(ports / 2) : ports;
  const rows = ports > 24 ? 2 : 1;
  const pw = Math.min(14, (w - 160) / perRow - 2);
  return { w, h, svg: `
    ${chassis(w, h, label, model)}
    <rect x="140" y="${h / 2 - (rows === 2 ? 14 : 8)}" width="${perRow * (pw + 2) + 8}" height="${rows === 2 ? 28 : 16}" rx="2" fill="${C.bezel}"/>
    ${Array.from({ length: rows }, (_, r) =>
      Array.from({ length: Math.min(perRow, ports - r * perRow) }, (_, i) =>
        `<rect x="${144 + i * (pw + 2)}" y="${h / 2 - (rows === 2 ? 11 : 5) + r * 13}" width="${pw}" height="10" rx="1"
               fill="${C.port}" stroke="${C.portRim}" stroke-width=".7"/>`).join('')).join('')}
    <text x="26" y="${h - 6}" font-family="system-ui,sans-serif" font-size="8" fill="${C.inkDim}">PATCH · ${ports}P</text>` };
}

function pduFace({ label, model, outlets = 24 }) {
  const w = 430, h = 44;
  const ow = Math.min(13, (w - 160) / outlets - 2);
  return { w, h, svg: `
    ${chassis(w, h, label, model)}
    ${Array.from({ length: outlets }, (_, i) =>
      `<circle cx="${146 + i * (ow + 2) + ow / 2}" cy="${h / 2}" r="${ow / 2}" fill="${C.port}" stroke="${C.portRim}" stroke-width=".8"/>`).join('')}
    <text x="26" y="${h - 6}" font-family="system-ui,sans-serif" font-size="8" fill="${C.inkDim}">PDU · ${outlets} OUTLET</text>` };
}

function genericFace({ label, model, kind }) {
  const w = 430, h = 44;
  return { w, h, svg: `
    ${chassis(w, h, label, model)}
    <rect x="140" y="${h / 2 - 9}" width="${w - 170}" height="18" rx="2" fill="${C.bezel}"/>
    <text x="150" y="${h / 2 + 4}" font-family="system-ui,sans-serif" font-size="8" fill="${C.inkDim}">${esc(String(kind || 'device').toUpperCase())}</text>` };
}

/**
 * Build a faceplate for one device.
 * @returns {{svg:string, w:number, h:number, caption:string}}
 */
export function deviceFace({ kind, label, model, ports_total, ports_up, status, view = 'front' } = {}) {
  const k = String(kind || 'other').toLowerCase();
  const name = label || '—';
  const mdl = model || '';
  const total = Number(ports_total) || 0;
  const up = Math.max(0, Math.min(total, Number(ports_up) || 0));

  // An APC model is drawn from its catalogue entry — rack height, display,
  // module bays, outlet counts. A model that matches nothing is NOT drawn as
  // some other APC unit; it falls through to the generic panel and says the
  // model is unrecognised.
  const entry = catalogModel(mdl);
  if (entry) {
    const hasRear = !!entry.rear;
    // A switch is not a UPS. Power and cooling go to the bezel-and-LCD drawing;
    // network, compute and passive gear go to the faces that have ports and
    // drive bays, now with the catalogue's own port count and rack height.
    const isNetwork = ['network', 'compute', 'passive'].includes(entry.class);
    let f;
    if (view === 'rear' && hasRear) f = rearFace({ entry });
    else if (isNetwork) {
      const p = entry.ports ?? total;
      const upN = Math.max(0, Math.min(p || 0, up));
      f = entry.kind === 'server' || entry.class === 'compute'
        ? serverFace({ label: name, model: entry.label, bays: entry.drives?.match(/^(\d+)/)?.[1] ? Math.min(12, Number(entry.drives.match(/^(\d+)/)[1])) : 8 })
        : entry.kind === 'patch'
          ? patchFace({ label: name, model: entry.label, ports: p || 24 })
          : entry.kind === 'sbc'
            ? sbcFace({ label: name, model: entry.label, ports: p || 0, up: upN })
            : switchFace({ label: name, model: entry.label, ports: p || 0, up: upN, kind: entry.kind === 'router' ? 'router' : 'switch' });
      // Chassis switches are several U tall; the 1U faces are drawn taller.
      if (entry.u > 2) f = { ...f, h: Math.max(f.h, entry.u * U_PX + 10) };
    } else f = apcFace({ entry, status });
    return {
      ...f,
      svg: `<svg viewBox="0 0 ${f.w} ${f.h}" width="100%" preserveAspectRatio="xMidYMid meet"
              role="img" aria-label="${esc(name)} ${esc(entry.label)} ${view === 'rear' ? '후면부' : '전면부'}">${f.svg}</svg>`,
      entry,
      hasRear,
      view: (view === 'rear' && hasRear) ? 'rear' : 'front',
      caption: [entry.label, catalogSpecLine(entry)].filter(Boolean).join(' · '),
      note: catalogNote(entry),
      rearNote: entry.rear?.note || null,
    };
  }

  let face;
  if (k === 'switch' || k === 'router') face = switchFace({ label: name, model: mdl, ports: total, up, kind: k });
  else if (k === 'server' || k === 'storage') face = serverFace({ label: name, model: mdl, bays: 8 });
  else if (k === 'sbc') face = sbcFace({ label: name, model: mdl, ports: total, up });
  else if (k === 'patch') face = patchFace({ label: name, model: mdl, ports: total || 24 });
  else if (k === 'pdu') face = pduFace({ label: name, model: mdl, outlets: total || 24 });
  else face = genericFace({ label: name, model: mdl, kind: k });
  const unknownApc = k === 'ups' && mdl && !entry;

  return {
    ...face,
    svg: `<svg viewBox="0 0 ${face.w} ${face.h}" width="100%" preserveAspectRatio="xMidYMid meet"
            role="img" aria-label="${esc(name)} ${esc(mdl)} 전면부">${face.svg}</svg>`,
    // The device reports how many ports are up, not which, so the drawing lights
    // a count from the left and the caption refuses to imply more than that.
    // A patch panel is passive, so link state would be meaningless on it.
    caption: unknownApc ? `카탈로그에 없는 모델 — 일반 도식 (${mdl})`
      : !total ? '전면부 도식 — 포트 수 미수집'
      : (k === 'patch' || k === 'pdu') ? `${total}포트 전면부 도식`
      : `${total}포트 · 링크 업 ${up} (표시 위치는 실제 포트 번호가 아님)`,
  };
}
