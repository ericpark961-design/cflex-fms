// Equipment photography, cropped from the same FMS/DCIM design sheets the
// catalogues were transcribed from. 94 models, 273 views.
//
// This file is the PHOTO layer only. The patch it came from also carried its
// own model→id resolvers; those were dropped because model resolution lives in
// catalog.js, and two resolvers disagreeing about what a string means is worse
// than either of them being slightly wrong. equipmentPhoto.js maps a catalogue
// id to a photo id here.
const RAW = import.meta.glob('../assets/equipment/*.webp', { query: '?url', import: 'default', eager: true });
export const apcImg = (id, view = 'front') => RAW[`../assets/equipment/${id}_${view}.webp`] || null;
export const apcViews = (id) => ['front', 'side', 'rear', 'internal', 'top', 'hero'].filter(v => apcImg(id, v));

// form: rack (19" U-height) | tower | cabinet (floor, w×h×d mm) | zerou (vertical rack PDU) | card | sensor
export const APC_LIB = {
  // ── Smart-UPS On-Line SRT (rack) ──
  srt3000_2u: { title: 'Smart-UPS SRT 3000 (2U)', series: 'SRT', form: 'rack', u: 2, mm: [482.6, 88.9, 635], spec: { capacity: '3,000 VA / 2,700 W', io: '200–240 V', topology: 'Online (Double Conversion)', mgmt: 'NMC', use: 'Server, Network, Edge' } },
  srt5000_xbp: { title: 'Smart-UPS SRT 5000 + XBP (5U)', series: 'SRT', form: 'rack', u: 5, mm: [482.6, 222.3, 635], spec: { capacity: '5,000 VA / 4,500 W', io: '200–240 V', topology: 'Online (Double Conversion)', mgmt: 'NMC', use: 'Data Center, Core' } },
  srt8000_xbp: { title: 'Smart-UPS SRT 8000 + XBP (5U)', series: 'SRT', form: 'rack', u: 5, mm: [482.6, 222.3, 715], spec: { capacity: '8,000 VA / 8,000 W', io: '200–240 V (3-phase in)', topology: 'Online (Double Conversion)', mgmt: 'NMC', use: 'Data Center, HPC' } },
  srt10000_6u: { title: 'Smart-UPS SRT 10000 (6U)', series: 'SRT', form: 'rack', u: 6, mm: [482.6, 266.7, 715], spec: { capacity: '10,000 VA / 10,000 W', io: '200–240 V (3-phase in)', topology: 'Online (Double Conversion)', mgmt: 'NMC', use: 'Enterprise DC' } },
  srt1000_rm: { title: 'SRT 1000RMXLI (2U)', series: 'SRT', form: 'rack', u: 2, mm: [482.6, 88.9, 635], spec: { capacity: '1,000 VA / 900 W', topology: 'Online' } },
  srt2200_rm: { title: 'SRT 2200RMXLI (2U)', series: 'SRT', form: 'rack', u: 2, mm: [482.6, 88.9, 635], spec: { capacity: '2,200 VA / 1,980 W', topology: 'Online' } },
  srt3000_rm: { title: 'SRT 3000RMXLI (2U)', series: 'SRT', form: 'rack', u: 2, mm: [482.6, 88.9, 635], spec: { capacity: '3,000 VA / 2,700 W', topology: 'Online' } },
  srt5000_rm: { title: 'SRT 5000RMXLI (3U)', series: 'SRT', form: 'rack', u: 3, mm: [482.6, 133, 715], spec: { capacity: '5,000 VA / 4,500 W', topology: 'Online' } },
  srt6000_rm: { title: 'SRT 6000RMXLI (3U)', series: 'SRT', form: 'rack', u: 3, mm: [482.6, 133, 715], spec: { capacity: '6,000 VA / 5,400 W', topology: 'Online' } },
  srt8000_rm: { title: 'SRT 8000RMXLI (4U)', series: 'SRT', form: 'rack', u: 4, mm: [482.6, 178, 715], spec: { capacity: '8,000 VA / 7,200 W', topology: 'Online' } },
  srt10000_rm: { title: 'SRT 10000RMXLI (4U)', series: 'SRT', form: 'rack', u: 4, mm: [482.6, 178, 715], spec: { capacity: '10,000 VA / 9,000 W', topology: 'Online' } },
  srt3000xli_tower: { title: 'SRT 3000XLI (Tower)', series: 'SRT', form: 'tower', mm: [130, 440, 600], spec: { capacity: '3,000 VA / 2,700 W', topology: 'Online', use: 'Tower / convertible' } },
  xbp192: { title: 'SRT192RMBP XBP (3U)', series: 'SRT XBP', form: 'rack', u: 3, mm: [482.6, 133, 635], spec: { capacity: '192 VDC battery pack · for SRT 5/6 kVA' } },
  xbp240: { title: 'SRT240RMBP XBP (3U)', series: 'SRT XBP', form: 'rack', u: 3, mm: [482.6, 133, 715], spec: { capacity: '240 VDC battery pack · for SRT 8/10 kVA' } },
  srtl3000_rm: { title: 'Smart-UPS Ultra SRTL 3000 (2U, Li-ion)', series: 'SRTL', form: 'rack', u: 2, mm: [482.6, 88.9, 500], spec: { capacity: '3,000 VA / 3,000 W', topology: 'Online · Li-ion' } },
  srtl5000_rm: { title: 'Smart-UPS Ultra SRTL 5000 (2U, Li-ion)', series: 'SRTL', form: 'rack', u: 2, mm: [482.6, 88.9, 560], spec: { capacity: '5,000 VA / 5,000 W', topology: 'Online · Li-ion' } },
  src3000_rm: { title: 'Smart-UPS SRC 3000RMXLI (2U)', series: 'SRC', form: 'rack', u: 2, mm: [482.6, 88.9, 600], spec: { capacity: '3,000 VA / 2,700 W', topology: 'Online · rugged/edge' } },
  srv3000_rm: { title: 'Easy UPS SRV 3000RLI (2U)', series: 'SRV', form: 'rack', u: 2, mm: [482.6, 88.9, 600], spec: { capacity: '3,000 VA / 2,700 W', topology: 'Online' } },
  srv6000_rm: { title: 'Easy UPS SRV 6000RLI (3U)', series: 'SRV', form: 'rack', u: 3, mm: [482.6, 133, 650], spec: { capacity: '6,000 VA / 5,400 W', topology: 'Online' } },
  srvrm1000: { title: 'Easy UPS SRVRM 1000A (2U)', series: 'SRV', form: 'rack', u: 2, mm: [482.6, 88.9, 450], spec: { capacity: '1,000 VA / 800 W', topology: 'Online' } },
  srvrm3000: { title: 'Easy UPS SRVRM 3000A (2U)', series: 'SRV', form: 'rack', u: 2, mm: [482.6, 88.9, 600], spec: { capacity: '3,000 VA / 2,700 W', topology: 'Online' } },
  // ── Line-interactive / SOHO ──
  smt_rm: { title: 'Smart-UPS SMT (Rackmount 2U)', series: 'SMT', form: 'rack', u: 2, mm: [482.6, 88.9, 460], spec: { capacity: '750–3,000 VA', topology: 'Line-Interactive', use: 'Rack servers, network' } },
  smc_rm: { title: 'Smart-UPS C / SMC (Rackmount 1U)', series: 'SMC', form: 'rack', u: 1, mm: [482.6, 44.45, 420], spec: { capacity: '750–1,500 VA', topology: 'Line-Interactive', use: 'Network, edge' } },
  smx_rm: { title: 'Smart-UPS X / SMX (Rackmount 2U)', series: 'SMX', form: 'rack', u: 2, mm: [482.6, 88.9, 480], spec: { capacity: '750–3,000 VA', topology: 'Line-Interactive · XBP' } },
  smt_tower: { title: 'Smart-UPS SMT (Tower)', series: 'SMT', form: 'tower', mm: [170, 220, 440], spec: { capacity: '750–3,000 VA', topology: 'Line-Interactive' } },
  backups: { title: 'Back-UPS (Tower)', series: 'Back-UPS', form: 'tower', mm: [110, 220, 300], spec: { capacity: '350–1,400 VA', topology: 'Line-Interactive' } },
  backups_pro: { title: 'Back-UPS Pro (Tower)', series: 'Back-UPS', form: 'tower', mm: [110, 250, 330], spec: { capacity: '900–1,500 VA', topology: 'Line-Interactive · LCD/AVR' } },
  backups_bx: { title: 'Back-UPS BX (Tower)', series: 'Back-UPS', form: 'tower', mm: [100, 215, 300], spec: { capacity: '650–1,600 VA', topology: 'Line-Interactive' } },
  easy_bv: { title: 'Easy UPS BV / BVX (Tower)', series: 'Easy UPS', form: 'tower', mm: [100, 215, 300], spec: { capacity: '650–1,600 VA', topology: 'Line-Interactive' } },
  easy_smv: { title: 'Easy UPS SMV (Tower)', series: 'Easy UPS', form: 'tower', mm: [145, 235, 380], spec: { capacity: '1,000–3,000 VA', topology: 'Line-Interactive · wide AVR' } },
  // ── Modular / 3-phase ──
  modular15k: { title: 'Smart-UPS Modular Ultra 15 kW (7U)', series: 'Modular Ultra', form: 'rack', u: 7, mm: [482, 311, 700], spec: { capacity: '15 kW / 15 kVA', io: '380–415 V 3Ø', topology: 'Modular · N+1 · 5 kW modules', mgmt: 'SNMP, Modbus, Dry contact' } },
  modular20k: { title: 'Smart-UPS Modular Ultra 20 kW (7U)', series: 'Modular Ultra', form: 'rack', u: 7, mm: [482, 311, 700], spec: { capacity: '20 kW / 20 kVA', io: '380–415 V 3Ø', topology: 'Modular · N+1 · 10 kW modules', mgmt: 'SNMP, Modbus, Dry contact' } },
  galaxy_vs: { title: 'Galaxy VS (Cabinet)', series: 'Galaxy', form: 'cabinet', mm: [600, 2000, 850], spec: { capacity: '20–150 kW (scalable)', io: '380–415 V 3Ø', topology: 'Modular · up to 4 parallel', mgmt: 'SNMP, Modbus, Dry contact' } },
  galaxy_vs8: { title: 'Galaxy VS 20–150 kW', series: 'Galaxy', form: 'cabinet', mm: [600, 2000, 850], spec: { capacity: '20–150 kW', io: '3-phase' } },
  galaxy_vl: { title: 'Galaxy VL 200–500 kW', series: 'Galaxy', form: 'cabinet', mm: [1200, 2000, 1000], spec: { capacity: '200–500 kW', io: '3-phase', use: 'Large DC' } },
  galaxy_vx: { title: 'Galaxy VX 500–1,500 kW', series: 'Galaxy', form: 'cabinet', mm: [1800, 2000, 1000], spec: { capacity: '500–1,500 kW', io: '3-phase', use: 'Hyperscale' } },
  symmetra_px: { title: 'Symmetra PX (Cabinet)', series: 'Symmetra', form: 'cabinet', mm: [600, 2000, 850], spec: { capacity: '20–500 kW (scalable)', io: '380–415 V 3Ø', topology: 'Modular · N+1 redundant', mgmt: 'SNMP, Modbus, Dry contact' } },
  symmetra_px8: { title: 'Symmetra PX 20–500 kW', series: 'Symmetra', form: 'cabinet', mm: [900, 2000, 1000], spec: { capacity: '20–500 kW', io: '3-phase modular' } },
  symmetra_lx: { title: 'Symmetra LX 8–16 kVA', series: 'Symmetra', form: 'cabinet', mm: [480, 1100, 700], spec: { capacity: '8–16 kVA', io: '3-phase modular', use: 'IT rooms, edge' } },
  easy3s: { title: 'Easy UPS 3S 10–40 kVA', series: 'Easy UPS 3', form: 'cabinet', mm: [400, 1100, 800], spec: { capacity: '10–40 kVA', io: '3-phase' } },
  easy3m: { title: 'Easy UPS 3M 60–200 kVA', series: 'Easy UPS 3', form: 'cabinet', mm: [600, 1900, 850], spec: { capacity: '60–200 kVA', io: '3-phase' } },
  easy3mod: { title: 'Easy UPS 3-Phase Modular 250–600 kW', series: 'Easy UPS 3', form: 'cabinet', mm: [600, 2000, 1000], spec: { capacity: '250–600 kW', io: '3-phase modular' } },
  // ── Monitoring & sensors ──
  netbotz750: { title: 'NetBotz 750 (NBES7550)', series: 'NetBotz', form: 'rack', u: 1, mm: [432, 44, 236], spec: { capacity: 'up to 78 sensors', mgmt: 'Web, SNMP, Modbus, EcoStruxure IT', io: '1× GbE · 4× sensor (RJ12) · A-Link in/out · USB · console' } },
  nmc_ap9640: { title: 'Network Management Card 3 (AP9640)', series: 'NMC', form: 'card', mm: [121, 38, 114], spec: { mgmt: 'Web, SNMP, SSH, EcoStruxure IT', io: '1× 10/100/1000 RJ45 · reset' } },
  sensor_th: { title: 'Temperature & Humidity Sensor (AP9335T)', series: 'Sensor', form: 'sensor', spec: { capacity: '-20…80 °C (±0.5) · 0–100 % RH (±3)', io: '1× sensor port (RJ12) · status LED' } },
  sensor_leak: { title: 'Leak Rope / Leak Sensor Kit (AP9335W)', series: 'Sensor', form: 'sensor', spec: { capacity: 'rope 3 m (10 ft) · distilled & conductive liquids', io: '1× sensor port (RJ12)' } },
  sensor_door: { title: 'Door Switch / Rack Access Sensor (AP9335D)', series: 'Sensor', form: 'sensor', spec: { capacity: 'magnetic contact · 3 m lead', io: '1× sensor port (RJ12) · status LED' } },
  // ── Power distribution ──
  pdu_basic: { title: 'Basic Rack PDU (AP7552, 0U)', series: 'Rack PDU', form: 'zerou', mm: [56, 1500, 44], spec: { capacity: '7.4 kW · 230 V 32 A', io: '(20) C13 + (4) C19 · IEC309 in' } },
  pdu_metered: { title: 'Metered Rack PDU (AP8858, 0U)', series: 'Rack PDU', form: 'zerou', mm: [56, 1500, 44], spec: { capacity: '7.4 kW · 230 V 32 A', io: '(20) C13 + (4) C19', mgmt: 'V/A/kW · SNMP' } },
  pdu_switched: { title: 'Switched Rack PDU (AP8959, 0U)', series: 'Rack PDU', form: 'zerou', mm: [56, 1500, 44], spec: { capacity: '7.4 kW · 230 V 32 A', io: '(20) C13 + (4) C19', mgmt: 'per-outlet on/off · SNMP' } },
  rack_ats: { title: 'Rack ATS (AP4423A, 1U)', series: 'ATS', form: 'rack', u: 1, mm: [482.6, 44.45, 300], spec: { capacity: '16 A dual input · <10 ms transfer', io: '(8) C13 out · LCD' } },
  // ══════════ Vertiv ══════════ (vendor: 'Vertiv')
  gxt5_1_3: { vendor: 'Vertiv', title: 'Liebert GXT5 1–3 kVA (2U)', series: 'GXT5', form: 'rack', u: 2, mm: [482.6, 88.9, 500], spec: { capacity: '1 / 1.5 / 2 / 3 kVA', io: '200–240 V 1Ø', topology: 'Online (Double Conversion)', mgmt: 'LCD, RDU101 SNMP, USB, RS-232, Intellislot', use: 'Edge, IT room' } },
  gxt5_5_10: { vendor: 'Vertiv', title: 'Liebert GXT5 5–10 kVA (3U)', series: 'GXT5', form: 'rack', u: 3, mm: [482.6, 133, 650], spec: { capacity: '5 / 6 / 8 / 10 kVA', io: '200–240 V 1Ø', topology: 'Online (Double Conversion)', mgmt: 'LCD, RDU101 SNMP, dry contact', use: 'Mission critical, server room' } },
  psi5: { vendor: 'Vertiv', title: 'Liebert PSI5 (2U)', series: 'PSI5', form: 'rack', u: 2, mm: [482.6, 88.9, 430], spec: { capacity: '650 VA – 3 kVA', io: '100–125 / 200–240 V', topology: 'Line-Interactive (AVR)', mgmt: 'LCD, USB, RS-232, SNMP (opt.)' } },
  ita2: { vendor: 'Vertiv', title: 'Liebert ITA2 5–10 kVA (3U)', series: 'ITA2', form: 'rack', u: 3, mm: [482.6, 133, 650], spec: { capacity: '5 / 6 / 8 / 10 kVA', io: '200–240 V 1Ø / 380–415 V 3Ø', topology: 'Online (Double Conversion)', mgmt: 'LCD, USB, RS-232, SNMP, dry contact' } },
  gxe: { vendor: 'Vertiv', title: 'Liebert GXE 1–3 kVA (2U)', series: 'GXE', form: 'rack', u: 2, mm: [482.6, 88.9, 450], spec: { capacity: '1 / 2 / 3 kVA', io: '200–240 V 1Ø', topology: 'Online (Double Conversion)', mgmt: 'LCD, USB, RS-232, SNMP (opt.)' } },
  vertiv_ebc: { vendor: 'Vertiv', title: 'External Battery Cabinet (2U/3U)', series: 'EBC', form: 'rack', u: 2, mm: [482.6, 88.9, 500], spec: { capacity: 'VRLA battery pack · GXT5 / PSI5 / ITA2 / GXE', mgmt: 'auto detection' } },
  gxt5_tower: { vendor: 'Vertiv', title: 'Liebert GXT5 Tower 1–3 kVA', series: 'GXT5', form: 'tower', mm: [130, 440, 500], spec: { capacity: '1–3 kVA', topology: 'Online' } },
  psi5_tower: { vendor: 'Vertiv', title: 'Liebert PSI5 Tower 1.5–3 kVA', series: 'PSI5', form: 'tower', mm: [145, 400, 430], spec: { capacity: '1.5–3 kVA', topology: 'Line-Interactive' } },
  exm2: { vendor: 'Vertiv', title: 'Liebert EXM2 (Modular 3Ø)', series: 'EXM2', form: 'cabinet', mm: [600, 2000, 1100], spec: { capacity: '250 – 2,500 kVA (250 kVA modules)', io: '380/400/415 V 3Ø', topology: 'True Online, VFI · up to 97 %', mgmt: 'hot-swap modules, N+1', use: 'Large DC, colocation' } },
  exl_s1: { vendor: 'Vertiv', title: 'Liebert EXL S1 (3Ø)', series: 'EXL S1', form: 'cabinet', mm: [600, 2000, 1000], spec: { capacity: '250 – 1,200 kVA', io: '380/400/415 V 3Ø', topology: 'True Online, VFI · up to 98 %', use: 'Hyperscale, enterprise' } },
  apm2: { vendor: 'Vertiv', title: 'Liebert APM2 (Modular 3Ø)', series: 'APM2', form: 'cabinet', mm: [600, 2000, 1100], spec: { capacity: '50 – 600 kVA (50 kVA modules)', io: '380/400/415 V 3Ø', topology: 'True Online, VFI · up to 97 %', mgmt: 'hot-swap modules, N+1', use: 'Medium/large DC, edge' } },
  aps: { vendor: 'Vertiv', title: 'Liebert APS (Scalable 3Ø)', series: 'APS', form: 'cabinet', mm: [1200, 2000, 1000], spec: { capacity: '300 – 4,800 kVA', io: '380/400/415 V 3Ø', topology: 'True Online, VFI', mgmt: 'N+1, parallel', use: 'Hyperscale, critical infra' } },
  nxc: { vendor: 'Vertiv', title: 'Liebert NXC (3Ø)', series: 'NXC', form: 'cabinet', mm: [1200, 2000, 1000], spec: { capacity: '800 kVA – 6+ MW (parallel)', io: '380/400/415 V 3Ø', topology: 'True Online, VFI · up to 98.5 %', use: 'Large DC, industrial, healthcare' } },
  trinergy_cube: { vendor: 'Vertiv', title: 'Trinergy Cube (3Ø)', series: 'Trinergy', form: 'cabinet', mm: [2400, 2000, 1000], spec: { capacity: '3,000 – 48,000 kVA', io: '400/480 V 3Ø', topology: 'Online VFI · modular, parallel', use: 'Hyperscale, utility-scale' } },
  // Vertiv precision cooling (CRAC / CRAH / in-row)
  liebert_pdx: { vendor: 'Vertiv', title: 'Liebert PDX (CRAC, DX)', series: 'PDX', form: 'crac', mm: [900, 1970, 900], spec: { capacity: '25 – 200 kW', topology: 'DX · inverter compressor', io: 'Downflow / Upflow · perimeter', use: 'Tier III/IV DC' } },
  liebert_pcw: { vendor: 'Vertiv', title: 'Liebert PCW (CRAH, chilled water)', series: 'PCW', form: 'crac', mm: [1800, 1970, 900], spec: { capacity: '30 – 300 kW', topology: 'Chilled water · EC fans', io: 'Downflow / Upflow · perimeter', use: 'Large DC, high density' } },
  liebert_dse: { vendor: 'Vertiv', title: 'Liebert DSE (indirect evaporative)', series: 'DSE', form: 'crac', mm: [1200, 1970, 900], spec: { capacity: '50 – 300 kW', topology: 'Indirect evaporative + DX (hybrid)', io: 'Downflow / Upflow', use: 'Energy-saving DC, low PUE' } },
  liebert_crv: { vendor: 'Vertiv', title: 'Liebert CRV (in-row)', series: 'CRV', form: 'crac', mm: [600, 2000, 1100], spec: { capacity: '10 – 60 kW per unit', topology: 'DX or chilled water', io: 'Horizontal (rack to rack) · in-row', use: 'High density, HPC/AI, edge' } },
  minimate2: { vendor: 'Vertiv', title: 'Liebert Mini-Mate2 (compact)', series: 'Mini-Mate', form: 'crac', mm: [700, 1500, 600], spec: { capacity: '5 – 40 kW', topology: 'DX', io: 'Upflow / Downflow · room, wall, floor', use: 'Small server rooms, telecom' } },
  liebert_hpm: { vendor: 'Vertiv', title: 'Liebert HPM (thermal module, CW)', series: 'HPM', form: 'crac', mm: [2500, 2000, 1000], spec: { capacity: '200 – 1,200 kW (modular)', topology: 'Chilled water', io: 'Upflow · outdoor / mechanical room', use: 'Large modular DC' } },
  vertiv_edge: { vendor: 'Vertiv', title: 'Vertiv Edge Cooling', series: 'Edge', form: 'crac', mm: [600, 1800, 800], spec: { capacity: '3 – 20 kW', topology: 'DX', io: 'Front to back · rack / floor / wall', use: 'Edge, telecom, industrial' } },
  // Vertiv chillers / outdoor heat rejection
  afc_chiller: { vendor: 'Vertiv', title: 'Liebert AFC Chiller (water-cooled)', series: 'AFC', form: 'outdoor', mm: [4500, 2200, 1800], spec: { capacity: 'centrifugal · condenser water → cooling tower', io: 'Mechanical room (indoor)', use: 'Large DC, campus' } },
  aircooled_chiller: { vendor: 'Vertiv', title: 'Air-Cooled Chiller (scroll/screw)', series: 'Chiller', form: 'outdoor', mm: [8000, 2500, 2200], spec: { capacity: 'air-cooled (ambient)', io: 'Outdoor (rooftop / ground)', use: 'Small/medium DC' } },
  freecooling_chiller: { vendor: 'Vertiv', title: 'Free-Cooling Chiller', series: 'Chiller', form: 'outdoor', mm: [8000, 2500, 2200], spec: { capacity: 'air-cooled + free cooling', io: 'Outdoor (rooftop / ground)', use: 'Energy-efficient DC' } },
  drycooler: { vendor: 'Vertiv', title: 'Dry Cooler / Fluid Cooler', series: 'Heat rejection', form: 'outdoor', mm: [6000, 2200, 2200], spec: { capacity: 'air-cooled (process fluid)', io: 'Outdoor', use: 'Chilled water / glycol loop' } },
  condenser: { vendor: 'Vertiv', title: 'Outdoor Condenser (DX)', series: 'Heat rejection', form: 'outdoor', mm: [4000, 2000, 1500], spec: { capacity: 'air-cooled (refrigerant)', io: 'Outdoor', use: 'DX systems / pumped refrigerant' } },
  pumped_refrig: { vendor: 'Vertiv', title: 'Pumped Refrigerant / Heat-Rejection Unit', series: 'Heat rejection', form: 'outdoor', mm: [4000, 2200, 2000], spec: { capacity: 'air-cooled (refrigerant / fluid)', io: 'Outdoor or service area', use: 'Distributed cooling, row / edge' } },
  // ══════════ Cisco ══════════ (vendor: 'Cisco') — photo faces replace the vector facades in 3D when present
  cisco_c9200: { vendor: 'Cisco', title: 'Catalyst 9200 (access, 1U)', series: 'Catalyst', form: 'rack', u: 1, mm: [445, 44.45, 400], spec: { capacity: '24 / 48 × 1G · uplink 1G/10G SFP+', topology: 'StackWise-160', use: 'Access switching' } },
  cisco_c9300: { vendor: 'Cisco', title: 'Catalyst 9300-48P (access, 1U)', series: 'Catalyst', form: 'rack', u: 1, mm: [445, 44.45, 450], spec: { capacity: '48 × 1G PoE+ (740 W) · uplink 1G/10G/25G', topology: 'StackWise-480', use: 'Access switching' } },
  cisco_c9500: { vendor: 'Cisco', title: 'Catalyst 9500-48Y4C (core, 1U)', series: 'Catalyst', form: 'rack', u: 1, mm: [445, 44.45, 500], spec: { capacity: '48 × 1/10/25G SFP28 · 4 × 100G QSFP28', mgmt: 'Redundant power / fans', use: 'Campus core, aggregation' } },
  cisco_c9600: { vendor: 'Cisco', title: 'Catalyst 9600 (modular chassis)', series: 'Catalyst', form: 'rack', u: 7, mm: [445, 311, 550], spec: { capacity: 'up to 12.8 Tbps · 7U/10U/13U options', topology: 'Line cards 1G–100G · redundant supervisor/power', use: 'Campus core / backbone' } },
  cisco_n93180: { vendor: 'Cisco', title: 'Nexus 93180YC-FX (leaf, 1U)', series: 'Nexus', form: 'rack', u: 1, mm: [445, 44.45, 560], spec: { capacity: '48 × 25G SFP28 · 6 × 100G QSFP28', topology: 'NX-OS', use: 'Data center leaf' } },
  cisco_n9300: { vendor: 'Cisco', title: 'Nexus 9300 (spine-leaf, 1U)', series: 'Nexus', form: 'rack', u: 1, mm: [445, 44.45, 560], spec: { capacity: '48 / 96 × 10G/25G · 6 × 100G · up to 6.4 Tbps', mgmt: 'Redundant power / fans', use: 'DC spine / leaf' } },
  cisco_n9500: { vendor: 'Cisco', title: 'Nexus 9500 (modular chassis)', series: 'Nexus', form: 'rack', u: 7, mm: [445, 311, 800], spec: { capacity: 'up to 115 Tbps · 7U/10U/18U options', topology: 'Line cards 1–400G · redundant supervisor/fabric/power', use: 'DC core / spine' } },
  cisco_n7700: { vendor: 'Cisco', title: 'Nexus 7700 (modular chassis)', series: 'Nexus', form: 'rack', u: 7, mm: [445, 311, 800], spec: { capacity: 'up to 460 Tbps · 7U/10U/18U', topology: 'Line cards 1/10/40/100G · redundant supervisor', use: 'Backbone / SP core' } },
  cisco_mds9700: { vendor: 'Cisco', title: 'MDS 9700 (SAN director)', series: 'MDS', form: 'rack', u: 4, mm: [445, 178, 700], spec: { capacity: 'up to 115 Tbps · 16/32/64G FC', topology: '4U/8U · redundant supervisor/power', use: 'SAN core' } },
  cisco_isr4331: { vendor: 'Cisco', title: 'ISR 4331 (edge router, 1U)', series: 'ISR', form: 'rack', u: 1, mm: [445, 44.45, 440], spec: { capacity: 'up to 100 Mbps (IMIX) · 3 × GE, 1 × SFP', topology: 'Routing / VPN / SD-WAN', mgmt: 'Dual PSU (AC)' } },
  cisco_isr4451: { vendor: 'Cisco', title: 'ISR 4451-X / CUBE (2U)', series: 'ISR', form: 'rack', u: 2, mm: [445, 88.9, 470], spec: { capacity: '4 × GE, 2 × SFP+, modular · PVDM4', topology: 'CUBE / voice gateway / routing', mgmt: 'Dual PSU (AC)' } },
  cisco_ucs_c220: { vendor: 'Cisco', title: 'UCS C220 M6 (1U rack server)', series: 'UCS', form: 'rack', u: 1, mm: [445, 44.45, 760], spec: { capacity: '2 × Xeon · up to 2 TB · 8 × SFF', mgmt: 'Cisco IMC / UCS Manager', io: 'Dual PSU (AC)' } },
  cisco_ucs_c240: { vendor: 'Cisco', title: 'UCS C240 M6 (2U rack server)', series: 'UCS', form: 'rack', u: 2, mm: [445, 88.9, 760], spec: { capacity: '2 × Xeon · up to 4 TB · 24 × SFF', mgmt: 'Cisco IMC / UCS Manager', io: 'Dual PSU (AC)' } },
  meraki_mx105: { vendor: 'Cisco', title: 'Meraki MX105 (security appliance, 1U)', series: 'Meraki', form: 'rack', u: 1, mm: [445, 44.45, 300], spec: { capacity: 'VPN up to 750 Mbps · 1 × WAN + 8 × LAN', topology: 'Security / SD-WAN / auto VPN', mgmt: 'Meraki Dashboard' } },
  patch24_photo: { vendor: 'Cisco', title: '24-port patch panel (1U)', series: 'Passive', form: 'rack', u: 1, mm: [445, 44.45, 120], spec: { capacity: '24 × RJ45 (Cat6/6A) · T568A/B' } },
  patch48_photo: { vendor: 'Cisco', title: '48-port patch panel (2U)', series: 'Passive', form: 'rack', u: 2, mm: [445, 88.9, 120], spec: { capacity: '48 × RJ45 (Cat6) · 110/LSA punch down' } },
};

// model / vendor / kind → library id (null when the model is not an APC item in the library)
export const apcMeta = (id) => APC_LIB[id] || null;
