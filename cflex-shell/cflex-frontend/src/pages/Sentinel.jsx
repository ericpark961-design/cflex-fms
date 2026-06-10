// ============================================================
// Sentinel — Claude-style LLM Operations Copilot
// Standalone full-bleed workspace at sentinel.runless.co.uk/sentinel
//
// Layout:
//   left  (260px) — thread history, "New chat" button, logout
//   main  (1fr)   — chat thread, streaming text + tool calls, composer
//
// Backend: POST /v1/agent/sentinel/converse  (SSE)
// ============================================================
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';

const FONT_SANS = '"IBM Plex Sans","Helvetica Neue",Arial,sans-serif';
const FONT_MONO = '"IBM Plex Mono","JetBrains Mono",Menlo,monospace';

const T = {
  bg:        '#fdfcfa',  // warm white (Claude.ai-ish)
  bgDark:    '#1d1c1a',
  panel:     '#f7f6f3',
  panelDark: '#262524',
  border:    '#e8e5df',
  ink:       '#1d1c1a',
  inkMuted:  '#6b6962',
  inkSubtle: '#8e8b83',
  accent:    '#c66432',  // claude orange
  accentSoft:'#fbeee4',
  tool:      '#0f62fe',
  toolSoft:  '#edf5ff',
  ok:        '#24a148',
  danger:    '#da1e28',
};

const auth = () => {
  const t = localStorage.getItem('cflex_token') || localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      const data = dataLines.join('\n');
      try { yield { event, data: JSON.parse(data) }; }
      catch { yield { event, data }; }
    }
  }
}

// Lightweight markdown — bold, italic, code, headings, links, simple tables
function MD({ text }) {
  if (!text) return null;
  // tables: lines like | col | col | with separator row
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    // Table block?
    if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-|]+\|[\s:-]+/.test(lines[i + 1])) {
      const head = lines[i].split('|').filter(Boolean).map(s => s.trim());
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(lines[i].split('|').filter(Boolean).map(s => s.trim()));
        i++;
      }
      out.push(
        <table key={out.length} style={{ borderCollapse: 'collapse', margin: '12px 0', fontSize: 13 }}>
          <thead><tr>{head.map((h, j) => <th key={j} style={{ padding: '6px 12px', borderBottom: `1px solid ${T.border}`, textAlign: 'left', fontWeight: 600 }}>{inline(h)}</th>)}</tr></thead>
          <tbody>{rows.map((r, k) => (
            <tr key={k}>{r.map((c, j) => <td key={j} style={{ padding: '6px 12px', borderBottom: `1px solid ${T.border}` }}>{inline(c)}</td>)}</tr>
          ))}</tbody>
        </table>
      );
      continue;
    }
    if (/^#{1,3} /.test(lines[i])) {
      const lvl = lines[i].match(/^(#{1,3}) /)[1].length;
      const txt = lines[i].slice(lvl + 1);
      const Tag = lvl === 1 ? 'h2' : lvl === 2 ? 'h3' : 'h4';
      const fs = lvl === 1 ? 20 : lvl === 2 ? 16 : 14;
      out.push(React.createElement(Tag, { key: out.length, style: { fontSize: fs, fontWeight: 600, margin: '14px 0 6px' } }, inline(txt)));
      i++;
      continue;
    }
    if (lines[i].startsWith('---')) { out.push(<hr key={out.length} style={{ border: 0, borderTop: `1px solid ${T.border}`, margin: '14px 0' }} />); i++; continue; }
    if (lines[i].startsWith('> ')) {
      out.push(<blockquote key={out.length} style={{ borderLeft: `3px solid ${T.accent}`, padding: '4px 12px', margin: '8px 0', color: T.inkMuted, fontStyle: 'italic' }}>{inline(lines[i].slice(2))}</blockquote>);
      i++; continue;
    }
    if (/^[-*] /.test(lines[i])) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(lines[i].slice(2)); i++; }
      out.push(<ul key={out.length} style={{ margin: '6px 0 6px 22px', padding: 0 }}>{items.map((it, k) => <li key={k} style={{ margin: '2px 0' }}>{inline(it)}</li>)}</ul>);
      continue;
    }
    if (lines[i].trim()) {
      out.push(<p key={out.length} style={{ margin: '4px 0', lineHeight: 1.65 }}>{inline(lines[i])}</p>);
    } else {
      out.push(<div key={out.length} style={{ height: 8 }} />);
    }
    i++;
  }
  return <>{out}</>;
}
function inline(s) {
  const parts = [];
  let rest = String(s);
  let key = 0;
  const push = (node) => parts.push(<React.Fragment key={key++}>{node}</React.Fragment>);
  // very light pass — `code`, **bold**, *italic*, [text](url)
  while (rest.length) {
    const m = rest.match(/(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/);
    if (!m) { push(rest); break; }
    if (m.index > 0) push(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) push(<code style={{ background: T.panel, padding: '1px 5px', fontFamily: FONT_MONO, fontSize: '0.92em' }}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) push(<strong>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('*')) push(<em>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith('[')) {
      const mm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
      push(<a href={mm[2]} target="_blank" rel="noopener" style={{ color: T.accent }}>{mm[1]}</a>);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return parts;
}

// ── Thread row in sidebar ────────────────────────────────────
function ThreadRow({ thread, active, onClick }) {
  return (
    <div onClick={onClick} style={{
      padding: '8px 12px', fontSize: 13, cursor: 'pointer',
      background: active ? T.panel : 'transparent',
      borderLeft: active ? `3px solid ${T.accent}` : '3px solid transparent',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      color: T.ink,
    }}>
      {thread.title || 'Untitled'}
    </div>
  );
}

// ── Tool call card ───────────────────────────────────────────
function ToolCard({ call, result }) {
  const [open, setOpen] = useState(false);
  const status = !result ? 'running' : result.error ? 'error' : 'ok';
  const dot = status === 'running' ? T.tool : status === 'error' ? T.danger : T.ok;
  return (
    <div style={{ margin: '8px 0', border: `1px solid ${T.border}`, background: T.toolSoft, fontSize: 12, fontFamily: FONT_MONO }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', cursor: 'pointer', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: dot, display: 'inline-block' }} />
        <span style={{ fontWeight: 600, color: T.tool }}>{call.name}</span>
        <span style={{ color: T.inkSubtle }}>({Object.keys(call.input || {}).map(k => `${k}=${JSON.stringify(call.input[k])}`).join(', ')})</span>
        {result && <span style={{ color: T.inkSubtle, marginLeft: 'auto' }}>{result.duration_ms}ms · {open ? '▾' : '▸'}</span>}
      </div>
      {open && result && (
        <pre style={{ margin: 0, padding: '8px 12px', borderTop: `1px solid ${T.border}`, background: '#fff', maxHeight: 280, overflow: 'auto', fontSize: 11, lineHeight: 1.5 }}>
          {JSON.stringify(result.output, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────
export default function Sentinel() {
  const { user, tenant, logout } = useAuth();
  const [threads, setThreads] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);  // [{ role, content, toolCalls, toolResults }]
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // AI toggle — persisted per browser. When OFF, the composer is disabled
  // and we never POST to the LLM (zero Anthropic tokens consumed).
  const [aiEnabled, setAiEnabled] = useState(() => {
    try { return localStorage.getItem('sentinel_ai_enabled') !== '0'; } catch { return true; }
  });
  const toggleAi = (next) => {
    setAiEnabled(next);
    try { localStorage.setItem('sentinel_ai_enabled', next ? '1' : '0'); } catch {}
  };
  const scroller = useRef(null);

  const loadThreads = () => fetch('/v1/agent/sentinel/threads', { headers: auth() })
    .then(r => r.json()).then(d => { if (d?.ok) setThreads(d.threads || []); });

  const loadThread = (id) => fetch(`/v1/agent/sentinel/threads/${id}`, { headers: auth() })
    .then(r => r.json()).then(d => {
      if (!d?.ok) return;
      setActiveId(id);
      const msgs = [];
      for (const m of d.messages) {
        if (m.role === 'user') msgs.push({ role: 'user', text: m.content });
        else if (m.role === 'assistant') {
          const blocks = Array.isArray(m.content) ? m.content : [];
          let text = '';
          const toolCalls = [];
          for (const b of blocks) {
            if (b.type === 'text') text += b.text;
            else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input });
          }
          msgs.push({ role: 'assistant', text, toolCalls, toolResults: {} });
        }
      }
      setMessages(msgs);
    });

  useEffect(() => { loadThreads(); }, []);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, busy]);

  const newChat = () => { setActiveId(null); setMessages([]); setInput(''); };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!aiEnabled) {
      setMessages(prev => [...prev,
        { role: 'user', text },
        { role: 'assistant', text: '⚠ AI is currently disabled. Toggle it on in the sidebar to send messages.', toolCalls: [], toolResults: {} }
      ]);
      setInput('');
      return;
    }
    setBusy(true);
    setInput('');
    const userMsg = { role: 'user', text };
    setMessages(prev => [...prev, userMsg, { role: 'assistant', text: '', toolCalls: [], toolResults: {} }]);

    try {
      const resp = await fetch('/v1/agent/sentinel/converse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify({ thread_id: activeId, user_message: text }),
      });
      if (resp.status === 401) {
        // Token expired or invalid — clear creds + bounce to login.
        try {
          localStorage.removeItem('cflex_token');
          localStorage.removeItem('cflex_user');
          localStorage.removeItem('cflex_tenant');
        } catch (_) {}
        window.location.replace('/login');
        return;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      let newThreadId = activeId;
      for await (const ev of readSse(resp.body)) {
        if (ev.event === 'thread') {
          newThreadId = ev.data.thread_id;
          if (!activeId) setActiveId(newThreadId);
        }
        else if (ev.event === 'text') {
          setMessages(prev => {
            const arr = [...prev];
            const last = arr[arr.length - 1];
            arr[arr.length - 1] = { ...last, text: (last.text || '') + ev.data.text };
            return arr;
          });
        }
        else if (ev.event === 'tool_use') {
          setMessages(prev => {
            const arr = [...prev];
            const last = arr[arr.length - 1];
            const toolCalls = [...(last.toolCalls || []), { id: ev.data.id, name: ev.data.name, input: ev.data.input }];
            arr[arr.length - 1] = { ...last, toolCalls };
            return arr;
          });
        }
        else if (ev.event === 'tool_result') {
          setMessages(prev => {
            const arr = [...prev];
            const last = arr[arr.length - 1];
            const toolResults = { ...(last.toolResults || {}), [ev.data.tool_use_id]: ev.data };
            arr[arr.length - 1] = { ...last, toolResults };
            return arr;
          });
        }
        else if (ev.event === 'error') {
          setMessages(prev => {
            const arr = [...prev];
            const last = arr[arr.length - 1];
            arr[arr.length - 1] = { ...last, text: (last.text || '') + `\n\n⚠ ${ev.data.message}` };
            return arr;
          });
        }
        else if (ev.event === 'done') {
          // refresh thread list to surface the new one
          loadThreads();
        }
      }
    } catch (e) {
      setMessages(prev => {
        const arr = [...prev];
        arr[arr.length - 1] = { ...arr[arr.length - 1], text: '⚠ ' + e.message };
        return arr;
      });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // ── render ───────────────────────────────────────────────
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', height: '100vh', fontFamily: FONT_SANS, color: T.ink, background: T.bg }}>
      {/* Sidebar */}
      <aside style={{ background: T.panel, borderRight: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, background: T.accent, color: '#fff', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 }}>S</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Sentinel</div>
            <div style={{ fontSize: 11, color: T.inkSubtle }}>{tenant?.display_name || tenant?.name || '—'}</div>
          </div>
        </div>
        <button onClick={newChat} style={{ margin: '12px 12px 8px', padding: '8px 12px', background: '#fff', border: `1px solid ${T.border}`, fontSize: 13, fontFamily: FONT_SANS, cursor: 'pointer', textAlign: 'left', color: T.ink }}>
          + New chat
        </button>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {threads.length === 0 && (
            <div style={{ padding: 14, fontSize: 12, color: T.inkSubtle }}>No conversations yet</div>
          )}
          {threads.map(t => (
            <ThreadRow key={t.id} thread={t} active={activeId === t.id} onClick={() => loadThread(t.id)} />
          ))}
        </div>
        {/* AI toggle — operator can disable LLM calls for cost / safety */}
        <div style={{ padding: '12px 16px', borderTop: `1px solid ${T.border}`, fontSize: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 600, color: T.ink }}>AI {aiEnabled ? 'ON' : 'OFF'}</span>
              <span style={{ color: T.inkSubtle, fontSize: 11 }}>
                {aiEnabled ? 'Claude is answering' : 'Composer disabled'}
              </span>
            </span>
            {/* iOS-style switch */}
            <span onClick={() => toggleAi(!aiEnabled)} style={{
              width: 36, height: 20, background: aiEnabled ? T.accent : '#c8c5be',
              borderRadius: 999, position: 'relative', transition: 'background 120ms',
              flexShrink: 0,
            }}>
              <span style={{
                position: 'absolute', top: 2, left: aiEnabled ? 18 : 2, width: 16, height: 16,
                background: '#fff', borderRadius: 999, transition: 'left 120ms',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </span>
          </label>
        </div>

        <div style={{ padding: 14, borderTop: `1px solid ${T.border}`, fontSize: 12, color: T.inkMuted, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{user?.email || ''}</span>
          <button onClick={logout} style={{ background: 'transparent', border: 'none', color: T.accent, cursor: 'pointer', fontSize: 12, padding: 0 }}>Logout</button>
        </div>
      </aside>

      {/* Main chat */}
      <main style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <div ref={scroller} style={{ flex: 1, overflow: 'auto', padding: '32px 40px 120px' }}>
          {messages.length === 0 ? (
            <div style={{ maxWidth: 720, margin: '60px auto 0', textAlign: 'center' }}>
              <div style={{ fontSize: 26, fontWeight: 600, marginBottom: 8 }}>How can I help you today?</div>
              <div style={{ color: T.inkMuted, fontSize: 14, marginBottom: 32 }}>
                I can query alarms, search devices, look up tickets, and route messages across Slack / Teams / SMS for your tenant.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, maxWidth: 700, margin: '0 auto' }}>
                {[
                  '오늘 P1 알람 요약해줘',
                  'HAEA UPS 배터리 부족 디바이스 보여줘',
                  '미해결 P2 티켓 5개 보여줘',
                  '최근 1시간 동안 발생한 알람만 보여줘',
                ].map(p => (
                  <button key={p} onClick={() => setInput(p)} style={{
                    padding: '12px 14px', textAlign: 'left', background: T.panel,
                    border: `1px solid ${T.border}`, fontSize: 13, fontFamily: FONT_SANS,
                    color: T.ink, cursor: 'pointer',
                  }}>{p}</button>
                ))}
              </div>
            </div>
          ) : messages.map((m, i) => (
            <div key={i} style={{ maxWidth: 780, margin: '0 auto 24px' }}>
              {m.role === 'user' ? (
                <div style={{ background: T.accentSoft, padding: '12px 16px', borderRadius: 4, fontSize: 14 }}>
                  {m.text}
                </div>
              ) : (
                <div style={{ fontSize: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12, color: T.inkSubtle, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                    <span style={{ width: 18, height: 18, background: T.accent, color: '#fff', borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>S</span>
                    Sentinel
                  </div>
                  {(m.toolCalls || []).map(call => (
                    <ToolCard key={call.id} call={call} result={m.toolResults?.[call.id]} />
                  ))}
                  <MD text={m.text} />
                  {busy && i === messages.length - 1 && !m.text && (
                    <div style={{ color: T.inkSubtle, fontSize: 13 }}>thinking…</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Composer */}
        <div style={{ borderTop: `1px solid ${T.border}`, padding: '14px 40px 18px', background: T.bg }}>
          <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', alignItems: 'flex-end', gap: 10,
                        background: aiEnabled ? '#fff' : '#f4f1ec',
                        border: `1px solid ${aiEnabled ? T.border : '#c66432aa'}`, padding: 8,
                        opacity: aiEnabled ? 1 : 0.7 }}>
            <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKeyDown}
              disabled={busy || !aiEnabled}
              placeholder={aiEnabled ? "Ask Sentinel — e.g. 'HAEA P1 알람 요약해줘'" : 'AI is OFF — toggle it on in the sidebar'}
              style={{ flex: 1, border: 'none', resize: 'none', outline: 'none', fontFamily: FONT_SANS,
                       fontSize: 14, padding: '6px 8px', minHeight: 24, maxHeight: 140,
                       background: 'transparent', color: T.ink }} rows={1} />
            <button onClick={send} disabled={busy || !input.trim() || !aiEnabled}
              style={{ background: input.trim() && !busy && aiEnabled ? T.accent : T.border, color: '#fff',
                       border: 'none', padding: '8px 14px', cursor: busy || !input.trim() || !aiEnabled ? 'not-allowed' : 'pointer',
                       fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600 }}>
              {busy ? '…' : 'Send'}
            </button>
          </div>
          <div style={{ maxWidth: 780, margin: '6px auto 0', fontSize: 11, color: T.inkSubtle, textAlign: 'center' }}>
            {aiEnabled
              ? 'Sentinel can make mistakes — verify before taking destructive actions.'
              : 'AI is currently disabled. No LLM calls will be made until you turn it back on.'}
          </div>
        </div>
      </main>
    </div>
  );
}
