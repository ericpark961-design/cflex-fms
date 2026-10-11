// APC equipment catalogue, transcribed from the C-Flex FMS / DCIM equipment
// library sheets (REV 1.0, 2024–2025).
//
// Why this exists: iconIdForModel() knew six models and silently returned
// 'srt5000' for everything else, so a Modular Ultra 15 kW, a Symmetra PX and a
// Smart-UPS X all displayed as an SRT 5000. Five of the fleet's own units were
// drawn as the wrong machine, and a model nobody had mapped was indistinguishable
// from one that matched.
//
// What is here is specification, not artwork: model, rack height, capacity,
// form factor, outlet and interface counts. The faceplates in deviceFaces.js
// are drawn from these numbers, so a 2U unit draws 2U and a PDU with 20 C13 and
// 4 C19 draws 24 outlets.
//
// Where the sheets disagree with each other the entry carries both figures and
// says so rather than quietly choosing — see `u_note` on the SRT 8000/10000 and
// the Modular Ultra 15 kW.

/**
 * form: rack | tower | cabinet | zero_u | module | card | sensor
 * u:    rack units for a rack-mounted unit; null when it is not rack-mounted
 */
export const APC_CATALOG = [
  // ── Smart-UPS SRT, on-line double conversion (rack) ───────────────
  { id: 'srt1000',  match: /SRT\s*1000/i,              label: 'Smart-UPS SRT 1000', family: 'srt', form: 'rack', u: 2, va: 1000, w: 900, topology: 'online', mgmt: 'NMC' },
  { id: 'srt2200',  match: /SRT\s*2200/i,              label: 'Smart-UPS SRT 2200', family: 'srt', form: 'rack', u: 2, va: 2200, w: 1980, topology: 'online', mgmt: 'NMC' },
  { id: 'srt3000',  match: /SRT\s*3000(?!XLI\s*\(T)/i, label: 'Smart-UPS SRT 3000', family: 'srt', form: 'rack', u: 2, va: 3000, w: 2700, depth_mm: 635, width_mm: 482.6, height_mm: 88.9, topology: 'online', mgmt: 'NMC' },
  { id: 'srt5000',  match: /SRT\s*5000/i,              label: 'Smart-UPS SRT 5000', family: 'srt', form: 'rack', u: 3, u_with_xbp: 5, va: 5000, w: 4500, depth_mm: 635, topology: 'online', mgmt: 'NMC' },
  { id: 'srt6000',  match: /SRT\s*6000/i,              label: 'Smart-UPS SRT 6000', family: 'srt', form: 'rack', u: 3, va: 6000, w: 5400, topology: 'online', mgmt: 'NMC' },
  { id: 'srt8000',  match: /SRT\s*8000/i,              label: 'Smart-UPS SRT 8000', family: 'srt', form: 'rack', u: 4, u_with_xbp: 5, va: 8000, w: 7200, depth_mm: 715, phase_in: 3, topology: 'online', mgmt: 'NMC',
    u_note: '단품 4U(개별 SKU 시트) / 5U는 XBP 포함(라인업 시트)' },
  { id: 'srt10000', match: /SRT\s*10000/i,             label: 'Smart-UPS SRT 10000', family: 'srt', form: 'rack', u: 4, u_with_xbp: 6, va: 10000, w: 9000, depth_mm: 715, width_mm: 482.6, height_mm: 266.7, phase_in: 3, topology: 'online', mgmt: 'NMC',
    u_note: '단품 4U / 6U는 확장 배터리 포함 구성' },

  // External battery packs — a rack slot each, and no LCD.
  { id: 'srt192xbp', match: /SRT192RMBP/i, label: 'Smart-UPS SRT XBP 192 VDC', family: 'xbp', form: 'rack', u: 3, vdc: 192, for: 'SRT 5/6 kVA' },
  { id: 'srt240xbp', match: /SRT240RMBP/i, label: 'Smart-UPS SRT XBP 240 VDC', family: 'xbp', form: 'rack', u: 3, vdc: 240, for: 'SRT 8/10 kVA' },
  { id: 'srtxbp',    match: /\bXBP\b/i,    label: 'Smart-UPS SRT XBP',         family: 'xbp', form: 'rack', u: 2 },

  // ── Smart-UPS Ultra (lithium-ion) ─────────────────────────────────
  { id: 'srtl3000', match: /SRTL\s*3000/i, label: 'Smart-UPS Ultra 3000 (Li-ion)', family: 'ultra', form: 'rack', u: 2, va: 3000, w: 3000, topology: 'online', mgmt: 'SmartSlot' },
  { id: 'srtl5000', match: /SRTL\s*5000/i, label: 'Smart-UPS Ultra 5000 (Li-ion)', family: 'ultra', form: 'rack', u: 2, va: 5000, w: 5000, topology: 'online', mgmt: 'SmartSlot' },

  // ── Smart-UPS Modular Ultra, 3-phase ──────────────────────────────
  { id: 'modular5k',  match: /Modular\s*Ultra\s*5\s*kW|SRYLF5K/i,  label: 'Smart-UPS Modular Ultra 5 kW',  family: 'modular', form: 'rack', u: 2, kw: 5,  phase_in: 3, phase_out: 3 },
  { id: 'modular8k',  match: /Modular\s*Ultra\s*8\s*kW|SRYLF8K/i,  label: 'Smart-UPS Modular Ultra 8 kW',  family: 'modular', form: 'rack', u: 3, kw: 8,  phase_in: 3, phase_out: 3 },
  { id: 'modular12k', match: /Modular\s*Ultra\s*12\s*kW|SRYLF12K/i, label: 'Smart-UPS Modular Ultra 12 kW', family: 'modular', form: 'rack', u: 4, kw: 12, phase_in: 3, phase_out: 3 },
  { id: 'modular15k', match: /Modular\s*Ultra\s*15|SRYLF15K|SRYL15K/i, label: 'Smart-UPS Modular Ultra 15 kW', family: 'modular', form: 'rack', u: 7, kw: 15,
    width_mm: 482, height_mm: 311, depth_mm: 700, phase_in: 3, phase_out: 3, volts: '380–415 V', modules: 3, module_kw: 5, efficiency: '97%', redundancy: 'N+1',
    u_note: '7U(치수 명시 시트) / 5U로 적힌 라인업 시트도 있음' },
  { id: 'modular20k', match: /Modular\s*Ultra\s*20|SRYLF20K|SRYL20K/i, label: 'Smart-UPS Modular Ultra 20 kW', family: 'modular', form: 'rack', u: 7, kw: 20,
    width_mm: 482, height_mm: 311, depth_mm: 700, phase_in: 3, phase_out: 3, volts: '380–415 V', modules: 2, module_kw: 10, efficiency: '97%', redundancy: 'N+1' },

  // ── Smart-UPS line-interactive ────────────────────────────────────
  { id: 'smx',  match: /Smart-UPS\s*X\b|\bSMX\s*\d/i,            label: 'Smart-UPS X',   family: 'smx', form: 'rack', u: 2, va_range: '750–3000 VA', topology: 'line-interactive' },
  { id: 'smtrm', match: /SMT\s*\d+\s*RM|Smart-UPS\s*SMT.*Rack/i,    label: 'Smart-UPS SMT (Rackmount)', family: 'smt', form: 'rack', u: 2, va_range: '750–3000 VA', topology: 'line-interactive' },
  { id: 'smt',  match: /\bSMT\s*\d/i,                            label: 'Smart-UPS SMT (Tower)', family: 'smt', form: 'tower', u: null, va_range: '750–3000 VA', topology: 'line-interactive' },
  { id: 'smc',  match: /\bSMC\s*\d|Smart-UPS\s*C\b/i,            label: 'Smart-UPS C / SMC', family: 'smc', form: 'rack', u: 1, va_range: '750–1500 VA', topology: 'line-interactive' },

  // ── Easy UPS ──────────────────────────────────────────────────────
  { id: 'srvrm', match: /SRVRM/i,        label: 'Easy UPS SRVRM', family: 'srv', form: 'rack', u: 2, va_range: '1–10 kVA', topology: 'online' },
  { id: 'srv',   match: /\bSRV\s*\d/i,      label: 'Easy UPS SRV',   family: 'srv', form: 'rack', u: 2, va_range: '1–10 kVA', topology: 'online' },
  { id: 'src',   match: /\bSRC\s*\d/i,      label: 'Smart-UPS SRC',  family: 'src', form: 'rack', u: 2, va: 3000, w: 2700, topology: 'online' },
  { id: 'smv',   match: /\bSMV\s*\d|Easy\s*UPS\s*SMV/i, label: 'Easy UPS SMV', family: 'easy', form: 'tower', u: null, va_range: '1000–3000 VA', topology: 'line-interactive' },
  { id: 'bvx',   match: /\bBVX|\bBV\s*\d|Easy\s*UPS\s*BV/i, label: 'Easy UPS BV / BVX', family: 'easy', form: 'tower', u: null, va_range: '650–1600 VA', topology: 'line-interactive' },

  // ── Back-UPS (tower) ──────────────────────────────────────────────
  { id: 'backups_pro', match: /Back-UPS\s*Pro|\bBR\s*\d/i, label: 'Back-UPS Pro', family: 'backups', form: 'tower', u: null, va_range: '900–1500 VA', topology: 'line-interactive' },
  { id: 'backups_bx',  match: /\bBX\s*\d|Back-UPS\s*BX/i,  label: 'Back-UPS BX',  family: 'backups', form: 'tower', u: null, va_range: '650–1600 VA', topology: 'line-interactive' },
  { id: 'backups',     match: /Back-UPS|\bBE\s*\d/i,       label: 'Back-UPS',     family: 'backups', form: 'tower', u: null, va_range: '350–1400 VA', topology: 'line-interactive' },

  // ── Symmetra / Galaxy (modular, cabinet) ──────────────────────────
  { id: 'symmetra_px', match: /Symmetra\s*PX/i, label: 'Symmetra PX', family: 'symmetra', form: 'cabinet', u: null, kw_range: '20–500 kW', phase_in: 3, phase_out: 3, modular: true },
  { id: 'symmetra_lx', match: /Symmetra\s*LX|Symmetra/i, label: 'Symmetra LX', family: 'symmetra', form: 'cabinet', u: null, kva_range: '8–16 kVA', phase_in: 3, phase_out: 3, modular: true },
  { id: 'galaxy_vx',   match: /Galaxy\s*VX/i, label: 'Galaxy VX', family: 'galaxy', form: 'cabinet', u: null, kw_range: '500–1500 kW', phase_in: 3 },
  { id: 'galaxy_vl',   match: /Galaxy\s*VL/i, label: 'Galaxy VL', family: 'galaxy', form: 'cabinet', u: null, kw_range: '200–500 kW', phase_in: 3 },
  { id: 'galaxy_vs',   match: /Galaxy\s*VS/i, label: 'Galaxy VS', family: 'galaxy', form: 'cabinet', u: null, kw_range: '20–150 kW', phase_in: 3, width_mm: 600, depth_mm: 850, height_mm: 2000 },
  { id: 'easy3ph',     match: /Easy\s*UPS\s*3(S|M|-Phase)/i, label: 'Easy UPS 3-Phase', family: 'easy3', form: 'cabinet', u: null, kva_range: '10–600 kVA', phase_in: 3 },

  // ── Rack PDU / ATS ────────────────────────────────────────────────
  { id: 'pdu_switched', match: /AP89\d\d|Switched\s*Rack\s*PDU/i, label: 'Switched Rack PDU', family: 'pdu', form: 'zero_u', u: 0,
    outlets_c13: 20, outlets_c19: 4, input: '200–240 V, 32 A (IEC 60309)', rating_kw: 7.4, metered: true, switched: true, network: true },
  { id: 'pdu_metered',  match: /AP88\d\d|Metered\s*Rack\s*PDU/i,  label: 'Metered Rack PDU',  family: 'pdu', form: 'zero_u', u: 0,
    outlets_c13: 20, outlets_c19: 4, input: '200–240 V, 32 A (IEC 60309)', rating_kw: 7.4, metered: true, network: true },
  { id: 'pdu_basic',    match: /AP75\d\d|Basic\s*Rack\s*PDU/i,    label: 'Basic Rack PDU',    family: 'pdu', form: 'zero_u', u: 0,
    outlets_c13: 20, outlets_c19: 4, input: '200–240 V, 32 A (IEC 60309)', rating_kw: 7.4 },
  { id: 'rack_ats',     match: /AP44\d\d|Rack\s*ATS/i,            label: 'Rack ATS',          family: 'ats', form: 'rack', u: 1,
    outlets_c13: 8, input: '200–240 V, 16 A (dual input)', transfer_ms: 10, network: true },

  // ── Monitoring and sensors ────────────────────────────────────────
  { id: 'netbotz750', match: /NetBotz\s*750|NBES7550/i, label: 'NetBotz 750', family: 'netbotz', form: 'rack', u: 1,
    width_mm: 432, height_mm: 44, depth_mm: 236, weight_kg: 3.6, sensors_max: 78,
    ports: { ethernet: 1, sensor: 4, alink: 2, usb: 1, console: 1 } },
  { id: 'nmc3',       match: /AP964\d|Network\s*Management\s*Card|\bNMC\b/i, label: 'Network Management Card 3', family: 'nmc', form: 'card', u: null,
    width_mm: 121, height_mm: 38, depth_mm: 114, weight_kg: 0.1, ports: { ethernet: 1 } },
  { id: 'sensor_th',  match: /AP9335T|Temperature\s*&?\s*Humidity/i, label: 'Temperature & Humidity Sensor', family: 'sensor', form: 'sensor', u: null,
    range: '-20 ~ 80 °C (±0.5), 0–100 %RH (±3)', ports: { rj12: 1 } },
  { id: 'sensor_leak', match: /AP9335W|Leak\s*(Rope|Sensor)/i, label: 'Leak Rope / Leak Sensor', family: 'sensor', form: 'sensor', u: null,
    rope_m: 3, ports: { rj12: 1 } },
  { id: 'sensor_door', match: /AP9335D|Door\s*Switch|Rack\s*Access/i, label: 'Door Switch / Rack Access Sensor', family: 'sensor', form: 'sensor', u: null,
    cable_m: 3, ports: { rj12: 1 } },
];

/**
 * Resolve a model string to its catalogue entry.
 * Returns null when nothing matches — the caller must say "unknown" rather than
 * fall back to a picture of a different machine, which is what the old
 * `return 'srt5000'` did.
 */
export function apcModel(model) {
  const m = String(model || '').trim();
  if (!m) return null;
  for (const e of APC_CATALOG) if (e.match.test(m)) return e;
  return null;
}

/** Rack height for a model, or null when it is not a rack-mounted unit. */
export const rackUnits = (model) => apcModel(model)?.u ?? null;

/** One-line spec summary for a caption. */
export function specLine(e) {
  if (!e) return null;
  const bits = [];
  if (e.va) bits.push(`${e.va.toLocaleString()} VA / ${e.w.toLocaleString()} W`);
  else if (e.kw) bits.push(`${e.kw} kW`);
  else if (e.va_range) bits.push(e.va_range);
  else if (e.kw_range) bits.push(e.kw_range);
  else if (e.kva_range) bits.push(e.kva_range);
  if (e.u) bits.push(`${e.u}U`);
  else if (e.form === 'zero_u') bits.push('0U');
  else if (e.form === 'tower') bits.push('타워');
  else if (e.form === 'cabinet') bits.push('캐비닛');
  if (e.phase_in === 3) bits.push('3상');
  if (e.outlets_c13) bits.push(`C13 ${e.outlets_c13}${e.outlets_c19 ? ` · C19 ${e.outlets_c19}` : ''}`);
  if (e.rating_kw) bits.push(`${e.rating_kw} kW`);
  return bits.join(' · ') || null;
}
