import './index.css';
import './i18n';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/index.css';

// 앱 부팅 시 1회 설치. 모든 raw fetch의 401/403을 한 곳에서 처리.
// FMS/Sentinel/cflex shell 전 portals 공통 — /v1/* 응답이 401/403이면 토큰을
// 즉시 비우고 /login으로 hard redirect (재시도 루프 방지).
const _fetch = window.fetch;
window.fetch = async (...a) => {
  const res = await _fetch(...a);
  try {
    const url = typeof a[0] === 'string' ? a[0] : (a[0]?.url || '');
    if ((res.status === 401 || res.status === 403) && url.includes('/v1/')) {
      ['cflex_token', 'cflex_user', 'cflex_tenant'].forEach(k => localStorage.removeItem(k));
      if (!location.pathname.startsWith('/login')) location.replace('/login');
    }
  } catch {}
  return res;
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);


// Service-worker registration disabled — the previous PWA SW cached old
// bundles and confused the routing migration. We actively unregister any
// existing registration on every visit so stale clients self-heal on the
// next page load. Re-enable via vite-plugin-pwa once routing is stable.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(regs => regs.forEach(r => r.unregister().catch(() => {})))
    .catch(() => {});
  if (typeof caches !== 'undefined') {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k).catch(() => {}))).catch(() => {});
  }
}
