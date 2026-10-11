// Catalogue id → photograph.
//
// The catalogues resolve a model string to an entry (specs, rack height, the
// places the source sheets disagree). This maps that entry to the photo crops
// taken from the same sheets, so the picture and the specification are two
// views of one record rather than two independent guesses.
//
// A model the catalogue knows but the photo set does not falls back to the
// generated faceplate — which is the right outcome, not a near-miss photo of a
// different unit.
import { catalogModel } from './catalog.js';

// NOTE: this module deliberately does NOT import equipmentLibrary.js. That file
// uses import.meta.glob, which only exists under Vite, and the mapping below is
// the part worth testing — it should not be unreachable from a plain node run
// just because the images are bundled by a build tool. deviceFace.js pulls the
// two together.

/**
 * catalogue id → photo id. Written out rather than derived, because the two id
 * schemes were authored separately and a clever rule would silently mis-map the
 * cases that do not line up (srt3000 has both a 2U unit and an RM variant;
 * easy3ph covers three cabinets that share one photo).
 */
export const PHOTO_OF = {
  // APC — SRT and battery packs
  srt1000: 'srt1000_rm', srt2200: 'srt2200_rm', srt3000: 'srt3000_rm',
  srt5000: 'srt5000_rm', srt6000: 'srt6000_rm', srt8000: 'srt8000_rm',
  srt10000: 'srt10000_rm',
  srt192xbp: 'xbp192', srt240xbp: 'xbp240', srtxbp: 'xbp192',
  // APC — Ultra / line-interactive / Easy
  srtl3000: 'srtl3000_rm', srtl5000: 'srtl5000_rm',
  smx: 'smx_rm', smtrm: 'smt_rm', smt: 'smt_tower', smc: 'smc_rm',
  srvrm: 'srvrm3000', srv: 'srv3000_rm', src: 'src3000_rm',
  smv: 'easy_smv', bvx: 'easy_bv',
  backups: 'backups', backups_pro: 'backups_pro', backups_bx: 'backups_bx',
  // APC — modular / cabinets
  modular15k: 'modular15k', modular20k: 'modular20k',
  symmetra_lx: 'symmetra_lx', symmetra_px: 'symmetra_px',
  galaxy_vs: 'galaxy_vs', galaxy_vl: 'galaxy_vl', galaxy_vx: 'galaxy_vx',
  easy3ph: 'easy3s',
  // APC — power distribution and monitoring
  pdu_basic: 'pdu_basic', pdu_metered: 'pdu_metered', pdu_switched: 'pdu_switched',
  rack_ats: 'rack_ats', netbotz750: 'netbotz750', nmc3: 'nmc_ap9640',
  sensor_th: 'sensor_th', sensor_leak: 'sensor_leak', sensor_door: 'sensor_door',

  // Vertiv — rack / edge
  gxt5_small: 'gxt5_1_3', gxt5_large: 'gxt5_5_10', psi5: 'psi5',
  ita2: 'ita2', gxe: 'gxe', vertiv_ebc: 'vertiv_ebc',
  // Vertiv — modular cabinets
  exm2: 'exm2', exl_s1: 'exl_s1', apm2: 'apm2', aps: 'aps',
  nxc: 'nxc', trinergy: 'trinergy_cube',
  // Vertiv — cooling and heat rejection
  pdx: 'liebert_pdx', pcw: 'liebert_pcw', dse: 'liebert_dse', crv: 'liebert_crv',
  minimate2: 'minimate2', hpm: 'liebert_hpm', edge_cooling: 'vertiv_edge',
  afc_chiller: 'afc_chiller', air_chiller: 'aircooled_chiller',
  free_chiller: 'freecooling_chiller', dry_cooler: 'drycooler',
  condenser: 'condenser', pumped_refrigerant: 'pumped_refrig',

  // Cisco
  cat9200: 'cisco_c9200', cat9300: 'cisco_c9300', cat9300_48p: 'cisco_c9300',
  cat9500: 'cisco_c9500', cat9500_48y4c: 'cisco_c9500', cat9600: 'cisco_c9600',
  nexus93180: 'cisco_n93180', nexus9300: 'cisco_n9300', nexus9500: 'cisco_n9500',
  nexus7700: 'cisco_n7700', mds9700: 'cisco_mds9700',
  isr4331: 'cisco_isr4331', isr4451: 'cisco_isr4451', meraki_mx105: 'meraki_mx105',
  ucs_c220: 'cisco_ucs_c220', ucs_c240: 'cisco_ucs_c240',
  patch24: 'patch24_photo', patch48: 'patch48_photo',
};

/** The photo id for a catalogue entry, or null when there is no photograph. */
export const photoIdFor = (entry) => (entry ? PHOTO_OF[entry.id] || null : null);

/**
 * Resolve a model string to { entry, photoId }. The caller supplies the image
 * accessors, which is what keeps this file free of the build-time glob.
 */
export function photoFor(model) {
  const entry = catalogModel(model);
  return { entry: entry || null, photoId: photoIdFor(entry) };
}

/** The view order a picker should offer, filtered to what exists. */
export const ORDERED_VIEWS = ['front', 'side', 'rear', 'internal', 'top', 'hero'];
export const orderViews = (available = []) => ORDERED_VIEWS.filter(v => available.includes(v));

/** Human label for a view, for the picker. */
export const VIEW_LABEL = {
  front: '전면', side: '측면', rear: '후면',
  internal: '내부', top: '상면', hero: '외관',
};
