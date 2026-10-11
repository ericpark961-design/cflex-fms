// Vertiv / Liebert equipment catalogue, transcribed from the C-Flex FMS / DCIM
// asset library sheets (v1.0, 2024.1).
//
// Same purpose as apcCatalog.js and the same rule: specification, not artwork.
// It also covers the half of a facility the UPS catalogue cannot — precision
// cooling and heat rejection. The ledger already carries CRAC-1/2/3 as objects
// and the twin drew all three as one generic box, so a PDX, a CRV in-row and a
// Mini-Mate2 were indistinguishable despite being different machines in
// different places doing different jobs.
//
// The two Vertiv UPS sheets disagree with each other in several places — the
// modular cabinets are rated in kW on one and kVA on the other, and the rack
// units differ by region (one sheet says so itself: "SPECIFICATIONS MAY VARY BY
// REGION"). Those entries carry both figures in `spec_note` rather than
// presenting one as settled.

/**
 * form:  rack | tower | cabinet | crac | chiller | outdoor | battery
 * class: ups | cooling | heat_rejection | battery
 */
export const VERTIV_CATALOG = [
  // ── Rack / edge UPS ───────────────────────────────────────────────
  { id: 'gxt5_small', match: /GXT5.*\b(1|1\.5|2|3)\s*kVA|Liebert\s*GXT5\b(?!.*(5|6|8|10))/i,
    label: 'Liebert GXT5 1–3 kVA', vendor: 'Vertiv', family: 'gxt5', class: 'ups', form: 'rack', u: 2,
    kva_range: '1 / 1.5 / 2 / 3 kVA', topology: 'online', convertible: true,
    interfaces: ['USB', 'RS-232', 'SNMP (RDU101)', 'Intellislot'],
    spec_note: '1U(1–2 kVA)/2U(3 kVA) · 100–125 VAC 시트와 2U · 200–240 V 시트가 다름(지역별 사양)',
    rear: { inlet: 'IEC C14', outlets: { c13: 6 }, fans: 1, ports: { intellislot: 1, usb: 1, serial: 1 }, battery: true } },
  { id: 'gxt5_large', match: /GXT5.*\b(5|6|8|10)\s*kVA/i,
    label: 'Liebert GXT5 5–10 kVA', vendor: 'Vertiv', family: 'gxt5', class: 'ups', form: 'rack', u: 3,
    kva_range: '5 / 6 / 8 / 10 kVA', topology: 'online', volts: '200–240 VAC (1φ)', convertible: true,
    interfaces: ['USB', 'RS-232', 'SNMP (RDU101)', 'Intellislot', 'Dry Contact'],
    rear: { inlet: 'IEC C20', outlets: { c13: 8, c19: 2 }, fans: 2, ports: { intellislot: 1, usb: 1, serial: 1, dry: 1 }, battery: true } },
  { id: 'psi5', match: /\bPSI5\b/i,
    label: 'Liebert PSI5', vendor: 'Vertiv', family: 'psi5', class: 'ups', form: 'rack', u: 2,
    va_range: '650 VA – 3 kVA', convertible: true, interfaces: ['USB', 'RS-232', 'SNMP (옵션)'],
    spec_note: '토폴로지가 시트마다 다름 — 라인인터랙티브(AVR) / 온라인 더블컨버전. 1U(650–1500 VA) 표기 시트도 있음',
    rear: { inlet: 'IEC C14', outlets: { c13: 6 }, fans: 1, ports: { usb: 1, serial: 1 }, battery: true } },
  { id: 'ita2', match: /\bITA2\b/i,
    label: 'Liebert ITA2', vendor: 'Vertiv', family: 'ita2', class: 'ups', form: 'rack', u: 3,
    kva_range: '5 / 6 / 8 / 10 kVA', topology: 'online', volts: '200–240 V (1φ) / 380–415 V (3φ)',
    interfaces: ['USB', 'RS-232', 'SNMP (RDU101)', 'Dry Contact'],
    spec_note: '2U 표기 시트와 3U 표기 시트가 있음',
    rear: { inlet: 'terminal', outlets: { c13: 6, c19: 2 }, fans: 2, ports: { intellislot: 1, usb: 1, serial: 1, dry: 1 }, battery: true } },
  { id: 'gxe', match: /\bGXE\b/i,
    label: 'Liebert GXE 1–3 kVA', vendor: 'Vertiv', family: 'gxe', class: 'ups', form: 'rack', u: 2,
    kva_range: '1 / 2 / 3 kVA (1φ)', topology: 'online', volts: '200–240 V',
    interfaces: ['LCD', 'USB', 'RS-232', 'SNMP / Web Card (옵션)'],
    rear: { inlet: 'IEC C14', outlets: { c13: 6 }, fans: 1, ports: { usb: 1, serial: 1 }, battery: true } },
  { id: 'vertiv_ebc', match: /\bEBC\b|External\s*Battery\s*Cabinet|Battery\s*Pack/i,
    label: 'External Battery Cabinet', vendor: 'Vertiv', family: 'ebc', class: 'battery', form: 'rack', u: 3,
    battery: 'VRLA (hot-swap 가능)', fits: 'GXT5 / PSI5 / ITA2 / GXE',
    rear: { battery: true, note: 'BATTERY INPUT / BATTERY OUTPUT' } },

  // ── Modular / three-phase cabinets ────────────────────────────────
  { id: 'exm2', match: /\bEXM2\b/i,
    label: 'Liebert EXM2', vendor: 'Vertiv', family: 'exm2', class: 'ups', form: 'cabinet', u: null,
    topology: 'Online Double Conversion (VFI)', phase_in: 3, phase_out: 3, volts: '380 / 400 / 415 · 480 VAC (3φ)',
    efficiency: '97%', modular: true, redundancy: 'N+1', height_mm: 2000, width_mm: 1200, depth_mm: 1100,
    rating: '250 kW – 1,500 kW', module: '250 kW/모듈',
    spec_note: '다른 시트는 250–2,500 kVA · 250 kVA 모듈로 표기',
    rear: { inlet: 'terminal 3φ', bypass: true, fans: 9, ports: { network: 1, dry: 1 }, terminals: ['AC INPUT', 'BYPASS', 'AC OUTPUT'] } },
  { id: 'exl_s1', match: /EXL\s*S1/i,
    label: 'Liebert EXL S1', vendor: 'Vertiv', family: 'exl', class: 'ups', form: 'cabinet', u: null,
    topology: 'Online Double Conversion (VFI)', phase_in: 3, phase_out: 3, volts: '380 / 400 / 415 VAC (3φ)',
    efficiency: '98%', modular: true, redundancy: 'N+1', height_mm: 2000, width_mm: 1000, depth_mm: 1000,
    rating: '250 kW – 1,200 kW', module: '250 kW/모듈',
    spec_note: '다른 시트는 250–1,200 kVA로 표기',
    rear: { inlet: 'terminal 3φ', bypass: true, fans: 9, ports: { network: 1, dry: 1 }, terminals: ['AC INPUT', 'BYPASS', 'AC OUTPUT'] } },
  { id: 'apm2', match: /\bAPM2\b/i,
    label: 'Liebert APM2', vendor: 'Vertiv', family: 'apm2', class: 'ups', form: 'cabinet', u: null,
    topology: 'Online Double Conversion (VFI)', phase_in: 3, phase_out: 3, volts: '380 / 400 / 415 · 480 VAC (3φ)',
    efficiency: '97%', modular: true, redundancy: 'N+1', height_mm: 2000, width_mm: 600, depth_mm: 1100,
    rating: '300 kW – 1,200 kW', module: '300 kW/모듈',
    spec_note: '다른 시트는 50–600 kVA · 50 kVA 모듈로 크게 다르게 표기 — 확인 필요',
    rear: { inlet: 'terminal 3φ', bypass: true, fans: 6, ports: { network: 1, dry: 1 }, terminals: ['AC INPUT', 'BYPASS', 'AC OUTPUT'] } },
  { id: 'aps', match: /Liebert\s*APS\b|\bAPS\b(?!.*Chiller)/i,
    label: 'Liebert APS', vendor: 'Vertiv', family: 'aps', class: 'ups', form: 'cabinet', u: null,
    topology: 'Online Double Conversion (VFI)', phase_in: 3, phase_out: 3, volts: '380 / 400 / 415 · 480 VAC (3φ)',
    efficiency: '97%', modular: true, redundancy: 'N+1 · 병렬', height_mm: 2000, depth_mm: 1000,
    rating: '750 kW – 4,500 kW', module: '750 kW/모듈',
    spec_note: '다른 시트는 300–4,800 kVA로 표기',
    rear: { inlet: 'terminal 3φ', bypass: true, fans: 6, ports: { network: 1, dry: 1 }, terminals: ['AC INPUT', 'BYPASS', 'AC OUTPUT'] } },
  { id: 'nxc', match: /\bNXC\b/i,
    label: 'Liebert NXC', vendor: 'Vertiv', family: 'nxc', class: 'ups', form: 'cabinet', u: null,
    topology: 'Online Double Conversion (VFI)', phase_in: 3, phase_out: 3, volts: '380 / 400 / 415 · 480 VAC (3φ)',
    efficiency: '98.5%', redundancy: '병렬 (최대 수십 MVA)', height_mm: 2000, depth_mm: 1000,
    rating: '250 kVA – 6,000 kVA',
    spec_note: '다른 시트는 800 kVA – 6+ MW로 표기',
    rear: { inlet: 'terminal 3φ', bypass: true, fans: 12, ports: { network: 1, dry: 1 }, terminals: ['AC INPUT', 'BYPASS', 'AC OUTPUT'] } },
  { id: 'trinergy', match: /Trinergy/i,
    label: 'Trinergy Cube', vendor: 'Vertiv', family: 'trinergy', class: 'ups', form: 'cabinet', u: null,
    topology: 'Online Double Conversion (VFI)', phase_in: 3, phase_out: 3, volts: '400 / 480 VAC (3φ)',
    modular: true, rating: '3,000 kVA – 48,000 kVA', redundancy: '모듈형 · 병렬 (최대 수십 MVA)',
    rear: { inlet: 'terminal 3φ', bypass: true, fans: 12, ports: { network: 1, dry: 1 }, terminals: ['AC INPUT', 'BYPASS', 'AC OUTPUT'] } },

  // ── Precision cooling ─────────────────────────────────────────────
  { id: 'pdx', match: /\bPDX\b/i,
    label: 'Liebert PDX', vendor: 'Vertiv', family: 'pdx', class: 'cooling', form: 'crac',
    cooling: 'DX (직접팽창)', airflow: 'Downflow / Upflow', install: 'Room-based (주변부)',
    capacity: '25 – 200 kW', features: '인버터 컴프레서, 고효율, 저소음',
    rear: { service: true, piping: ['refrigerant'], fans: 2, note: '서비스 뷰 — 컴프레서 · 배관' } },
  { id: 'pcw', match: /\bPCW\b/i,
    label: 'Liebert PCW', vendor: 'Vertiv', family: 'pcw', class: 'cooling', form: 'crac',
    cooling: 'Chilled Water', airflow: 'Downflow / Upflow', install: 'Room-based (주변부)',
    capacity: '30 – 300 kW', features: '고효율 EC 팬, 다양한 코일 옵션',
    rear: { service: true, piping: ['chilled water supply', 'return'], valves: 2, note: '후면 — 냉수 배관 · 밸브' } },
  { id: 'dse', match: /\bDSE\b/i,
    label: 'Liebert DSE', vendor: 'Vertiv', family: 'dse', class: 'cooling', form: 'crac',
    cooling: 'Indirect Evaporative + DX (하이브리드)', airflow: 'Downflow / Upflow', install: 'Room-based',
    capacity: '50 – 300 kW', features: '프리쿨링, 낮은 PUE, 절수 설계',
    rear: { service: true, piping: ['water'], note: '후면 — 증발 패드 · 급수' } },
  { id: 'crv', match: /\bCRV\b/i,
    label: 'Liebert CRV', vendor: 'Vertiv', family: 'crv', class: 'cooling', form: 'crac', in_row: true,
    cooling: 'DX 또는 Chilled Water', airflow: 'Horizontal (랙 대 랙)', install: 'In-Row (랙 사이)',
    capacity: '10 – 60 kW (유닛당)', features: '가변 풍량 제어, 근접 냉각, 고효율 EC 팬',
    rear: { service: true, fans: 3, note: '후면 — EC 팬' } },
  { id: 'minimate2', match: /Mini-?Mate\s*2?/i,
    label: 'Liebert Mini-Mate2', vendor: 'Vertiv', family: 'minimate', class: 'cooling', form: 'crac',
    cooling: 'DX (직접팽창)', airflow: 'Upflow / Downflow', install: 'Room / Wall / Floor',
    capacity: '5 – 40 kW', features: '컴팩트 설계, 빠른 설치',
    rear: { service: true, piping: ['refrigerant'], fans: 1, note: '후면 — 배관 · 팬' } },
  { id: 'hpm', match: /\bHPM\b/i,
    label: 'Liebert HPM', vendor: 'Vertiv', family: 'hpm', class: 'cooling', form: 'crac',
    cooling: 'Chilled Water', airflow: 'Upflow', install: 'Outdoor / Mechanical Room',
    capacity: '200 – 1,200 kW (모듈형)', features: '모듈형 확장, N+1 구성',
    rear: { service: true, piping: ['chilled water'], note: '서비스 뷰 — 코일 · 배관' } },
  { id: 'edge_cooling', match: /Edge\s*Cooling/i,
    label: 'Vertiv Edge Cooling', vendor: 'Vertiv', family: 'edge', class: 'cooling', form: 'crac',
    cooling: 'DX (직접팽창)', airflow: 'Front to Back', install: 'Rack / Floor / Wall',
    capacity: '3 – 20 kW', features: '컴팩트, 원격 모니터링, DCIM 연계',
    rear: { service: true, fans: 2, note: '후면 — 배기 팬' } },

  // ── Chillers and heat rejection ───────────────────────────────────
  { id: 'afc_chiller', match: /\bAFC\b.*Chiller|Liebert\s*AFC/i,
    label: 'Liebert AFC Chiller (수냉식)', vendor: 'Vertiv', family: 'chiller', class: 'heat_rejection', form: 'chiller',
    cooling: '수냉식 칠러 (원심식)', install: '기계실 (실내)', heat_rejection: '응축수 → 냉각탑',
    rear: { service: true, piping: ['condenser water'], note: '후면 — 응축수 배관' } },
  { id: 'air_chiller', match: /Air-?Cooled\s*Chiller/i,
    label: 'Air-Cooled Chiller', vendor: 'Vertiv', family: 'chiller', class: 'heat_rejection', form: 'chiller',
    cooling: '공랭식 칠러 (스크롤/스크류)', install: '옥외 (옥상/지상)', heat_rejection: '공랭식 (주변 공기)',
    rear: { service: true, fans: 8, piping: ['chilled water'], note: '후면 — 응축기 팬 뱅크' } },
  { id: 'free_chiller', match: /Free-?Cooling\s*Chiller/i,
    label: 'Free-Cooling Chiller', vendor: 'Vertiv', family: 'chiller', class: 'heat_rejection', form: 'chiller',
    cooling: '프리쿨링 칠러', install: '옥외 (옥상/지상)', heat_rejection: '공랭 + 자연냉각',
    rear: { service: true, fans: 8, piping: ['chilled water'], note: '후면 — 프리쿨링 코일 · 팬' } },
  { id: 'dry_cooler', match: /Dry\s*Cooler|Fluid\s*Cooler/i,
    label: 'Dry Cooler / Fluid Cooler', vendor: 'Vertiv', family: 'dry_cooler', class: 'heat_rejection', form: 'outdoor',
    cooling: '드라이 쿨러 / 플루이드 쿨러', install: '옥외 (옥상/지상)', heat_rejection: '공랭식 (프로세스 유체)',
    rear: { service: true, fans: 5, piping: ['process fluid'], note: '상면 — 팬 뱅크' } },
  { id: 'condenser', match: /Outdoor\s*Condenser|Remote\s*Condenser/i,
    label: 'Outdoor Condenser', vendor: 'Vertiv', family: 'condenser', class: 'heat_rejection', form: 'outdoor',
    cooling: '원격 콘덴서 (DX)', install: '옥외 (옥상/지상)', heat_rejection: '공랭식 (냉매)',
    rear: { service: true, fans: 6, piping: ['refrigerant'], note: '후면 — 코일 · 팬' } },
  { id: 'pumped_refrigerant', match: /Pumped\s*Refrigerant|Heat-?Rejection\s*Unit/i,
    label: 'Pumped Refrigerant / Heat-Rejection Unit', vendor: 'Vertiv', family: 'pumped', class: 'heat_rejection', form: 'outdoor',
    cooling: '펌프식 냉매 / 열방출', install: '옥외 또는 서비스 구역', heat_rejection: '공랭식 (냉매/유체)',
    rear: { service: true, fans: 4, piping: ['refrigerant'], pumps: 2, note: '후면 — 펌프 · 코일' } },
];

/** Resolve a model string to its Vertiv entry, or null. */
export function vertivModel(model) {
  const m = String(model || '').trim();
  if (!m) return null;
  for (const e of VERTIV_CATALOG) if (e.match.test(m)) return e;
  return null;
}

/** One-line spec summary for a caption. */
export function vertivSpecLine(e) {
  if (!e) return null;
  const bits = [];
  if (e.rating) bits.push(e.rating);
  else if (e.kva_range) bits.push(e.kva_range);
  else if (e.va_range) bits.push(e.va_range);
  else if (e.capacity) bits.push(e.capacity);
  if (e.u) bits.push(`${e.u}U`);
  else if (e.form === 'cabinet') bits.push('캐비닛');
  else if (e.form === 'crac') bits.push(e.in_row ? '인로우' : '항온항습');
  else if (e.form === 'chiller') bits.push('칠러');
  else if (e.form === 'outdoor') bits.push('옥외');
  if (e.phase_in === 3) bits.push('3상');
  if (e.cooling && e.class !== 'ups') bits.push(e.cooling);
  if (e.efficiency) bits.push(`효율 ${e.efficiency}`);
  return bits.join(' · ') || null;
}
