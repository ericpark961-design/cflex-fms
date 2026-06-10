// ============================================================
// Login — IBM Carbon Design (white canvas, Plex 300 hero, square inputs)
// ============================================================
import React, { useState } from 'react';
import { useNavigate, Navigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTranslation } from 'react-i18next';

const IBM = {
  blue: '#0f62fe', blueHover: '#0050e6', blue60: '#0043ce',
  ink: '#161616', inkMuted: '#525252', inkSubtle: '#8c8c8c',
  canvas: '#ffffff', surface1: '#f4f4f4', surface2: '#e0e0e0',
  hairline: '#e0e0e0', error: '#da1e28',
};
const FONT = "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif";

export default function Login() {
  const { t } = useTranslation();
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Where ProtectedRoute redirected us from; preserve so we can return after login.
  const from = location.state && location.state.from ? location.state.from : null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailFocus, setEmailFocus] = useState(false);
  const [pwFocus, setPwFocus] = useState(false);

  // Surface any M365 callback error (?m365_error=...) at the top of the form
  const m365Error = React.useMemo(() => {
    try {
      const p = new URLSearchParams(location.search);
      return p.get('m365_error');
    } catch { return null; }
  }, [location.search]);
  React.useEffect(() => { if (m365Error) setError(m365Error); }, [m365Error]);

  // Domain-based auto-redirect to M365: when user types email@domain and
  // tabs out, if our backend recognizes the domain we kick off OAuth.
  const tryM365 = () => {
    const dom = (email.split('@')[1] || '').toLowerCase();
    if (!dom) return;
    window.location.href = `/v1/auth/m365/login?domain=${encodeURIComponent(dom)}`;
  };

  if (user) return <Navigate to={from || '/'} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const r = await login(email, password);
      // Tenant-aware landing: prefer tenant.enabled_modules[0] → module URL,
      // fall back to role-based or '/'. Server may also send landingRoute hint.
      const u = r?.user || {};
      const t = r?.tenant || null;
      const role = u.role || '';
      const ROLE_MAP = { noc_operator: '/sentinel' };
      const MODS = { fms: '/fms', sentinel: '/sentinel', dealer: '/dealer', facility: '/facility',
                     tickets: '/tickets', sla: '/sla', billing: '/billing', voice_ops: '/voice-ops',
                     voice_workflow: '/voice-workflow', insights: '/insights', home: '/home',
                     ups: '/facility', network: '/facility', sbc: '/facility', teams: '/teams-phone' };
      let dest = null;
      if (role.startsWith('fms_')) dest = '/fms';
      else if (ROLE_MAP[role]) dest = ROLE_MAP[role];
      else if (role.startsWith('dealer_')) dest = role === 'dealer_sales' || role === 'dealer_tech' ? '/tickets' : '/dealer';
      else {
        let mods = t?.skus || t?.sku || t?.enabled_modules;
        if (typeof mods === 'string') { try { mods = JSON.parse(mods); } catch { mods = []; } }
        if (Array.isArray(mods) && mods.length > 0 && MODS[String(mods[0]).toLowerCase()]) {
          dest = MODS[String(mods[0]).toLowerCase()];
        }
      }
      if (!dest) dest = (role === 'super_admin' || role === 'admin' || role === 'oem_admin' || role === 'engineer') ? '/' : '/home';

      // ── Cross-domain portal routing ────────────────────────────────
      // Rule: each persona has its own portal subdomain. Admin-class
      // roles (super/admin/oem_admin/engineer) stay on cflex.runless.co.uk
      // because they need cross-module access. Everyone else is shipped
      // to the portal that matches their persona.
      const isAdminClass = role === 'super_admin' || role === 'admin' || role === 'oem_admin' || role === 'engineer';
      let portalHost = null;
      if (!isAdminClass) {
        if (role.startsWith('fms_')) portalHost = 'fms.runless.co.uk';
        else if (role === 'noc_operator') portalHost = 'sentinel.runless.co.uk';
        else if (role.startsWith('dealer_')) portalHost = 'dealer.runless.co.uk';
        else {
          // Tenant-driven for customer_admin/viewer — match SKU family
          let mods = t?.skus || t?.sku;
          if (typeof mods === 'string') { try { mods = JSON.parse(mods); } catch { mods = []; } }
          if (!Array.isArray(mods)) mods = [];
          const lc = mods.map(m => String(m).toLowerCase());
          if (lc.some(m => m === 'sentinel' || m === 'ebond' || m === 'sentinel-connect' || m === 'sc')) portalHost = 'sentinel.runless.co.uk';
          else if (lc.some(m => m === 'fms' || m === 'ups' || m === 'network' || m === 'sbc')) portalHost = 'fms.runless.co.uk';
        }
      }

      // If a portal mapping exists AND we are not already on that host AND
      // ProtectedRoute did not capture a specific `from` location, do a
      // top-level navigation (cross-origin).
      if (portalHost && window.location.host !== portalHost && !from) {
        window.location.href = 'https://' + portalHost + dest;
        return;
      }
      navigate(from || dest);
    }
    catch (err) { setError(err.response?.data?.error || 'Login failed'); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: '1.2fr 1fr', fontFamily: FONT, color: IBM.ink, letterSpacing: '0.16px' }}>
      {/* Left — IBM hero panel */}
      <div style={{ background: IBM.canvas, padding: '64px 80px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderRight: `1px solid ${IBM.hairline}` }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 64 }}>
            <div style={{ width: 32, height: 32, background: IBM.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 16 }}>C</div>
            <span style={{ fontSize: 14, fontWeight: 600 }}>cflex — Sentinel connect</span>
            <span style={{ fontSize: 12, color: IBM.inkSubtle, marginLeft: 8 }}>by RingOn Service</span>
          </div>
          <div style={{ fontSize: 14, color: IBM.inkMuted, marginBottom: 16 }}>Runless Orchestrator</div>
          <h1 style={{ fontSize: 60, fontWeight: 300, lineHeight: 1.17, letterSpacing: '-0.4px', color: IBM.ink, margin: 0, maxWidth: 520 }}>
            {t('login.heading')}
          </h1>
          <p style={{ fontSize: 18, color: IBM.inkMuted, lineHeight: 1.5, margin: '32px 0 0', maxWidth: 480 }}>
            {t('login.subtitle')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 24, fontSize: 12, color: IBM.inkSubtle }}>
          <Link to="/welcome" style={{ color: IBM.blue, textDecoration: 'none', fontWeight: 600 }}>{t('login.learn_more')}</Link>
          <span>© 2026 RingOn Service Corp.</span>
        </div>
      </div>

      {/* Right — form panel */}
      <div style={{ background: IBM.surface1, padding: '64px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ maxWidth: 400 }}>
          <div style={{ fontSize: 12, color: IBM.inkSubtle, marginBottom: 8, fontFamily: 'IBM Plex Mono, monospace' }}>cflex.runless.co.uk</div>
          <h2 style={{ fontSize: 32, fontWeight: 400, lineHeight: 1.25, color: IBM.ink, margin: '0 0 32px' }}>
            {t('common.sign_in')}
          </h2>

          {error && (
            <div style={{ padding: '12px 16px', background: '#fff1f1', borderLeft: `3px solid ${IBM.error}`, color: IBM.error, fontSize: 14, marginBottom: 16 }}>
              ⚠ {error}
            </div>
          )}

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <CarbonField label={t('login.email')} focused={emailFocus}>
              <input
                type="email" required value={email} onChange={e => setEmail(e.target.value)}
                onFocus={() => setEmailFocus(true)} onBlur={() => setEmailFocus(false)}
                style={inputStyle(emailFocus)} placeholder="you@company.com" />
            </CarbonField>

            <CarbonField label={t('login.password')} focused={pwFocus}>
              <input
                type="password" required value={password} onChange={e => setPassword(e.target.value)}
                onFocus={() => setPwFocus(true)} onBlur={() => setPwFocus(false)}
                style={inputStyle(pwFocus)} placeholder="" />
            </CarbonField>

            <button type="submit" disabled={loading || !email || !password}
              style={{ background: IBM.blue, color: 'white', border: 'none', padding: '14px 32px', fontSize: 14, fontWeight: 400, fontFamily: FONT, cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: loading || !email || !password ? 0.5 : 1 }}
              onMouseOver={e => !loading && (e.currentTarget.style.background = IBM.blueHover)}
              onMouseOut={e => (e.currentTarget.style.background = IBM.blue)}>
              <span>{loading ? t('login.signing_in') : t('login.continue')}</span>
              <span>→</span>
            </button>
          </form>

          {/* ── Sign in with Microsoft ─────────────────────────────── */}
          <div style={{ marginTop: 18, paddingTop: 18, borderTop: `1px solid ${IBM.hairline}` }}>
            <div style={{ fontSize: 11, color: IBM.inkMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
              {t('login.or') || 'Or'}
            </div>
            <button type="button" onClick={tryM365} disabled={!email}
              title={!email ? 'Enter your work email first' : 'Sign in with your Microsoft 365 account'}
              style={{ width: '100%', background: '#fff', color: '#161616', border: '1px solid #c6c6c6',
                       padding: '12px 16px', fontSize: 14, fontFamily: FONT,
                       cursor: !email ? 'not-allowed' : 'pointer', display: 'flex',
                       alignItems: 'center', justifyContent: 'center', gap: 10,
                       opacity: !email ? 0.55 : 1 }}>
              <svg width="18" height="18" viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <rect x="1" y="1"  width="10" height="10" fill="#f25022"/>
                <rect x="12" y="1" width="10" height="10" fill="#7fba00"/>
                <rect x="1" y="12" width="10" height="10" fill="#00a4ef"/>
                <rect x="12" y="12" width="10" height="10" fill="#ffb900"/>
              </svg>
              <span>Sign in with Microsoft</span>
            </button>
            <div style={{ fontSize: 11, color: IBM.inkSubtle, marginTop: 6, lineHeight: 1.5 }}>
              {t('login.m365_hint') || 'Your tenant must have connected Microsoft 365 via Admin → M365 SSO first.'}
            </div>
          </div>

          {import.meta.env.VITE_ENABLE_DEMO_ACCOUNTS === 'true' && (
            <div style={{ marginTop: 32, paddingTop: 24, borderTop: `1px solid ${IBM.hairline}` }}>
              <div style={{ fontSize: 12, color: IBM.inkMuted, marginBottom: 8 }}>{t('login.demo_accounts')}</div>
              {[
                { email: 'admin@runless.io', label: 'Super Admin' },
                { email: 'htl-admin@hyundai.com', label: 'Customer (HTL)' },
                { email: 'engineer@runless.io', label: 'Engineer' },
              ].map(d => (
                <button key={d.email} type="button"
                  onClick={() => { setEmail(d.email); setPassword('cflex2026'); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '8px 0', fontSize: 13, color: IBM.ink, cursor: 'pointer', borderBottom: `1px solid ${IBM.hairline}` }}>
                  <span style={{ fontWeight: 600 }}>{d.label}</span>
                  <span style={{ color: IBM.inkSubtle, marginLeft: 8, fontFamily: 'IBM Plex Mono, monospace' }}>{d.email}</span>
                </button>
              ))}
            </div>
          )}

          <div style={{ marginTop: 32, fontSize: 12, color: IBM.inkSubtle }}>
            Need access? Contact <a href="mailto:eric@ringonservice.net" style={{ color: IBM.blue, textDecoration: 'none' }}>eric@ringonservice.net</a>
          </div>
        </div>
      </div>
    </div>
  );
}

function CarbonField({ label, focused, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 12, color: '#525252', marginBottom: 6, fontWeight: 400, letterSpacing: '0.32px' }}>{label}</div>
      {children}
    </label>
  );
}

function inputStyle(focused) {
  return {
    width: '100%',
    padding: '11px 16px',
    background: '#ffffff',
    color: IBM.ink,
    border: 'none',
    borderBottom: focused ? `2px solid ${IBM.blue}` : `1px solid ${IBM.ink}`,
    fontSize: 16,
    fontFamily: FONT,
    letterSpacing: '0.16px',
    outline: 'none',
    transition: 'border-bottom 0.15s',
    borderRadius: 0,
  };
}
