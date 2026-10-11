// Cisco equipment catalogue, transcribed from the C-Flex FMS / DCIM asset
// library sheets (v1.0).
//
// This is the half of a rack the power catalogues cannot describe, and the half
// the 3D scene gets most wrong: a Nexus 9500 chassis is up to 13U and a Catalyst
// 9300 is 1U, but the twin drew every device in a rack as the same slab. Rack
// height, port count and PoE budget all live here, which is also what the
// capacity module needs — the 9300-48P's 740 W PoE budget is the single biggest
// line item in an access rack and it comes straight off the sheet.
//
// Chassis switches ship in several heights (7U / 10U / 13U …). `u` is the
// smallest, `u_options` lists what the sheet gives, and the drawing uses `u`
// unless the record says which one was bought.

export const CISCO_CATALOG = [
  // ── Access switching ──────────────────────────────────────────────
  { id: 'cat9200', match: /Catalyst\s*9200/i, label: 'Catalyst 9200', vendor: 'Cisco',
    family: 'catalyst', class: 'network', kind: 'switch', form: 'rack', u: 1,
    ports: 48, port_speed: '1G', port_options: [24, 48], uplink: '1G / 10G SFP+',
    stacking: 'StackWise-160', use: '액세스 스위칭' },
  { id: 'cat9300_48p', match: /Catalyst\s*9300-?48P/i, label: 'Catalyst 9300-48P', vendor: 'Cisco',
    family: 'catalyst', class: 'network', kind: 'switch', form: 'rack', u: 1,
    ports: 48, port_speed: '1G', poe: 'poe_plus', poe_budget_w: 740,
    uplink: '1G / 10G / 25G', stacking: 'StackWise-480', use: '액세스 스위칭' },
  { id: 'cat9300', match: /Catalyst\s*9300/i, label: 'Catalyst 9300', vendor: 'Cisco',
    family: 'catalyst', class: 'network', kind: 'switch', form: 'rack', u: 1,
    ports: 48, port_speed: '1G', poe: 'poe_plus', poe_budget_w: 740,
    uplink: '1G / 10G / 25G', stacking: 'StackWise-480', use: '액세스 스위칭' },

  // ── Core / aggregation ────────────────────────────────────────────
  { id: 'cat9500_48y4c', match: /Catalyst\s*9500-?48Y4C/i, label: 'Catalyst 9500-48Y4C', vendor: 'Cisco',
    family: 'catalyst', class: 'network', kind: 'switch', form: 'rack', u: 1,
    ports: 48, port_speed: '10/25G SFP28', uplink: '4 × 100G QSFP28',
    redundant: '전원 / 팬', use: '코어 · 애그리게이션' },
  { id: 'cat9500', match: /Catalyst\s*9500/i, label: 'Catalyst 9500', vendor: 'Cisco',
    family: 'catalyst', class: 'network', kind: 'switch', form: 'rack', u: 1,
    ports: 48, port_options: [48, 96], port_speed: '1G / 10G / 25G', uplink: '4 × 100G QSFP28',
    switching: '최대 3.6 Tbps', redundant: '전원 / 팬', use: '캠퍼스 코어' },
  { id: 'cat9600', match: /Catalyst\s*9600/i, label: 'Catalyst 9600', vendor: 'Cisco',
    family: 'catalyst', class: 'network', kind: 'switch', form: 'rack', u: 7, u_options: [7, 10, 13],
    chassis: true, line_cards: '1G / 10G / 25G / 40G / 100G', supervisor: 'Supervisor 1/2 (SSO)',
    switching: '최대 12.8 Tbps', redundant: '전원 / 팬 / 수퍼바이저', use: '캠퍼스 코어 · 백본',
    u_note: '7U / 10U / 13U 섀시 옵션 — 실제 구매 사양에 따라 다름. 스위칭 용량은 시트마다 7.2 / 12.8 Tbps로 다르게 표기' },

  // ── Data centre switching ─────────────────────────────────────────
  { id: 'nexus93180', match: /Nexus\s*93180/i, label: 'Nexus 93180YC-FX', vendor: 'Cisco',
    family: 'nexus', class: 'network', kind: 'switch', form: 'rack', u: 1,
    ports: 48, port_speed: '25G SFP28', uplink: '6 × 100G QSFP28', os: 'NX-OS',
    use: '데이터센터 리프' },
  { id: 'nexus9300', match: /Nexus\s*9300/i, label: 'Nexus 9300', vendor: 'Cisco',
    family: 'nexus', class: 'network', kind: 'switch', form: 'rack', u: 1,
    ports: 48, port_options: [48, 96], port_speed: '10G / 25G', uplink: '6 × 100G QSFP28',
    switching: '최대 6.4 Tbps', redundant: '전원 / 팬', use: '스파인 · 리프' },
  { id: 'nexus9500', match: /Nexus\s*9500/i, label: 'Nexus 9500', vendor: 'Cisco',
    family: 'nexus', class: 'network', kind: 'switch', form: 'rack', u: 7, u_options: [7, 10, 13, 18],
    chassis: true, line_cards: '1/10/25/40/100/400G', supervisor: 'Supervisor 1/2 (NSF/ISSU)',
    switching: '최대 57.6 Tbps', redundant: '전원 / 팬 / 수퍼바이저 / 패브릭', use: '데이터센터 코어 · 스파인',
    u_note: '7U / 10U / 13U 시트와 7U / 10U / 18U 시트가 다름. 스위칭 용량도 57.6 / 115.2 Tbps로 다르게 표기' },
  { id: 'nexus7700', match: /Nexus\s*7700/i, label: 'Nexus 7700', vendor: 'Cisco',
    family: 'nexus', class: 'network', kind: 'switch', form: 'rack', u: 7, u_options: [7, 10, 18],
    chassis: true, line_cards: '1/10/40/100G', supervisor: 'Supervisor 1/2 (NSR)',
    switching: '최대 460 Tbps', redundant: '전원 / 팬 / 수퍼바이저', use: '서비스 프로바이더 코어' },
  { id: 'mds9700', match: /MDS\s*9700/i, label: 'MDS 9700', vendor: 'Cisco',
    family: 'mds', class: 'network', kind: 'switch', form: 'rack', u: 4, u_options: [4, 8],
    chassis: true, ports: null, port_speed: '16G / 32G / 64G FC', supervisor: 'Supervisor 1/2',
    switching: '최대 115.2 Tbps', use: 'SAN 코어 · 스토리지 백본' },

  // ── Routing / voice ───────────────────────────────────────────────
  { id: 'isr4331', match: /ISR\s*4331/i, label: 'ISR 4331', vendor: 'Cisco',
    family: 'isr', class: 'network', kind: 'router', form: 'rack', u: 1,
    interfaces: '3 × GE, 1 × SFP, 모듈형', throughput: '최대 100 Mbps (IMIX)',
    features: 'Routing / VPN / SD-WAN', psu: 'Dual PSU (AC)', use: '엣지 라우팅' },
  { id: 'isr4451', match: /ISR\s*44\d1|ISR[\w\s-]*CUBE|CUBE[\w\s-]*ISR/i, label: 'ISR 4451-X / CUBE', vendor: 'Cisco',
    family: 'isr', class: 'network', kind: 'sbc', form: 'rack', u: 2,
    interfaces: '4 × GE, 2 × SFP+, 모듈형', dsp: 'PVDM4 (음성)',
    features: 'CUBE / Voice / Routing', psu: 'Dual PSU (AC)', use: '음성 게이트웨이' },
  { id: 'meraki_mx105', match: /MX105|Meraki\s*MX/i, label: 'Meraki MX105', vendor: 'Cisco',
    family: 'meraki', class: 'network', kind: 'router', form: 'rack', u: 1,
    interfaces: '1 × WAN + 8 × LAN (GE)', throughput: 'VPN 최대 750 Mbps',
    features: 'Security / SD-WAN / Auto VPN', mgmt: 'Meraki Dashboard', use: '지사 보안' },

  // ── Compute ───────────────────────────────────────────────────────
  { id: 'ucs_c220', match: /UCS\s*C220/i, label: 'UCS C220 M6', vendor: 'Cisco',
    family: 'ucs', class: 'compute', kind: 'server', form: 'rack', u: 1,
    cpu: '2 × Intel Xeon (Gen4/5)', memory: '최대 2 TB', drives: '8 × SFF (NVMe/SAS/SATA)',
    mgmt: 'Cisco IMC / UCS Manager', psu: 'Dual PSU (AC)' },
  { id: 'ucs_c240', match: /UCS\s*C240/i, label: 'UCS C240 M6', vendor: 'Cisco',
    family: 'ucs', class: 'compute', kind: 'server', form: 'rack', u: 2,
    cpu: '2 × Intel Xeon (Gen4/5)', memory: '최대 4 TB', drives: '24 × SFF (NVMe/SAS/SATA)',
    mgmt: 'Cisco IMC / UCS Manager', psu: 'Dual PSU (AC)' },

  // ── Passive ───────────────────────────────────────────────────────
  { id: 'patch48', match: /48-?\s*Port\s*Patch|Patch\s*Panel\s*48/i, label: '48-Port Patch Panel', vendor: 'Cisco',
    family: 'patch', class: 'passive', kind: 'patch', form: 'rack', u: 2,
    ports: 48, port_type: 'RJ45 (Cat6)', termination: 'Punch Down (110/LSA)', material: 'Steel (Black)' },
  { id: 'patch24', match: /24-?\s*Port\s*Patch|Patch\s*Panel\s*24|Patch\s*Panel/i, label: '24-Port Patch Panel', vendor: 'Cisco',
    family: 'patch', class: 'passive', kind: 'patch', form: 'rack', u: 1,
    ports: 24, port_type: 'RJ45 (Cat6/6A)', wiring: 'T568A/B' },
];

/** Resolve a model string to its Cisco entry, or null. */
export function ciscoModel(model) {
  const m = String(model || '').trim();
  if (!m) return null;
  for (const e of CISCO_CATALOG) if (e.match.test(m)) return e;
  return null;
}

/** One-line spec summary for a caption. */
export function ciscoSpecLine(e) {
  if (!e) return null;
  const bits = [];
  if (e.ports) bits.push(`${e.ports}포트${e.port_speed ? ` ${e.port_speed}` : ''}`);
  else if (e.port_speed) bits.push(e.port_speed);
  if (e.uplink) bits.push(`업링크 ${e.uplink}`);
  if (e.u) bits.push(e.u_options ? `${e.u_options.join('/')}U` : `${e.u}U`);
  if (e.poe_budget_w) bits.push(`PoE ${e.poe_budget_w} W`);
  if (e.cpu) bits.push(e.cpu);
  if (e.drives) bits.push(e.drives);
  return bits.join(' · ') || null;
}
