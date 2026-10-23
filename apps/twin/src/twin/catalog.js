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
/**
 * Model strings that arrive mistyped from a survey, and what they mean.
 *
 * Encoding a typo into a catalogue matcher would make the catalogue wrong. The
 * correction lives here instead, and `catalogModel()` reports that it applied
 * one, so a screen can say "resolved from a corrected model string" rather
 * than silently presenting the fix as the record.
 *
 * `SRT300RMXLA-NC` is in the Q3 2026 PM seed three times beside
 * `SRT3000RMXLA-NC` three times — the same unit type with a dropped zero.
 * There is no APC part number 'SRT300', so the reading is not ambiguous.
 */
export const MODEL_TYPOS = {
  'SRT300RMXLA-NC': { to: 'SRT3000RMXLA-NC', why: '0 누락 — SRT300 부품번호는 존재하지 않음' },
  'SRT300RMXLA': { to: 'SRT3000RMXLA', why: '0 누락' },
};

/** Apply a known correction, if there is one. */
export function normalizeModel(model) {
  const raw = String(model || '').trim();
  const hit = MODEL_TYPOS[raw.toUpperCase()];
  return hit ? { model: hit.to, corrected: true, from: raw, why: hit.why }
             : { model: raw, corrected: false };
}

export function catalogModel(model) {
  const norm = normalizeModel(model);
  const m = norm.model;
  if (!m) return null;
  // Vertiv first: its families (GXT5, PSI5, ITA2, EXM2, PDX…) are distinctive
  // strings, while a few APC patterns are loose enough to catch them by
  // accident if they ran first.
  // A corrected model string must not pass as the record: the correction
  // travels on the entry so the caller can show it.
  const corr = norm.corrected ? { model_corrected_from: norm.from, model_correction_why: norm.why } : {};
  const c = ciscoModel(m);
  if (c) return { ...c, vendor: 'Cisco', ...corr };
  const v = vertivModel(m);
  if (v) return { ...v, vendor: 'Vertiv', ...corr };
  const a = apcModel(m);
  if (a) return { ...a, vendor: 'APC', ...corr };
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
