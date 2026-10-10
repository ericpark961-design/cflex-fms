// #/devices — the inventory tree: CBU → 장소 → 룸 → 랙 → 장비.
//
// Until now /twin had no device list at all; `#/device` is one device's detail,
// and the hierarchy the server already computes (/v1/fms/floor) was fetched into
// store.floor and never rendered. This is the screen the real rollout is driven
// from, so it is a tree you can *edit*, not a table you can look at: every row
// can be moved to another CBU, location, room or rack, polling can be turned on
// or off, and a rack can be created by typing its name into a device's rack
// field — the tree is derived from the devices, so a rack exists once something
// is in it.
//
// The tree is assembled client-side from the two feeds that make up the real
// inventory, because the server's /floor tree has no CBU level and covers only
// ups_devices:
//   - store.assets        — the polled UPS (ups_devices)
//   - /v1/fms/devices     — network / UC / server gear (fms_devices)
// Both carry cbu/location/room/rack, so the same five levels come out of either.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { token, cbu as globalCbu } from './theme';
import { store, refresh } from './data';
import { devId } from './ids';
import { t } from './i18n';
import { CbuBar } from './cbubar';
import { inventory, buildTree, sortedKeys, allKeys, filterRows, totals, UNSET } from './tree';

const SC = { ok: '#42be65', warn: '#f1c21b', critical: '#fa4d56', unreachable: '#6f6f6f', nodata: '#6f6f6f' };
const KIND_LABEL = {
  ups: 'UPS', switch: '스위치', router: '라우터', sbc: 'SBC', server: '서버',
  pdu: 'PDU', patch: '패치', storage: '스토리지', other: '기타',
};
const KIND_COLOR = { ups: '#4589ff', switch: '#08bdba', router: '#08bdba', sbc: '#be95ff', server: '#ff832b', pdu: '#8d8d8d', patch: '#525252', storage: '#d4bbff' };

const S = {
  btn: { background: '#262626', border: '1px solid #525252', color: '#f4f4f4', padding: '5px 10px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' },
  prim: { background: '#0f62fe', border: '1px solid #0f62fe', color: '#fff', padding: '5px 10px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' },
  input: { background: '#262626', border: 0, borderBottom: '1px solid #525252', color: '#f4f4f4', padding: '5px 7px', fontFamily: 'inherit', fontSize: 12, width: '100%', boxSizing: 'border-box' },
  badge: { fontSize: 10, fontWeight: 700, padding: '1px 5px', letterSpacing: '.02em' },
  h: { fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase' },
};

// theme.js api() drops the HTTP status, and a write that is silently ignored is
// the thing this screen must never do — so status comes back with the body.
async function req(path, opts = {}) {
  try {
    const r = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(opts.headers || {}) },
    });
    const body = await r.json().catch(() => null);
    return { ...(body || {}), status: r.status };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
}

function Roll({ n }) {
  return <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 11 }}>
    <span className="mono" style={{ color: '#8d8d8d' }}>{n.count}</span>
    {n.critical > 0 && <span style={{ ...S.badge, background: SC.critical, color: '#fff' }}>{n.critical}</span>}
    {n.warn > 0 && <span style={{ ...S.badge, background: SC.warn, color: '#161616' }}>{n.warn}</span>}
    {n.ok > 0 && <span style={{ ...S.badge, background: '#0e3a22', color: SC.ok }}>{n.ok}</span>}
    {n.nodata > 0 && <span style={{ ...S.badge, background: '#2b2b2b', color: '#8d8d8d' }}>{n.nodata}</span>}
  </span>;
}

function Caret({ open }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 12, color: '#8d8d8d', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>▶</span>;
}

export default function DevicesScreen() {
  const [netDevices, setNetDevices] = useState([]);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(() => new Set());
  const [edit, setEdit] = useState(null);        // device id being edited
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [cbuWritable, setCbuWritable] = useState(null);   // null = not probed yet
  const firstRender = useRef(true);

  const load = useCallback(async () => {
    const scope = globalCbu();
    const r = await req(`/v1/fms/devices${scope && scope !== 'all' ? `?cbu=${encodeURIComponent(scope)}` : ''}`);
    setNetDevices(r?.ok ? (r.devices || []) : []);
  }, []);

  useEffect(() => { load(); }, [load, tick]);

  // `tick` is a real dependency even though it is unused in the body: refresh()
  // mutates store.assets in place, so React has no other way to know the UPS
  // list changed.
  const rows = useMemo(() => inventory({ assets: store.assets, devices: netDevices, devId }), [netDevices, tick]);
  const filtered = useMemo(() => filterRows(rows, q), [rows, q]);
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  // A search narrows the tree, so expand everything that survived the filter —
  // a matching device four levels down is useless behind collapsed parents.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      // Open the CBUs by default; deeper levels stay closed so the first paint
      // is the site list, not 50 devices.
      setOpen(new Set([...tree.keys()].map(c => `c:${c}`)));
      return;
    }
    if (!q.trim()) return;
    setOpen(allKeys(tree));
  }, [q, tree]);

  const toggle = (key) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const startEdit = (r) => {
    setEdit(r.src === 'ups' ? `ups:${r.id}` : `net:${r.id}`);
    setForm({ cbu: r.cbu || '', location: r.location || '', room: r.room || '', rack: r.rack || '', u_pos: r.u_pos ?? '' });
    setErr(null); setMsg(null);
  };

  const save = async (r) => {
    setBusy(`save:${r.src}:${r.id}`); setErr(null); setMsg(null);
    const body = {
      location: form.location.trim() || null,
      room: form.room.trim() || null,
      rack: form.rack.trim() || null,
    };
    if (form.cbu.trim() !== (r.cbu || '')) body.cbu = form.cbu.trim() || null;
    if (String(form.u_pos) !== String(r.u_pos ?? '')) body.u_pos = form.u_pos === '' ? null : Number(form.u_pos);

    const res = await req(`/v1/fms/assets/${r.id}`, { method: 'PUT', body: JSON.stringify(body) });
    setBusy(null);
    if (!res?.ok) { setErr(res?.error || `저장 실패 (HTTP ${res?.status || '?'})`); return; }

    // The endpoint silently skips fields it does not allow. Compare what came
    // back against what was asked for, and say so rather than showing a move
    // that did not happen.
    const a = res.asset || {};
    const ignored = [];
    if (body.cbu !== undefined && !('cbu' in a)) { ignored.push('CBU'); setCbuWritable(false); }
    else if (body.cbu !== undefined) setCbuWritable(true);
    if (body.u_pos !== undefined && !('u_pos' in a)) ignored.push('U 위치');

    await refresh();
    setTick(x => x + 1);
    setEdit(null);
    setMsg(ignored.length
      ? `${r.label} 저장 — 단 ${ignored.join(' · ')}는 서버가 아직 지원하지 않습니다 (백엔드 배포 대기)`
      : `${r.label} 저장됨`);
  };

  const setPolling = async (r, on) => {
    setBusy(`poll:${r.id}`); setErr(null); setMsg(null);
    const res = await req(`/v1/fms/assets/${r.id}`, { method: 'PUT', body: JSON.stringify({ polling_enabled: on ? 1 : 0 }) });
    setBusy(null);
    if (!res?.ok) { setErr(res?.error || `폴링 변경 실패 (HTTP ${res?.status || '?'})`); return; }
    await refresh();
    setTick(x => x + 1);
    setMsg(`${r.label} 폴링 ${on ? '켜짐' : '꺼짐'}`);
  };

  const sum = useMemo(() => totals(rows), [rows]);

  const indent = (lvl) => ({ paddingLeft: 8 + lvl * 18 });
  const rowBase = {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    borderBottom: '1px solid #212121', fontSize: 13, width: '100%', boxSizing: 'border-box',
    background: 'none', border: 0, borderBottomWidth: 1, borderBottomStyle: 'solid',
    borderBottomColor: '#212121', color: '#f4f4f4', fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer',
  };

  return <div style={{ display: 'flex', minHeight: '100vh', background: '#161616', color: '#f4f4f4', fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif' }}>
    <nav aria-label={t('주 메뉴')} style={{ flex: '0 0 220px', background: '#0b0b0b', borderRight: '1px solid #262626', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid #262626', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, background: '#0f62fe', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#fff' }}>C</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>C-Flex FMS <span style={{ fontSize: 11, color: '#78a9ff' }}>2.0</span></div>
          <div style={{ fontSize: 11, color: '#8d8d8d' }}>RingOn Service · {store.me?.tenantName || 'HAEA'}</div>
        </div>
      </div>
      <div style={{ padding: '10px 0', display: 'flex', flexDirection: 'column' }}>
        {[['#/', t('시설 대시보드')], ['#/devices', t('장비 구성')], ['#/powerchain', t('전력체인')],
          ['#/alarms', t('알람 센터')], ['#/map', t('알람 지도')], ['#/twin', t('3D 디지털트윈')], ['#/wall', t('NOC 월')]]
          .map(([h, l]) => {
            const on = h === '#/devices';
            return <a key={h} href={h} style={{ padding: '11px 16px 11px 13px', fontSize: 14, textDecoration: 'none', color: on ? '#f4f4f4' : '#c6c6c6', background: on ? '#262626' : 'transparent', borderLeft: `3px solid ${on ? '#4589ff' : 'transparent'}`, fontWeight: on ? 600 : 400 }}>{l}</a>;
          })}
      </div>
      <div style={{ marginTop: 'auto', padding: '14px 16px', borderTop: '1px solid #262626', fontSize: 12, color: '#c6c6c6' }}>
        {store.me?.displayName || ''}<br /><span style={{ color: '#8d8d8d' }}>{store.me?.email || ''}</span>
      </div>
    </nav>

    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '10px 20px', background: '#0b0b0b', borderBottom: '1px solid #262626' }}>
        <label htmlFor="devq" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{t('검색')}</label>
        <input id="devq" type="search" value={q} onChange={e => setQ(e.target.value)}
          placeholder={t('장비 · IP · 랙 · 룸 검색')}
          style={{ ...S.input, flex: '1 1 220px', maxWidth: 340, borderBottom: '1px solid #525252' }} />
        <CbuBar onChange={() => { setTick(x => x + 1); load(); }} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', fontSize: 11, color: '#8d8d8d' }}>
          <span>{t('사이트')} {sum.cbus.size}</span>
          <span>{t('랙')} {sum.racks.size}</span>
          <span>UPS {sum.ups}</span>
          <span>{t('네트워크/UC')} {sum.net}</span>
          {sum.unplaced > 0 && <span style={{ color: '#f1c21b' }}>{t('랙 미지정')} {sum.unplaced}</span>}
          <span className="mono" style={{ color: '#c6c6c6' }}>{t('총')} {sum.count}</span>
        </div>
      </div>

      <div style={{ padding: '14px 20px 28px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, color: '#8d8d8d', letterSpacing: '.04em' }}>
              {t('CBU → 장소 → 룸 → 랙 → 장비')}
            </div>
            <h1 style={{ margin: '4px 0 0', fontSize: 26, fontWeight: 600 }}>{t('장비 구성')}</h1>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
            <button style={S.btn} onClick={() => setOpen(new Set([...tree.keys()].map(c => `c:${c}`)))}>{t('모두 접기')}</button>
            <button style={S.btn} onClick={() => setOpen(allKeys(tree))}>{t('모두 펼치기')}</button>
          </div>
        </div>

        {sum.unplaced > 0 && <div style={{ background: '#3d2a0a', borderLeft: '3px solid #f1c21b', padding: '8px 12px', fontSize: 12 }}>
          {t('랙이 지정되지 않은 장비')} <b>{sum.unplaced}</b>{t('대')} — {t('각 행의 "이동"으로 장소·룸·랙을 채우면 트리에 바로 반영됩니다.')}
        </div>}

        {msg && <div style={{ background: '#0e3a22', borderLeft: '3px solid #42be65', padding: '8px 12px', fontSize: 12 }}>{msg}</div>}
        {err && <div style={{ background: '#3d0a0e', borderLeft: '3px solid #fa4d56', padding: '8px 12px', fontSize: 12, color: '#ff8389' }}>{err}</div>}
        {cbuWritable === false && <div style={{ background: '#3d2a0a', borderLeft: '3px solid #f1c21b', padding: '8px 12px', fontSize: 12 }}>
          {t('CBU 이동은 백엔드 배포 후에 저장됩니다. 장소·룸·랙 변경은 지금 반영됩니다.')}
        </div>}

        <div style={{ border: '1px solid #262626', background: '#1a1a1a' }}>
          <div style={{ display: 'flex', gap: 8, padding: '7px 10px', background: '#0b0b0b', borderBottom: '1px solid #262626', ...S.h }}>
            <span style={{ flex: 1 }}>{t('계층')}</span>
            <span style={{ flex: '0 0 92px' }}>{t('종류')}</span>
            <span style={{ flex: '0 0 116px' }}>IP</span>
            <span style={{ flex: '0 0 74px' }}>{t('상태')}</span>
            <span style={{ flex: '0 0 150px', textAlign: 'right' }}>{t('구성')}</span>
          </div>

          {!rows.length && <div style={{ padding: 22, textAlign: 'center', color: '#8d8d8d', fontSize: 13 }}>
            {t('장비가 없습니다')}
          </div>}

          {sortedKeys(tree).map(cName => {
            const C = tree.get(cName);
            const cKey = `c:${cName}`;
            const cOpen = open.has(cKey);
            return <div key={cKey}>
              <button onClick={() => toggle(cKey)} aria-expanded={cOpen} style={{ ...rowBase, ...indent(0), background: '#202020', fontWeight: 600 }}>
                <Caret open={cOpen} />
                <span style={{ ...S.badge, background: '#0f62fe', color: '#fff' }}>CBU</span>
                <span style={{ flex: 1 }}>{cName === UNSET ? t('미지정') : cName}
                  {store.cbuMeta?.[cName]?.display && <span style={{ color: '#8d8d8d', fontWeight: 400, marginLeft: 7, fontSize: 11 }}>{store.cbuMeta[cName].display}</span>}
                </span>
                <Roll n={C} />
              </button>

              {cOpen && sortedKeys(C.locations).map(lName => {
                const L = C.locations.get(lName);
                const lKey = `l:${cName}/${lName}`;
                const lOpen = open.has(lKey);
                return <div key={lKey}>
                  <button onClick={() => toggle(lKey)} aria-expanded={lOpen} style={{ ...rowBase, ...indent(1), background: '#1d1d1d' }}>
                    <Caret open={lOpen} />
                    <span style={{ ...S.badge, background: '#393939', color: '#c6c6c6' }}>{t('장소')}</span>
                    <span style={{ flex: 1 }}>{lName === UNSET ? t('미지정') : lName}</span>
                    <Roll n={L} />
                  </button>

                  {lOpen && sortedKeys(L.rooms).map(mName => {
                    const M = L.rooms.get(mName);
                    const mKey = `m:${cName}/${lName}/${mName}`;
                    const mOpen = open.has(mKey);
                    return <div key={mKey}>
                      <button onClick={() => toggle(mKey)} aria-expanded={mOpen} style={{ ...rowBase, ...indent(2) }}>
                        <Caret open={mOpen} />
                        <span style={{ ...S.badge, background: '#2b2b2b', color: '#8d8d8d' }}>{t('룸')}</span>
                        <span style={{ flex: 1 }}>{mName === UNSET ? t('미지정') : mName}</span>
                        <Roll n={M} />
                      </button>

                      {mOpen && sortedKeys(M.racks).map(kName => {
                        const K = M.racks.get(kName);
                        const kKey = `k:${cName}/${lName}/${mName}/${kName}`;
                        const kOpen = open.has(kKey);
                        return <div key={kKey}>
                          <button onClick={() => toggle(kKey)} aria-expanded={kOpen} style={{ ...rowBase, ...indent(3) }}>
                            <Caret open={kOpen} />
                            <span style={{ ...S.badge, background: '#1c2a44', color: '#78a9ff' }}>{t('랙')}</span>
                            <span style={{ flex: 1 }} className="mono">{kName === UNSET ? t('미지정') : kName}</span>
                            <Roll n={K} />
                          </button>

                          {kOpen && K.devices.map(d => {
                            const editing = edit === `${d.src}:${d.id}`;
                            return <div key={`${d.src}:${d.id}`}>
                              <div style={{ ...rowBase, ...indent(4), cursor: 'default', background: editing ? '#17233a' : 'transparent' }}>
                                <span style={{ width: 12 }} />
                                <span className="mono" style={{ flex: '0 0 34px', color: '#6f6f6f', fontSize: 11 }}>
                                  {d.u_pos != null ? `U${d.u_pos}` : '—'}
                                </span>
                                <span style={{ flex: 1, minWidth: 0 }}>
                                  {d.src === 'ups'
                                    ? <a href={`#/device?id=${d.id}`} style={{ color: '#f4f4f4', textDecoration: 'none', borderBottom: '1px solid #393939' }}>{d.label}</a>
                                    : <span>{d.label}</span>}
                                  {d.model && <span style={{ color: '#8d8d8d', fontSize: 11, marginLeft: 7 }}>{d.vendor} {d.model}</span>}
                                  {d.ports && <span style={{ color: '#6f6f6f', fontSize: 11, marginLeft: 7 }}>{d.ports}</span>}
                                </span>
                                <span style={{ flex: '0 0 92px' }}>
                                  <span style={{ ...S.badge, background: '#262626', color: KIND_COLOR[d.kind] || '#c6c6c6' }}>
                                    {t(KIND_LABEL[d.kind] || d.kind)}
                                  </span>
                                </span>
                                <span className="mono" style={{ flex: '0 0 116px', fontSize: 11, color: '#c6c6c6' }}>{d.ip || '—'}</span>
                                <span style={{ flex: '0 0 74px' }}>
                                  <span style={{ ...S.badge, background: SC[d.status] || '#6f6f6f', color: d.status === 'warn' ? '#161616' : '#fff' }}>
                                    {t({ ok: '정상', warn: '경고', critical: '위험', unreachable: '데이터없음', nodata: '데이터없음' }[d.status] || d.status)}
                                  </span>
                                </span>
                                <span style={{ flex: '0 0 150px', display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                                  {d.editable ? <>
                                    {d.polling_enabled != null && (
                                      <button onClick={() => setPolling(d, !d.polling_enabled)} disabled={!!busy}
                                        title={t('폴링 켜기/끄기')}
                                        style={{ ...S.btn, padding: '3px 7px', borderColor: d.polling_enabled ? '#42be65' : '#525252', color: d.polling_enabled ? '#42be65' : '#8d8d8d' }}>
                                        {busy === `poll:${d.id}` ? '…' : (d.polling_enabled ? t('폴링 ON') : t('폴링 OFF'))}
                                      </button>
                                    )}
                                    <button onClick={() => (editing ? setEdit(null) : startEdit(d))} disabled={!!busy} style={{ ...S.btn, padding: '3px 8px' }}>
                                      {editing ? t('취소') : t('이동')}
                                    </button>
                                  </> : <span style={{ fontSize: 10, color: '#6f6f6f' }} title={t('fms_devices 쓰기 API가 아직 없습니다')}>{t('읽기 전용')}</span>}
                                </span>
                              </div>

                              {editing && <div style={{ ...indent(4), padding: '10px 10px 14px', background: '#17233a', borderBottom: '1px solid #212121' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, maxWidth: 820 }}>
                                  {[['cbu', t('CBU')], ['location', t('장소')], ['room', t('룸')], ['rack', t('랙')], ['u_pos', t('U 위치')]].map(([k, label]) => (
                                    <label key={k} style={{ fontSize: 11, color: '#8d8d8d' }}>{label}
                                      <input list={k === 'cbu' ? 'cbu-opts' : k === 'location' ? 'loc-opts' : k === 'room' ? 'room-opts' : k === 'rack' ? 'rack-opts' : undefined}
                                        value={form[k] ?? ''} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                                        style={{ ...S.input, marginTop: 3 }} />
                                    </label>
                                  ))}
                                </div>
                                <div style={{ fontSize: 11, color: '#8d8d8d', margin: '9px 0' }}>
                                  {t('랙 이름을 새로 입력하면 그 랙이 생깁니다 — 트리는 장비에서 파생됩니다.')}
                                </div>
                                <div style={{ display: 'flex', gap: 7 }}>
                                  <button style={S.prim} onClick={() => save(d)} disabled={!!busy}>
                                    {busy === `save:${d.src}:${d.id}` ? t('저장 중…') : t('저장')}
                                  </button>
                                  <button style={S.btn} onClick={() => setEdit(null)}>{t('취소')}</button>
                                </div>
                              </div>}
                            </div>;
                          })}
                        </div>;
                      })}
                    </div>;
                  })}
                </div>;
              })}
            </div>;
          })}
        </div>

        {/* Existing values offered as suggestions, so a move reuses a name
            instead of inventing a near-duplicate ("CCR" vs "CCR " vs "ccr"). */}
        <datalist id="cbu-opts">{[...new Set(rows.map(r => r.cbu).filter(Boolean))].sort().map(v => <option key={v} value={v} />)}</datalist>
        <datalist id="loc-opts">{[...new Set(rows.map(r => r.location).filter(Boolean))].sort().map(v => <option key={v} value={v} />)}</datalist>
        <datalist id="room-opts">{[...new Set(rows.map(r => r.room).filter(Boolean))].sort().map(v => <option key={v} value={v} />)}</datalist>
        <datalist id="rack-opts">{[...new Set(rows.map(r => r.rack).filter(Boolean))].sort().map(v => <option key={v} value={v} />)}</datalist>

        <div style={{ fontSize: 11, color: '#6f6f6f', lineHeight: 1.6 }}>
          {t('UPS는 ups_devices, 네트워크·UC 장비는 fms_devices에서 읽습니다. 두 목록을 같은 트리로 합칩니다.')}
        </div>
      </div>
    </main>
  </div>;
}
