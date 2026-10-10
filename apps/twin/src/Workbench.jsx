// The alarm workbench — v5 §1, §4.
//
// One component, opened from every place an alarm appears: the dashboard's
// recent list, the alarm centre rows, device detail history, the 3D twin's
// alarm list, the NOC ticker. It opens as a slide-over on the same
// `cflex:open-alarm` event those call sites already dispatch (house rule: an
// alarm click is never a route change), and `#/incident/:id` renders the same
// thing full-screen — that is the link a dispatched engineer receives.
//
// Degradation is explicit. While /v1/incidents is undeployed the panel says so
// and still shows the alarm, because a blank right-hand pane looks like a bug
// and an invented triage card would be worse than either.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { token } from './theme';
import { ticketForAlert, hhmm, tzMark, SIM_NOTE } from './data';
import { t } from './i18n';
import { AlarmPanel } from './AlarmModal';


// api() in theme.js returns only the parsed body, so a 404 from an unmounted
// router is indistinguishable from a missing incident. Same convention as
// askCopilot() in data.js: merge the HTTP status onto the body. The workbench
// payload has no top-level `status` field of its own (the incident's own status
// is nested), so the merge is safe.
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

const PRI = { P1: '#fa4d56', P2: '#f1c21b', P3: '#4589ff', P4: '#8d8d8d' };
const STATE_LABEL = { open: '미처리', ack: '확인', in_progress: '진행 중', resolved: '해결', closed: '종료' };
const STATE_COLOR = { open: '#fa4d56', ack: '#ff832b', in_progress: '#4589ff', resolved: '#42be65', closed: '#6f6f6f' };
const RISK = { low: '#42be65', med: '#f1c21b', high: '#fa4d56' };
const KIND_LABEL = {
  state_change: '상태', triage: 'AI 트리아지', alarm_attach: '알람', action: '원격 조치',
  dispatch: '디스패치', verify: '검증', rca: 'RCA', comment: '코멘트', assign: '담당', channel_send: '발송',
};
const ACTION_TYPE = { remote: '원격', onsite: '현장', monitor: '관찰' };

const ago = (ms) => {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 90 ? `${Math.round(s)}초` : s < 5400 ? `${Math.round(s / 60)}분` : `${Math.round(s / 3600)}시간`;
};
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

const S = {
  card: { background: '#1f1f1f', border: '1px solid #333', padding: 12, marginBottom: 10 },
  h: { fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 7, textTransform: 'uppercase' },
  btn: { background: '#262626', border: '1px solid #525252', color: '#f4f4f4', padding: '7px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' },
  prim: { background: '#0f62fe', border: '1px solid #0f62fe', color: '#fff', padding: '7px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' },
  badge: { fontSize: 10, fontWeight: 700, padding: '2px 6px', letterSpacing: '.03em' },
};

// ── the mini trend chart, reused shape from device detail ────────────
function Trend({ series, threshold }) {
  const pts = series?.points || [];
  if (!pts.length) {
    return <div style={{ ...S.card, color: '#8d8d8d', fontSize: 12, textAlign: 'center', padding: 22 }}>
      {t('데이터 축적 중 · 수집 대기')}
      <div style={{ fontSize: 11, marginTop: 4, color: '#6f6f6f' }}>{series?.metric || ''} — {t('±2시간 구간에 표본이 없다')}</div>
    </div>;
  }
  const W = 560, H = 120, PAD = 4;
  const xs = pts.map(p => p.ts), ys = pts.map(p => p.v);
  const lo = Math.min(...ys, threshold ?? Infinity), hi = Math.max(...ys, threshold ?? -Infinity);
  const span = hi - lo || 1;
  const x = (ts) => PAD + ((ts - xs[0]) / ((xs[xs.length - 1] - xs[0]) || 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const line = pts.map(p => `${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return <div style={S.card}>
    <div style={S.h}>{series.metric} · ±2h</div>
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 120, display: 'block' }} role="img"
      aria-label={`${series.metric} ${t('추세')}`}>
      {threshold != null && <>
        <line x1={PAD} x2={W - PAD} y1={y(threshold)} y2={y(threshold)} stroke="#fa4d56" strokeWidth="1" strokeDasharray="4 3" />
        <text x={W - PAD} y={y(threshold) - 4} fill="#fa4d56" fontSize="10" textAnchor="end">{t('임계')} {threshold}</text>
      </>}
      <polyline points={line} fill="none" stroke="#4589ff" strokeWidth="1.6" />
      <circle cx={x(xs[xs.length - 1])} cy={y(ys[ys.length - 1])} r="3" fill="#4589ff" />
    </svg>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#6f6f6f', marginTop: 2 }}>
      <span>{hhmm(xs[0], series.cbu)}</span><span>{pts.length} {t('표본')}</span><span>{hhmm(xs[xs.length - 1], series.cbu)}</span>
    </div>
  </div>;
}

// ── the triage card (always present, §1.2) ───────────────────────────
function TriageCard({ wb, onFeedback, onRerun, onAction, busy, evRef }) {
  const tg = wb?.triage;
  if (!tg) {
    return <div style={{ ...S.card, borderLeft: '3px solid #6f6f6f' }}>
      <div style={S.h}>{t('AI 트리아지')}</div>
      <div style={{ fontSize: 13, color: '#c6c6c6' }}>{t('아직 트리아지가 없다')}</div>
      <button style={{ ...S.btn, marginTop: 9 }} onClick={onRerun} disabled={!!busy}>
        {busy === 'rerun' ? t('분석 중…') : t('지금 분석')}
      </button>
    </div>;
  }
  const isRules = tg.source === 'rules';
  const fb = new Map((wb.feedback || []).map(f => [f.hypothesis_id, f.outcome]));
  return <div style={{ ...S.card, borderLeft: `3px solid ${isRules ? '#8d8d8d' : '#4589ff'}` }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
      <div style={S.h}>{t('AI 트리아지')}</div>
      <span style={{ ...S.badge, background: isRules ? '#393939' : '#0f62fe', color: '#fff' }}>
        {isRules ? t('규칙 기반') : 'AI'}
      </span>
      {tg.fallback_reason && <span style={{ fontSize: 10, color: '#ff832b' }}>{tg.fallback_reason}</span>}
    </div>
    <div style={{ fontSize: 14, marginBottom: 12, lineHeight: 1.5 }}>{tg.summary}</div>

    <div style={S.h}>{t('원인 가설')}</div>
    {(tg.hypotheses || []).map(h => {
      const mark = fb.get(h.id);
      return <div key={h.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 0', borderTop: '1px solid #2a2a2a' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13 }}>{h.cause}</div>
          <div style={{ fontSize: 11, color: '#8d8d8d', marginTop: 3 }}>
            {t('신뢰도')} {pct(h.confidence)} · {t('근거')}{' '}
            {(h.evidence_ids || []).map(id => (
              <button key={id} onClick={() => evRef?.(id)} style={{ background: 'none', border: 0, color: '#78a9ff', cursor: 'pointer', padding: '0 2px', font: 'inherit' }}>#{id.replace(/^e/, '')}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>
          <button title={t('원인 확정')} onClick={() => onFeedback(h.id, 'confirmed')} disabled={!!busy}
            style={{ ...S.btn, padding: '3px 8px', background: mark === 'confirmed' ? '#042d1c' : '#262626', borderColor: mark === 'confirmed' ? '#42be65' : '#525252', color: mark === 'confirmed' ? '#42be65' : '#f4f4f4' }}>✓</button>
          <button title={t('가설 기각')} onClick={() => onFeedback(h.id, 'rejected')} disabled={!!busy}
            style={{ ...S.btn, padding: '3px 8px', background: mark === 'rejected' ? '#3d0a0e' : '#262626', borderColor: mark === 'rejected' ? '#fa4d56' : '#525252', color: mark === 'rejected' ? '#fa4d56' : '#f4f4f4' }}>✗</button>
        </div>
      </div>;
    })}

    <div style={{ ...S.h, marginTop: 14 }}>{t('권고 조치')}</div>
    {(tg.actions || []).map(a => <div key={a.id} style={{ padding: '7px 0', borderTop: '1px solid #2a2a2a' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ ...S.badge, background: a.type === 'remote' ? '#1c2a44' : a.type === 'onsite' ? '#3d2a0a' : '#262626', color: '#f4f4f4' }}>
          {t(ACTION_TYPE[a.type] || a.type)}
        </span>
        <span style={{ fontSize: 13, flex: 1 }}>{a.title}</span>
        <span style={{ fontSize: 10, color: RISK[a.risk] || '#8d8d8d' }}>{t('위험도')} {a.risk}</span>
        {a.type === 'remote' && a.control_action && wb.permissions?.control && (
          <button style={{ ...S.btn, padding: '3px 9px' }} onClick={() => onAction(a)} disabled={!!busy}>
            {busy === `act:${a.id}` ? t('실행 중…') : t('실행')}
          </button>
        )}
      </div>
      {!!(a.steps || []).length && <ul style={{ margin: '5px 0 0 18px', padding: 0, fontSize: 12, color: '#c6c6c6', lineHeight: 1.6 }}>
        {a.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ul>}
    </div>)}

    <div style={{ ...S.h, marginTop: 14 }}>{t('디스패치 판단')}</div>
    <div style={{ fontSize: 13, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <span style={{ color: tg.dispatch?.needed ? '#ff832b' : '#42be65', fontWeight: 600 }}>
        {tg.dispatch?.needed ? t('현장 필요') : t('원격으로 가능')}
      </span>
      <span style={{ color: '#c6c6c6' }}>{t('기술등급')} {tg.dispatch?.skill || '—'}</span>
      <span style={{ color: '#c6c6c6' }}>{t('긴급도')} {tg.dispatch?.urgency || '—'}</span>
      <span style={{ color: '#c6c6c6' }}>{t('예상')} {tg.dispatch?.eta_min != null ? `${tg.dispatch.eta_min}분` : '—'}</span>
    </div>
    {tg.dispatch?.reason && <div style={{ fontSize: 12, color: '#8d8d8d', marginTop: 4 }}>{tg.dispatch.reason}</div>}

    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13, paddingTop: 9, borderTop: '1px solid #2a2a2a', fontSize: 11, color: '#6f6f6f', flexWrap: 'wrap' }}>
      <span>{t('근거')} {(tg.evidence || []).length}{t('건')}</span>
      <span>·</span><span>{tg.model || t('규칙표')}</span>
      <span>·</span><span>{ago(tg.generated_at)} {t('전')}</span>
      <button style={{ ...S.btn, marginLeft: 'auto', padding: '4px 10px' }} onClick={onRerun} disabled={!!busy}>
        {busy === 'rerun' ? t('재평가 중…') : t('재평가')}
      </button>
    </div>
  </div>;
}

// ── main ─────────────────────────────────────────────────────────────
// #/incident/:id — the link a dispatched engineer opens.
const hashIncident = () => {
  const m = /^#\/incident\/(\d+)/.exec(typeof location === 'undefined' ? '' : location.hash || '');
  return m ? Number(m[1]) : null;
};

export default function Workbench() {
  const [open, setOpen] = useState(() => hashIncident() != null);
  const [alarm, setAlarm] = useState(null);       // the clicked alarm, when it came from one
  const [incidentId, setIncidentId] = useState(() => hashIncident());
  const [wb, setWb] = useState(null);
  const [state, setState] = useState('idle');     // idle | loading | ready | nobackend | noincident | error
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [comment, setComment] = useState('');
  const [showDispatch, setShowDispatch] = useState(false);
  const [dispatchForm, setDispatchForm] = useState({ engineer: '', skill: '', urgency: '4h', eta_min: '', note: '' });
  const evidenceRefs = useRef({});
  const [highlight, setHighlight] = useState(null);

  const narrow = typeof window !== 'undefined' && window.innerWidth < 860;

  const [deep, setDeep] = useState(() => hashIncident());

  const close = useCallback(() => {
    setOpen(false); setWb(null); setAlarm(null); setIncidentId(null); setState('idle');
    if (hashIncident()) location.hash = '#/alarms';
  }, []);
  useEffect(() => {
    const onHash = () => {
      const id = hashIncident();
      setDeep(id);
      if (id) { setIncidentId(id); setAlarm(null); setOpen(true); }
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  // Every existing alarm click still works: same event, richer panel.
  useEffect(() => {
    const onAlarm = (e) => {
      const d = e.detail || {};
      setAlarm(d); setIncidentId(null); setWb(null); setErr(null); setBusy(null);
      setShowDispatch(false); setComment('');
      setOpen(true);
    };
    const onIncident = (e) => {
      const id = Number(e.detail?.id);
      if (!Number.isFinite(id)) return;
      setAlarm(null); setIncidentId(id); setWb(null); setErr(null); setOpen(true);
    };
    addEventListener('cflex:open-alarm', onAlarm);
    addEventListener('cflex:open-incident', onIncident);
    const esc = (ev) => { if (ev.key === 'Escape' && !deep) close(); };
    addEventListener('keydown', esc);
    return () => {
      removeEventListener('cflex:open-alarm', onAlarm);
      removeEventListener('cflex:open-incident', onIncident);
      removeEventListener('keydown', esc);
    };
  }, [deep]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve an alarm to its incident, then load the workbench in one call.
  const load = useCallback(async (id) => {
    setState('loading');
    const r = await req(`/v1/incidents/${id}/workbench`);
    if (r?.ok) { setWb(r); setState('ready'); return; }
    // 404 on the collection means the router is not deployed; 404 on the id
    // means the incident is gone. The status tells them apart.
    setState(r?.status === 404 && !r?.error ? 'nobackend' : 'error');
    setErr(r?.error || `HTTP ${r?.status || '?'}`);
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    (async () => {
      if (incidentId) { await load(incidentId); return; }
      if (!alarm?.id) { setState('noincident'); return; }
      setState('loading');
      const tk = await ticketForAlert(alarm.id).catch(() => null);
      if (!live) return;
      if (tk?.id) { setIncidentId(tk.id); await load(tk.id); }
      else setState('noincident');
    })();
    return () => { live = false; };
  }, [open, incidentId, alarm?.id, load]);

  // ── actions ────────────────────────────────────────────────────────
  const post = async (path, body, key) => {
    setBusy(key); setErr(null);
    const r = await req(path, { method: 'POST', body: JSON.stringify(body || {}) });
    setBusy(null);
    if (!r?.ok) { setErr(r?.error || `HTTP ${r?.status || '?'}`); return null; }
    await load(incidentId);
    return r;
  };

  const transition = (to) => post(`/v1/incidents/${incidentId}/state`, { state: to }, `st:${to}`);
  const rerun = () => post(`/v1/incidents/${incidentId}/triage/rerun`, {}, 'rerun');
  const feedback = (hid, outcome) => post(`/v1/incidents/${incidentId}/triage/feedback`, { hypothesis_id: hid, outcome }, `fb:${hid}`);
  const runAction = (a) => post(`/v1/incidents/${incidentId}/action`, { action: a.control_action }, `act:${a.id}`);
  const addComment = async () => {
    if (!comment.trim()) return;
    const r = await post(`/v1/incidents/${incidentId}/comment`, { note: comment.trim() }, 'comment');
    if (r) setComment('');
  };
  const sendDispatch = async () => {
    const body = { ...dispatchForm, eta_min: dispatchForm.eta_min === '' ? null : Number(dispatchForm.eta_min) };
    const r = await post(`/v1/incidents/${incidentId}/dispatch`, body, 'dispatch');
    if (r) setShowDispatch(false);
  };
  const patchDispatch = (did, step) => {
    setBusy(`dp:${did}:${step}`);
    req(`/v1/incidents/${incidentId}/dispatch/${did}`, { method: 'PATCH', body: JSON.stringify({ step }) })
      .then(() => load(incidentId)).catch(e => setErr(String(e))).finally(() => setBusy(null));
  };
  const checkVerify = () => {
    setBusy('verify');
    req(`/v1/incidents/${incidentId}/verify`).then(() => load(incidentId)).finally(() => setBusy(null));
  };

  const jumpToEvidence = (id) => {
    setHighlight(id);
    evidenceRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => setHighlight(null), 1600);
  };

  if (!open) return null;

  const inc = wb?.incident || null;
  const full = !!deep || narrow;
  const shell = full
    ? { position: 'fixed', inset: 0, zIndex: 60, background: '#161616', display: 'flex', flexDirection: 'column' }
    : { position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(680px, 100vw)', zIndex: 60, background: '#161616', borderLeft: '1px solid #393939', boxShadow: '-12px 0 40px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column' };

  const pri = inc?.priority || alarm?.priority || 'P3';
  const title = inc?.title || alarm?.message || t('알람');

  return <>
    {!full && <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 59, background: 'rgba(0,0,0,.5)' }} />}
    <div role="dialog" aria-modal="true" aria-label={t('알람 워크벤치')} style={{ ...shell, fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif', color: '#f4f4f4' }}>

      {/* ── header (§1.1) — sticky, so the phone view keeps it ── */}
      <div style={{ flex: '0 0 auto', padding: '13px 16px', background: '#0b0b0b', borderBottom: '1px solid #262626' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <span style={{ ...S.badge, background: PRI[pri], color: pri === 'P2' ? '#161616' : '#fff', fontSize: 11, padding: '3px 7px' }}>{pri}</span>
          {inc && <span style={{ ...S.badge, background: STATE_COLOR[inc.status] || '#393939', color: '#fff' }}>{t(STATE_LABEL[inc.status] || inc.status)}</span>}
          {(inc?.simulated || alarm?.simulated) ? <span title={SIM_NOTE()} style={{ ...S.badge, background: '#ff832b', color: '#161616' }}>SIM</span> : null}
          {inc?.verify_state && <span style={{ ...S.badge, background: inc.verify_state === 'ok' ? '#042d1c' : inc.verify_state === 'failed' ? '#3d0a0e' : '#262626', color: inc.verify_state === 'ok' ? '#42be65' : inc.verify_state === 'failed' ? '#fa4d56' : '#c6c6c6' }}>
            Verify {inc.verify_state}
          </span>}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#8d8d8d' }}>
            {inc?.ticket_no || (alarm?.id ? `ALERT-${alarm.id}` : '')}
          </span>
          <button onClick={close} aria-label={t('닫기')} style={{ ...S.btn, padding: '3px 9px', border: 0, background: 'none', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, margin: '8px 0 4px', lineHeight: 1.35 }}>{title}</div>
        <div style={{ fontSize: 11, color: '#8d8d8d', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span className="mono">{inc?.device_label || alarm?.device || inc?.device_id || '—'}</span>
          {wb?.device?.model && <span>{wb.device.model}</span>}
          <span>{[inc?.site || wb?.device?.location, wb?.device?.room, wb?.device?.rack].filter(Boolean).join(' · ') || '—'}</span>
          <span>{hhmm(inc?.created_at || alarm?.at, inc?.cbu)} {tzMark(inc?.cbu) && <span style={{ color: '#6f6f6f' }}>{tzMark(inc?.cbu)}</span>} ({ago(inc?.created_at || alarm?.at)} {t('전')})</span>
          {inc?.assignee && <span>{t('담당')} {inc.assignee}</span>}
        </div>

        {/* state buttons — only the transitions the machine allows */}
        {inc && <div style={{ display: 'flex', gap: 6, marginTop: 11, flexWrap: 'wrap' }}>
          {['ack', 'in_progress', 'resolved', 'closed'].filter(s => (inc.can_transition || []).includes(s)).map(s => (
            <button key={s} onClick={() => transition(s)} disabled={!!busy}
              style={s === 'resolved' ? { ...S.prim, background: '#42be65', borderColor: '#42be65' } : S.btn}>
              {busy === `st:${s}` ? '…' : t(STATE_LABEL[s])}
            </button>
          ))}
          <button onClick={() => setShowDispatch(v => !v)} disabled={!!busy} style={S.btn}>{t('엔지니어 디스패치')}</button>
          {inc.verify_state === 'pending' && <button onClick={checkVerify} disabled={!!busy} style={S.btn}>{busy === 'verify' ? '…' : t('복귀 확인')}</button>}
          {!full && <a href={`#/incident/${inc.id}`} style={{ ...S.btn, textDecoration: 'none', marginLeft: 'auto' }}>{t('전체 화면')}</a>}
        </div>}
      </div>

      {/* ── body ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, maxWidth: full ? 980 : 'none', margin: full ? '0 auto' : 0, width: '100%', boxSizing: 'border-box' }}>
        {err && <div style={{ ...S.card, borderLeft: '3px solid #fa4d56', color: '#ff8389', fontSize: 12 }}>{err}</div>}

        {state === 'loading' && <div style={{ ...S.card, color: '#8d8d8d', fontSize: 13 }}>{t('불러오는 중…')}</div>}

        {state === 'nobackend' && <div style={{ ...S.card, borderLeft: '3px solid #f1c21b' }}>
          <div style={{ fontSize: 13, color: '#f1c21b', fontWeight: 600, marginBottom: 5 }}>{t('워크벤치 백엔드 미배포')}</div>
          <div style={{ fontSize: 12, color: '#c6c6c6', lineHeight: 1.6 }}>
            {t('이 서버에는 아직 /v1/incidents 가 배포되지 않았다. 아래는 알람 원본이다.')}
          </div>
        </div>}

        {state === 'noincident' && <div style={{ ...S.card, borderLeft: '3px solid #6f6f6f' }}>
          <div style={{ fontSize: 13, marginBottom: 5 }}>{t('이 알람에는 인시던트가 없다')}</div>
          <div style={{ fontSize: 12, color: '#8d8d8d', lineHeight: 1.6 }}>
            {t('P1·P2 알람은 수신 즉시 인시던트가 생성된다. P3·P4는 운영자가 필요할 때 올린다.')}
          </div>
        </div>}

        {/* No incident to open: show the alarm panel, which still offers the
            copilot analysis and ticket actions that work today. */}
        {alarm && state !== 'ready' && state !== 'loading' && (
          <div style={S.card}><AlarmPanel alarm={alarm} onClose={close} /></div>
        )}

        {state === 'ready' && wb && <>
          <TriageCard wb={wb} busy={busy} onRerun={rerun} onFeedback={feedback} onAction={runAction} evRef={jumpToEvidence} />

          {/* dispatch form */}
          {showDispatch && <div style={{ ...S.card, borderLeft: '3px solid #ff832b' }}>
            <div style={S.h}>{t('엔지니어 디스패치')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1fr 1fr', gap: 8 }}>
              {[['engineer', t('담당 엔지니어')], ['skill', t('기술등급')], ['urgency', t('긴급도')], ['eta_min', t('예상 소요(분)')]].map(([k, label]) => (
                <label key={k} style={{ fontSize: 11, color: '#8d8d8d' }}>{label}
                  <input value={dispatchForm[k]} onChange={e => setDispatchForm(f => ({ ...f, [k]: e.target.value }))}
                    placeholder={k === 'skill' ? (wb.triage?.dispatch?.skill || '') : k === 'urgency' ? 'now | 4h | next-day' : ''}
                    style={{ display: 'block', width: '100%', marginTop: 3, background: '#262626', border: 0, borderBottom: '1px solid #525252', color: '#f4f4f4', padding: '6px 8px', fontFamily: 'inherit', fontSize: 12, boxSizing: 'border-box' }} />
                </label>
              ))}
            </div>
            <label style={{ fontSize: 11, color: '#8d8d8d', display: 'block', marginTop: 8 }}>{t('메모')}
              <textarea value={dispatchForm.note} onChange={e => setDispatchForm(f => ({ ...f, note: e.target.value }))} rows={2}
                style={{ display: 'block', width: '100%', marginTop: 3, background: '#262626', border: 0, borderBottom: '1px solid #525252', color: '#f4f4f4', padding: '6px 8px', fontFamily: 'inherit', fontSize: 12, boxSizing: 'border-box', resize: 'vertical' }} />
            </label>
            <div style={{ fontSize: 11, color: '#8d8d8d', margin: '8px 0' }}>
              {t('MOP 초안은 발송 시 AI가 작성해 디스패치 레코드에 첨부된다.')}
            </div>
            <div style={{ display: 'flex', gap: 7 }}>
              <button style={S.prim} onClick={sendDispatch} disabled={!!busy}>{busy === 'dispatch' ? t('발송 중…') : t('발송')}</button>
              <button style={S.btn} onClick={() => setShowDispatch(false)}>{t('취소')}</button>
            </div>
          </div>}

          {/* dispatch records */}
          {(wb.dispatch || []).map(d => <div key={d.id} style={{ ...S.card, borderLeft: '3px solid #ff832b' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <div style={S.h}>{t('디스패치')} #{d.id}</div>
              <span style={{ fontSize: 12, color: '#c6c6c6' }}>{d.engineer || '—'} · {d.skill || '—'} · {d.urgency}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: d.sent_at ? '#42be65' : '#fa4d56' }}>
                {d.sent_at ? `${t('발송')} ${d.channel || ''}` : t('미발송')}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 7, marginTop: 8, flexWrap: 'wrap' }}>
              {[['accept', '수락', d.accepted_at], ['arrive', '도착', d.arrived_at], ['done', '작업 완료', d.done_at]].map(([step, label, at]) => (
                <button key={step} onClick={() => patchDispatch(d.id, step)} disabled={!!busy || !!at}
                  style={{ ...(at ? { ...S.btn, borderColor: '#42be65', color: '#42be65' } : S.btn), padding: narrow ? '11px 16px' : '7px 12px', flex: narrow ? '1 1 30%' : '0 0 auto' }}>
                  {t(label)}{at ? ` ✓ ${hhmm(at, inc?.cbu)}` : ''}
                </button>
              ))}
            </div>
            {d.mop && <details style={{ marginTop: 9 }}>
              <summary style={{ fontSize: 11, color: '#78a9ff', cursor: 'pointer' }}>{t('MOP 보기')}</summary>
              <pre style={{ fontSize: 11, color: '#c6c6c6', whiteSpace: 'pre-wrap', background: '#141414', padding: 10, marginTop: 6, maxHeight: 320, overflow: 'auto' }}>{d.mop}</pre>
            </details>}
          </div>)}

          {/* ── evidence (§1.3) ── */}
          <Trend series={wb.series} threshold={wb.series?.threshold} />

          <div style={S.card}>
            <div style={S.h}>{t('증거')}</div>
            {(wb.evidence || []).map(e => <div key={e.id} ref={el => { evidenceRefs.current[e.id] = el; }}
              style={{ display: 'flex', gap: 8, padding: '6px 7px', marginBottom: 3, fontSize: 12,
                background: highlight === e.id ? '#1c2a44' : 'transparent',
                borderLeft: `2px solid ${highlight === e.id ? '#4589ff' : '#333'}`, transition: 'background .3s' }}>
              <span style={{ ...S.badge, background: '#262626', color: '#78a9ff', flex: '0 0 auto' }}>#{e.id.replace(/^e/, '')}</span>
              <span style={{ color: '#8d8d8d', flex: '0 0 auto', fontSize: 11 }}>{e.kind}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{e.label}</span>
            </div>)}
            {!(wb.evidence || []).length && <div style={{ fontSize: 12, color: '#8d8d8d' }}>{t('수집된 증거가 없다')}</div>}
          </div>

          {!!(wb.chain || []).length && <div style={S.card}>
            <div style={S.h}>{t('전원 체인')} ({t('부하 → 공급')})</div>
            <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
              {wb.chain.map((c, i) => <React.Fragment key={i}>
                {i > 0 && <span style={{ color: '#6f6f6f' }}>→</span>}
                <span style={{ background: '#262626', padding: '3px 8px' }}>{c.name}<span style={{ color: '#8d8d8d', fontSize: 10, marginLeft: 4 }}>{c.kind}</span></span>
              </React.Fragment>)}
            </div>
          </div>}

          {!!(wb.alarms || []).length && <div style={S.card}>
            <div style={S.h}>{t('묶인 알람')} ({wb.alarms.length})</div>
            {wb.alarms.map(a => <div key={a.id} style={{ fontSize: 12, padding: '4px 0', borderTop: '1px solid #2a2a2a', display: 'flex', gap: 8 }}>
              <span style={{ color: PRI[a.priority] }}>{a.priority}</span>
              <span style={{ flex: 1 }}>{a.message}</span>
              <span className="mono" style={{ color: '#8d8d8d' }}>{hhmm(a.received_at, inc?.cbu)}</span>
            </div>)}
          </div>}

          {/* ── timeline (§1.4) ── */}
          <div style={S.card}>
            <div style={S.h}>{t('타임라인')}</div>
            {(wb.timeline || []).map(ev => <div key={ev.id} style={{ display: 'flex', gap: 9, padding: '6px 0', borderTop: '1px solid #2a2a2a', fontSize: 12 }}>
              <span className="mono" style={{ color: '#6f6f6f', flex: '0 0 42px' }}>{hhmm(ev.created_at, inc?.cbu)}</span>
              <span style={{ ...S.badge, background: '#262626', color: '#c6c6c6', flex: '0 0 auto', alignSelf: 'flex-start' }}>
                {t(KIND_LABEL[ev.kind] || ev.kind)}
              </span>
              <span style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>
                {ev.note}
                <span style={{ color: '#6f6f6f', fontSize: 11 }}> — {ev.author}</span>
              </span>
            </div>)}
            <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
              <input value={comment} onChange={e => setComment(e.target.value)} placeholder={t('코멘트 추가')}
                onKeyDown={e => { if (e.key === 'Enter') addComment(); }}
                style={{ flex: 1, background: '#262626', border: 0, borderBottom: '1px solid #525252', color: '#f4f4f4', padding: '7px 9px', fontFamily: 'inherit', fontSize: 12 }} />
              <button style={S.btn} onClick={addComment} disabled={!!busy || !comment.trim()}>{busy === 'comment' ? '…' : t('추가')}</button>
            </div>
          </div>

          {/* ── RCA (§1.5) ── */}
          {inc?.rca_summary ? <div style={{ ...S.card, borderLeft: '3px solid #42be65' }}>
            <div style={S.h}>RCA</div>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>{inc.rca_summary}</div>
            {inc.rca_confidence != null && <div style={{ fontSize: 11, color: '#8d8d8d', marginTop: 6 }}>
              {t('신뢰도')} {pct(inc.rca_confidence)} · {inc.rca_model || ''} · {ago(inc.rca_generated_at)} {t('전')}
            </div>}
          </div> : inc?.status === 'resolved' || inc?.status === 'closed' ? <div style={{ ...S.card, color: '#8d8d8d', fontSize: 12 }}>
            {t('RCA 초안 생성 중 — 해결 시점에 자동 작성된다')}
          </div> : null}
        </>}
      </div>
    </div>
  </>;
}
