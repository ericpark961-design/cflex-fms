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
export function deviceFace({ kind, label, model, ports_total, ports_up } = {}) {
  const k = String(kind || 'other').toLowerCase();
  const name = label || '—';
  const mdl = model || '';
  const total = Number(ports_total) || 0;
  const up = Math.max(0, Math.min(total, Number(ports_up) || 0));

  let face;
  if (k === 'switch' || k === 'router') face = switchFace({ label: name, model: mdl, ports: total, up, kind: k });
  else if (k === 'server' || k === 'storage') face = serverFace({ label: name, model: mdl, bays: 8 });
  else if (k === 'sbc') face = sbcFace({ label: name, model: mdl, ports: total, up });
  else if (k === 'patch') face = patchFace({ label: name, model: mdl, ports: total || 24 });
  else if (k === 'pdu') face = pduFace({ label: name, model: mdl, outlets: total || 24 });
  else face = genericFace({ label: name, model: mdl, kind: k });

  return {
    ...face,
    svg: `<svg viewBox="0 0 ${face.w} ${face.h}" width="100%" preserveAspectRatio="xMidYMid meet"
            role="img" aria-label="${esc(name)} ${esc(mdl)} 전면부">${face.svg}</svg>`,
    // The device reports how many ports are up, not which, so the drawing lights
    // a count from the left and the caption refuses to imply more than that.
    // A patch panel is passive, so link state would be meaningless on it.
    caption: !total ? '전면부 도식 — 포트 수 미수집'
      : (k === 'patch' || k === 'pdu') ? `${total}포트 전면부 도식`
      : `${total}포트 · 링크 업 ${up} (표시 위치는 실제 포트 번호가 아님)`,
  };
}
