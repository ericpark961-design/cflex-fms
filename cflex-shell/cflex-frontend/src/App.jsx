import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { LayoutDashboard, Ticket, CreditCard, Network, LogOut, Zap, Phone, Settings as SettingsIcon, Mic, Building2, BookOpen, ShieldCheck, Headphones, Users as UsersIcon, GitBranch, Sparkles, Home, Shield, Megaphone } from 'lucide-react';
import { AuthProvider, useAuth } from './hooks/useAuth';
import NocChat from './components/NocChat';
import { useTranslation } from 'react-i18next';

import Login from './pages/Login';
import Welcome from './pages/Welcome';
import Dashboard from './pages/Dashboard';
import Tickets from './pages/Tickets';
import Billing from './pages/Billing';
import Topology from './pages/Topology';
import TeamsPhone from './pages/TeamsPhone';
import Settings from './pages/Settings';
import VoiceApps from './pages/VoiceApps';
import Onboarding from './pages/Onboarding';
import Runbooks from './pages/Runbooks';
import Sla from './pages/Sla';
import Facility from './pages/Facility';
import HomeModule from './pages/HomeModule';
import AdminModule from './pages/AdminModule';
import RelationshipsModule from './pages/RelationshipsModule';
import VoiceWorkflowModule from './pages/VoiceWorkflowModule';
import InsightsModule from './pages/InsightsModule';
import VoiceOpsModule from './pages/VoiceOps';
import DealerPortal from './pages/DealerPortal';
import MarketingModule from './pages/MarketingModule';
import Fms from './pages/Fms';
import M365SsoPage from './pages/M365SsoPage';
import Sentinel from './pages/Sentinel';
// UpsOnboarding is rendered from inside the Tenant Onboarding page (not a separate route)
import GlobalTicketModal from './components/GlobalTicketModal';
import SlaTenantModal from './components/SlaTenantModal';
import ErrorBoundary from './components/ErrorBoundary';
import SubscriptionModal from './components/SubscriptionModal';
import WorkflowItemModal from './components/WorkflowItemModal';

// Facility route branches by persona — RingOn-internal sees honeycomb Dashboard, customer sees simple UPS sites
function FacilityRoute() {
  const { user } = useAuth();
  if (user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'engineer') {
    return <Dashboard />;
  }
  return <Facility />;
}

// Persona/SKU resolution from /v1/me — shared across module wrappers
function usePersonaInfo() {
  const [info, setInfo] = useState({ persona: null, skus: [], tenant: null });
  useEffect(() => {
    const tok = localStorage.getItem('cflex_token');
    if (!tok) return;
    fetch('/v1/me', { headers: { Authorization: `Bearer ${tok}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setInfo({ persona: d.persona, skus: d.sku || d.tenant?.skus || [], tenant: d.tenant || null }); })
      .catch(() => {});
  }, []);
  return info;
}

// Wrappers: pull token + user + navigation, pass to ported dev modules
function HomeRoute() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const token = localStorage.getItem('cflex_token');
  return <HomeModule token={token} user={user} onModuleSelect={(m) => {
    const map = { 'cflex.tickets': '/tickets', 'cflex.facility': '/facility', 'cflex.sla': '/sla', 'cflex.billing': '/billing', 'cflex.voice.ops': '/voice-ops', 'cflex.relationships': '/relationships', 'cflex.voice.workflow': '/voice-workflow', 'cflex.insights': '/insights', 'cflex.admin': '/admin' };
    if (map[m]) navigate(map[m]);
  }} />;
}
function AdminModuleRoute() {
  const token = localStorage.getItem('cflex_token');
  return <AdminModule token={token} />;
}
function RelationshipsRoute() {
  const token = localStorage.getItem('cflex_token');
  return <RelationshipsModule token={token} />;
}
function VoiceWorkflowRoute() {
  const { persona } = usePersonaInfo();
  const { user } = useAuth();
  const token = localStorage.getItem('cflex_token');
  return <VoiceWorkflowModule token={token} persona={persona} userUpn={user?.upn || user?.email} />;
}
function InsightsRoute() {
  const token = localStorage.getItem('cflex_token');
  return <InsightsModule token={token} />;
}
function VoiceOpsRoute() {
  const { persona } = usePersonaInfo();
  const token = localStorage.getItem('cflex_token');
  return <VoiceOpsModule token={token} persona={persona} />;
}
function DealerPortalRoute() {
  const { user } = useAuth();
  const token = localStorage.getItem('cflex_token');
  return <DealerPortal token={token} user={user} />;
}
function MarketingRoute() {
  const { user } = useAuth();
  const token = localStorage.getItem('cflex_token');
  return <MarketingModule token={token} user={user} />;
}

// Iframe to dev (cflex-monorepo) modules — DEPRECATED, kept for reference; native modules now used
function IframeModule({ moduleId, title }) {
  const token = localStorage.getItem('cflex_token') || '';
  const src = `https://dev.cflex.runless.co.uk/?token=${encodeURIComponent(token)}&embed=1#module=${encodeURIComponent(moduleId)}`;
  return (
    <div style={{ height: 'calc(100vh - 16px)', display: 'flex', flexDirection: 'column' }}>
      <iframe
        src={src}
        title={title}
        style={{ flex: 1, border: 'none', width: '100%', background: '#fff' }}
        allow="clipboard-write; clipboard-read"
      />
    </div>
  );
}

// ── Default landing per user/tenant ──────────────────────────────
// 1) Role override wins (fms_* / noc_operator / dealer_*)
// 2) Otherwise pick the tenant's primary enabled module → `/<module>`
// 3) Fallback to `/` (NOC shell dashboard)
const MODULE_TO_PATH = {
  fms: '/fms', sentinel: '/sentinel', dealer: '/dealer', ebond: '/sentinel',
  ipilot: '/teams-phone',
  facility: '/facility', tickets: '/tickets', sla: '/sla', billing: '/billing',
  voice_ops: '/voice-ops', voice_workflow: '/voice-workflow', insights: '/insights',
  home: '/home',
  // Legacy SKU aliases
  ups: '/facility', network: '/facility', sbc: '/facility', teams: '/teams-phone',
};
function defaultLandingFor(user, tenant) {
  const role = user?.role || '';
  // Role overrides win over tenant SKU for explicit personas
  if (role.startsWith('fms_')) return '/fms';
  if (role === 'noc_operator') return '/sentinel';
  if (role.startsWith('dealer_')) return role === 'dealer_sales' || role === 'dealer_tech' ? '/tickets' : '/dealer';
  // Internal admin roles always go to the NOC shell regardless of tenant SKU
  if (role === 'super_admin' || role === 'admin' || role === 'oem_admin' || role === 'engineer') return '/';
  // Tenant-driven: SKU list acts as the enabled-modules list
  let mods = tenant?.skus || tenant?.sku || tenant?.enabled_modules;
  if (typeof mods === 'string') { try { mods = JSON.parse(mods); } catch { mods = []; } }
  if (Array.isArray(mods) && mods.length > 0) {
    const first = String(mods[0]).toLowerCase();
    if (MODULE_TO_PATH[first]) return MODULE_TO_PATH[first];
  }
  // No matching route — fall back to "/" (NOC shell). Returning "/home" used
  // to cause an SPA navigation loop because /home isn't a registered route.
  return '/';
}

function RootRedirectOrShell() {
  const { user, tenant } = useAuth();
  let cachedTenant = tenant;
  if (!cachedTenant) {
    try { cachedTenant = JSON.parse(localStorage.getItem('cflex_tenant') || 'null'); } catch {}
  }
  const dest = defaultLandingFor(user, cachedTenant);
  if (dest && dest !== '/') return <Navigate to={dest} replace />;
  return <Shell><Dashboard /></Shell>;
}

// Map each non-admin persona to its dedicated portal subdomain.
// Admin-class roles return null because they may stay on any host.
function portalHostForUser(user, tenant) {
  const role = user?.role || '';
  if (role === 'super_admin' || role === 'admin' || role === 'oem_admin' || role === 'engineer') return null;
  if (role.startsWith('fms_')) return 'fms.runless.co.uk';
  if (role === 'noc_operator') return 'sentinel.runless.co.uk';
  if (role.startsWith('dealer_')) return 'dealer.runless.co.uk';
  let mods = tenant?.skus || tenant?.sku;
  if (typeof mods === 'string') { try { mods = JSON.parse(mods); } catch { mods = []; } }
  if (!Array.isArray(mods)) mods = [];
  const lc = mods.map(m => String(m).toLowerCase());
  // Sentinel SKUs (multichannel inbox + ebond) → sentinel portal
  if (lc.some(m => m === 'sentinel' || m === 'ebond' || m === 'sentinel-connect' || m === 'sc')) return 'sentinel.runless.co.uk';
  // FMS family SKUs → fms portal
  if (lc.some(m => m === 'fms' || m === 'ups' || m === 'network' || m === 'sbc')) return 'fms.runless.co.uk';
  // iPilot family (Teams Phone / Voice Ops) stays on cflex shell for now
  if (lc.some(m => m === 'ipilot' || m === 'teams' || m === 'teams-phone' || m === 'voice_ops')) return null;
  return null;
}

// /auth/m365/complete — backend redirects here with `#token=<jwt>` after a
// successful M365 sign-in. We parse the fragment, store the token + a minimal
// user envelope, then re-hydrate via /v1/me so the rest of the app sees a
// normal logged-in state.
function M365Complete() {
  const navigate = useNavigate();
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    let token = null;
    try {
      const h = (window.location.hash || '').replace(/^#/, '');
      const p = new URLSearchParams(h);
      token = p.get('token');
    } catch {}
    if (!token) { setError('Missing token in callback URL'); return; }
    localStorage.setItem('cflex_token', token);
    fetch('/v1/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`/v1/me ${r.status}`)))
      .then(d => {
        const user = { id: d.userId, email: d.email, name: d.displayName, role: d.role,
                       tenantId: d.tenantId, tenantName: d.tenantName };
        localStorage.setItem('cflex_user', JSON.stringify(user));
        if (d.tenant) localStorage.setItem('cflex_tenant', JSON.stringify(d.tenant));
        // Hard reload so AuthProvider re-reads localStorage on first paint
        const dest = d.landingRoute || '/';
        window.location.replace(dest);
      })
      .catch(e => setError(e.message));
  }, []);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'IBM Plex Sans, sans-serif', background: '#f4f4f4' }}>
      <div style={{ textAlign: 'center', color: '#525252' }}>
        {error ? (
          <>
            <div style={{ color: '#da1e28', fontWeight: 600, marginBottom: 8 }}>Sign-in failed</div>
            <div style={{ fontSize: 13 }}>{error}</div>
            <button onClick={() => navigate('/login')} style={{ marginTop: 16, padding: '8px 18px',
                    background: '#0f62fe', color: '#fff', border: 'none', cursor: 'pointer' }}>
              Back to login
            </button>
          </>
        ) : (
          <div>Completing Microsoft sign-in…</div>
        )}
      </div>
    </div>
  );
}

function ProtectedRoute({ children, path }) {
  const { user, tenant, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{background:'#f4f4f4'}}>
        <div style={{color:'#525252'}}>Loading...</div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  // Cross-domain portal enforcement moved to Login.jsx (one-shot at sign-in).
  // Once authenticated, users stay on whichever host they explicitly typed —
  // no auto-redirect, no browser navigation throttling. Role/SKU access is
  // still gated below via ROLE_ALLOWED.
  // Hotfix: identity 서비스가 dealer_sales/tech를 모두 dealer_staff 로 묶어 보냄. email 기반으로 정확히 분기.
  const effectiveRole = (user.role === 'dealer_staff' || user.role === 'customer_user')
    ? (user.email === 'irvine.sales@kia.com' ? 'dealer_sales'
       : user.email === 'irvine.tech@kia.com'  ? 'dealer_tech'
       : user.role)
    : user.role;
  // Customer roles are restricted to allowed paths
  const ROLE_ALLOWED = {
    super_admin:     ['*'],
    admin:           ['*'],
    engineer:        ['/', '/facility', '/home', '/tickets', '/teams-phone', '/voice-apps', '/billing', '/sla', '/topology', '/runbooks', '/voice-ops', '/insights', '/onboarding'],
    customer_admin:  ['/', '/fms', '/sentinel', '/admin/sso', '/facility', '/home', '/tickets', '/teams-phone', '/voice-apps', '/billing', '/sla', '/voice-ops'],
    customer_viewer: ['/', '/fms', '/sentinel', '/facility', '/home', '/tickets', '/sla'],
    customer_user:   ['/voice-ops', '/voice-workflow', '/insights'],
    oem_admin:       ['*'],
    // dealer_owner: 자기 매장만 보는 단일-딜러 뷰. 8 menus.
    dealer_owner:    ['/dealer', '/tickets', '/voice-workflow', '/marketing', '/insights', '/sla', '/billing', '/settings'],
    // dealer_sales: Voice Workflow + Sales Pipeline (Dealer Portal) + Tickets read-only. 3 menus.
    dealer_sales:    ['/dealer', '/voice-workflow', '/tickets'],
    // dealer_tech: Tickets + Voice Ops. 2 menus.
    dealer_tech:     ['/tickets', '/voice-ops'],
    // dealer_cs (legacy): same as dealer_owner subset
    dealer_cs:       ['/dealer', '/marketing', '/tickets', '/voice-ops'],
    // dealer_staff fallback (identity 서비스가 sales/tech 분류 안 한 경우): 가장 좁은 권한
    dealer_staff:    ['/tickets', '/voice-ops'],
    // Sentinel NOC operator — 전용 풀스크린만 접근
    noc_operator:    ['/sentinel'],
  };
  const allowed = ROLE_ALLOWED[effectiveRole] || ['*'];
  if (allowed[0] !== '*') {
    const cur = location.pathname;
    const ok = allowed.some(p => cur === p || (p !== '/' && cur.startsWith(p + '/')) || (p === '/' && cur === '/'));
    if (!ok) {
      // Prefer tenant-driven default landing; fall back to first allowed path
      let cachedTenant = tenant;
      if (!cachedTenant) { try { cachedTenant = JSON.parse(localStorage.getItem('cflex_tenant') || 'null'); } catch {} }
      const preferred = defaultLandingFor(user, cachedTenant);
      const preferOk = allowed.some(p => preferred === p || (p !== '/' && preferred.startsWith(p + '/')));
      const landing = preferOk ? preferred : (allowed[0] || '/');
      return <Navigate to={landing} replace />;
    }
  }
  return children;
}

function Shell({ children }) {
  const { user, tenant, logout } = useAuth();
  const location = useLocation();
  const { t, i18n } = useTranslation();

  // Persona + SKU from dev identity — single source of truth (cflex.runless.co.uk/v1/me proxied to dev :4002)
  const [persona, setPersona] = useState(null);
  const [skus, setSkus] = useState([]);
  useEffect(() => {
    const tok = localStorage.getItem('cflex_token');
    if (!tok) return;
    fetch('/v1/me', { headers: { Authorization: `Bearer ${tok}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        // Hotfix: identity가 dealer_sales/tech를 dealer_staff로 묶어 보냄. email로 정확 분기.
        let p = d.persona;
        if (p === 'dealer_staff' || p === 'customer_user') {
          if (d.email === 'irvine.sales@kia.com') p = 'dealer_sales';
          else if (d.email === 'irvine.tech@kia.com')  p = 'dealer_tech';
        }
        setPersona(p);
        const s = d.sku || d.tenant?.skus || [];
        setSkus(Array.isArray(s) ? s : []);
      })
      .catch(() => {});
  }, []);

  // All nav items with category + persona allowlist + optional SKU gate. iframe=<moduleId> means dev iframe.
  const allNavItems = [
    // Core
    { to: '/home',           label: t('nav.home'),           icon: Home,           category: 'core',       personas: ['super_admin','si_operator','customer_admin','customer_viewer'], iframe: 'cflex.shell' },
    { to: '/sentinel',       label: 'Sentinel',              icon: Shield,         category: 'core',       personas: ['super_admin','si_operator','noc_operator','customer_admin'] },
    { to: '/dealer',         label: t('nav.dealer'),         icon: Building2,      category: 'core',       personas: ['super_admin','si_operator','oem_admin','dealer_owner','dealer_sales'] },
    { to: '/marketing',      label: t('nav.marketing'),      icon: Megaphone,      category: 'core',       personas: ['super_admin','si_operator','oem_admin','dealer_owner'] },
    { to: '/admin',          label: t('nav.admin'),          icon: Shield,         category: 'core',       personas: ['super_admin','oem_admin'],                                       iframe: 'cflex.admin' },
    { to: '/admin/sso',      label: 'M365 SSO',              icon: Shield,         category: 'core',       personas: ['super_admin','admin','customer_admin','fms_admin','oem_admin','dealer_owner','engineer'] },
    { to: '/settings',       label: t('nav.settings'),       icon: SettingsIcon,   category: 'core',       personas: ['super_admin','si_operator','dealer_owner'] },
    // Operations
    { to: '/facility',       label: t('nav.facility'),       icon: LayoutDashboard,category: 'operations', personas: ['super_admin','si_operator','customer_admin'], skus: ['UPS','NETWORK'] },
    { to: '/tickets',        label: t('nav.tickets'),        icon: Ticket,         category: 'operations', personas: ['super_admin','si_operator','customer_admin','customer_viewer','dealer_owner','dealer_sales','dealer_tech','dealer_staff'] },
    { to: '/teams-phone',    label: t('nav.teams_phone'),    icon: Phone,          category: 'operations', personas: ['super_admin','si_operator','customer_admin'],                    skus: ['TEAMS'] },
    { to: '/voice-apps',     label: t('nav.voice_apps'),     icon: Mic,            category: 'operations', personas: ['super_admin','si_operator','customer_admin'],                    skus: ['TEAMS'] },
    { to: '/voice-ops',      label: t('nav.voice_ops'),      icon: Headphones,     category: 'operations', personas: ['super_admin','si_operator','customer_admin','customer_viewer','customer_user','dealer_tech','dealer_staff'], skus: ['TEAMS'] },
    { to: '/onboarding',     label: t('nav.onboarding'),     icon: Building2,      category: 'operations', personas: ['super_admin','si_operator'] },
    { to: '/billing',        label: t('nav.billing'),        icon: CreditCard,     category: 'operations', personas: ['super_admin','si_operator','customer_admin','dealer_owner'] },
    { to: '/sla',            label: t('nav.sla'),            icon: ShieldCheck,    category: 'operations', personas: ['super_admin','si_operator','customer_admin','customer_viewer','dealer_owner'] },
    { to: '/topology',       label: t('nav.topology'),       icon: Network,        category: 'operations', personas: ['super_admin','si_operator'] },
    // Workflow
    { to: '/relationships',  label: t('nav.relationships'),  icon: UsersIcon,      category: 'workflow',   personas: ['super_admin','si_operator','workflow_user'],                     iframe: 'cflex.relationships' },
    { to: '/voice-workflow', label: t('nav.voice_workflow'), icon: GitBranch,      category: 'workflow',   personas: ['super_admin','si_operator','workflow_user','customer_user','dealer_owner','dealer_sales'], iframe: 'cflex.voice.workflow' },
    { to: '/runbooks',       label: t('nav.runbooks'),       icon: BookOpen,       category: 'workflow',   personas: ['super_admin','si_operator'] },
    // Insights
    { to: '/insights',       label: t('nav.insights'),       icon: Sparkles,       category: 'insights',   personas: ['super_admin','si_operator','workflow_user','customer_user','oem_admin','dealer_owner'], iframe: 'cflex.insights' },
  ];

  const isInternal = persona === 'super_admin' || persona === 'si_operator' || persona === 'workflow_user';
  // dealer_* 페르소나는 SKU 체크 우회 (KIA dealer tenant SKU가 항상 박혀있는 게 아님)
  const skipSkuCheck = isInternal || persona === 'oem_admin' || (persona && persona.startsWith('dealer_'));
  const navItems = persona
    ? allNavItems.filter(it => {
        if (!it.personas.includes(persona)) return false;
        if (it.skus && !skipSkuCheck && !it.skus.some(s => skus.includes(s))) return false;
        return true;
      })
    : [];

  const grouped = {
    core:       navItems.filter(i => i.category === 'core'),
    operations: navItems.filter(i => i.category === 'operations'),
    workflow:   navItems.filter(i => i.category === 'workflow'),
    insights:   navItems.filter(i => i.category === 'insights'),
  };
  const CAT_LABEL = { core: 'CORE', operations: 'OPERATIONS', workflow: 'WORKFLOW', insights: 'INSIGHTS' };

  return (
    <div className="min-h-screen flex" style={{ background: '#f4f4f4', color: '#161616', fontFamily: '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif', letterSpacing: '0.16px' }}>
      {/* Sidebar — IBM ink charcoal */}
      <aside className="w-60 flex flex-col" style={{ background: '#161616', color: '#ffffff' }}>
        <div className="px-5 py-4" style={{ borderBottom: '1px solid #262626' }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 flex items-center justify-center" style={{ background: '#0f62fe' }}>
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>C-Flex NOC</div>
              <div style={{ fontSize: 11, color: '#c6c6c6', letterSpacing: '0.32px' }}>by RingOn Service</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-2 overflow-y-auto">
          {(['core','operations','workflow','insights']).map(cat => (
            grouped[cat].length > 0 && (
              <div key={cat} className="mb-3">
                <div style={{ fontSize: 10, color: '#8d8d8d', letterSpacing: '0.8px', padding: '8px 16px 4px', fontWeight: 600 }}>{CAT_LABEL[cat]}</div>
                {grouped[cat].map((item) => {
                  const Icon = item.icon;
                  const active = location.pathname === item.to || (item.to !== '/' && location.pathname.startsWith(item.to));
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className="flex items-center gap-3 px-4 py-2 text-sm transition"
                      style={{
                        background: active ? '#262626' : 'transparent',
                        color: active ? '#ffffff' : '#c6c6c6',
                        borderLeft: active ? '3px solid #0f62fe' : '3px solid transparent',
                        paddingLeft: active ? 13 : 16,
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      <Icon className="w-4 h-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            )
          ))}
        </nav>

        <div style={{ padding: 16, borderTop: '1px solid #262626' }}>
          <div style={{ fontSize: 11, color: '#c6c6c6', marginBottom: 8, fontFamily: 'IBM Plex Mono, monospace' }}>
            {user?.email || user?.name}
          </div>
          <div style={{ fontSize: 10, color: '#0f62fe', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
            {user?.role}
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm transition"
            style={{ color: '#c6c6c6', background: 'transparent', border: '1px solid #525252' }}
            onMouseOver={e => { e.currentTarget.style.background = '#262626'; e.currentTarget.style.color = '#ffffff'; }}
            onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#c6c6c6'; }}
          >
            <LogOut className="w-4 h-4" />
            {t('common.sign_out')}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Carbon utility bar (32px slim) */}
        <div style={{ background: '#f4f4f4', height: 32, borderBottom: '1px solid #e0e0e0', display: 'flex', alignItems: 'center', padding: '0 24px', fontSize: 12, color: '#525252', letterSpacing: '0.32px' }}>
          <span>{tenant ? tenant.display_name : 'All Tenants'}</span>
          <span style={{ margin: '0 12px', color: '#c6c6c6' }}>·</span>
          <span style={{ color: '#161616', fontWeight: 600 }}>{user?.role}</span>
          <span style={{ marginLeft: 'auto', fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }}>cflex.runless.co.uk</span>
          <button
            onClick={() => i18n.changeLanguage(i18n.language === 'ko' ? 'en' : 'ko')}
            style={{ marginLeft: 16, background: 'transparent', border: '1px solid #c6c6c6', padding: '2px 8px', fontSize: 11, color: '#161616', cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace' }}
            title="Toggle language"
          >
            {i18n.language === 'ko' ? 'EN' : 'KO'}
          </button>
        </div>
        <main className="flex-1 p-6 overflow-auto" style={{ background: '#ffffff' }}>
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
        <GlobalTicketModal />
        <SlaTenantModal />
        <SubscriptionModal />
        <WorkflowItemModal />
      </div>
      <NocChat />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/login" element={<Login />} />
          <Route path="/auth/m365/complete" element={<M365Complete />} />
          <Route path="/fms" element={<ProtectedRoute><Fms /></ProtectedRoute>} />
          <Route path="/admin/sso" element={<ProtectedRoute><Shell><M365SsoPage /></Shell></ProtectedRoute>} />
          {/* Sentinel — full-bleed standalone workspace (own dark sidebar) */}
          <Route path="/sentinel" element={<ProtectedRoute><Sentinel /></ProtectedRoute>} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <RootRedirectOrShell />
              </ProtectedRoute>
            }
          />
          <Route
            path="/tickets"
            element={
              <ProtectedRoute>
                <Shell><Tickets /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/teams-phone"
            element={
              <ProtectedRoute>
                <Shell><TeamsPhone /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/billing"
            element={
              <ProtectedRoute>
                <Shell><Billing /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/topology"
            element={
              <ProtectedRoute>
                <Shell><Topology /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/sla"
            element={
              <ProtectedRoute>
                <Shell><Sla /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/sla/:tenantId"
            element={
              <ProtectedRoute>
                <Shell><Sla /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/runbooks"
            element={
              <ProtectedRoute>
                <Shell><Runbooks /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Shell><Settings /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/voice-apps"
            element={
              <ProtectedRoute>
                <Shell><VoiceApps /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/onboarding"
            element={
              <ProtectedRoute>
                <Shell><Onboarding /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/home"
            element={
              <ProtectedRoute>
                <Shell><HomeRoute /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute>
                <Shell><AdminModuleRoute /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/voice-ops"
            element={
              <ProtectedRoute>
                <Shell><VoiceOpsRoute /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/facility"
            element={
              <ProtectedRoute>
                <Shell><FacilityRoute /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/dealer"
            element={
              <ProtectedRoute>
                <Shell><DealerPortalRoute /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/marketing"
            element={
              <ProtectedRoute>
                <Shell><MarketingRoute /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/relationships"
            element={
              <ProtectedRoute>
                <Shell><RelationshipsRoute /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/voice-workflow"
            element={
              <ProtectedRoute>
                <Shell><VoiceWorkflowRoute /></Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/insights"
            element={
              <ProtectedRoute>
                <Shell><InsightsRoute /></Shell>
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
