import './index.css';
import './i18n';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/index.css';

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
