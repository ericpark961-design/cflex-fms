// Capacity planning, on the rack you clicked.
//
// Three questions, in the order they get asked:
//
//   1. What is in this rack now, and how much room is left — U, kW, kg.
//   2. Where does its power come from, and which hop is closest to its limit.
//   3. If we add this much next quarter, what gives first.
//
// Every number carries its basis. A figure that rests on a meter says so; one
// that rests on a planning table says so; a node whose supply nobody recorded
// shows no percentage at all rather than a comfortable one. That is the whole
// point of the panel: an expansion approved against an invented number is worse
// than one that was never costed.
import React, { useMemo, useState } from 'react';
import { roomCapacity, simulateAdd, chainReport, EXPANSION_CATALOG } from './roomCapacity';
import { t } from '../i18n';

const ST = {
  ok: '#24a148', warn: '#f1c21b', critical: '#da1e28',
  // A contradiction in the ledger is not a load condition; it gets its own
  // colour so it cannot be read as either "fine" or "on fire".
  conflict: '#be95ff', nodata: '#6f6f6f',
};
const KIND = {
  rack: '랙', pdu_cabinet: '분전 PDU', ups_cabinet: 'UPS',
  panel: '분전반', crac: 'CRAC',
};
const BASIS = {
  measured: '계측', 'measured+planned': '계측 + 증설분',
  'downstream-estimate': '하위 추정', 'ledger-inconsistent': '원장 모순', cycle: '순환 참조',
};
const bt = {
  fontSize: 11, padding: '1px 7px', background: '#262626', color: '#78a9ff',
  border: '1px solid #393939', cursor: 'pointer', fontFamily: 'inherit',
};
const H = { fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em' };

/**
 * One load bar. `after` draws the simulated figure behind the current one, so
 * the move is visible rather than described.
 */
export function Bar({ pct, status, label, right, after }) {
  return <div style={{ marginBottom: 6 }}>
    <div style={{ display: 'flex', fontSize: 11, marginBottom: 2, gap: 8 }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ marginLeft: 'auto', color: '#c6c6c6', flex: '0 0 auto' }}>{right}</span>
    </div>
    <div style={{ position: 'relative', height: 8, background: '#262626' }}>
      {after != null && <div style={{ position: 'absolute', left: 0, top: 0, height: 8, width: `${Math.min(100, after)}%`, background: '#4589ff55', outline: '1px dashed #4589ff' }} />}
      <div style={{ position: 'absolute', left: 0, top: 0, height: 8, width: `${Math.min(100, pct || 0)}%`, background: ST[status] || ST.nodata }} />
      {/* the 80 % design ceiling, where a plan should stop rather than where it fails */}
      <div style={{ position: 'absolute', left: '80%', top: -2, height: 12, borderLeft: '1px solid #f1c21b88' }} />
    </div>
  </div>;
}

/** The room line: IT load, heat, and the cooling that is actually there. */
export function RoomCapacitySummary({ room, onFocus }) {
  const cap = useMemo(() => roomCapacity(room), [room]);
  const r = cap.room;
  const dist = Object.values(cap.nodes)
    .filter(n => ['ups_cabinet', 'pdu_cabinet', 'panel'].includes(n.kind) && n.cap_kw);
  return <div style={{ fontSize: 12, color: '#c6c6c6', lineHeight: 1.6 }}>
    <div style={{ ...H, margin: '12px 0 6px' }}>{t('용량')} · {t('원장 기준 자동 계산')}</div>
    {t('IT 부하')} <b style={{ color: '#f4f4f4' }}>{r.it_kw} kW</b>
    {' '}<span style={{ color: '#8d8d8d' }}>({t('정격 합')} {r.it_peak_kw} kW)</span>
    {' · '}{t('발열')} {r.heat_kw} kW = {r.heat_btu_h.toLocaleString()} BTU/h<br />
    {r.cooling_n1_kw != null ? <>
      {t('냉방')} {r.cooling_kw} kW · N+1 {r.cooling_n1_kw} kW → <b style={{ color: ST[r.cooling_status] }}>{r.cooling_pct ?? '—'} %</b>
    </> : <span style={{ color: ST.nodata }}>{t('냉방 용량 미기재 — 발열 대비 판단 불가')}</span>}<br />
    {t('랙 U')} {r.u_used} / {r.u_total} ({t('여유')} {r.u_free}U · {t('랙')} {r.racks})
    {r.cooling_note && <div style={{ color: '#f1c21b', fontSize: 11 }}>※ {r.cooling_note}</div>}
    {r.unknown > 0 && <div style={{ color: '#f1c21b', fontSize: 11 }}>
      ※ {t('전력 정보 없는 장비')} {r.unknown}{t('대')} — {t('위 숫자에 빠져 있음')}
    </div>}
    {cap.voltage.assumed && <div style={{ color: '#f1c21b', fontSize: 11 }}>※ {cap.voltage.note}</div>}
    <div style={{ marginTop: 8 }}>
      {dist.map(n => <div key={n.name} onClick={() => onFocus?.(n.name)} style={{ cursor: onFocus ? 'pointer' : 'default' }}>
        <Bar label={`${n.name} · ${t(KIND[n.kind] || n.kind)}`} pct={n.pct} status={n.status}
          right={`${n.load_kw} / ${n.cap_kw} kW · ${n.pct} %`} />
      </div>)}
    </div>
  </div>;
}

export default function CapacityPanel({ room, rackName, onFocus }) {
  const [sim, setSim] = useState(false);
  const [qty, setQty] = useState({});
  const cap = useMemo(() => roomCapacity(room), [room]);
  const picked = EXPANSION_CATALOG
    .map((c, i) => ({ ...c, qty: qty[i] || 0 }))
    .filter(c => c.qty > 0);
  const result = useMemo(
    () => (sim && picked.length ? simulateAdd(room, rackName, picked) : null),
    [room, rackName, sim, JSON.stringify(qty)],
  );
  const rk = cap.nodes[rackName];
  if (!rk) return null;
  const rkA = result?.rack.after || null;
  const chain = result ? result.chain : chainReport(cap, rackName);
  const uH = rk.u_height || 42;

  const copyJson = () => {
    // The survey's output: the devices to append to this room in the ledger's
    // own import shape, so a plan that was approved can be entered as fact
    // without being retyped.
    const devices = result.addDevices.map(({ _new, ...d }) => d);
    navigator.clipboard?.writeText(JSON.stringify({ room: room.name, devices }, null, 1));
  };

  return <div style={{ marginTop: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, gap: 8 }}>
      <span style={H}>{t('용량 · 부하')} <span style={{ fontWeight: 400, textTransform: 'none' }}>({t('자동 계산')})</span></span>
      <button type="button" onClick={() => setSim(s => !s)} style={{
        ...bt, marginLeft: 'auto', padding: '2px 8px',
        background: sim ? '#0f62fe' : '#262626', color: sim ? '#fff' : '#78a9ff',
      }}>{t('장비 증설 시뮬레이션')}</button>
    </div>

    <div style={{ background: '#1f1f1f', padding: 8 }}>
      <Bar label={`${t('랙 공간')} ${rk.u_used}U / ${uH}U`}
        pct={(rk.u_used / uH) * 100}
        status={rk.u_used > uH ? 'critical' : rk.u_used > uH * 0.8 ? 'warn' : 'ok'}
        right={rkA ? `→ ${rkA.u_used}U (${t('여유')} ${uH - rkA.u_used}U)` : `${t('여유')} ${uH - rk.u_used}U`}
        after={rkA ? (rkA.u_used / uH) * 100 : null} />
      <Bar label={`${t('전력')} ${rk.load_kw} kW · ${rk.btu_h.toLocaleString()} BTU/h`}
        pct={rk.pct} status={rkA ? rkA.status : rk.status} after={rkA?.pct}
        right={rk.cap_kw
          ? `${rkA ? `→ ${rkA.load_kw} kW · ${rkA.pct} %` : `${rk.pct} %`} / ${t('한도')} ${rk.cap_kw} kW`
          : t('회로 정격 미등록')} />
      <div style={{ fontSize: 11, color: '#8d8d8d' }}>
        {rk.cap_basis && <>{t('한도 근거')} {rk.cap_basis} · </>}
        {t('중량')} {Math.round(rk.weight_kg)} kg{rkA ? ` → ${Math.round(rkA.weight_kg)} kg` : ''}
        {' · '}{t('장비')} {rk.n_devices}{rkA ? ` → ${rkA.n_devices}` : ''}
        {' · '}{t('근거')} {t(BASIS[rk.basis] || rk.basis)}
      </div>
      {rk.conflict_reason && <div style={{ fontSize: 11, color: ST.conflict, marginTop: 4 }}>
        ※ {t('원장 모순')} — {rk.conflict_reason}
      </div>}
      {rk.unknown > 0 && <div style={{ fontSize: 11, color: '#f1c21b', marginTop: 2 }}>
        ※ {t('전력 정보 없는 장비')} {rk.unknown}{t('대')}
      </div>}
    </div>

    <div style={{ ...H, margin: '10px 0 4px' }}>
      {t('전원 체인 여유')} ({t('부하 → 공급')}){result ? ` · ${t('증설 후 점선')}` : ''}
    </div>
    <div style={{ background: '#1f1f1f', padding: 8 }}>
      {chain.map((c, i) => {
        const b = c.before; const a = c.after;
        return <div key={c.name} onClick={() => onFocus?.(c.name)} style={{ cursor: onFocus ? 'pointer' : 'default' }}>
          <Bar label={`${i} · ${c.name} · ${t(KIND[c.kind] || c.kind)}`}
            pct={b.pct} status={a ? a.status : b.status} after={a?.pct}
            right={b.cap_kw
              ? `${b.load_kw}${a ? ` → ${a.load_kw}` : ''} / ${b.cap_kw} kW · ${a ? a.pct : b.pct} %`
              : `${b.load_kw} kW · ${t('정격 미기재')}`} />
        </div>;
      })}
      <div style={{ fontSize: 10, color: '#8d8d8d' }}>
        {t('80 % 선 = 증설 경고 기준 · UPS 효율 95 % 반영 · 회로 한도 = 정격 A × 전압 × 0.8')}
      </div>
    </div>

    {sim && <div style={{ marginTop: 10, background: '#161616', border: '1px solid #393939', padding: 8 }}>
      <div style={{ ...H, marginBottom: 6 }}>
        {t('추가할 장비')} <span style={{ fontWeight: 400, textTransform: 'none' }}>({t('카탈로그 계획값 적용')})</span>
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto' }}>
        {EXPANSION_CATALOG.map((c, i) => <div key={c.id + i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '2px 0', borderBottom: '1px solid #262626' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.vendor} {c.model}
            <span style={{ color: '#8d8d8d' }}>
              {' · '}{c.u}U · {c.load_w} W{c.poe_budget_w ? ` (PoE ${c.poe_budget_w} W 포함)` : ''} · {c.kg} kg
            </span>
          </span>
          <button type="button" onClick={() => setQty(q => ({ ...q, [i]: Math.max(0, (q[i] || 0) - 1) }))} style={bt}>−</button>
          <span style={{ width: 16, textAlign: 'center' }}>{qty[i] || 0}</span>
          <button type="button" onClick={() => setQty(q => ({ ...q, [i]: (q[i] || 0) + 1 }))} style={bt}>+</button>
        </div>)}
      </div>
      {result && <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: result.ok ? '#42be65' : '#fa4d56' }}>
          {result.ok ? t('증설 가능') : t('증설 불가 — 조치 필요')}
          {' · '}+{result.added_kw} kW · +{result.addDevices.length}{t('대')} · +{result.added_u}U · +{result.added_kg} kg
        </div>
        {result.issues.map((x, i) => <div key={i} style={{ fontSize: 11, color: ST[x.level] || ST.nodata, marginTop: 2 }}>• {x.msg}</div>)}
        {result.confidence !== 'measured' && <div style={{ fontSize: 11, color: '#f1c21b', marginTop: 4 }}>
          ※ {t('이 판정에는 추정값이 섞여 있습니다')} ({t(BASIS[result.after.nodes[rackName].basis] || result.confidence)})
        </div>}
        <div style={{ fontSize: 11, color: '#c6c6c6', marginTop: 4 }}>
          {t('룸 발열')} {result.before.room.heat_kw} → {result.after.room.heat_kw} kW
          {result.after.room.cooling_pct != null
            ? ` · ${t('냉방 N+1 사용')} ${result.before.room.cooling_pct} → ${result.after.room.cooling_pct} %`
            : ` · ${t('냉방 용량 미기재')}`}
        </div>
        <button type="button" onClick={copyJson} style={{ ...bt, marginTop: 8, padding: '4px 10px' }}>
          {t('원장 반영 JSON 복사')}
        </button>
      </div>}
      {!picked.length && <div style={{ fontSize: 11, color: '#6f6f6f', marginTop: 6 }}>
        {t('수량을 1 이상으로 올리면 증설 판정이 계산됩니다')}
      </div>}
    </div>}
  </div>;
}
