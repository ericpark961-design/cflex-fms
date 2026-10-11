// The room as a power tree: rack → PDU → UPS → panel, plus heat against the
// cooling that is actually there.
//
// capacity.js answers one rack. This answers the question that comes after it —
// "we are adding eight servers in B07 next quarter, what breaks first" — which
// cannot be answered one rack at a time, because the rack is rarely what runs
// out. The 16 A branch circuit, the 125 A PDU, the 40 kW UPS and the CRACs all
// sit above it, and the first of them to hit its design ceiling decides what the
// expansion costs.
//
// Two rules carry over from capacity.js and they are the whole design:
//
//  1. Measured and estimated never merge. Every node can have BOTH: its own
//     measurement (a rack's branch kW, a PDU's load_a, a UPS's load_pct) and the
//     sum of what hangs below it. Both are kept, `load_kw` is the one the node
//     rests on, and `basis` says which it is. Where the two disagree the gap is
//     reported — that disagreement is a survey finding, not noise to average
//     away.
//
//  2. Nothing is invented. A rack with no measurement and nothing recognisable
//     in it contributes to `unknown`, and every node above it is marked
//     `partial`: its headroom is a number with a hole in it, and it says so.
//     A node with no known supply reports null capacity, never a comfortable
//     percentage.
import { deviceLoad, upsRating, deviceU, PLANNING } from './capacity.js';
import { CISCO_CATALOG } from './ciscoCatalog.js';
import { APC_CATALOG } from './apcCatalog.js';

const BTU_PER_KW = 3412;
const KW_PER_RT = 3.517;          // one refrigeration ton of cooling
const UPS_EFF = 0.95;             // double-conversion losses, input = output / eff
const DERATE = 0.8;               // continuous load on a breaker, NEC 80 %

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;

export const kwToBtu = (kw) => Math.round(kw * BTU_PER_KW);
export const rtToKw = (rt) => r1(rt * KW_PER_RT);

/**
 * The room's voltage, and whether we actually know it.
 *
 * Every breaker's kW capacity is a voltage multiplied by an amp rating, so a
 * wrong voltage is a wrong capacity everywhere at once. KMX Pesquería runs
 * 127/220 V; assuming the North-American 120/208 V understates every circuit in
 * the plant by 6 %, which is the difference between "79 % loaded" and "84 %
 * loaded" on the same hardware. When the ledger does not say, we proceed on the
 * default and every basis string carries `(가정)` so no one reads it as surveyed.
 */
export function roomVoltage(room = {}) {
  const v1 = num(room.voltage_1ph);
  const v3 = num(room.voltage_3ph);
  if (v1 != null && v3 != null) return { v1, v3, assumed: false, note: room.voltage_note || null };
  return { v1: v1 ?? 120, v3: v3 ?? 208, assumed: true, note: '전압 미기재 — 120/208 V 가정' };
}

const isThreePhase = (phaseOrKind) => /3p|3ø|three/i.test(String(phaseOrKind || ''));

/**
 * The volts a circuit runs at.
 *
 * The room default covers most of it, but a single room mixes voltages: in a
 * 127/220 V plant the convenience circuits are 127 V and the rack branches are
 * 220 V, and treating a 30 A rack feed as 127 V understates it by 42 %. So a
 * link or an object may state its own `volts`, and that wins.
 */
function voltsOf(src, { v1, v3 }, threePhase) {
  const own = num(src?.volts) ?? num(src?.attrs?.volts);
  if (own != null) return threePhase ? own * Math.sqrt(3) : own;
  return threePhase ? v3 * Math.sqrt(3) : v1;
}

/** kW a circuit of `amps` can carry continuously, at the derate. */
function ampsToKw(amps, volt, threePhase, src = null) {
  return r2(amps * voltsOf(src, volt, threePhase) * DERATE / 1000);
}

/**
 * What a node can supply, and the arithmetic behind it.
 * Returns null when the ledger does not say — which is not the same as zero.
 */
export function nodeSupply(o = {}, volt) {
  const a = o.attrs || {};
  const kw = num(a.capacity_kw);
  if (kw != null) return { kw, basis: `${kw} kW ${o.kind === 'ups_cabinet' ? 'UPS' : ''}`.trim() };
  const amps = num(a.rated_a);
  if (amps != null) {
    // A PDU cabinet or a distribution panel is three-phase unless it says
    // otherwise; a rack's own branch circuit is single-phase unless it says so.
    const three = isThreePhase(a.phase) || o.kind === 'pdu_cabinet' || o.kind === 'panel';
    const v = num(a.volts) ?? (three ? volt.v3 : volt.v1);
    return {
      kw: ampsToKw(amps, volt, three, o),
      basis: `${amps} A ${three ? `3Ø ${v}` : `1Ø ${v}`} V × ${DERATE}${volt.assumed && a.volts == null ? ' (가정)' : ''}`,
    };
  }
  return null;
}

/** What a node measures of itself, in kW, or null. */
function ownMeasurement(o = {}, volt) {
  const a = o.attrs || {};
  // A rack's branch meter: the real draw of everything in it, whatever the
  // inventory does or does not know about.
  const kw = num(a.kw) ?? num(a.load_kw);
  if (kw != null) return { kw: r2(kw), basis: '분기 계측' };
  // A PDU reports amps. Same arithmetic as its rating, without the derate —
  // this is what is flowing, not what is allowed.
  const la = num(a.load_a);
  if (la != null) {
    const three = isThreePhase(a.phase) || o.kind === 'pdu_cabinet' || o.kind === 'panel';
    return {
      kw: r2(la * voltsOf(o, volt, three) / 1000),
      basis: `${la} A 계측${volt.assumed && a.volts == null ? ' (가정 전압)' : ''}`,
    };
  }
  // A UPS reports a percentage of its rating.
  const pct = num(a.load_pct);
  if (pct != null) {
    const r = upsRating({ capacity_kw: a.capacity_kw, model: o.model || a.model, load_pct: pct });
    if (r) return { kw: r2(r.watts * pct / 100 / 1000), basis: `부하율 ${pct}% · ${r.basis}` };
  }
  return null;
}

const worst = (a, b) => {
  const rank = { measured: 0, mixed: 1, estimated: 2, partial: 3 };
  return (rank[a] ?? 3) >= (rank[b] ?? 3) ? a : b;
};
const statusOf = (pct) => (pct == null ? 'nodata' : pct >= 100 ? 'critical' : pct >= DERATE * 100 ? 'warn' : 'ok');

/**
 * A measured load this far above its protective device is not an overload.
 *
 * A breaker at 110 % of rating is real, lasts hours, and is worth waking
 * someone for. A breaker at 540 % opens in seconds — so a meter reading 540 %
 * of its own breaker is telling us the ledger has the wrong breaker, the wrong
 * feed, or the wrong voltage, not that the circuit is carrying 86 A. Reporting
 * it as "critical" buries the real overloads under impossible ones.
 */
const IMPLAUSIBLE_PCT = 200;

/**
 * Build the power tree for one room.
 *
 * @param room  a ledger room: { objects, devices, power_links, voltage_1ph… }
 * @param opts.addDevices  devices that are not installed yet (the simulator)
 * @returns { nodes, racks, cracs, room, voltage }
 */
export function roomCapacity(room = {}, { addDevices = [] } = {}) {
  const volt = roomVoltage(room);
  const objects = room.objects || [];
  const obj = Object.fromEntries(objects.map(o => [o.name, o]));

  const byRack = {};
  for (const d of [...(room.devices || []), ...addDevices]) {
    (byRack[d.rack] = byRack[d.rack] || []).push(d);
  }

  // A UPS device standing in a UPS cabinet is the same node as the cabinet, or
  // the chain reads "rack → PDU → KMX-UPS-01 → UPS-1 → panel" and the cabinet's
  // rating gets applied twice.
  const alias = {};
  for (const d of room.devices || []) {
    if (d.kind === 'ups' && obj[d.rack]?.kind === 'ups_cabinet') alias[d.label] = d.rack;
  }
  const links = (room.power_links || [])
    .filter(l => l.src_type !== 'device')
    .map(l => ({ ...l, src: alias[l.src] || l.src, dst: alias[l.dst] || l.dst }))
    .filter(l => l.src !== l.dst);
  const feeders = {};                              // node → the links arriving from below
  for (const l of links) (feeders[l.dst] = feeders[l.dst] || []).push(l);
  const feedsTo = {};                              // node → the node above it
  for (const l of links) if (!feedsTo[l.src]) feedsTo[l.src] = l.dst;

  // ── what each node is on its own ────────────────────────────────
  const own = {};
  for (const o of objects) {
    if (o.kind === 'rack') {
      const ds = byRack[o.name] || [];
      let est = 0, peak = 0, kg = 0, uUsed = 0, unknown = 0;
      let addedEst = 0;
      const items = [];
      for (const d of ds) {
        const l = deviceLoad(d);
        const u = deviceU(d);
        uUsed += u;
        if (l.kg != null) kg += l.kg;
        items.push({ label: d.label, model: d.model, kind: d.kind, u, isNew: !!d._new, ...l });
        if (l.watts == null) { unknown++; continue; }
        // A UPS in the rack is supply for the rack, not load on it. Its draw is
        // accounted for where it feeds, which is the rack's own measurement.
        if (String(d.kind).toLowerCase() === 'ups') continue;
        est += l.watts;
        peak += l.peakW ?? l.watts;
        if (d._new) addedEst += l.watts;
      }
      const meas = ownMeasurement(o, volt);
      own[o.name] = {
        estKw: r2(est / 1000), peakKw: r2(peak / 1000), addedKw: r2(addedEst / 1000),
        measuredKw: meas?.kw ?? null, measuredBasis: meas?.basis ?? null,
        unknown, nDevices: ds.length, uUsed, uHeight: num(o.u_height) ?? 42, weightKg: r1(kg),
        items,
      };
    } else if (o.kind === 'crac') {
      // A CRAC removes heat and consumes power doing it. The cooling figure is
      // what the room needs; the electrical draw is what the UPS or the house
      // supply carries. An EER around 3.2 is the planning figure.
      const rt = num(o.attrs?.rt);
      const coolingKw = rt != null ? rtToKw(rt) : null;
      const elecKw = num(o.attrs?.kw_elec) ?? (coolingKw != null ? r1(coolingKw / 3.2) : null);
      const fan = num(o.attrs?.fan_pct);
      own[o.name] = {
        estKw: elecKw != null ? r2(elecKw * ((fan ?? 70) / 100)) : 0,
        peakKw: elecKw ?? 0, addedKw: 0,
        measuredKw: null, measuredBasis: null,
        unknown: elecKw == null ? 1 : 0, nDevices: 0, uUsed: 0, uHeight: 0, weightKg: 0,
        coolingKw, elecKw, items: [],
      };
    } else {
      const meas = ownMeasurement(o, volt);
      own[o.name] = {
        estKw: 0, peakKw: 0, addedKw: 0,
        measuredKw: meas?.kw ?? null, measuredBasis: meas?.basis ?? null,
        unknown: 0, nDevices: 0, uUsed: 0, uHeight: 0, weightKg: 0, items: [],
      };
    }
  }

  // ── roll the tree up ────────────────────────────────────────────
  // Both numbers travel: the sum of what is below (estimate) and what this node
  // measures of itself. Neither overwrites the other.
  const memo = {};
  const visiting = new Set();
  function rollup(name) {
    if (memo[name]) return memo[name];
    if (visiting.has(name)) {
      return {
        loadKw: 0, estKw: 0, peakKw: 0, addedKw: 0, measuredKw: null,
        downstreamKw: 0, measuredBelowKw: 0, unknown: 0,
        conf: 'partial', basis: 'cycle', inconsistent: false,
      };
    }
    visiting.add(name);
    const o = own[name] || {};
    let est = o.estKw || 0, peak = o.peakKw || 0, added = o.addedKw || 0, unknown = o.unknown || 0;
    let conf = o.unknown ? 'partial' : (o.estKw ? 'estimated' : 'measured');
    let downstream = 0, downMeasured = 0;
    for (const l of feeders[name] || []) {
      const c = rollup(l.src);
      est += c.loadKw; peak += c.peakKw; added += c.addedKw; unknown += c.unknown;
      downstream += c.loadKw;
      downMeasured += c.measuredBelowKw;
      conf = worst(conf, c.conf);
    }
    // Crossing a UPS, what the upstream supply carries is the output plus the
    // conversion losses.
    if (obj[name]?.kind === 'ups_cabinet') {
      est /= UPS_EFF; peak /= UPS_EFF; added /= UPS_EFF;
    }
    est = r2(est); peak = r2(peak); added = r2(added);

    // The node's own measurement wins where it has one — it is a reading of
    // everything below it, which is exactly what the estimate was trying to
    // approximate. The estimate stays, as the cross-check.
    const measured = o.measuredKw;
    let loadKw = est, basis = 'downstream-estimate', inconsistent = false;
    if (measured != null) {
      // Equipment that is not installed yet cannot be in a meter reading.
      loadKw = r2(measured + added);
      basis = added > 0 ? 'measured+planned' : 'measured';
      conf = unknown ? 'partial' : (added > 0 ? 'mixed' : 'measured');

      // A node's own meter beating its children's ESTIMATES is the normal case
      // and the reason measurement wins. A node's own meter coming in BELOW the
      // sum of its children's own METERS is not that: it is two independent
      // readings contradicting each other, and averaging them or preferring the
      // nearer one would hide it. Planning takes the larger figure — under-
      // reporting load is the error that trips a breaker — and says why.
      const belowMeasured = r2(downMeasured + added);
      if (downMeasured > 0 && belowMeasured > loadKw * 1.1) {
        loadKw = belowMeasured;
        basis = 'ledger-inconsistent';
        inconsistent = true;
        conf = 'partial';
      }
    }
    // Whatever the node rests on, its peak cannot be below it: most racks here
    // carry a branch meter and no inventory, so a peak summed from devices
    // alone came out an order of magnitude under the measured load.
    peak = Math.max(peak, loadKw);
    visiting.delete(name);
    return (memo[name] = {
      loadKw, estKw: est, peakKw: r2(peak), addedKw: added, measuredKw: measured,
      downstreamKw: r2(downstream), unknown, conf, basis, inconsistent,
      // What this subtree measures of itself, for the node above to compare
      // against its own meter.
      measuredBelowKw: r2(measured != null ? measured + added : downMeasured + added),
    });
  }

  const nodes = {};
  for (const o of objects) {
    const L = rollup(o.name);
    // A rack rarely declares its own supply; the breaker feeding it does.
    let cap = nodeSupply(o, volt);
    if (!cap && o.kind === 'rack') {
      const up = links.find(l => l.src === o.name);
      if (up?.rated_a != null) {
        const three = isThreePhase(up.phase);
        const v = num(up.volts) ?? (three ? volt.v3 : volt.v1);
        cap = {
          kw: ampsToKw(num(up.rated_a), volt, three, up),
          basis: `${up.rated_a} A ${v} V ${up.dst_port || up.dst || ''} × ${DERATE}${volt.assumed && up.volts == null ? ' (가정)' : ''}`.trim(),
        };
      }
    }
    const pct = cap ? Math.round((L.loadKw / cap.kw) * 100) : null;
    const o2 = own[o.name] || {};
    // Two different ways the ledger can contradict itself, both of which make
    // any headroom figure through this node unusable until a survey settles it.
    const impossible = pct != null && pct >= IMPLAUSIBLE_PCT
      && L.measuredKw != null && L.addedKw === 0;
    const conflict = L.inconsistent || impossible;
    const conflictReason = L.inconsistent
      ? `자체 계측 ${L.measuredKw} kW vs 하위 계측 합 ${L.downstreamKw} kW`
      : impossible
        ? `계측 ${L.loadKw} kW 가 공급 ${cap.kw} kW 의 ${pct} % — 차단기가 버틸 수 없는 값`
        : null;
    nodes[o.name] = {
      name: o.name, kind: o.kind,
      load_kw: L.loadKw, est_kw: L.estKw, peak_kw: L.peakKw, measured_kw: L.measuredKw,
      added_kw: L.addedKw, downstream_kw: L.downstreamKw,
      // Where a node both measures itself and has an inventory below it, the gap
      // between the two is a survey finding: either the inventory is incomplete
      // or the planning figures are wrong for this room.
      gap_kw: L.measuredKw != null && L.downstreamKw > 0
        ? r2(L.measuredKw - L.downstreamKw) : null,
      cap_kw: cap?.kw ?? null, cap_basis: cap?.basis ?? null,
      pct, pct_peak: cap ? Math.round((L.peakKw / cap.kw) * 100) : null,
      headroom_kw: cap ? r2(cap.kw - L.loadKw) : null,
      // A contradiction between two meters is not a load condition. Painting it
      // 'critical' cries wolf on a node that may be fine; painting it 'ok'
      // hides that the number cannot be trusted. It gets its own state, and the
      // planner refuses to give a verdict through it.
      status: conflict ? 'conflict' : statusOf(pct),
      basis: L.basis, confidence: conflict ? 'partial' : L.conf,
      inconsistent: conflict, conflict_reason: conflictReason,
      unknown: L.unknown, btu_h: kwToBtu(L.loadKw),
      u_height: o2.uHeight || 0, u_used: o2.uUsed || 0,
      u_free: Math.max(0, (o2.uHeight || 0) - (o2.uUsed || 0)),
      weight_kg: o2.weightKg || 0, n_devices: o2.nDevices || 0,
      cooling_kw: o2.coolingKw ?? null,
      items: o2.items || [],
      feeds: feedsTo[o.name] || null,
      fed_by: (feeders[o.name] || []).map(l => l.src),
    };
  }

  // ── the room: heat against the cooling that is there ────────────
  const racks = objects.filter(o => o.kind === 'rack').map(o => nodes[o.name]);
  const cracs = objects.filter(o => o.kind === 'crac').map(o => nodes[o.name]);
  const itKw = r2(racks.reduce((s, r) => s + r.load_kw, 0));
  const itPeakKw = r2(racks.reduce((s, r) => s + r.peak_kw, 0));
  const upsLossKw = r2(itKw * (1 / UPS_EFF - 1));
  const heatKw = r2(itKw + upsLossKw);
  const coolKnown = cracs.filter(c => c.cooling_kw != null);
  const coolKw = coolKnown.length ? r1(coolKnown.reduce((s, c) => s + c.cooling_kw, 0)) : null;
  // N+1 is the figure that matters: a room is only as cool as it is with its
  // largest unit out, because that is the day the call comes.
  const coolN1Kw = coolKw != null
    ? r1(coolKw - Math.max(0, ...coolKnown.map(c => c.cooling_kw)))
    : null;
  const coolPct = coolN1Kw ? Math.round((heatKw / coolN1Kw) * 100) : null;
  const uTotal = racks.reduce((s, r) => s + (r.u_height || 0), 0);
  const uUsed = racks.reduce((s, r) => s + (r.u_used || 0), 0);
  const unknown = racks.reduce((s, r) => s + (r.unknown || 0), 0);

  return {
    nodes, racks, cracs, voltage: volt,
    room: {
      name: room.name || null, location: room.location || null,
      it_kw: itKw, it_peak_kw: itPeakKw, ups_loss_kw: upsLossKw,
      heat_kw: heatKw, heat_btu_h: kwToBtu(heatKw),
      cooling_kw: coolKw, cooling_n1_kw: coolN1Kw, cooling_pct: coolPct,
      cooling_status: statusOf(coolPct),
      cooling_note: coolKnown.length < cracs.length
        ? `CRAC ${cracs.length - coolKnown.length}대 용량 미기재 — 냉방 합계에서 제외` : null,
      u_total: uTotal, u_used: uUsed, u_free: Math.max(0, uTotal - uUsed),
      racks: racks.length, cracs: cracs.length,
      unknown,
      confidence: racks.reduce((c, r) => worst(c, r.confidence), 'measured'),
    },
  };
}

/**
 * The chain above one rack, with before/after when a simulation is supplied.
 * [rack, PDU, UPS, panel …] — the order the load actually travels.
 */
export function chainReport(before, rackName, after = null) {
  const out = [];
  const seen = new Set();
  let n = rackName;
  while (n && !seen.has(n)) {
    seen.add(n);
    const b = before.nodes[n];
    if (!b) break;
    const a = after?.nodes[n] || null;
    out.push({
      name: n, kind: b.kind, before: b, after: a,
      delta_kw: a ? r2(a.load_kw - b.load_kw) : 0,
      pct_before: b.pct, pct_after: a ? a.pct : null,
    });
    n = b.feeds;
  }
  return out;
}

/**
 * What-if: put `items` into a rack and report what gives first.
 *
 * @param items [{ kind, model, vendor, qty, nameplate_w?, u_height?, weight_kg? }]
 */
export function simulateAdd(room, rackName, items = [], { limitPct = DERATE * 100 } = {}) {
  const addDevices = [];
  let i = 0;
  for (const it of items) {
    for (let q = 0; q < Math.max(1, num(it.qty) ?? 1); q++) {
      addDevices.push({
        label: `NEW-${++i}`, kind: it.kind, model: it.model, vendor: it.vendor,
        rack: rackName, nameplate_w: it.nameplate_w, weight_kg: it.weight_kg,
        u_height: it.u_height, poe: it.poe, _new: true,
      });
    }
  }
  const before = roomCapacity(room);
  const after = roomCapacity(room, { addDevices });
  const chain = chainReport(before, rackName, after);
  const rackB = before.nodes[rackName] || null;
  const rackA = after.nodes[rackName] || null;

  const issues = [];
  if (!rackA) issues.push({ level: 'critical', msg: `${rackName} — 원장에 없는 랙` });
  if (rackA && rackA.u_used > rackA.u_height) {
    issues.push({
      level: 'critical',
      msg: `랙 U 부족 — ${rackA.u_used}U 필요 / ${rackA.u_height}U`,
    });
  }
  for (const c of chain) {
    const a = c.after;
    if (!a) continue;
    if (a.cap_kw == null) {
      issues.push({ level: 'nodata', msg: `${c.name} — 공급 정격 미기재, 여유 판단 불가` });
      continue;
    }
    if (a.inconsistent) {
      // Two meters on the same path disagree. Any headroom figure through this
      // node is one of two numbers and we do not know which, so no verdict is
      // given here — the survey has to settle it first.
      issues.push({
        level: 'conflict',
        msg: `${c.name} — 원장 모순: ${a.conflict_reason}. 증설 판단 전 실측 확인 필요`,
      });
      continue;
    }
    if (a.pct >= 100) {
      issues.push({ level: 'critical', msg: `${c.name} 용량 초과 — ${a.load_kw} / ${a.cap_kw} kW (${a.pct} %) · ${a.cap_basis}` });
    } else if (a.pct >= limitPct) {
      issues.push({ level: 'warn', msg: `${c.name} 설계 한계 ${limitPct} % 초과 — ${a.pct} % · 증설 전 분산 검토` });
    }
    if (a.unknown > 0) {
      issues.push({ level: 'nodata', msg: `${c.name} — 전력 정보 없는 장비 ${a.unknown}대, 위 숫자에 빠져 있음` });
    }
  }
  if (after.room.cooling_n1_kw == null) {
    issues.push({ level: 'nodata', msg: '냉방 용량 미기재 — 발열 대비 판단 불가' });
  } else if (after.room.cooling_status !== 'ok') {
    issues.push({
      level: after.room.cooling_status,
      msg: `냉방 N+1 ${after.room.cooling_pct} % — 발열 ${after.room.heat_kw} kW / N+1 ${after.room.cooling_n1_kw} kW`,
    });
  }

  const added = r2(addDevices.reduce((s, d) => s + (deviceLoad(d).watts || 0), 0) / 1000);
  const uAdded = addDevices.reduce((s, d) => s + deviceU(d), 0);
  return {
    rackName, addDevices, before, after, chain,
    rack: { before: rackB, after: rackA },
    added_kw: added, added_u: uAdded,
    added_kg: r1(addDevices.reduce((s, d) => s + (deviceLoad(d).kg || 0), 0)),
    issues,
    // 'ok' means nothing on the path is over capacity AND the path could be
    // read at all. A conflict or a missing rating is not a pass.
    ok: !issues.some(x => x.level === 'critical' || x.level === 'conflict'),
    undecided: issues.filter(x => x.level === 'conflict' || x.level === 'nodata').map(x => x.msg),
    confidence: after.room.confidence,
    limitPct,
  };
}

/**
 * What the what-if picker offers: every catalogued model that has a planning
 * figure, which is exactly the set the simulator can answer for.
 *
 * Derived rather than listed, so a model added to a catalogue with a planning
 * figure appears here, and one without a figure cannot be picked and then
 * silently costed at a guess. The order is the catalogue's own — access gear
 * first, chassis later — which is the order a survey walks a rack.
 */
export const EXPANSION_CATALOG = (() => {
  const rows = [...CISCO_CATALOG, ...APC_CATALOG]
    .filter(e => PLANNING[e.id])
    .map(e => ({
      id: e.id, kind: e.kind || 'other',
      // The APC sheets are a single vendor's catalogue and do not repeat the
      // name on every row.
      vendor: e.vendor || (APC_CATALOG.includes(e) ? 'APC' : '—'),
      model: e.label, u: e.u ?? 1, ...PLANNING[e.id],
      poe_budget_w: e.poe_budget_w ?? null,
      // What one of these would actually contribute, through the same path a
      // real device takes — so the picker's number and the simulation's number
      // cannot drift apart.
      load_w: deviceLoad({ kind: e.kind, model: e.label }).watts,
    }));
  // Several catalogue entries exist only as fallback matchers for a family
  // ("Catalyst 9300" behind "Catalyst 9300-48P") and carry the same figures. In
  // a picker they read as two different products that cost the same. The
  // catalogue lists the specific one first, so the first of each identical set
  // is the one kept.
  const seen = new Set();
  return rows.filter(r => {
    const k = [r.vendor, r.kind, r.u, r.typ, r.max, r.kg, r.poe_budget_w].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
})();
