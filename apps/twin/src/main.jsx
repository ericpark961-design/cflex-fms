import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { lang } from './theme'
// Keep <html lang> in step with the tx()/t() language.
document.documentElement.lang = lang();
const _fetch = window.fetch.bind(window);
window.fetch = async (...a) => {
  const r = await _fetch(...a);
  try { const url = typeof a[0] === 'string' ? a[0] : a[0]?.url || '';
    if ((r.status === 401 || r.status === 403) && url.includes('/v1/') && !location.pathname.startsWith('/login')) { ['cflex_token', 'cflex_user', 'cflex_tenant'].forEach(k => localStorage.removeItem(k)); location.replace('/login'); } } catch {}
  return r;
};
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
