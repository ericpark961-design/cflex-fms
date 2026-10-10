// Wires the 전력체인·코파일럿 panel to POST /v1/fms/copilot (Claude Opus 5, server-side).
//
// The template ships a static form; this attaches a transcript above it and turns
// the form into a real request. Answers are inserted as TEXT nodes, never innerHTML —
// the reply is model output and must not be able to inject markup into the console.
import { tx, lang } from './theme';

const C = {
  ink: '#f4f4f4', muted: '#c6c6c6', subtle: '#8d8d8d',
  panel: '#1f1f1f', deep: '#0b0b0b', line: '#393939',
  accent: '#78a9ff', warn: '#f1c21b', crit: '#ff8389',
};

const el = (tag, style, text) => {
  const n = document.createElement(tag);
  if (style) n.style.cssText = style;
  if (text != null) n.textContent = text;   // textContent, never innerHTML
  return n;
};

function turn(role, text) {
  const wrap = el('div', 'display:flex;flex-direction:column;gap:3px');
  wrap.appendChild(el('div', `font-size:10px;font-weight:600;letter-spacing:.04em;color:${role === 'user' ? C.subtle : C.accent}`,
    role === 'user' ? tx('질문', 'YOU') : tx('코파일럿', 'COPILOT')));
  const body = el('div', `font-size:12.5px;line-height:1.6;white-space:pre-wrap;color:${role === 'user' ? C.muted : C.ink};` +
    `background:${role === 'user' ? 'transparent' : C.deep};${role === 'user' ? '' : `border-left:2px solid ${C.accent};padding:9px 11px;`}`, text);
  wrap.appendChild(body);
  return { wrap, body };
}

// Honest failure text: an operator must be able to tell "AI is off" from "it broke"
// from "this build has no backend for it yet".
function failureText(status, payload) {
  if (status === 503) return tx(
    'AI 기능이 꺼져 있습니다. 서버에서 `cflex-ai on` 으로 켜야 합니다.',
    'AI features are switched off. Enable them on the server with `cflex-ai on`.');
  if (status === 404) return tx(
    '이 서버에는 아직 코파일럿 엔드포인트(/v1/fms/copilot)가 배포되지 않았습니다.',
    'This server has no /v1/fms/copilot endpoint deployed yet.');
  if (status === 429) return tx(
    '요청이 너무 잦습니다. 5분 뒤에 다시 시도하세요.',
    'Too many requests. Try again in five minutes.');
  if (payload?.error === 'refused') return tx(
    '모델이 이 요청에 답하지 않았습니다.',
    'The model declined to answer this request.');
  return tx(`응답을 받지 못했습니다${status ? ` (HTTP ${status})` : ''}.`,
    `No answer returned${status ? ` (HTTP ${status})` : ''}.`);
}

export function mountCopilot(root, { deviceId } = {}) {
  const form = root.querySelector('#copilot form');
  const input = root.querySelector('#ask');
  if (!form || !input || form.dataset.wired) return;
  form.dataset.wired = '1';

  const log = el('div', 'display:flex;flex-direction:column;gap:12px;max-height:340px;overflow:auto;margin-bottom:4px');
  form.parentNode.insertBefore(log, form);

  let busy = false;
  const send = async (question) => {
    if (busy || !question.trim()) return;
    busy = true;
    input.value = ''; input.disabled = true;
    log.appendChild(turn('user', question).wrap);

    const a = turn('assistant', tx('생각 중…', 'Thinking…'));
    log.appendChild(a.wrap);
    log.scrollTop = log.scrollHeight;

    let status = 0, d = null;
    try {
      const r = await fetch('/v1/fms/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('cflex_token') || localStorage.getItem('token') || ''}` },
        body: JSON.stringify({ question, device_id: deviceId || undefined, lang: lang() }),
      });
      status = r.status;
      try { d = await r.json(); } catch { d = null; }
    } catch { /* network */ }

    if (d?.ok && d.answer) {
      a.body.textContent = d.answer + (d.truncated ? tx('\n\n[답변이 길이 제한에서 잘렸습니다]', '\n\n[answer was cut off at the length limit]') : '');
      const g = d.grounded_on || {};
      a.wrap.appendChild(el('div', `font-size:10px;color:${C.subtle};font-family:monospace`,
        `${d.model} · ${Math.round((d.latency_ms || 0) / 100) / 10}s · $${(d.cost_usd ?? 0).toFixed(4)} · ` +
        tx(`장치 ${g.devices ?? 0} · 알람 ${g.alerts ?? 0} 기준`, `grounded on ${g.devices ?? 0} devices, ${g.alerts ?? 0} alarms`)));
    } else {
      a.body.style.borderLeftColor = C.warn;
      a.body.textContent = failureText(status, d);
    }
    input.disabled = false; busy = false; input.focus();
    log.scrollTop = log.scrollHeight;
  };

  form.addEventListener('submit', (e) => { e.preventDefault(); e.stopPropagation(); send(input.value); });

  // The three canned prompts directly above the form.
  const quick = form.previousElementSibling?.previousElementSibling;
  (quick?.querySelectorAll?.('button.mini') || []).forEach(b =>
    b.addEventListener('click', (e) => { e.preventDefault(); send(b.textContent.trim()); }));
}
