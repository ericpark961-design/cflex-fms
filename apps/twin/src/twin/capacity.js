// Rack and supply capacity: what is drawn, what is left, and what still fits.
//
// The point is the last part. Once a survey has put devices in racks, adding
// "four more 1U servers next quarter" should be answerable before the order is
// placed — against the rack's power, the UPS it hangs off, and the free U.
//
// Two rules decide everything here:
//
//  1. Measured beats estimated, and the two are never added together silently.
//     A UPS reports load_pct, which is the real draw of everything on it. A
//     server with no meter has only a nameplate figure. Both are returned, each
//     labelled, and `confidence` says which the total rests on.
//
//  2. Nothing is invented. A device with no measurement and no nameplate is
//     counted in `unknown`, not given a plausible-looking number. A rack whose
//     supply is unknown reports null headroom rather than a reassuring one.
import { catalogModel } from './catalog.js';

/**
 * Nameplate draw when nothing better exists, in watts. These are planning
 * figures for a device nobody is metering — deliberately typical rather than
 * worst case, and always reported as `estimated` so a plan built on them is
 * visibly a plan built on them.
 */
export const TYPICAL_W = {
  switch: 150,      // 48-port access switch, PoE budget excluded
  router: 250,
  sbc: 200,
  server: 450,      // 1–2U dual-socket, moderate load
  storage: 600,
  patch: 0,         // passive
  pdu: 0,           // distributes, does not consume
  other: 100,
};

/** PoE changes a switch's draw more than anything else, so it is explicit. */
export const POE_BUDGET_W = { none: 0, poe: 370, poe_plus: 740 };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * What one device draws.
 * @returns {{watts:number|null, source:'measured'|'nameplate'|'typical'|null, note?:string}}
 */
export function deviceLoad(d = {}) {
  // A UPS is supply, not load — its own draw is the load on it, handled below.
  const kind = String(d.kind || '').toLowerCase();

  // Measured: a metered device reports its own draw.
  const measuredW = num(d.watts) ?? num(d.power_w);
  if (measuredW != null) return { watts: measuredW, source: 'measured' };

  // A UPS's load_pct against its catalogue rating is a real measurement of
  // everything plugged into it.
  if (kind === 'ups') {
    const e = catalogModel(d.model);
    const ratedW = e?.w ?? (e?.kw ? e.kw * 1000 : null);
    const pct = num(d.load_pct);
    if (ratedW != null && pct != null) {
      return { watts: Math.round(ratedW * pct / 100), source: 'measured', note: `${pct}% of ${ratedW} W` };
    }
    return { watts: null, source: null, note: ratedW == null ? '정격 미상' : '부하율 미수집' };
  }

  // Declared nameplate on the record.
  const plate = num(d.nameplate_w) ?? num(d.attrs?.nameplate_w);
  if (plate != null) return { watts: plate, source: 'nameplate' };

  // Typical for the kind, plus PoE. The catalogue carries the model's real PoE
  // budget where the sheet gives one — a Catalyst 9300-48P is 740 W, which is
  // the largest single line in an access rack and not something to guess at.
  if (kind in TYPICAL_W) {
    const e = catalogModel(d.model);
    const poe = e?.poe_budget_w
      ?? (POE_BUDGET_W[String(d.poe || d.attrs?.poe || 'none').toLowerCase()] ?? 0);
    const note = e?.poe_budget_w ? `PoE +${e.poe_budget_w} W (카탈로그)` : poe ? `PoE +${poe} W` : undefined;
    return { watts: TYPICAL_W[kind] + poe, source: 'typical', note };
  }
  return { watts: null, source: null, note: '전력 정보 없음' };
}

/**
 * Roll a set of devices into a load figure.
 * `measured` and `estimated` stay apart; `total` is their sum, and
 * `confidence` reports what it mostly rests on.
 */
export function rollupLoad(devices = []) {
  let upsMeasured = 0, otherMeasured = 0, estimated = 0, unknown = 0;
  const breakdown = [];
  for (const d of devices) {
    const l = deviceLoad(d);
    const isUps = String(d.kind || '').toLowerCase() === 'ups';
    breakdown.push({ label: d.label, kind: d.kind, feeds: isUps || undefined, ...l });
    if (l.watts == null) { unknown++; continue; }
    if (isUps) upsMeasured += l.watts;
    else if (l.source === 'measured') otherMeasured += l.watts;
    else estimated += l.watts;
  }

  // A UPS in the rack reports what is drawn THROUGH it — that already includes
  // the switches and servers it feeds. Adding their nameplate estimates on top
  // counts the same watts twice: rack A01 read 2,597 W against a 2,700 W unit
  // when the measurement said 1,107 W. The downstream estimate is kept as a
  // cross-check, and the total takes the measurement where there is one.
  const downstream = otherMeasured + estimated;
  const doubleCounted = upsMeasured > 0 && downstream > 0;
  const total = doubleCounted ? Math.max(upsMeasured, downstream) : upsMeasured + downstream;

  return {
    measured: upsMeasured + otherMeasured,
    upsMeasured,
    estimated,
    downstream,
    total,
    unknown,
    devices: breakdown,
    basis: doubleCounted
      ? (upsMeasured >= downstream ? 'ups-measured' : 'downstream-estimate')
      : upsMeasured > 0 ? 'ups-measured' : 'downstream-estimate',
    doubleCountAvoided: doubleCounted,
    confidence: unknown > 0 ? 'partial'
      : estimated === 0 ? 'measured'
      : (upsMeasured > 0 && upsMeasured >= downstream) ? 'measured'
      : 'mixed',
  };
}

/**
 * A rack's capacity picture.
 *
 * @param rack     { name, u_height }
 * @param devices  everything placed in it
 * @param supply   { watts, label }  the circuit or UPS feeding it, when known
 */
export function rackCapacity({ rack = {}, devices = [], supply = null } = {}) {
  const load = rollupLoad(devices);
  const uHeight = num(rack.u_height) ?? 42;
  const uUsed = devices.reduce((n, d) => n + (num(d.u_height) || 1), 0);

  const supplyW = num(supply?.watts);
  // Headroom is only a number when the supply is actually known. "Unknown
  // supply" must not round down to "plenty left".
  const headroomW = supplyW != null ? supplyW - load.total : null;
  const usedPct = supplyW ? Math.round((load.total / supplyW) * 1000) / 10 : null;

  return {
    rack: rack.name || null,
    load,
    supply: supplyW != null ? { watts: supplyW, label: supply.label || null } : null,
    power: { usedW: load.total, headroomW, usedPct },
    space: { uHeight, uUsed, uFree: Math.max(0, uHeight - uUsed), usedPct: Math.round((uUsed / uHeight) * 1000) / 10 },
    confidence: load.confidence,
  };
}

/**
 * Can N more of something go in?
 *
 * Answers in both dimensions, because a rack runs out of one before the other
 * and which one it is decides what the fix costs.
 *
 * @param capacity  the rackCapacity() result
 * @param add       { kind, count, u_height, watts?, poe? }
 * @param limitPct  design ceiling on the supply, default 80%
 */
export function canFit(capacity, add = {}, limitPct = 80) {
  const count = Math.max(1, Math.floor(num(add.count) ?? 1));
  const each = deviceLoad({ kind: add.kind, nameplate_w: add.watts, poe: add.poe });
  const perU = num(add.u_height) || 1;

  const spaceFits = capacity.space.uFree >= perU * count;
  const uPossible = Math.floor(capacity.space.uFree / perU);

  let powerFits = null, wPossible = null, ceilingW = null;
  if (capacity.supply && each.watts != null) {
    ceilingW = capacity.supply.watts * (limitPct / 100);
    const free = ceilingW - capacity.power.usedW;
    wPossible = Math.max(0, Math.floor(free / each.watts));
    powerFits = free >= each.watts * count;
  }

  const blockers = [];
  if (!spaceFits) blockers.push(`공간 부족 — ${perU}U × ${count} 필요, ${capacity.space.uFree}U 남음`);
  if (powerFits === false) blockers.push(`전력 부족 — ${each.watts * count} W 필요, 한계 ${limitPct}%까지 ${Math.max(0, Math.round(ceilingW - capacity.power.usedW))} W 남음`);

  return {
    fits: spaceFits && powerFits !== false,
    // null means "cannot be answered", which is different from "no".
    powerKnown: powerFits !== null,
    space: { fits: spaceFits, possible: uPossible },
    power: { fits: powerFits, possible: wPossible, perDeviceW: each.watts, source: each.source, ceilingW },
    max: powerFits === null ? uPossible : Math.min(uPossible, wPossible),
    blockers,
    limitPct,
    confidence: capacity.confidence,
    caveat: each.source === 'typical'
      ? '추가 장비의 소비전력은 종류별 일반값 — 실제 명판값을 넣으면 정확해집니다'
      : capacity.confidence !== 'measured'
        ? '현재 부하에 추정값이 섞여 있습니다'
        : null,
  };
}

/** The supply a UPS can deliver, from its catalogue rating. */
export function upsSupply(model) {
  const e = catalogModel(model);
  if (!e) return null;
  const watts = e.w ?? (e.kw ? e.kw * 1000 : null);
  if (watts == null) return null;
  return { watts, label: e.label };
}
