import '@fontsource/ibm-plex-sans/300.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import Fms from './pages/Fms.jsx';

// The Local Console answers 401 when the session cookie is missing or expired;
// send the browser to its server-rendered login page instead of a blank screen.
if (import.meta.env.VITE_CONSOLE_PROFILE === 'internal') {
  const _fetch = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const res = await _fetch(...a);
    const url = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
    if (res.status === 401 && url.includes('/v1/') && !url.includes('/v1/auth/')) window.location.replace('/login');
    return res;
  };
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename="/fms">
      <Fms />
    </BrowserRouter>
  </React.StrictMode>
);
