// Mirrors frontend/src/pages/Fms.jsx tokens exactly (lines 19, 37-48). Do not restyle.
export const FONT = '"IBM Plex Sans","Helvetica Neue",Arial,sans-serif';
export const C = {
  primary: '#0f62fe', primarySoft: '#edf5ff',
  ok: '#24a148', okSoft: '#defbe6',
  warn: '#f1c21b', warnSoft: '#fff8e1',
  critical: '#da1e28', criticalSoft: '#fff1f1',
  ink: '#161616', inkMuted: '#525252', inkSubtle: '#8d8d8d',
  bg: '#f4f4f4', card: '#ffffff', hairline: '#e0e0e0',
  navBg: '#161616', navText: '#c6c6c6',
};
export const lang = () => (localStorage.getItem('lang') === 'en' ? 'en' : 'ko');
export const tx = (ko, en) => (lang() === 'en' ? en : ko);
export const STATUS = {
  ok: { color: C.ok, label: () => tx('정상', 'OK') },
  warn: { color: C.warn, label: () => tx('경고', 'WARN') },
  critical: { color: C.critical, label: () => tx('위험', 'CRITICAL') },
  unreachable: { color: '#8d8d8d', label: () => tx('데이터없음', 'NO DATA') },
  nodata: { color: '#8d8d8d', label: () => tx('데이터없음', 'NO DATA') },
  unknown: { color: '#8d8d8d', label: () => tx('데이터없음', 'NO DATA') },
};
export const SEV = { P1: C.critical, P2: C.warn, P3: C.primary, P4: '#8d8d8d' };
export const token = () => localStorage.getItem('cflex_token') || localStorage.getItem('token') || '';
export async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(opts.headers || {}) } });
  try { return await r.json(); } catch { return { ok: false }; }
}
export const cbu = () => localStorage.getItem('fms_cbu') || 'all';
export const withCbu = (q = '') => { const c = cbu(); if (c === 'all') return q; return q ? `${q}&cbu=${c}` : `?cbu=${c}`; };
