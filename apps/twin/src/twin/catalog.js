// One lookup across every vendor catalogue.
//
// Callers should not have to know whether a model is APC or Vertiv to draw it —
// they have a string from ups_devices.model or fms_devices.model and nothing
// else. This resolves it, or returns null so the caller can say "not in the
// catalogue" instead of borrowing another machine's picture.
import { apcModel, specLine as apcSpecLine } from './apcCatalog.js';
import { vertivModel, vertivSpecLine } from './vertivCatalog.js';
import { ciscoModel, ciscoSpecLine } from './ciscoCatalog.js';

/**
 * @returns the catalogue entry, with `vendor` always set, or null.
 */
export function catalogModel(model) {
  const m = String(model || '').trim();
  if (!m) return null;
  // Vertiv first: its families (GXT5, PSI5, ITA2, EXM2, PDX…) are distinctive
  // strings, while a few APC patterns are loose enough to catch them by
  // accident if they ran first.
  const c = ciscoModel(m);
  if (c) return { ...c, vendor: 'Cisco' };
  const v = vertivModel(m);
  if (v) return { ...v, vendor: 'Vertiv' };
  const a = apcModel(m);
  if (a) return { ...a, vendor: 'APC' };
  return null;
}

/** One-line spec summary, from whichever catalogue the entry came from. */
export const catalogSpecLine = (e) =>
  (!e ? null
    : e.vendor === 'Cisco' ? ciscoSpecLine(e)
    : e.vendor === 'Vertiv' ? vertivSpecLine(e)
    : apcSpecLine(e));

/** The discrepancy note, if the source sheets disagreed about this model. */
export const catalogNote = (e) => (e ? (e.spec_note || e.u_note || null) : null);

/** Rack height, or null for a cabinet, tower, sensor or outdoor unit. */
export const catalogUnits = (model) => catalogModel(model)?.u ?? null;
