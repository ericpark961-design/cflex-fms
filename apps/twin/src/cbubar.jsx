// The global CBU (site) selector.
//
// It used to live in Main.tpl.html only, so every other screen showed whatever
// site the last page happened to resolve — the dashboard said HMA while the
// device list said everything. There is now exactly one implementation, mounted
// into every screen (template and React alike) from here, reading and writing
// the single `fms_cbu` key that `withCbu()` already appends to every request.
import { useEffect, useRef } from 'react';
import { cbu as getCbu } from './theme';
import { cbus, refresh } from './data';
import { t } from './i18n';

const BTN = 'border:0;border-left:1px solid #393939;padding:6px 11px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap';

/** Build the bar. `onChange` fires after the new scope has been fetched. */
export function cbuBarEl(onChange, { compact = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'cbu-bar';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', t('CBU 필터'));
  wrap.style.cssText = `display:flex;border:1px solid #393939;flex:0 0 auto;${compact ? 'background:rgba(11,16,26,.6)' : ''}`;
  for (const c of cbus()) {
    const b = document.createElement('button');
    b.className = 'ghost cbu-btn';
    b.dataset.cbu = c.cbu;
    b.type = 'button';
    b.style.cssText = `${BTN};background:${c.bg};color:${c.fg}`;
    b.setAttribute('aria-pressed', String(c.cbu === getCbu()));
    // The summary COALESCEs a NULL cbu to 'unknown', but the server filters with
    // `AND cbu=?`, which no NULL row can match — picking it would empty every
    // screen. Shown with its real count (it is part of 전체) and disabled until
    // the filter is COALESCE-aware.
    const unassigned = c.cbu === 'unknown';
    if (unassigned) {
      b.disabled = true;
      b.style.cssText += ';opacity:.45;cursor:not-allowed';
      b.title = t('서버 필터가 미지정 CBU를 아직 지원하지 않습니다');
    }
    const label = document.createElement('span');
    label.textContent = c.cbu === 'all' ? t('전체') : unassigned ? t('미지정') : c.label;
    b.appendChild(label);
    if (c.total !== '' && c.total != null) {
      const n = document.createElement('span');
      n.className = 'mono';
      n.style.cssText = 'color:#8d8d8d;margin-left:5px';
      n.textContent = c.total;
      b.appendChild(n);
    }
    if (c.crit) {
      const k = document.createElement('span');
      k.style.cssText = 'color:#ff8389;font-weight:700;margin-left:4px';
      k.textContent = c.crit;
      b.appendChild(k);
    }
    b.addEventListener('click', async () => {
      if (c.cbu === getCbu() || b.disabled) return;
      localStorage.setItem('fms_cbu', c.cbu);
      wrap.querySelectorAll('.cbu-btn').forEach(x => { x.disabled = true; x.style.opacity = '.5'; });
      // An explicit ?cbu= in the URL would otherwise outrank the new choice.
      if (/[?&]cbu=/.test(location.hash)) location.hash = location.hash.replace(/([?&])cbu=[^&]*&?/, '$1').replace(/[?&]$/, '');
      await refresh().catch(() => {});
      onChange?.(c.cbu);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

/**
 * Put the bar in a rendered screen. Every sidebar template opens `<main>` with a
 * topbar row; the NOC wall has a `<header>` instead. Idempotent — re-running on
 * a re-rendered screen replaces the old bar rather than stacking a second one.
 */
export function mountCbuBar(root, onChange) {
  if (!root) return;
  root.querySelectorAll('.cbu-bar').forEach(n => n.remove());
  const host = root.querySelector('main > div') || root.querySelector('header') || root.firstElementChild;
  if (!host) return;
  const bar = cbuBarEl(onChange, { compact: !root.querySelector('main') });
  // Sit before the trailing LIVE / language group so the row reads
  // search → sites → status on every screen.
  const tail = Array.from(host.children).find(c => /margin-left:\s*auto/.test(c.getAttribute('style') || ''));
  if (tail) host.insertBefore(bar, tail); else host.appendChild(bar);
  return bar;
}

/** The same bar for the React screens (map, twin, wall), which have no template. */
export function CbuBar({ onChange, compact = false, style }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.replaceChildren(cbuBarEl(onChange, { compact }));
  });
  return <div ref={ref} style={{ display: 'flex', ...style }} />;
}
