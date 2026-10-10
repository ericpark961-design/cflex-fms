// Alarm detail: what the alarm says, what to do about it (asked of the copilot
// with this alarm as context), and whether to raise a ticket.
//
// v5 replaced this modal with the workbench, which opens on the same
// `cflex:open-alarm` event. The panel below is still the right thing to show
// when there is no incident to open — a P3 alarm, or a server where
// /v1/incidents is not yet deployed — so it is exported separately and the
// workbench hosts it. Deleting it would have cost the working "AI 분석" and
// "티켓 발행" buttons for exactly those cases.
import React, { useEffect, useState } from 'react';
import { store, ticketForAlert, createTicketFromAlert, askCopilot } from './data';
import { t } from './i18n';
import { tx, lang } from './theme';

const PRI = { P1: '#fa4d56', P2: '#f1c21b', P3: '#4589ff', P4: '#8d8d8d' };
const fmtAgo = (ms) => {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

export function AlarmPanel({ alarm, onClose }) {
  const [ticket, setTicket] = useState(undefined);      // undefined = not looked up yet
  const [advice, setAdvice] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { setTicket(undefined); setAdvice(null); setErr(null); setBusy(null); }, [alarm?.id]);

  // Does this alarm already have a ticket? Asked once, so the button can say
  // "open the ticket" instead of silently raising a second one.
  useEffect(() => {
    if (!alarm?.id) return;
    let live = true;
    ticketForAlert(alarm.id).then(t2 => { if (live) setTicket(t2); }).catch(() => live && setTicket(null));
    return () => { live = false; };
  }, [alarm?.id]);

  if (!alarm) return null;

  const dev = store.assets.find(a => String(a.id) === String(alarm.deviceId)) || null;
  const close = () => onClose?.();

  const ask = async () => {
    setBusy('advice'); setErr(null);
    const q = lang() === 'en'
      ? `Alarm ${alarm.priority} on ${alarm.device || alarm.deviceId}: "${alarm.message}" (${alarm.metric || ''} ${alarm.value ?? ''} vs threshold ${alarm.threshold ?? ''}). What is the likely cause, and what should the operator do now? Say which steps are remote and which need a site visit.`
      : `${alarm.device || alarm.deviceId} 장치의 ${alarm.priority} 알람: "${alarm.message}" (${alarm.metric || ''} ${alarm.value ?? ''}, 임계 ${alarm.threshold ?? ''}). 원인으로 무엇이 유력하고 운영자가 지금 무엇을 해야 하는가? 원격으로 가능한 조치와 현장 출동이 필요한 조치를 구분해 달라.`;
    const r = await askCopilot(q, alarm.deviceId);
    setBusy(null);
    if (r?.ok) setAdvice(r);
    else setErr(r?.status === 503
      ? t('AI 기능이 꺼져 있습니다. 서버에서 `cflex-ai on` 으로 켜야 합니다.')
      : r?.status === 404 ? t('이 서버에는 아직 코파일럿 엔드포인트(/v1/fms/copilot)가 배포되지 않았습니다.')
        : t('응답을 받지 못했습니다.'));
  };

  const raise = async () => {
    setBusy('ticket'); setErr(null);
    const r = await createTicketFromAlert(alarm.id);
    setBusy(null);
    if (r?.ok && r.ticket) setTicket(r.ticket);
    else setErr(t('티켓 발행에 실패했습니다.'));
  };

  const box = { background: '#1f1f1f', padding: '9px 11px' };
  const label = { fontSize: 10, color: '#8d8d8d' };
  const btn = (primary) => ({
    fontFamily: 'inherit', fontSize: 12, padding: '7px 12px', cursor: 'pointer',
    border: `1px solid ${primary ? '#4589ff' : '#525252'}`,
    background: primary ? '#1c2a44' : 'transparent', color: '#f4f4f4',
  });

  return (
    <div style={{ color: '#f4f4f4' }}>
      <div>
        <div style={{ padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
            {[[t('장치'), alarm.device || '—'], [t('메트릭'), alarm.metric || '—'],
              [t('값 / 임계'), alarm.value != null ? `${alarm.value} / ${alarm.threshold ?? '—'}` : '—'],
              [t('경과'), fmtAgo(alarm.at)]].map(([l, v]) => (
                <div key={l} style={box}><div style={label}>{l}</div><div style={{ fontSize: 14, fontWeight: 700 }}>{v}</div></div>
              ))}
          </div>
          {dev && <div style={{ fontSize: 12, color: '#c6c6c6' }}>
            {dev.vendor} {dev.model} · {dev.location} / {dev.room} · <span className="mono">{dev.ip}</span>
          </div>}

          {/* resolution */}
          <section>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em' }}>{t('해결 방안')}</span>
              <button onClick={ask} disabled={busy === 'advice'} style={{ ...btn(true), marginLeft: 'auto' }}>
                {busy === 'advice' ? t('분석 중…') : (advice ? t('다시 분석') : t('AI 분석'))}
              </button>
            </div>
            {!advice && !busy && <div style={{ fontSize: 12, color: '#8d8d8d' }}>{t('AI 분석을 누르면 이 알람의 원인과 조치를 제시한다.')}</div>}
            {busy === 'advice' && <div style={{ height: 54, background: '#1f1f1f' }} />}
            {advice && (
              <div style={{ background: '#0b0b0b', borderLeft: '2px solid #78a9ff', padding: '10px 12px', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {advice.answer}
                <div className="mono" style={{ fontSize: 10, color: '#8d8d8d', marginTop: 8 }}>
                  {advice.model} · {Math.round((advice.latency_ms || 0) / 100) / 10}s · ${(advice.cost_usd ?? 0).toFixed(4)}
                </div>
              </div>
            )}
          </section>

          {/* ticket */}
          <section>
            <div style={{ fontSize: 11, color: '#8d8d8d', fontWeight: 600, letterSpacing: '.04em', marginBottom: 6 }}>{t('티켓')}</div>
            {ticket === undefined && <div style={{ fontSize: 12, color: '#8d8d8d' }}>{tx('확인 중…', 'Checking…')}</div>}
            {ticket === null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, color: '#c6c6c6' }}>{t('이 알람에 연결된 티켓이 없다.')}</span>
                <button onClick={raise} disabled={busy === 'ticket'} style={{ ...btn(true), marginLeft: 'auto' }}>
                  {busy === 'ticket' ? t('발행 중…') : t('티켓 발행')}
                </button>
              </div>
            )}
            {ticket && (
              <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 10 }}>
                <b className="mono">{ticket.ticket_no}</b>
                <span style={{ fontSize: 12, color: '#c6c6c6' }}>{ticket.title}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#8d8d8d' }}>{ticket.status}</span>
              </div>
            )}
          </section>

          {err && <div style={{ fontSize: 12, color: '#f1c21b', borderLeft: '2px solid #f1c21b', paddingLeft: 10 }}>{err}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <a href={`#/device?id=${alarm.deviceId || ''}`} onClick={close} style={{ ...btn(false), textDecoration: 'none', display: 'inline-block' }}>{t('장치 상세 →')}</a>
          </div>
        </div>
      </div>
    </div>
  );
}


/**
 * The standalone modal, kept for any entry point that wants alarm detail
 * without the incident loop. App.jsx now mounts <Workbench/> instead, which
 * hosts AlarmPanel itself when there is no incident.
 */
export default function AlarmModal() {
  const [alarm, setAlarm] = useState(null);
  useEffect(() => {
    const open = (e) => setAlarm(e.detail || null);
    const esc = (e) => { if (e.key === 'Escape') setAlarm(null); };
    addEventListener('cflex:open-alarm', open);
    addEventListener('keydown', esc);
    return () => { removeEventListener('cflex:open-alarm', open); removeEventListener('keydown', esc); };
  }, []);
  if (!alarm) return null;
  return (
    <div onClick={() => setAlarm(null)} role="dialog" aria-modal="true" aria-label={t('알람 상세')}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 'min(680px, 100%)', maxHeight: '86vh', overflowY: 'auto', background: '#262626', border: '1px solid #393939', padding: 16, fontFamily: '"IBM Plex Sans KR","IBM Plex Sans",sans-serif' }}>
        <AlarmPanel alarm={alarm} onClose={() => setAlarm(null)} />
      </div>
    </div>
  );
}
