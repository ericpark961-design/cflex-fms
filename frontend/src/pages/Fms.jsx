// src/pages/Fms.jsx — EcoStruxure IT Expert-inspired FMS workspace
// Axes:
//   Left fixed nav: Dashboard · Floor Layout · Devices · Alarms · Alarm Map · Admin
//   Top bar: brand · search · bell · account
//   Body: per-section content
// Bilingual: KO primary, EN fallback. tx(ko, en) helper.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  LayoutGrid, Map as MapIcon, Server, AlertTriangle, Globe, Settings as SettingsIcon,
  Search, Bell, LogOut, RefreshCw, ChevronRight, ArrowLeft, Volume2, VolumeX,
  Battery, Activity, Thermometer, Power, Zap, Clock,
  Edit3, Upload, X as XIcon, Sliders, CheckCircle2, Menu,
} from 'lucide-react';

// ─── Tokens ────────────────────────────────────────────────────────
const FONT = '"IBM Plex Sans","Helvetica Neue",Arial,sans-serif';

// Inject @keyframes once, top of the document. Safe to call repeatedly.
function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('fms-keyframes')) return;
  const s = document.createElement('style');
  s.id = 'fms-keyframes';
  s.textContent = `
    @keyframes fmsPulse  { 0% { box-shadow: 0 0 0 0 rgba(218,30,40,0.55); } 70% { box-shadow: 0 0 0 10px rgba(218,30,40,0); } 100% { box-shadow: 0 0 0 0 rgba(218,30,40,0); } }
    @keyframes fmsWarnPulse  { 0% { box-shadow: 0 0 0 0 rgba(241,194,27,0.55); } 70% { box-shadow: 0 0 0 10px rgba(241,194,27,0); } 100% { box-shadow: 0 0 0 0 rgba(241,194,27,0); } }
    @keyframes fmsFadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
    @keyframes fmsSlideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: none; } }
    @keyframes fmsSlideOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(20px); } }
    @keyframes fmsPulseDot { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.3); opacity: 0.7; } }
  `;
  document.head.appendChild(s);
}
const C = {
  primary: '#0f62fe', primarySoft: '#edf5ff',
  ok: '#24a148', okSoft: '#defbe6',
  warn: '#f1c21b', warnSoft: '#fff8e1',
  critical: '#da1e28', criticalSoft: '#fff1f1',
  ink: '#161616', inkMuted: '#525252', inkSubtle: '#8d8d8d',
  bg: '#f4f4f4', card: '#ffffff', hairline: '#e0e0e0',
  navBg: '#161616', navText: '#c6c6c6',
};

const lang = () => (localStorage.getItem('lang') === 'en' ? 'en' : 'ko');
const tx = (ko, en) => (lang() === 'en' ? en : ko);

// Responsive — single breakpoint at 768px (tablet/phone)
const MOBILE_BP = 768;
function useViewport() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1280);
  useEffect(() => {
    const onR = () => setW(window.innerWidth);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  return { w, isMobile: w < MOBILE_BP };
}

const auth = () => {
  const t = localStorage.getItem('cflex_token') || localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const api = {
  get: (p) => fetch(p, { headers: auth() }).then(r => r.json()),
  post: (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() }, body: JSON.stringify(body) }).then(r => r.json()),
  put: (p, body) => fetch(p, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth() }, body: JSON.stringify(body) }).then(r => r.json()),
  del: (p) => fetch(p, { method: 'DELETE', headers: auth() }).then(r => r.json()),
};

const fmtTime = (ms) => {
  if (!ms) return '—';
  const ago = (Date.now() - ms) / 1000;
  if (ago < 60) return tx('방금', 'just now');
  if (ago < 3600) return `${Math.floor(ago / 60)}${tx('분 전', 'm ago')}`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}${tx('시간 전', 'h ago')}`;
  return new Date(ms).toLocaleDateString();
};
const fmtAbs = (ms) => ms ? new Date(ms).toLocaleString() : '—';

const statusColor = (s) => ({
  ok:          { bg: C.okSoft,       fg: C.ok,       label: 'NORMAL' },
  warn:        { bg: C.warnSoft,     fg: C.warn,     label: 'WARNING' },
  critical:    { bg: C.criticalSoft, fg: C.critical, label: 'CRITICAL' },
  unreachable: { bg: '#f4f4f4',      fg: C.inkMuted, label: 'OFFLINE' },
  unknown:     { bg: '#f4f4f4',      fg: C.inkSubtle, label: '—' },
}[s] || { bg: '#f4f4f4', fg: C.inkSubtle, label: s || '—' });

const sevColor = (p) => ({
  P1: { bg: C.criticalSoft, fg: C.critical, label: 'CRITICAL' },
  P2: { bg: C.warnSoft,     fg: C.warn,     label: 'WARNING' },
  P3: { bg: C.primarySoft,  fg: C.primary,  label: 'INFO' },
  P4: { bg: '#f4f4f4',      fg: C.inkMuted, label: 'LOW' },
}[p] || { bg: '#f4f4f4', fg: C.inkSubtle, label: p || '—' });

// ═══════════════════════════════════════════════════════════════════
// Global modal pattern — every clickable widget pops a modal
// ═══════════════════════════════════════════════════════════════════
const FmsModalCtx = React.createContext({ openDevice: () => {}, openAlarm: () => {}, openTicket: () => {}, cbu: 'all', setCbu: () => {} });
const useFmsModal = () => React.useContext(FmsModalCtx);
// Helper: append cbu= to URL if a CBU filter is active
const withCbu = (url, cbu) => {
  if (!cbu || cbu === 'all') return url;
  return url + (url.includes('?') ? '&' : '?') + 'cbu=' + encodeURIComponent(cbu);
};

// ═══════════════════════════════════════════════════════════════════
// Main layout
// ═══════════════════════════════════════════════════════════════════
export default function Fms() {
  const nav = useNavigate();
  const { isMobile } = useViewport();
  useEffect(() => { ensureKeyframes(); }, []);
  const [section, setSection] = useState('dashboard');
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [user, setUser] = useState(null);
  const [query, setQuery] = useState('');
  const [_lang, setLang] = useState(lang());
  const [navOpen, setNavOpen] = useState(false);
  const [modal, setModal] = useState(null);
  const closeModal = () => setModal(null);
  const [cbu, setCbu] = useState(() => localStorage.getItem('fms_cbu') || 'all');
  const updateCbu = (c) => { setCbu(c); localStorage.setItem('fms_cbu', c); };
  const modalApi = {
    openDevice: (id) => setModal({ kind: 'device', id }),
    openAlarm: (alert) => setModal({ kind: 'alarm', alert }),
    openTicket: (ticket) => setModal({ kind: 'ticket', ticket }),
    openDevicesByStatus: (statusKey, title) => setModal({ kind: 'devicesByStatus', statusKey, title }),
    openSites: () => setModal({ kind: 'sites' }),
    openNotifications: () => setModal({ kind: 'notifications' }),
    // Jump to Devices section, set CBU filter, and close any open modal.
    openSiteDevices: (cbuKey) => {
      if (cbuKey) updateCbu(cbuKey);
      setSection('devices');
      setSelectedAssetId(null);
      setModal(null);
    },
    cbu, setCbu: updateCbu,
  };

  // Unread P1 ticket badge — poll every 30s
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const fetchUnread = () => api.get('/v1/fms/tickets?status=open')
      .then(d => d?.ok && setUnread((d.tickets || []).filter(t => t.priority === 'P1').length));
    fetchUnread();
    const t = setInterval(fetchUnread, 30 * 1000);
    return () => clearInterval(t);
  }, []);

  // Toast system + new-alarm detector — diff latest alert id, surface a toast
  const [toasts, setToasts] = useState([]);
  const seenAlertIdRef = useRef(null);
  useEffect(() => {
    const poll = () => api.get('/v1/fms/alerts?hours=1').then(d => {
      if (!d?.ok) return;
      const alerts = d.alerts || [];
      if (!alerts.length) return;
      const top = alerts[0];
      // First poll: just record what's already there, no toasts
      if (seenAlertIdRef.current === null) { seenAlertIdRef.current = top.id; return; }
      const newOnes = [];
      for (const a of alerts) {
        if (a.id === seenAlertIdRef.current) break;
        newOnes.push(a);
      }
      if (newOnes.length > 0) {
        seenAlertIdRef.current = top.id;
        const tid = Date.now();
        const newToasts = newOnes.slice(0, 3).map((a, i) => ({
          id: tid + i,
          alert: a,
        }));
        setToasts(prev => [...prev, ...newToasts]);
        // Auto-dismiss after 7s
        newToasts.forEach(t => {
          setTimeout(() => setToasts(prev => prev.filter(x => x.id !== t.id)), 7000);
        });
      }
    });
    poll();
    const t = setInterval(poll, 20 * 1000);
    return () => clearInterval(t);
  }, []);
  const dismissToast = (id) => setToasts(prev => prev.filter(x => x.id !== id));

  useEffect(() => {
    api.get('/v1/me').then(d => { if (d?.userId || d?.email) setUser(d); else nav('/login'); });
  }, []);

  const logout = () => { localStorage.removeItem('cflex_token'); localStorage.removeItem('token'); nav('/login'); };
  const toggleLang = () => { const next = lang() === 'ko' ? 'en' : 'ko'; localStorage.setItem('lang', next); setLang(next); };

  const navItems = [
    { id: 'dashboard', ko: '대시보드',  en: 'Dashboard',    Icon: LayoutGrid },
    { id: 'floor',     ko: '플로어',     en: 'Floor Layout', Icon: MapIcon },
    { id: 'devices',   ko: '장치',       en: 'Devices',      Icon: Server },
    { id: 'alarms',    ko: '알람',       en: 'Alarms',       Icon: AlertTriangle },
    { id: 'alarmmap',  ko: '알람 지도',   en: 'Alarm Map',    Icon: Globe },
    { id: 'admin',     ko: '관리',       en: 'Admin',        Icon: SettingsIcon },
  ];

  // Mobile: close nav drawer on section change
  const pickSection = (id) => { setSection(id); setSelectedAssetId(null); if (isMobile) setNavOpen(false); };

  return (
    <FmsModalCtx.Provider value={modalApi}>
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: FONT, background: C.bg, color: C.ink }}>
      {/* Mobile overlay backdrop */}
      {isMobile && navOpen && (
        <div onClick={() => setNavOpen(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 900,
        }} />
      )}
      {/* Left nav — fixed on desktop, slide-in drawer on mobile */}
      <aside style={{
        width: 220, background: C.navBg, color: C.navText, display: 'flex', flexDirection: 'column', flexShrink: 0,
        ...(isMobile ? {
          position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 901,
          transform: navOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 200ms ease',
          boxShadow: navOpen ? '4px 0 16px rgba(0,0,0,0.18)' : 'none',
        } : {}),
      }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 11, letterSpacing: '1px', color: '#8d8d8d', textTransform: 'uppercase' }}>RingOn FMS</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginTop: 4 }}>HAEA</div>
        </div>
        <nav style={{ padding: '10px 0', flex: 1 }}>
          {navItems.map(item => {
            const active = section === item.id;
            return (
              <div key={item.id} onClick={() => pickSection(item.id)} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '11px 22px', cursor: 'pointer', fontSize: 13,
                background: active ? 'rgba(15,98,254,0.18)' : 'transparent',
                borderLeft: active ? `3px solid ${C.primary}` : '3px solid transparent',
                color: active ? '#fff' : C.navText, transition: 'background 100ms',
              }}>
                <item.Icon size={16} /> {tx(item.ko, item.en)}
              </div>
            );
          })}
        </nav>
        <div style={{ padding: '14px 22px', borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: 12 }}>
          {user && (<>
            <div style={{ color: '#fff', fontWeight: 600 }}>{user.name}</div>
            <div style={{ color: '#8d8d8d', fontSize: 11, marginTop: 2 }}>{user.email}</div>
          </>)}
          <div onClick={logout} style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, color: '#8d8d8d', cursor: 'pointer' }}>
            <LogOut size={13} /> {tx('로그아웃', 'Sign out')}
          </div>
        </div>
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <header style={{
          height: 56, background: C.card, borderBottom: `1px solid ${C.hairline}`,
          display: 'flex', alignItems: 'center', padding: isMobile ? '0 12px' : '0 24px', gap: isMobile ? 8 : 16, flexShrink: 0,
        }}>
          {isMobile && (
            <Menu size={20} color={C.inkMuted} style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => setNavOpen(true)} />
          )}
          <div style={{ flex: 1, position: 'relative', maxWidth: isMobile ? 'none' : 480 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: C.inkSubtle }} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder={tx('검색 (장치/사이트/티켓…)', 'Search (device, site, ticket…)')}
              style={{
                width: '100%', padding: '7px 10px 7px 32px', fontSize: 13, fontFamily: FONT,
                border: `1px solid ${C.hairline}`, outline: 'none', background: '#fafafa',
              }} />
          </div>
          <CbuToggle cbu={cbu} onChange={updateCbu} isMobile={isMobile} />
          <button onClick={toggleLang} style={{
            padding: '6px 10px', background: 'transparent', border: `1px solid ${C.hairline}`,
            cursor: 'pointer', fontSize: 11, fontWeight: 600, color: C.inkMuted, flexShrink: 0,
          }}>{lang() === 'ko' ? 'KO' : 'EN'}</button>
          <div onClick={() => modalApi.openNotifications()} style={{ position: 'relative', cursor: 'pointer', flexShrink: 0, padding: 4 }} title={tx('알림', 'Notifications')}>
            <Bell size={18} color={unread > 0 ? C.critical : C.inkMuted} />
            {unread > 0 && (
              <span style={{
                position: 'absolute', top: 0, right: 0, minWidth: 16, height: 16,
                background: C.critical, color: '#fff', borderRadius: 8, fontSize: 9, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
                animation: 'fmsPulse 1.8s ease-out infinite',
              }}>{unread > 99 ? '99+' : unread}</span>
            )}
          </div>
        </header>

        {/* Body */}
        <main style={{ flex: 1, overflow: 'auto' }}>
          {section === 'dashboard' && <Dashboard />}
          {section === 'floor' && <FloorLayout />}
          {section === 'devices' && (selectedAssetId
            ? <DeviceDetail id={selectedAssetId} onBack={() => setSelectedAssetId(null)} />
            : <DevicesList query={query} onPick={setSelectedAssetId} />
          )}
          {section === 'alarms' && <AlarmsView />}
          {section === 'alarmmap' && <AlarmMap />}
          {section === 'admin' && <Admin user={user} />}
        </main>
      </div>
    </div>
    {/* Global modal layer — single instance per kind, mounted at root */}
    {modal?.kind === 'device' && <DeviceDetailModal id={modal.id} onClose={closeModal} />}
    {modal?.kind === 'alarm'  && <AlarmDetailModal alert={modal.alert} onClose={closeModal} />}
    {modal?.kind === 'ticket' && <TicketDetailModal ticket={modal.ticket} onClose={closeModal} />}
    {modal?.kind === 'devicesByStatus' && <DevicesByStatusModal statusKey={modal.statusKey} title={modal.title} onClose={closeModal} />}
    {modal?.kind === 'sites' && <SitesListModal onClose={closeModal} />}
    {modal?.kind === 'notifications' && <NotificationsModal onClose={closeModal} />}

    {/* Toast stack — top-right, slide-in. New alarms surface here regardless of section. */}
    {toasts.length > 0 && (
      <div style={{
        position: 'fixed', top: 72, right: 16, zIndex: 1100,
        display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 380, pointerEvents: 'none',
      }}>
        {toasts.map(t => {
          const sc = sevColor(t.alert.priority);
          return (
            <div key={t.id} onClick={() => { dismissToast(t.id); modalApi.openAlarm(t.alert); }} style={{
              pointerEvents: 'auto',
              background: '#fff', border: `1px solid ${C.hairline}`, borderLeft: `4px solid ${sc.fg}`,
              padding: '10px 12px', fontSize: 12, cursor: 'pointer',
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              animation: 'fmsSlideIn 240ms ease-out',
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <span style={{
                padding: '2px 8px', fontSize: 10, fontWeight: 700, background: sc.fg, color: '#fff',
                flexShrink: 0,
              }}>{t.alert.priority}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: C.ink, marginBottom: 2 }}>{t.alert.message}</div>
                <div style={{ fontSize: 11, color: C.inkSubtle }}>{t.alert.device_label || t.alert.device_id}</div>
              </div>
              <XIcon size={14} color={C.inkSubtle}
                onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}
                style={{ cursor: 'pointer', flexShrink: 0 }} />
            </div>
          );
        })}
      </div>
    )}
    </FmsModalCtx.Provider>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 1) Dashboard
// ═══════════════════════════════════════════════════════════════════
function Dashboard() {
  const { isMobile } = useViewport();
  const { openDevice, openAlarm, openDevicesByStatus, openSites, cbu } = useFmsModal();
  const [s, setS] = useState(null);
  const [assets, setAssets] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const reload = () => {
    api.get(withCbu('/v1/fms/summary', cbu)).then(d => d?.ok && setS(d));
    api.get(withCbu('/v1/fms/assets', cbu)).then(d => d?.ok && setAssets(d.assets));
    api.get(withCbu('/v1/fms/alerts?hours=24', cbu)).then(d => d?.ok && setAlerts(d.alerts));
  };
  useEffect(() => { reload(); const t = setInterval(reload, 30000); return () => clearInterval(t); }, [cbu]);
  if (!s) return <Loading />;

  // KPI tiles — vivid icon + value + share-of-fleet bar
  const tiles = [
    { label: tx('위험', 'CRITICAL'), Icon: AlertTriangle, value: s.devices.critical + s.devices.unreachable, color: C.critical, soft: C.criticalSoft, onClick: () => openDevicesByStatus('critical', tx('위험 장치', 'Critical Devices')) },
    { label: tx('경고', 'WARNING'),  Icon: AlertTriangle, value: s.devices.warn,    color: C.warn,    soft: C.warnSoft,     onClick: () => openDevicesByStatus('warn',    tx('경고 장치', 'Warning Devices')) },
    { label: tx('정상', 'NORMAL'),   Icon: CheckCircle2,  value: s.devices.normal,  color: C.ok,      soft: C.okSoft,        onClick: () => openDevicesByStatus('ok',      tx('정상 장치', 'Normal Devices')) },
    { label: tx('사이트', 'SITES'),   Icon: Globe,         value: s.sites,           color: C.primary, soft: C.primarySoft,   onClick: () => openSites() },
  ];

  return (
    <div style={{ padding: isMobile ? 12 : 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: isMobile ? 18 : 22, fontWeight: 700 }}>{tx('HAEA 시설 대시보드', 'HAEA Facility Dashboard')}</h1>
        <span style={{ flex: 1 }} />
        <button onClick={reload} style={iconBtn}><RefreshCw size={13} /> {tx('새로고침', 'Refresh')}</button>
      </div>

      {/* KPI tiles — IBM Carbon styling with icon, soft glow on hover, share-of-fleet bar */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
        {tiles.map(t => {
          const pct = s.devices.total > 0 ? Math.min(100, (t.value / s.devices.total) * 100) : 0;
          const isSites = t.label === tx('사이트', 'SITES');
          return (
            <div key={t.label} onClick={t.onClick} style={{
              background: C.card, padding: '18px 18px 14px', border: `1px solid ${C.hairline}`,
              borderTop: `4px solid ${t.color}`, cursor: 'pointer',
              transition: 'box-shadow 160ms ease, transform 160ms ease, border-color 160ms',
              position: 'relative', overflow: 'hidden',
            }}
              onMouseEnter={e => {
                e.currentTarget.style.boxShadow = `0 6px 18px ${t.color}22`;
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.borderColor = t.color + '40';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.boxShadow = 'none';
                e.currentTarget.style.transform = 'none';
                e.currentTarget.style.borderColor = C.hairline;
              }}>
              {/* Soft tinted backdrop ring */}
              <div style={{
                position: 'absolute', top: -20, right: -20, width: 80, height: 80, borderRadius: '50%',
                background: t.soft, opacity: 0.6,
              }} />
              {/* Icon */}
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 26, height: 26, background: t.soft, color: t.color,
                }}>
                  <t.Icon size={14} />
                </span>
                <span style={{ fontSize: 11, color: C.inkSubtle, letterSpacing: '0.5px', fontWeight: 700 }}>{t.label}</span>
              </div>
              {/* Big number with subtle tone */}
              <div style={{ position: 'relative', fontSize: 38, fontWeight: 700, marginTop: 6, color: t.color, lineHeight: 1, letterSpacing: '-0.5px' }}>
                {t.value}
              </div>
              {/* Sub-text + share bar */}
              <div style={{ position: 'relative', fontSize: 10, color: C.inkMuted, marginTop: 8 }}>
                {isSites
                  ? tx('운영중인 사이트', 'operated sites')
                  : <>{tx('전체 ', 'of ')}<strong style={{ color: C.ink }}>{s.devices.total}</strong>{tx(' 장치 중', ' total')}</>}
              </div>
              {!isSites && (
                <div style={{ marginTop: 6, height: 3, background: C.bg, position: 'relative' }}>
                  <div style={{ position: 'absolute', inset: 0, width: pct + '%', background: t.color, transition: 'width 300ms' }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Two-column: fleet live trend (left) + recent alarms (right) — stacked on mobile */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.6fr 1fr', gap: 12, marginBottom: 20 }}>
        <FleetLive />
        <RecentAlarms list={alerts.slice(0, 8)} onPick={openAlarm} />
      </div>

      {/* Bottom: 44-UPS honeycomb (rooms grouped) */}
      <Section title={tx('자산 상태', 'Asset status')}>
        <HoneycombGrid assets={assets} onPick={openDevice} />
      </Section>
    </div>
  );
}

// Fleet-wide live trend — polls /v1/fms/fleet-live every 30s, 30-min window.
function FleetLive() {
  const { cbu } = useFmsModal();
  const [d, setD] = useState(null);
  const [minutes, setMinutes] = useState(30);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const fetchOnce = () => api.get(withCbu(`/v1/fms/fleet-live?minutes=${minutes}`, cbu)).then(r => alive && r?.ok && setD(r));
    fetchOnce();
    const t = setInterval(fetchOnce, 30 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [minutes, cbu]);

  // Force redraw every 30s for "last update" age display
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 30 * 1000); return () => clearInterval(t); }, []);

  return (
    <div style={{ background: C.card, padding: 18, border: `1px solid ${C.hairline}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.ok, boxShadow: `0 0 0 3px ${C.ok}25`, animation: 'fmsPulseDot 1.8s ease-in-out infinite' }} />
          <span style={{ fontSize: 10, color: C.inkSubtle, letterSpacing: '0.4px', textTransform: 'uppercase', fontWeight: 700 }}>
            {tx('Fleet 실시간', 'Fleet Live')} · {minutes}m
          </span>
        </span>
        <span style={{ flex: 1 }} />
        {[15, 30, 60].map(m => (
          <button key={m} onClick={() => setMinutes(m)} style={{
            padding: '3px 8px', fontSize: 11, fontWeight: 600, background: minutes === m ? C.primary : 'transparent',
            color: minutes === m ? '#fff' : C.inkMuted, border: `1px solid ${minutes === m ? C.primary : C.hairline}`, cursor: 'pointer',
          }}>{m}m</button>
        ))}
      </div>

      {/* Meta strip */}
      {d?.fleet && (
        <div style={{
          display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: C.inkMuted,
          padding: '8px 0', borderBottom: `1px solid ${C.hairline}`, marginBottom: 10,
        }}>
          <span><strong style={{ color: C.ink }}>{d.fleet.polling || 0}</strong> {tx('대 폴링', 'devices polling')}</span>
          {d.fleet.critical > 0 && <span style={{ color: C.critical, fontWeight: 700 }}>● {d.fleet.critical} {tx('위험', 'critical')}</span>}
          {d.fleet.warn > 0 && <span style={{ color: C.warn, fontWeight: 700 }}>● {d.fleet.warn} {tx('경고', 'warning')}</span>}
          <span>{tx('평균 부하', 'avg load')} <strong style={{ color: C.ink }}>{d.fleet.avg_load != null ? Math.round(d.fleet.avg_load) + '%' : '—'}</strong></span>
          <span>{tx('최대 온도', 'max temp')} <strong style={{ color: C.ink }}>{d.fleet.max_temp != null ? Math.round(d.fleet.max_temp) + '°C' : '—'}</strong></span>
          <span style={{ marginLeft: 'auto', fontSize: 11 }}>{tx('업데이트', 'updated')} {fmtTime(d.fleet.last_polled || d.generated_at)}</span>
        </div>
      )}

      {!d ? <Loading />
        : d.series.length === 0
        ? <div style={{ padding: 28, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>
            <div style={{ marginBottom: 6 }}>{tx('실시간 데이터 없음', 'No live data')}</div>
            <div style={{ fontSize: 11 }}>{tx('프로브가 폴링을 시작해야 차트가 채워집니다.', 'Chart fills as probe begins polling.')}</div>
          </div>
        : <FleetLiveChart series={d.series} minutes={minutes} />
      }
    </div>
  );
}

// SVG fleet live multi-line chart with gradient area fill, hover crosshair, last-value badges.
function FleetLiveChart({ series, minutes }) {
  const W = 900, H = 240, P = 40;
  const now = Date.now();
  const start = now - minutes * 60 * 1000;
  const xScale = (t) => P + ((t - start) / (now - start)) * (W - P * 2);
  const yScale = (v) => H - P - ((v - 0) / (100 - 0)) * (H - P * 2);

  const lines = [
    { key: 'avg_battery', color: C.ok,       label: tx('평균 배터리 %', 'Avg battery %') },
    { key: 'avg_load',    color: C.primary,  label: tx('평균 부하 %',   'Avg load %') },
    { key: 'max_temp',    color: C.critical, label: tx('최대 온도 °C',  'Max temp °C') },
  ];

  // Hover crosshair state — index into series
  const [hoverX, setHoverX] = useState(null);
  const svgEl = useRef(null);

  const onMove = (e) => {
    if (!svgEl.current) return;
    const rect = svgEl.current.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const xSvg = (xPx / rect.width) * W;
    if (xSvg < P || xSvg > W - P) { setHoverX(null); return; }
    setHoverX(xSvg);
  };

  // Find nearest data point per series at hoverX
  const hoverValues = useMemo(() => {
    if (hoverX == null) return null;
    const tAtHover = start + ((hoverX - P) / (W - P * 2)) * (now - start);
    return lines.map(ln => {
      const pts = series.filter(p => p[ln.key] != null);
      if (!pts.length) return null;
      let nearest = pts[0];
      let minD = Math.abs(pts[0].bucket - tAtHover);
      for (const p of pts) {
        const d = Math.abs(p.bucket - tAtHover);
        if (d < minD) { minD = d; nearest = p; }
      }
      return { key: ln.key, color: ln.color, label: ln.label, value: nearest[ln.key], t: nearest.bucket };
    }).filter(Boolean);
  }, [hoverX, series, start, now]);

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg ref={svgEl} viewBox={`0 0 ${W} ${H + 40}`} width="100%" preserveAspectRatio="xMidYMid meet"
        onMouseMove={onMove} onMouseLeave={() => setHoverX(null)} style={{ display: 'block' }}>
        <defs>
          {lines.map(ln => (
            <linearGradient key={ln.key} id={`g-${ln.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ln.color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={ln.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* Y gridlines */}
        {[0, 25, 50, 75, 100].map(v => (
          <g key={v}>
            <line x1={P} y1={yScale(v)} x2={W - P} y2={yScale(v)} stroke="#f4f4f4" strokeWidth="1" />
            <text x={P - 6} y={yScale(v) + 3} textAnchor="end" fontSize="9" fill={C.inkSubtle}>{v}</text>
          </g>
        ))}
        {/* X axis ticks */}
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="#e0e0e0" />
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
          const tMs = start + f * (now - start);
          const xx = P + f * (W - P * 2);
          return (
            <g key={i}>
              <line x1={xx} y1={H - P} x2={xx} y2={H - P + 4} stroke={C.inkSubtle} strokeWidth="0.5" />
              <text x={xx} y={H - P + 16} textAnchor="middle" fontSize="9" fill={C.inkSubtle}>
                {new Date(tMs).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
              </text>
            </g>
          );
        })}

        {/* Area fills + lines */}
        {lines.map(ln => {
          const pts = series.filter(p => p[ln.key] != null);
          if (!pts.length) return null;
          // Catmull-rom style smoothing: cardinal-ish bezier between points
          const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.bucket)} ${yScale(p[ln.key])}`).join(' ');
          const last = pts[pts.length - 1];
          const first = pts[0];
          const areaPath = `${linePath} L ${xScale(last.bucket)} ${yScale(0)} L ${xScale(first.bucket)} ${yScale(0)} Z`;
          return (
            <g key={ln.key}>
              <path d={areaPath} fill={`url(#g-${ln.key})`} />
              <path d={linePath} stroke={ln.color} strokeWidth={2} fill="none"
                strokeLinejoin="round" strokeLinecap="round" />
              {/* Last point — glowing dot */}
              <circle cx={xScale(last.bucket)} cy={yScale(last[ln.key])} r="6" fill={ln.color} opacity="0.18" />
              <circle cx={xScale(last.bucket)} cy={yScale(last[ln.key])} r="3" fill={ln.color} stroke="#fff" strokeWidth="1" />
            </g>
          );
        })}

        {/* Hover crosshair + value markers */}
        {hoverX != null && hoverValues && hoverValues.length > 0 && (
          <g style={{ pointerEvents: 'none' }}>
            <line x1={hoverX} y1={P} x2={hoverX} y2={H - P} stroke={C.inkMuted} strokeWidth="0.6" strokeDasharray="3 3" />
            {hoverValues.map((v, i) => (
              <g key={v.key}>
                <circle cx={hoverX} cy={yScale(v.value)} r="4" fill={v.color} stroke="#fff" strokeWidth="1.5" />
              </g>
            ))}
            {/* Tooltip pill */}
            <g transform={`translate(${Math.min(hoverX + 10, W - P - 150)}, ${P + 6})`}>
              <rect x="0" y="0" width="150" height={18 + hoverValues.length * 16} rx="2"
                fill="#161616" opacity="0.92" />
              <text x="10" y="14" fontSize="9" fill="#a8a8a8" fontWeight="700">
                {new Date(hoverValues[0].t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
              </text>
              {hoverValues.map((v, i) => (
                <g key={v.key} transform={`translate(10, ${28 + i * 16})`}>
                  <rect x="0" y="-6" width="6" height="6" fill={v.color} />
                  <text x="12" y="0" fontSize="10" fill="#fff">{v.label}</text>
                  <text x="140" y="0" fontSize="10" fill="#fff" fontWeight="700" textAnchor="end">
                    {Math.round(v.value * 10) / 10}
                  </text>
                </g>
              ))}
            </g>
          </g>
        )}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginTop: 4, fontSize: 11, color: C.inkMuted, flexWrap: 'wrap' }}>
        {lines.map(ln => (
          <span key={ln.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 14, height: 3, background: ln.color, borderRadius: 1 }} /> {ln.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function RecentAlarms({ list, onPick }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.hairline}`, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.hairline}`, fontSize: 10, letterSpacing: '0.4px', fontWeight: 700, color: C.inkSubtle, textTransform: 'uppercase' }}>
        {tx('최신 알람', 'Recent alarms')}
      </div>
      <div style={{ flex: 1, overflow: 'auto', maxHeight: 320 }}>
        {list.length === 0
          ? <div style={{ padding: 32, color: C.inkSubtle, textAlign: 'center', fontSize: 13 }}>{tx('알람 없음', 'No alarms')}</div>
          : list.map(a => {
              const sc = sevColor(a.priority);
              return (
                <div key={a.id} onClick={() => onPick?.(a)} style={{ padding: '10px 14px', borderBottom: `1px solid ${C.hairline}`, fontSize: 12, cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                  onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ padding: '2px 6px', fontSize: 9, fontWeight: 700, background: sc.fg, color: '#fff' }}>{a.priority}</span>
                    <span style={{ flex: 1, fontWeight: 600 }}>{a.device_label || a.device_id}</span>
                    <span style={{ color: C.inkSubtle, fontSize: 10 }}>{fmtTime(a.received_at)}</span>
                  </div>
                  <div style={{ color: C.inkMuted, fontSize: 12 }}>{a.message}</div>
                  {a.recurring && (
                    <div style={{ fontSize: 10, color: C.warn, fontWeight: 600, marginTop: 2 }}>● {tx('반복', 'recurring')}</div>
                  )}
                </div>
              );
            })}
      </div>
    </div>
  );
}

function HoneycombGrid({ assets, onPick }) {
  // Group by CBU. Order is fixed so the rows always render in the same place.
  const CBU_ORDER = ['HMA', 'KUS', 'HAEA_HQ'];
  const byCbu = {};
  assets.forEach(a => {
    const k = a.cbu || 'unknown';
    if (!byCbu[k]) byCbu[k] = [];
    byCbu[k].push(a);
  });
  const groups = [...CBU_ORDER.filter(k => byCbu[k]), ...Object.keys(byCbu).filter(k => !CBU_ORDER.includes(k))]
    .map(k => ({ cbu: k, devices: byCbu[k] }));

  // Strip a CBU-specific prefix from labels to keep cell text short.
  const shortLabel = (label, cbu) => {
    if (!label) return '—';
    return label
      .replace(/^HMA\s+UPS\s+/i, '')
      .replace(/^HMA\s+/i, '')
      .replace(/^HAEA[-_]?(HQ\s+)?(IDF\d?|MDF[-_]?)?(UPS[-_]?)?/i, '$2$3')
      .replace(/^IDF\s+UPS\s+/i, '')
      .replace(/\s*\([0-9.]+\)$/, '')
      .trim() || label;
  };

  // Status accent colour per cell — bold fg fill, white text, sized for ~40-60 px cells
  const cellStyle = (status) => {
    const sc = statusColor(status);
    const solid =
      status === 'critical' || status === 'unreachable' ? { bg: C.critical, fg: '#fff' } :
      status === 'warn'                                  ? { bg: C.warn,     fg: C.ink } :
      status === 'ok'                                    ? { bg: C.ok,       fg: '#fff' } :
                                                            { bg: '#e8e8e8',  fg: C.inkMuted };
    return { ...sc, solid };
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 14 }}>
      {groups.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>
          {tx('표시할 장치가 없습니다.', 'No devices to display.')}
        </div>
      ) : groups.map(({ cbu, devices }, idx) => {
        const critical = devices.filter(d => d.status === 'critical' || d.status === 'unreachable').length;
        const warn = devices.filter(d => d.status === 'warn').length;
        const ok = devices.filter(d => d.status === 'ok').length;
        const unknown = devices.filter(d => !['critical', 'unreachable', 'warn', 'ok'].includes(d.status)).length;
        return (
          <div key={cbu} style={{ marginBottom: idx === groups.length - 1 ? 0 : 14, paddingBottom: idx === groups.length - 1 ? 0 : 14, borderBottom: idx === groups.length - 1 ? 'none' : `1px solid ${C.hairline}` }}>
            {/* CBU header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 11, letterSpacing: '0.5px', fontWeight: 700, color: C.ink,
                padding: '3px 10px', background: C.bg, border: `1px solid ${C.hairline}`,
              }}>{cbu.replace('_', ' ')}</span>
              <span style={{ fontSize: 11, color: C.inkSubtle }}>{devices.length} {tx('대', 'devices')}</span>
              <span style={{ flex: 1 }} />
              {critical > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: C.critical }}>
                  <span style={{ width: 8, height: 8, background: C.critical, borderRadius: '50%' }} />
                  {critical} {tx('위험', 'critical')}
                </span>
              )}
              {warn > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: C.warn }}>
                  <span style={{ width: 8, height: 8, background: C.warn, borderRadius: '50%' }} />
                  {warn} {tx('경고', 'warning')}
                </span>
              )}
              {ok > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: C.ok }}>
                  <span style={{ width: 8, height: 8, background: C.ok, borderRadius: '50%' }} />
                  {ok} {tx('정상', 'normal')}
                </span>
              )}
              {unknown > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.inkSubtle }}>
                  <span style={{ width: 8, height: 8, background: '#bbb', borderRadius: '50%' }} />
                  {unknown} {tx('미확인', 'unknown')}
                </span>
              )}
            </div>

            {/* Cell grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(54px, 1fr))', gap: 4 }}>
              {devices.map(a => {
                const { solid } = cellStyle(a.status);
                return (
                  <div key={a.id} onClick={() => onPick(a.id)}
                    title={`${a.label} · ${a.status || 'unknown'}${a.battery_pct != null ? ' · batt ' + Math.round(a.battery_pct) + '%' : ''}`}
                    style={{
                      aspectRatio: '1/1', background: solid.bg, color: solid.fg,
                      cursor: 'pointer', display: 'flex', flexDirection: 'column', justifyContent: 'center',
                      alignItems: 'center', fontSize: 9, fontWeight: 700, gap: 1,
                      transition: 'transform 80ms',
                      animation: (a.status === 'critical' || a.status === 'unreachable')
                        ? 'fmsPulse 2.4s ease-out infinite'
                        : a.status === 'warn' ? 'fmsWarnPulse 2.6s ease-out infinite' : undefined,
                    }}
                    onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.06)'}
                    onMouseLeave={e => e.currentTarget.style.transform = 'none'}>
                    <div style={{ fontSize: 9, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '90%' }}>
                      {shortLabel(a.label, cbu)}
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 800 }}>
                      {a.battery_pct != null ? `${Math.round(a.battery_pct)}%` : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 2) Floor Layout (drill-down: Location → Room → Rack → Device)
// ═══════════════════════════════════════════════════════════════════
function FloorLayout() {
  const { openDevice, cbu } = useFmsModal();
  const [tree, setTree] = useState(null);
  const [path, setPath] = useState([]); // [locId, roomId, rackId]
  useEffect(() => { setPath([]); api.get(withCbu('/v1/fms/floor', cbu)).then(d => d?.ok && setTree(d.tree)); }, [cbu]);
  if (!tree) return <Loading />;

  // Walk path
  let level = 'location', items = Object.values(tree);
  const breadcrumbs = [{ id: null, label: tx('전체', 'All') }];
  if (path[0]) {
    const loc = tree[path[0]]; breadcrumbs.push({ id: path[0], label: loc.name });
    level = 'room'; items = Object.values(loc.rooms);
    if (path[1]) {
      const room = loc.rooms[path[1]]; breadcrumbs.push({ id: path[1], label: room.name });
      level = 'rack'; items = Object.values(room.racks);
      if (path[2]) {
        const rack = room.racks[path[2]]; breadcrumbs.push({ id: path[2], label: rack.name });
        level = 'device'; items = rack.devices;
      }
    }
  }

  const goTo = (idx) => setPath(path.slice(0, idx));
  const drillDown = (id) => setPath([...path, id]);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{tx('플로어 레이아웃', 'Floor Layout')}</h1>
        <span style={{ flex: 1 }} />
        {path.length > 0 && (
          <button onClick={() => goTo(path.length - 1)} style={iconBtn}><ArrowLeft size={13} /> {tx('상위', 'Up')}</button>
        )}
      </div>

      {/* Breadcrumb */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, fontSize: 13 }}>
        {breadcrumbs.map((b, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight size={14} color={C.inkSubtle} style={{ alignSelf: 'center' }} />}
            <span onClick={() => goTo(i)} style={{
              cursor: 'pointer', color: i === breadcrumbs.length - 1 ? C.ink : C.primary, fontWeight: i === breadcrumbs.length - 1 ? 600 : 400,
            }}>{b.label}</span>
          </React.Fragment>
        ))}
      </div>

      {/* Cards or device grid */}
      {level !== 'device' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {items.map(it => {
            const sev = it.critical > 0 ? 'critical' : it.warn > 0 ? 'warn' : 'ok';
            const sc = statusColor(sev);
            return (
              <div key={it.name} onClick={() => drillDown(it.name)} style={{
                background: C.card, border: `1px solid ${C.hairline}`, borderLeft: `4px solid ${sc.fg}`,
                padding: 16, cursor: 'pointer',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{it.name}</div>
                  <span style={{ padding: '2px 6px', fontSize: 10, fontWeight: 700, background: sc.fg, color: '#fff' }}>{sc.label}</span>
                </div>
                <div style={{ fontSize: 11, color: C.inkSubtle, letterSpacing: '0.3px', textTransform: 'uppercase' }}>
                  {it.count} {tx('장치', 'devices')}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 8, fontSize: 12 }}>
                  <span><span style={{ color: C.critical, fontWeight: 700 }}>{it.critical}</span> {tx('위험', 'critical')}</span>
                  <span><span style={{ color: C.warn, fontWeight: 700 }}>{it.warn}</span> {tx('경고', 'warning')}</span>
                  <span><span style={{ color: C.ok, fontWeight: 700 }}>{it.ok}</span> {tx('정상', 'normal')}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
          {items.map(d => {
            const sc = statusColor(d.status);
            return (
              <div key={d.id} onClick={() => openDevice(d.id)} style={{
                background: C.card, border: `1px solid ${C.hairline}`, borderTop: `3px solid ${sc.fg}`,
                padding: 12, cursor: 'pointer',
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{d.label}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.inkMuted }}>
                  <span>{d.battery_pct != null ? `${Math.round(d.battery_pct)}%` : '—'}</span>
                  <span style={{ color: sc.fg, fontWeight: 700 }}>{sc.label}</span>
                </div>
                <div style={{ fontSize: 10, color: C.inkSubtle, marginTop: 4 }}>{fmtTime(d.last_polled)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 3) Devices list + 4) Device detail
// ═══════════════════════════════════════════════════════════════════
function DevicesList({ query, onPick }) {
  const { isMobile } = useViewport();
  const { openDevice, cbu } = useFmsModal();
  const [assets, setAssets] = useState([]);
  const reload = () => api.get(withCbu('/v1/fms/assets', cbu)).then(d => d?.ok && setAssets(d.assets));
  useEffect(() => { reload(); const t = setInterval(reload, 30000); return () => clearInterval(t); }, [cbu]);
  const filtered = useMemo(() => assets.filter(a => !query.trim() ||
    (a.label + ' ' + (a.ip || '') + ' ' + (a.vendor || '') + ' ' + (a.room || '') + ' ' + (a.rack || '')).toLowerCase().includes(query.toLowerCase())
  ), [assets, query]);

  return (
    <div style={{ padding: isMobile ? 12 : 24 }}>
      <h1 style={{ margin: '0 0 16px', fontSize: isMobile ? 18 : 22, fontWeight: 700 }}>{tx('장치 인벤토리 · UPS', 'Devices · UPS')}</h1>
      <div style={{ background: C.card, border: `1px solid ${C.hairline}`, overflowX: 'auto' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 130px 100px 80px 80px 80px 100px 80px', minWidth: 760,
          padding: '10px 14px', fontSize: 10, fontWeight: 700, color: C.inkSubtle, letterSpacing: '0.4px',
          textTransform: 'uppercase', borderBottom: `1px solid ${C.hairline}`, background: '#fafafa',
        }}>
          <div>{tx('장치 · 룸 / 랙', 'Device · room / rack')}</div>
          <div>{tx('IP', 'IP')}</div>
          <div>{tx('벤더', 'Vendor')}</div>
          <div>{tx('배터리', 'Batt')}</div>
          <div>{tx('부하', 'Load')}</div>
          <div>{tx('온도', 'Temp')}</div>
          <div>{tx('상태', 'Status')}</div>
          <div style={{ textAlign: 'right' }}>{tx('마지막', 'Last')}</div>
        </div>
        {filtered.map(a => {
          const sc = statusColor(a.status);
          const muted = a.muted_until && a.muted_until > Date.now();
          return (
            <div key={a.id} onClick={() => openDevice(a.id)} style={{
              display: 'grid', gridTemplateColumns: '1fr 130px 100px 80px 80px 80px 100px 80px', minWidth: 760,
              padding: '12px 14px', borderBottom: `1px solid ${C.hairline}`, cursor: 'pointer', fontSize: 13, alignItems: 'center',
            }}
              onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
              onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
              <div>
                <div style={{ fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' }}>
                  {a.label}
                  {muted && <VolumeX size={12} color={C.inkSubtle} />}
                </div>
                <div style={{ fontSize: 10, color: C.inkSubtle, marginTop: 2 }}>{a.room || '—'} · {a.rack || '—'}</div>
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 12, color: C.inkMuted }}>{a.ip || '—'}</div>
              <div style={{ color: C.inkMuted }}>{a.vendor || '—'}</div>
              <div>{a.battery_pct != null ? `${Math.round(a.battery_pct)}%` : '—'}</div>
              <div>{a.load_pct != null ? `${Math.round(a.load_pct)}%` : '—'}</div>
              <div>{a.temp_c != null ? `${Math.round(a.temp_c)}°` : '—'}</div>
              <div><span style={{ padding: '2px 8px', fontSize: 10, fontWeight: 700, background: sc.bg, color: sc.fg, border: `1px solid ${sc.fg}30` }}>{sc.label}</span></div>
              <div style={{ textAlign: 'right', fontSize: 11, color: C.inkSubtle }}>{fmtTime(a.last_polled)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// 4) Device Detail — fully rebuilt. Hero band on top (small icon, badges,
//    actions). Two-column body: spec card on the left, six metric tiles +
//    trend chart + alarms on the right. Everything sits in its own container,
//    nothing overflows or overlaps adjacent sections.
// ═══════════════════════════════════════════════════════════════════
function DeviceDetail({ id, onBack }) {
  const { isMobile } = useViewport();
  const [d, setD] = useState(null);
  const [range, setRange] = useState('24h');
  const [editOpen, setEditOpen] = useState(false);
  const [thresholdsOpen, setThresholdsOpen] = useState(false);
  const reload = () => api.get(`/v1/fms/assets/${id}?range=${range}`).then(r => r?.ok && setD(r));
  useEffect(() => { reload(); const t = setInterval(reload, 30000); return () => clearInterval(t); }, [id, range]);
  if (!d) return <Loading />;

  const a = d.asset;
  const sc = statusColor(a.status);
  const muted = a.muted_until && a.muted_until > Date.now();
  const reasons = (a.poll_error || '').split(/,\s*/).filter(Boolean);

  const muteFor = async (hours) => {
    await api.post(`/v1/fms/devices/${id}/mute`, { hours, reason: 'manual mute from detail' });
    reload();
  };
  const unmute = async () => { await api.post(`/v1/fms/devices/${id}/unmute`, {}); reload(); };

  // 6 primary metrics shown as a clean 3×2 (desktop) / 2×3 (mobile) grid
  const metrics = [
    { Icon: Battery,     label: tx('배터리', 'Battery'),  val: a.battery_pct != null ? Math.round(a.battery_pct) + '%' : '—', sub: a.battery_status || '—' },
    { Icon: Activity,    label: tx('부하', 'Load'),       val: a.load_pct != null ? Math.round(a.load_pct) + '%' : '—',     sub: tx('정격', 'rated VA') },
    { Icon: Thermometer, label: tx('온도', 'Temp'),       val: a.temp_c != null ? Math.round(a.temp_c) + '°C' : '—',         sub: tx('배터리', 'battery') },
    { Icon: Clock,       label: tx('런타임', 'Runtime'),   val: a.runtime_min != null ? Math.round(a.runtime_min) + 'm' : '—', sub: tx('남음', 'remaining') },
    { Icon: Power,       label: tx('출력', 'Output'),     val: a.output_v != null ? Math.round(a.output_v) + ' V' : '—',     sub: a.output_status || '—' },
    { Icon: Zap,         label: tx('입력', 'Input'),      val: a.input_v != null ? Math.round(a.input_v) + ' V' : '—',       sub: tx('주전원', 'mains') },
  ];

  return (
    <div style={{ padding: isMobile ? 12 : 24, maxWidth: 1280, margin: '0 auto' }}>
      {/* ── Back link ── */}
      <div onClick={onBack} style={{
        display: 'inline-flex', gap: 6, alignItems: 'center', color: C.inkMuted,
        fontSize: 13, cursor: 'pointer', marginBottom: 14,
      }}>
        <ArrowLeft size={14} /> {tx('장치 목록', 'Devices')}
      </div>

      {/* ── Title bar (one self-contained row) ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, lineHeight: 1.15 }}>{a.label}</h1>
          <div style={{ fontSize: 12, color: C.inkSubtle, marginTop: 4 }}>
            {[a.cbu && a.cbu.replace('_', ' '), a.location, a.room, a.rack].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <span style={{
          padding: '4px 10px', fontSize: 11, fontWeight: 700,
          background: sc.bg, color: sc.fg, border: `1px solid ${sc.fg}30`,
        }}>{sc.label}</span>
        {muted && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 10, fontWeight: 700, background: '#eee', color: C.inkSubtle }}>
            <VolumeX size={10} /> {tx('음소거', 'MUTED')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={() => setThresholdsOpen(true)} style={{ ...iconBtn, marginLeft: 0 }}>
          <Sliders size={13} /> {tx('임계치', 'Thresholds')}
        </button>
        {muted ? (
          <button onClick={unmute} style={{ ...iconBtn, marginLeft: 0 }}><Volume2 size={13} /> {tx('음소거 해제', 'Unmute')}</button>
        ) : (
          <button onClick={() => muteFor(1)} style={{ ...iconBtn, marginLeft: 0 }}><VolumeX size={13} /> {tx('음소거', 'Mute')} 1h</button>
        )}
        <button onClick={() => setEditOpen(true)} style={{
          ...iconBtn, marginLeft: 0, background: C.primary, color: '#fff', borderColor: C.primary,
        }}>
          <Edit3 size={13} /> {tx('편집', 'Edit')}
        </button>
      </div>

      {editOpen && <DeviceEditModal asset={a} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); reload(); }} />}
      {thresholdsOpen && <ThresholdEditModal deviceId={id} onClose={() => setThresholdsOpen(false)} onSaved={() => { setThresholdsOpen(false); reload(); }} />}

      {/* ── Two-column body ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '400px 1fr',
        gap: 16, alignItems: 'start',
      }}>
        {/* LEFT — spec card with photo */}
        <div style={{
          background: C.card, border: `1px solid ${C.hairline}`,
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Photo well — auto-fit the icon as large as possible in the box */}
          <div style={{
            height: 340, padding: 16, background: C.bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderBottom: `1px solid ${C.hairline}`,
          }}>
            <UpsModelIcon model={a.model}
              fitBox={{ width: 368, height: 308 }}
              status={a.status || 'unknown'} mode="inline" />
          </div>
          {/* Specs */}
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div style={{ fontSize: 9, color: C.inkSubtle, letterSpacing: '1px', fontWeight: 700, textTransform: 'uppercase' }}>
                {tx('모델', 'Model')}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{a.model || '—'}</div>
              <div style={{ display: 'inline-block', marginTop: 6 }}>
                <ModelTag model={a.model} accent={sc.fg} />
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${C.hairline}` }} />
            <SpecRow k="IP" v={<span style={{ fontFamily: 'monospace' }}>{a.ip || '—'}</span>} />
            <SpecRow k={tx('시리얼', 'Serial')} v={a.serial || '—'} />
            <SpecRow k={tx('펌웨어', 'Firmware')} v={a.firmware || '—'} />
            <SpecRow k="SNMP" v={`${a.snmp_version || 'v2c'} · ${a.snmp_community || 'public'} · :${a.snmp_port || 161}`} />
            <SpecRow k={tx('중요도', 'Criticality')} v={a.criticality || 'routine'} />
            <SpecRow k={tx('폴링', 'Polling')} v={a.polling_enabled ? <span style={{ color: C.ok, fontWeight: 700 }}>● {tx('활성', 'On')}</span> : <span style={{ color: C.inkSubtle }}>○ {tx('비활성', 'Off')}</span>} />
            <SpecRow k={tx('헬스 스코어', 'Health')} v={a.health_score != null ? a.health_score : '—'} />
            <SpecRow k={tx('마지막 폴링', 'Last poll')} v={fmtTime(a.last_polled)} />
          </div>
        </div>

        {/* RIGHT — metric tiles, reasons, trend, alarms */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {/* Reasons strip (when there's anything to flag) */}
          {reasons.length > 0 && (
            <div style={{
              background: sc.bg, borderLeft: `3px solid ${sc.fg}`, padding: '10px 14px',
              fontSize: 12, color: C.ink,
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: sc.fg, letterSpacing: '1px', marginRight: 8 }}>
                {tx('사유', 'REASONS')}
              </span>
              {reasons.join(' · ')}
            </div>
          )}

          {/* 3×2 / 2×3 metric grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)',
            gap: 10,
          }}>
            {metrics.map(m => (
              <div key={m.label} style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: C.inkSubtle, letterSpacing: '1px', fontWeight: 700, textTransform: 'uppercase' }}>
                  <m.Icon size={11} /> {m.label}
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6, color: C.ink, lineHeight: 1 }}>{m.val}</div>
                <div style={{ fontSize: 11, color: C.inkSubtle, marginTop: 4 }}>{m.sub}</div>
              </div>
            ))}
          </div>

          {/* Trend */}
          <div style={{ background: C.card, border: `1px solid ${C.hairline}` }}>
            <div style={{
              display: 'flex', alignItems: 'center', padding: '12px 14px',
              borderBottom: `1px solid ${C.hairline}`,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.inkMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                {tx('트렌드', 'Trend')} · {range}
              </span>
              <span style={{ flex: 1 }} />
              <div style={{ display: 'flex', gap: 4 }}>
                {['24h', '7d', '30d'].map(r => (
                  <button key={r} onClick={() => setRange(r)} style={{
                    padding: '3px 10px', fontSize: 11, fontWeight: 600,
                    background: range === r ? C.primary : 'transparent',
                    color: range === r ? '#fff' : C.inkMuted,
                    border: `1px solid ${range === r ? C.primary : C.hairline}`, cursor: 'pointer',
                  }}>{r}</button>
                ))}
              </div>
            </div>
            <div style={{ padding: 14, minHeight: 120 }}>
              {d.metrics.length === 0
                ? <div style={{ padding: 24, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>
                    {tx('데이터 없음 — 프로브 폴링 시작 시 채워집니다.', 'No data — fills as probe begins polling.')}
                  </div>
                : <ThresholdGraph series={[
                    { key: 'battery_pct', color: C.ok,       label: tx('배터리 %', 'Battery %'), data: d.metrics, threshold: d.thresholds.battery_pct },
                    { key: 'load_pct',    color: C.primary,  label: tx('부하 %', 'Load %'),     data: d.metrics, threshold: d.thresholds.load_pct },
                    { key: 'temp_c',      color: C.critical, label: tx('온도 °C', 'Temp °C'),    data: d.metrics, threshold: d.thresholds.temp_c },
                  ]} />
              }
            </div>
          </div>

          {/* Device control panel — only renders when the tenant has allow-listed actions */}
          <DeviceControlPanel deviceId={id} />

          {/* Alarm history */}
          <div style={{ background: C.card, border: `1px solid ${C.hairline}` }}>
            <div style={{
              padding: '12px 14px', borderBottom: `1px solid ${C.hairline}`,
              fontSize: 11, fontWeight: 700, color: C.inkMuted, letterSpacing: '0.5px', textTransform: 'uppercase',
            }}>
              {tx('알람 이력', 'Alarm history')} ({d.alerts.length})
            </div>
            {d.alerts.length === 0
              ? <div style={{ padding: 24, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>
                  {tx('알람 없음', 'No alarms')}
                </div>
              : d.alerts.map(al => {
                  const sc2 = sevColor(al.priority);
                  return (
                    <div key={al.id} style={{
                      padding: '10px 14px', borderBottom: `1px solid ${C.hairline}`,
                      display: 'flex', gap: 12, alignItems: 'center', fontSize: 13,
                    }}>
                      <span style={{ padding: '2px 8px', fontSize: 10, fontWeight: 700, background: sc2.fg, color: '#fff', minWidth: 24, textAlign: 'center' }}>{al.priority}</span>
                      <span style={{ flex: 1 }}>{al.message}</span>
                      <span style={{ color: C.inkSubtle, fontSize: 11 }}>{fmtAbs(al.received_at)}</span>
                    </div>
                  );
                })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Small helper used by the spec card
function SpecRow({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, fontSize: 12 }}>
      <span style={{ color: C.inkSubtle }}>{k}</span>
      <span style={{ color: C.ink, fontWeight: 600, textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// 5) Alarms (with threshold zones + mute + recurring)
// ═══════════════════════════════════════════════════════════════════
function AlarmsView() {
  const { openAlarm } = useFmsModal();
  const [list, setList] = useState([]);
  const [hours, setHours] = useState(24);
  const reload = () => api.get(`/v1/fms/alerts?hours=${hours}`).then(d => d?.ok && setList(d.alerts));
  useEffect(() => { reload(); const t = setInterval(reload, 30000); return () => clearInterval(t); }, [hours]);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{tx('알람', 'Alarms')}</h1>
        <span style={{ flex: 1 }} />
        <select value={hours} onChange={e => setHours(parseInt(e.target.value, 10))} style={{
          padding: '6px 10px', fontSize: 12, fontFamily: FONT, border: `1px solid ${C.hairline}`, background: C.card,
        }}>
          <option value={1}>{tx('1시간', '1 hour')}</option>
          <option value={24}>{tx('24시간', '24h')}</option>
          <option value={168}>{tx('7일', '7 days')}</option>
          <option value={720}>{tx('30일', '30 days')}</option>
        </select>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.hairline}` }}>
        {list.length === 0
          ? <div style={{ padding: 40, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>{tx('알람 없음', 'No alarms')}</div>
          : list.map(a => {
              const sc = sevColor(a.priority);
              const muted = a.muted_until && a.muted_until > Date.now();
              return (
                <div key={a.id} onClick={() => openAlarm(a)} style={{
                  padding: '14px 18px', borderBottom: `1px solid ${C.hairline}`,
                  display: 'flex', gap: 14, alignItems: 'center', fontSize: 13,
                  opacity: muted ? 0.5 : 1, cursor: 'pointer',
                }}
                  onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                  onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                  <span style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, background: sc.fg, color: '#fff', minWidth: 28, textAlign: 'center' }}>{a.priority}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}>
                      {a.message}
                      {a.recurring && <span style={{ padding: '1px 6px', fontSize: 9, background: C.warnSoft, color: C.warn, fontWeight: 700 }}>{tx('반복', 'RECURRING')}</span>}
                      {muted && <span style={{ padding: '1px 6px', fontSize: 9, background: '#eee', color: C.inkSubtle, fontWeight: 700 }}><VolumeX size={9} style={{ verticalAlign: 'middle' }} /> {tx('음소거', 'MUTED')}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: C.inkSubtle, marginTop: 2 }}>
                      {a.device_label || a.device_id} · {a.metric} {a.value != null && `= ${a.value}`}{a.threshold != null && ` (${tx('임계', 'threshold')} ${a.threshold})`}
                    </div>
                  </div>
                  <span style={{ color: C.inkSubtle, fontSize: 11 }}>{fmtAbs(a.received_at)}</span>
                </div>
              );
            })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 6) Alarm Map (multi-customer / multi-site geographic view)
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// 6) Alarm Map — MapLibre GL + Carto positron raster tiles (free)
// ═══════════════════════════════════════════════════════════════════
//
// Style chosen: Carto Positron (no API key, free for under 75k loads/day,
// attribution baked into MapLibre). For on-prem packaging the tile URL
// can be swapped to a self-hosted MBTiles+TileServerGL with no other
// changes needed.

const POSITRON_STYLE = {
  version: 8,
  sources: {
    'carto-light': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#e8eef5' } },
    { id: 'carto-light', type: 'raster', source: 'carto-light' },
  ],
};

function AlarmMap() {
  const { isMobile } = useViewport();
  const { openSiteDevices } = useFmsModal();
  const [sites, setSites] = useState([]);
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => { api.get('/v1/fms/sites-map').then(d => d?.ok && setSites(d.sites)); }, []);

  // Initialise map once
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: POSITRON_STYLE,
      center: [-95, 37], // continental US center
      zoom: 3.2,
      attributionControl: true,
      cooperativeGestures: false,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Render markers when sites change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sites.length) return;

    // Clear previous
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    sites.forEach(s => {
      if (s.lat == null || s.lng == null) return;
      const color = s.critical > 0 ? C.critical : s.warn > 0 ? C.warn : C.ok;

      // Custom HTML marker — pulsing halo + solid dot
      const el = document.createElement('div');
      el.className = 'fms-pin';
      el.style.cssText = `position:relative; width:18px; height:18px; cursor:pointer;`;
      el.innerHTML = `
        <span style="
          position:absolute; left:-10px; top:-10px; width:38px; height:38px; border-radius:50%;
          background:${color}; opacity:0.18; animation: fmsPulseDot 2s ease-in-out infinite;"></span>
        <span style="
          position:absolute; inset:0; border-radius:50%;
          background:${color}; border:3px solid #fff;
          box-shadow: 0 2px 8px rgba(0,0,0,0.30);"></span>
      `;

      const popupHtml = `
        <div style="font-family:'IBM Plex Sans','Helvetica Neue',Arial,sans-serif; padding:4px 2px; min-width:200px;">
          <div style="font-weight:700; font-size:13px; color:${C.ink}; margin-bottom:3px;">
            ${s.company || s.name}
          </div>
          <div style="font-size:11px; color:${C.inkMuted}; margin-bottom:8px; line-height:1.4;">
            ${s.address || ''}
          </div>
          <div style="display:flex; gap:10px; font-size:11px; align-items:center;">
            <span style="padding:2px 8px; background:${C.bg}; font-weight:700; color:${C.ink};">${s.total} UPS</span>
            ${s.critical > 0 ? `<span style="color:${C.critical}; font-weight:700;">● ${s.critical} 위험</span>` : ''}
            ${s.warn > 0 ? `<span style="color:${C.warn}; font-weight:700;">● ${s.warn} 경고</span>` : ''}
            ${s.ok > 0 ? `<span style="color:${C.ok};">● ${s.ok} 정상</span>` : ''}
          </div>
          <div style="margin-top:10px; font-size:11px; color:${C.primary}; font-weight:700; cursor:pointer;">
            → 장치 인벤토리 보기
          </div>
        </div>
      `;
      const popup = new maplibregl.Popup({ offset: 22, closeButton: false, className: 'fms-popup' }).setHTML(popupHtml);

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([s.lng, s.lat])
        .setPopup(popup)
        .addTo(map);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openSiteDevices(s.cbu);
      });

      markersRef.current.push(marker);
    });

    // Fit bounds to all sites with padding
    if (sites.length >= 2) {
      const bounds = new maplibregl.LngLatBounds();
      sites.forEach(s => { if (s.lat != null && s.lng != null) bounds.extend([s.lng, s.lat]); });
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 80, maxZoom: 11, duration: 600 });
      }
    } else if (sites.length === 1 && sites[0].lat != null) {
      map.flyTo({ center: [sites[0].lng, sites[0].lat], zoom: 11, duration: 600 });
    }
  }, [sites]);

  // Inject a small bit of CSS once for the popup styling
  useEffect(() => {
    if (document.getElementById('fms-map-css')) return;
    const s = document.createElement('style');
    s.id = 'fms-map-css';
    s.textContent = `
      .fms-popup .maplibregl-popup-content { padding: 10px 12px; box-shadow: 0 6px 22px rgba(0,0,0,0.14); border: 1px solid ${C.hairline}; }
      .fms-popup .maplibregl-popup-tip { display:none; }
      .maplibregl-ctrl-attrib { font-size: 10px; }
    `;
    document.head.appendChild(s);
  }, []);

  return (
    <div style={{ padding: isMobile ? 12 : 24 }}>
      <h1 style={{ margin: '0 0 14px', fontSize: isMobile ? 18 : 22, fontWeight: 700 }}>{tx('알람 지도', 'Alarm Map')}</h1>
      <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 16 }}>
        <div style={{ fontSize: 11, color: C.inkSubtle, letterSpacing: '0.4px', fontWeight: 700, marginBottom: 10, textTransform: 'uppercase' }}>
          {tx('운영중인 모든 사이트 — 알람 심각도별 색상', 'All operated sites — color-coded by alarm severity')}
        </div>
        <div ref={mapContainer} style={{ width: '100%', height: isMobile ? 360 : 560, borderRadius: 0, overflow: 'hidden' }} />
        <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: C.inkMuted, flexWrap: 'wrap' }}>
          {[
            { c: C.critical, l: tx('위험', 'Critical') },
            { c: C.warn, l: tx('경고', 'Warning') },
            { c: C.ok, l: tx('정상', 'Normal') },
          ].map(x => (
            <span key={x.l} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ width: 10, height: 10, background: x.c, borderRadius: '50%' }} /> {x.l}
            </span>
          ))}
        </div>
      </div>

      {/* Sites table — address list */}
      <Section title={tx('사이트 주소', 'Site addresses')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, overflowX: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '120px 1fr 280px 80px 80px', minWidth: 620,
            padding: '10px 14px', fontSize: 10, fontWeight: 700, color: C.inkSubtle, letterSpacing: '0.4px',
            textTransform: 'uppercase', borderBottom: `1px solid ${C.hairline}`, background: '#fafafa',
          }}>
            <div>CBU</div>
            <div>{tx('회사', 'Company')}</div>
            <div>{tx('주소', 'Address')}</div>
            <div style={{ textAlign: 'right' }}>UPS</div>
            <div style={{ textAlign: 'right' }}>{tx('알람', 'Alarms')}</div>
          </div>
          {sites.map(s => {
            const totalAlarms = (s.critical || 0) + (s.warn || 0);
            return (
              <div key={s.cbu} onClick={() => openSiteDevices(s.cbu)} style={{
                display: 'grid', gridTemplateColumns: '120px 1fr 280px 80px 80px', minWidth: 620,
                padding: '10px 14px', borderBottom: `1px solid ${C.hairline}`, fontSize: 13, cursor: 'pointer', alignItems: 'center',
              }}
                onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                <div style={{ fontWeight: 700 }}>{s.name}</div>
                <div style={{ color: C.inkMuted }}>{s.company}</div>
                <div style={{ fontSize: 12, color: C.inkMuted }}>{s.address}</div>
                <div style={{ textAlign: 'right', fontWeight: 700 }}>{s.total}</div>
                <div style={{ textAlign: 'right', fontWeight: 700, color: totalAlarms > 0 ? C.critical : C.ok }}>{totalAlarms}</div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// Admin
// ═══════════════════════════════════════════════════════════════════
function Admin({ user }) {
  const [tab, setTab] = useState('profile');
  const tabs = [
    { id: 'profile', label: tx('프로필', 'Profile') },
    { id: 'devices', label: tx('장치 등록', 'Devices') },
    { id: 'reports', label: tx('월간 리포트', 'Reports') },
    { id: 'channels', label: tx('알림 채널', 'Channels') },
    { id: 'control', label: tx('장치 제어', 'Device Control') },
  ];
  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <h1 style={{ margin: '0 0 14px', fontSize: 22, fontWeight: 700 }}>{tx('관리', 'Admin')}</h1>
      {/* Subtabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${C.hairline}`, marginBottom: 18 }}>
        {tabs.map(t => (
          <div key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '10px 18px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            color: tab === t.id ? C.primary : C.inkMuted,
            borderBottom: tab === t.id ? `2px solid ${C.primary}` : '2px solid transparent',
            marginBottom: -1,
          }}>{t.label}</div>
        ))}
      </div>

      {tab === 'profile' && (
        <Section title={tx('프로필', 'Profile')}>
          <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 16, fontSize: 13 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px 16px' }}>
              <Row k={tx('이름', 'Name')} v={user?.name || '—'} />
              <Row k="Email" v={user?.email || '—'} />
              <Row k={tx('역할', 'Role')} v={user?.role || '—'} />
              <Row k={tx('테넌트', 'Tenant')} v={`HAEA (id ${user?.tenantId})`} />
            </div>
          </div>
        </Section>
      )}

      {tab === 'devices' && <DevicesAdmin />}

      {tab === 'reports' && <ReportsAdmin user={user} />}

      {tab === 'channels' && <ChannelsAdmin />}

      {tab === 'control' && <ControlAdmin />}
    </div>
  );
}

// ─── Admin → Devices subtab: bulk CSV import + per-device edit ─────
function DevicesAdmin() {
  const { openDevice } = useFmsModal();
  const [assets, setAssets] = useState([]);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = () => api.get('/v1/fms/assets').then(d => d?.ok && setAssets(d.assets));
  useEffect(() => { reload(); }, []);

  // CSV parser — handles quoted fields and commas
  const parseCsv = (text) => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return { headers: [], rows: [] };
    const splitLine = (line) => {
      const out = []; let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; continue; }
        if (c === ',' && !inQ) { out.push(cur.trim()); cur = ''; continue; }
        cur += c;
      }
      out.push(cur.trim());
      return out;
    };
    const headers = splitLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
    const rows = lines.slice(1).map(line => {
      const cells = splitLine(line);
      const o = {};
      headers.forEach((h, i) => { o[h] = cells[i] ?? ''; });
      return o;
    });
    return { headers, rows };
  };

  const doPreview = () => {
    const p = parseCsv(csv);
    setPreview(p);
    setResult(null);
  };

  const doImport = async () => {
    if (!preview?.rows?.length) return;
    setBusy(true);
    const r = await api.post('/v1/fms/assets/bulk-import', { rows: preview.rows });
    setBusy(false);
    setResult(r);
    if (r?.ok) reload();
  };

  const sample = `label,ip,snmp_community,snmp_port,location,room,rack,criticality
HAEA-UPS-001,10.0.1.11,public,161,Irvine HQ,Server Room A,Rack 1,production
HAEA-UPS-002,10.0.1.12,public,161,Irvine HQ,Server Room A,Rack 2,production`;

  return (
    <>
      <Section title={tx('CSV 일괄 등록', 'Bulk CSV import')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 16 }}>
          <div style={{ fontSize: 12, color: C.inkMuted, marginBottom: 10 }}>
            {tx('컬럼: ', 'Columns: ')}
            <code style={{ background: C.bg, padding: '2px 6px', fontSize: 11 }}>label, ip, snmp_community, snmp_port, location, room, rack, criticality</code>
            <span style={{ marginLeft: 8 }}>· {tx('label은 필수, 동일 label은 업데이트', 'label required; same label is upserted')}</span>
          </div>
          <textarea value={csv} onChange={e => setCsv(e.target.value)}
            placeholder={sample}
            rows={8} style={{ ...fieldStyle, fontFamily: 'monospace', fontSize: 12, resize: 'vertical', marginBottom: 10 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={doPreview} style={iconBtn}><Sliders size={13} /> {tx('미리보기', 'Preview')}</button>
            <button onClick={() => setCsv(sample)} style={iconBtn}>{tx('샘플 채우기', 'Fill sample')}</button>
            <span style={{ flex: 1 }} />
            <button onClick={doImport} disabled={busy || !preview?.rows?.length} style={{
              ...iconBtn, background: C.primary, color: '#fff', borderColor: C.primary,
              opacity: (busy || !preview?.rows?.length) ? 0.5 : 1,
            }}>
              <Upload size={13} /> {busy ? tx('업로드 중…', 'Uploading…') : `${tx('업로드', 'Upload')} (${preview?.rows?.length || 0})`}
            </button>
          </div>

          {preview && (
            <div style={{ marginTop: 14, background: C.bg, padding: 12, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
              <div style={{ ...labelStyle, marginBottom: 6 }}>{tx('미리보기', 'Preview')} ({preview.rows.length} {tx('행', 'rows')})</div>
              {preview.rows.slice(0, 10).map((r, i) => (
                <div key={i} style={{ fontFamily: 'monospace', fontSize: 11, padding: '2px 0', borderBottom: `1px solid ${C.hairline}` }}>
                  <strong>{r.label}</strong> · {r.ip} · {r.location} / {r.room} / {r.rack}
                </div>
              ))}
              {preview.rows.length > 10 && <div style={{ fontSize: 11, color: C.inkSubtle, marginTop: 6 }}>… +{preview.rows.length - 10}</div>}
            </div>
          )}
          {result && (
            <div style={{ marginTop: 12, padding: 12, background: result.ok ? C.okSoft : C.criticalSoft, color: result.ok ? C.ok : C.critical, fontSize: 13 }}>
              {result.ok
                ? `✓ ${tx('성공', 'Success')} — ${tx('생성', 'created')}: ${result.created}, ${tx('업데이트', 'updated')}: ${result.updated}, ${tx('스킵', 'skipped')}: ${result.skipped}`
                : `⚠ ${result.error}`}
              {result.errors?.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11 }}>
                  {result.errors.map((e, i) => <div key={i}>row {e.row}: {e.reason}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title={`${tx('등록된 장치', 'Registered devices')} · ${assets.length}`}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, overflowX: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 140px 140px 100px 100px 90px', minWidth: 720,
            padding: '10px 14px', fontSize: 10, fontWeight: 700, color: C.inkSubtle, letterSpacing: '0.4px',
            textTransform: 'uppercase', borderBottom: `1px solid ${C.hairline}`, background: '#fafafa',
          }}>
            <div>{tx('장치', 'Device')}</div>
            <div>{tx('IP', 'IP')}</div>
            <div>{tx('룸 · 랙', 'Room · Rack')}</div>
            <div>{tx('중요도', 'Criticality')}</div>
            <div>{tx('폴링', 'Polling')}</div>
            <div style={{ textAlign: 'right' }}>{tx('편집', 'Edit')}</div>
          </div>
          {assets.map(a => (
            <div key={a.id} style={{
              display: 'grid', gridTemplateColumns: '1fr 140px 140px 100px 100px 90px', minWidth: 720,
              padding: '10px 14px', fontSize: 13, alignItems: 'center', borderBottom: `1px solid ${C.hairline}`,
            }}>
              <div style={{ fontWeight: 600 }}>{a.label}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 12, color: C.inkMuted }}>{a.ip || '—'}</div>
              <div style={{ fontSize: 12, color: C.inkMuted }}>{a.room || '—'} · {a.rack || '—'}</div>
              <div style={{ fontSize: 12 }}>{a.criticality || 'routine'}</div>
              <div>
                <span style={{
                  padding: '2px 6px', fontSize: 10, fontWeight: 700,
                  background: a.polling_enabled ? C.okSoft : '#eee',
                  color: a.polling_enabled ? C.ok : C.inkSubtle,
                }}>{a.polling_enabled ? 'ON' : 'OFF'}</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <button onClick={() => openDevice(a.id)} style={{ ...iconBtn, marginLeft: 0 }}>
                  <Edit3 size={12} /> {tx('편집', 'Edit')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

// ─── Admin → Device Control subtab ─ feature flags + EcoStruxure creds + audit log ─
function ControlAdmin() {
  const [cfg, setCfg] = useState(null);
  const [actions, setActions] = useState([]);
  const [log, setLog] = useState([]);
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState(null);

  const loadAll = () => {
    api.get('/v1/fms/control/config').then(d => d?.ok && setCfg(d.config));
    api.get('/v1/fms/control/actions').then(d => d?.ok && setActions(d.actions));
    api.get('/v1/fms/control/log?limit=50').then(d => d?.ok && setLog(d.log));
  };
  useEffect(() => { loadAll(); }, []);

  const save = async (patch) => {
    setMsg(null);
    const body = { ...patch };
    if (secret) body.ecostruxure_client_secret = secret;
    const r = await api.put('/v1/fms/control/config', body);
    if (r?.ok) { setMsg({ ok: true, text: tx('저장 완료', 'Saved') }); setSecret(''); loadAll(); }
    else setMsg({ ok: false, text: r?.error || 'failed' });
  };

  const toggleAction = (key) => {
    if (!cfg) return;
    const cur = new Set(cfg.allowed_actions || []);
    if (cur.has(key)) cur.delete(key); else cur.add(key);
    save({ allowed_actions: [...cur] });
  };

  if (!cfg) return <Loading />;

  const riskColor = (r) => r === 'high' ? C.critical : r === 'medium' ? C.warn : C.ok;

  return (
    <>
      <Section title={tx('마스터 스위치', 'Master switch')}>
        <div style={{
          background: C.card, border: `1px solid ${C.hairline}`,
          borderLeft: `4px solid ${cfg.control_enabled ? C.warn : C.inkSubtle}`,
          padding: 18,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                {tx('장치 제어', 'Device control')} {cfg.control_enabled
                  ? <span style={{ color: C.warn, fontWeight: 700 }}>· ON</span>
                  : <span style={{ color: C.inkSubtle }}>· OFF (Dry-run)</span>}
              </div>
              <div style={{ fontSize: 12, color: C.inkMuted, marginTop: 4 }}>
                {tx('OFF 상태에서는 모든 액션이 audit log에 기록만 되고 실제 장치엔 전송되지 않습니다.', 'When OFF, every action is dry-run logged only — nothing is sent to the device.')}
              </div>
            </div>
            <button onClick={() => save({ control_enabled: !cfg.control_enabled })} style={{
              padding: '8px 16px', fontSize: 12, fontWeight: 700,
              background: cfg.control_enabled ? C.critical : C.primary, color: '#fff',
              border: 'none', cursor: 'pointer',
            }}>
              {cfg.control_enabled ? tx('비활성화', 'Disable') : tx('활성화', 'Enable')}
            </button>
          </div>
        </div>
      </Section>

      <Section title={tx('채널', 'Channels')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 18, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          {[
            { k: 'snmp_enabled',        label: 'SNMP v3 SET',          hint: '범용 폴백, NMC v3 rw 자격증명 필요' },
            { k: 'nmc_http_enabled',    label: 'NMC HTTP/REST',        hint: 'NMC3 신규 펌웨어, http auth 필요' },
            { k: 'ecostruxure_enabled', label: 'EcoStruxure IT API',   hint: 'OAuth2, partner cred 필요' },
          ].map(c => (
            <div key={c.k} style={{ padding: 12, border: `1px solid ${C.hairline}`, background: cfg[c.k] ? C.primarySoft : '#fff' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!cfg[c.k]} onChange={() => save({ [c.k]: !cfg[c.k] })} />
                <span style={{ fontWeight: 700, fontSize: 12 }}>{c.label}</span>
              </label>
              <div style={{ fontSize: 11, color: C.inkSubtle, marginTop: 6 }}>{c.hint}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title={tx('허용 액션', 'Allowed actions')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 14 }}>
          <div style={{ fontSize: 11, color: C.inkMuted, marginBottom: 10 }}>
            {tx('체크된 액션만 device control panel에 노출됩니다.', 'Only checked actions are exposed in the device control panel.')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {actions.map(a => (
              <label key={a.key} style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, padding: 10,
                border: `1px solid ${C.hairline}`, borderLeft: `3px solid ${riskColor(a.risk)}`,
                background: a.allowed ? '#fafafa' : '#fff', cursor: 'pointer',
              }}>
                <input type="checkbox" checked={!!a.allowed} onChange={() => toggleAction(a.key)} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{a.label}</div>
                  <div style={{ fontSize: 10, color: C.inkSubtle, marginTop: 2 }}>
                    <span style={{ color: riskColor(a.risk), fontWeight: 700 }}>{a.risk.toUpperCase()}</span>
                    {' · '}<code style={{ fontSize: 9 }}>{a.key}</code>
                  </div>
                  <div style={{ fontSize: 9, color: C.inkSubtle, marginTop: 4 }}>
                    {a.supports.snmp && '● SNMP '}{a.supports.nmc_http && '● NMC '}{a.supports.ecostruxure && '● ESX'}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
      </Section>

      <Section title={tx('EcoStruxure IT 자격증명', 'EcoStruxure IT credentials')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 16 }}>
          <div style={{ fontSize: 11, color: C.inkMuted, marginBottom: 12 }}>
            {tx('Schneider Electric Partner Manager에서 OAuth2 자격증명을 발급받으세요. exchange.se.com → "EcoStruxure IT for ISV/MSP".', 'Get OAuth2 creds from your Schneider Electric Partner Manager. exchange.se.com → "EcoStruxure IT for ISV/MSP".')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <Field label="Client ID">
              <input style={fieldStyle} value={cfg.ecostruxure_client_id || ''}
                onChange={e => setCfg({ ...cfg, ecostruxure_client_id: e.target.value })} />
            </Field>
            <Field label="Client Secret">
              <input type="password" style={fieldStyle} value={secret}
                onChange={e => setSecret(e.target.value)}
                placeholder={cfg.has_ecostruxure_secret ? tx('●●● 저장됨 (변경 시 입력)', '●●● stored') : ''} />
            </Field>
            <Field label="Organization ID">
              <input style={fieldStyle} value={cfg.ecostruxure_org_id || ''}
                onChange={e => setCfg({ ...cfg, ecostruxure_org_id: e.target.value })} />
            </Field>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => save({
              ecostruxure_client_id: cfg.ecostruxure_client_id || '',
              ecostruxure_org_id: cfg.ecostruxure_org_id || '',
            })} style={{ ...iconBtn, background: C.primary, color: '#fff', borderColor: C.primary }}>
              <CheckCircle2 size={13} /> {tx('저장', 'Save')}
            </button>
          </div>
        </div>
      </Section>

      {msg && (
        <div style={{ padding: 10, fontSize: 12, marginBottom: 14,
          background: msg.ok ? C.okSoft : C.criticalSoft,
          color: msg.ok ? C.ok : C.critical }}>
          {msg.ok ? '✓ ' : '⚠ '}{msg.text}
        </div>
      )}

      <Section title={tx('감사 로그 (최근 50)', 'Audit log (last 50)')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, overflowX: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '110px 1fr 130px 90px 80px 70px 1fr', minWidth: 800,
            padding: '10px 14px', fontSize: 10, fontWeight: 700, color: C.inkSubtle, letterSpacing: '0.4px',
            textTransform: 'uppercase', borderBottom: `1px solid ${C.hairline}`, background: '#fafafa',
          }}>
            <div>{tx('시각', 'Time')}</div>
            <div>{tx('장치', 'Device')}</div>
            <div>{tx('액션', 'Action')}</div>
            <div>{tx('채널', 'Channel')}</div>
            <div>{tx('결과', 'Result')}</div>
            <div>{tx('모드', 'Mode')}</div>
            <div>{tx('사용자', 'User')}</div>
          </div>
          {log.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>
              {tx('아직 액션 기록 없음', 'No actions yet')}
            </div>
          ) : log.map(l => (
            <div key={l.id} style={{
              display: 'grid', gridTemplateColumns: '110px 1fr 130px 90px 80px 70px 1fr', minWidth: 800,
              padding: '8px 14px', fontSize: 12, borderBottom: `1px solid ${C.hairline}`, alignItems: 'center',
            }}>
              <div style={{ color: C.inkMuted, fontSize: 11 }}>{fmtTime(l.executed_at)}</div>
              <div>{l.device_label || `#${l.device_id}`}</div>
              <div><code style={{ fontSize: 11 }}>{l.action}</code></div>
              <div style={{ fontSize: 11, color: C.inkMuted }}>{l.channel}</div>
              <div>
                <span style={{
                  padding: '2px 6px', fontSize: 10, fontWeight: 700,
                  background: l.ok ? C.okSoft : C.criticalSoft,
                  color: l.ok ? C.ok : C.critical,
                }}>{l.ok ? 'OK' : 'FAIL'}</span>
              </div>
              <div>
                <span style={{
                  padding: '2px 6px', fontSize: 9, fontWeight: 700,
                  background: l.dry_run ? '#eee' : C.warnSoft,
                  color: l.dry_run ? C.inkSubtle : C.warn,
                }}>{l.dry_run ? 'DRY' : 'LIVE'}</span>
              </div>
              <div style={{ fontSize: 11, color: C.inkSubtle }}>{l.user_email || '—'}</div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

// ─── DeviceControlPanel ─ used inside the device detail page ─────
function DeviceControlPanel({ deviceId }) {
  const [actions, setActions] = useState([]);
  const [enabled, setEnabled] = useState(null); // null=loading, true=control ON, false=dry-run
  const [confirm, setConfirm] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.get('/v1/fms/control/actions').then(d => {
      if (!d?.ok) return;
      setActions((d.actions || []).filter(a => a.allowed));
      setEnabled(!!d.config?.control_enabled);
    });
  }, []);

  const fire = async (action, params) => {
    setResult(null);
    const r = await api.post(`/v1/fms/devices/${deviceId}/action`, { action: action.key, params: params || {} });
    setResult(r);
    setConfirm(null);
  };

  if (actions.length === 0) {
    return null;
  }

  const riskColor = (r) => r === 'high' ? C.critical : r === 'medium' ? C.warn : C.ok;

  return (
    <div style={{ background: C.card, border: `1px solid ${C.hairline}` }}>
      <div style={{
        padding: '12px 14px', borderBottom: `1px solid ${C.hairline}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.inkMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
          {tx('장치 제어', 'Device control')}
        </span>
        <span style={{
          padding: '2px 8px', fontSize: 9, fontWeight: 700,
          background: enabled ? C.warnSoft : '#eee',
          color: enabled ? C.warn : C.inkSubtle,
        }}>{enabled ? 'LIVE' : 'DRY-RUN'}</span>
        {!enabled && (
          <span style={{ fontSize: 11, color: C.inkSubtle }}>
            {tx('관리에서 활성화 가능. 비활성 시 audit에만 기록.', 'Enable in Admin. While off, calls are audit-only.')}
          </span>
        )}
      </div>
      <div style={{ padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {actions.map(a => (
          <button key={a.key} onClick={() => setConfirm(a)} style={{
            padding: 12, background: '#fff', border: `1px solid ${C.hairline}`,
            borderLeft: `3px solid ${riskColor(a.risk)}`,
            cursor: 'pointer', textAlign: 'left',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}
            onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
            onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{a.label}</div>
            <div style={{ fontSize: 10, color: riskColor(a.risk), fontWeight: 700 }}>
              {a.risk.toUpperCase()}
              {a.supports.ecostruxure && ' · ESX'}
              {a.supports.nmc_http && ' · NMC'}
              {a.supports.snmp && ' · SNMP'}
            </div>
          </button>
        ))}
      </div>

      {confirm && <ConfirmActionModal action={confirm} enabled={enabled} onCancel={() => setConfirm(null)}
        onConfirm={(params) => fire(confirm, params)} />}

      {result && (
        <div style={{ borderTop: `1px solid ${C.hairline}`, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.inkSubtle, marginBottom: 8 }}>
            {tx('결과', 'Result')} · {result.dry_run ? 'DRY-RUN' : 'LIVE'} · channel={result.channel || '—'}
          </div>
          {result.error && (
            <div style={{ padding: 10, background: C.criticalSoft, color: C.critical, fontSize: 12 }}>
              ⚠ {result.error}
            </div>
          )}
          {result.payload && (
            <pre style={{ fontSize: 10, color: C.inkMuted, background: C.bg, padding: 10, overflowX: 'auto', margin: 0 }}>
              {JSON.stringify(result.payload, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmActionModal({ action, enabled, onCancel, onConfirm }) {
  const [params, setParams] = useState({});
  const needsParams = !!action.paramSchema;
  const high = action.risk === 'high';
  return (
    <Modal title={tx('액션 확인', 'Confirm action')} onClose={onCancel} width={460}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <span style={{
          padding: '4px 10px', fontSize: 11, fontWeight: 700, color: '#fff',
          background: action.risk === 'high' ? C.critical : action.risk === 'medium' ? C.warn : C.ok,
        }}>{action.risk.toUpperCase()}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{action.label}</div>
          <code style={{ fontSize: 10, color: C.inkSubtle }}>{action.key}</code>
        </div>
      </div>

      {high && (
        <div style={{ padding: 10, background: C.criticalSoft, borderLeft: `3px solid ${C.critical}`, fontSize: 12, color: C.critical, marginBottom: 14 }}>
          ⚠ {tx('이 액션은 서비스 중단을 유발할 수 있습니다. 진행 전 운영팀에 알려주세요.', 'This action may cause service interruption. Notify the ops team before proceeding.')}
        </div>
      )}

      {!enabled && (
        <div style={{ padding: 10, background: '#f4f4f4', fontSize: 11, color: C.inkMuted, marginBottom: 14 }}>
          {tx('현재 dry-run 모드 — 실제 장치엔 전송되지 않고 audit log에만 기록됩니다.', 'Currently dry-run — call will be audit-logged only, never reach the device.')}
        </div>
      )}

      {needsParams && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          {Object.entries(action.paramSchema).map(([k, hint]) => (
            <Field key={k} label={`${k} (${hint})`}>
              <input style={fieldStyle} value={params[k] || ''}
                onChange={e => setParams({ ...params, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onCancel} style={iconBtn}>{tx('취소', 'Cancel')}</button>
        <button onClick={() => onConfirm(params)} style={{
          ...iconBtn, marginLeft: 0,
          background: high ? C.critical : C.primary, color: '#fff',
          borderColor: high ? C.critical : C.primary,
        }}>
          <CheckCircle2 size={13} /> {enabled ? tx('실행', 'Execute') : tx('Dry-run', 'Dry-run')}
        </button>
      </div>
    </Modal>
  );
}

// ─── Admin → Channels subtab ─ notification route CRUD + test/simulate ─
const CHANNEL_META = {
  line:       { label: 'LINE Notify',       dot: '#06c755', help: { ko: 'notify-bot.line.me 에서 발급한 Personal/Group Access Token', en: 'Personal/Group token from notify-bot.line.me' }, placeholder: 'NOTIFY_TOKEN_xxxx' },
  sms:        { label: 'SMS',               dot: '#0f62fe', help: { ko: '+E.164 형식의 휴대전화 번호 (예: +14155551212)', en: 'Phone number in E.164 format (e.g. +14155551212)' }, placeholder: '+14155551212' },
  teams:      { label: 'Microsoft Teams',   dot: '#5059c9', help: { ko: 'Incoming Webhook URL 또는 Power Automate Workflow URL. 폴백: teamId/channelId (AAD Bot 필요)', en: 'Incoming Webhook URL or Power Automate Workflow URL. Fallback: teamId/channelId (needs AAD bot)' }, placeholder: 'https://prod-xx.westus.logic.azure.com/workflows/...' },
  email:      { label: 'Email (SMTP)',      dot: '#ff8389', help: { ko: '쉼표로 다중 수신자 지정 가능', en: 'Comma-separated for multiple recipients' }, placeholder: 'ops@example.com, oncall@example.com' },
  slack:      { label: 'Slack',             dot: '#611f69', help: { ko: 'Slack 워크스페이스 → Apps → Incoming Webhooks 에서 발급', en: 'Slack workspace → Apps → Incoming Webhooks' }, placeholder: 'https://hooks.slack.com/services/T.../B.../...' },
  discord:    { label: 'Discord',           dot: '#5865f2', help: { ko: '채널 설정 → 연동 → 웹훅 에서 URL 발급', en: 'Channel settings → Integrations → Webhooks' }, placeholder: 'https://discord.com/api/webhooks/.../...' },
  pagerduty:  { label: 'PagerDuty',         dot: '#06ac38', help: { ko: 'Service → Integrations → Events API v2 의 32자리 Integration Key (routing key)', en: 'Service → Integrations → Events API v2 Integration Key (routing key)' }, placeholder: 'R0UTING_KEY_32_CHARS_XXXXXXXXXXX' },
  servicenow: { label: 'ServiceNow',        dot: '#293e40', help: { ko: 'URL|BASE64(user:password) 형식. 예: https://<instance>.service-now.com/api/now/table/incident|dXNlcjpwYXNz', en: 'URL|BASE64(user:password). e.g. https://<instance>.service-now.com/api/now/table/incident|dXNlcjpwYXNz' }, placeholder: 'https://acme.service-now.com/api/now/table/incident|dXNlcjpwYXNz' },
  webhook:    { label: 'Webhook (Generic)', dot: '#525252', help: { ko: 'Zapier / IFTTT / n8n / Make / 자체 엔드포인트. JSON POST 수신', en: 'Zapier / IFTTT / n8n / Make / custom endpoint. Receives JSON POST' }, placeholder: 'https://hooks.zapier.com/hooks/catch/.../...' },
};

function ChannelsAdmin() {
  const [routes, setRoutes] = useState([]);
  const [stats, setStats]   = useState([]);
  const [health, setHealth] = useState(null);
  const [busy, setBusy]     = useState(false);
  const [msg, setMsg]       = useState(null);
  const [form, setForm]     = useState({ channel: 'slack', target: '', min_priority: 'P2', enabled: true });
  const [editingId, setEditingId] = useState(null);
  const [editBuf, setEditBuf]     = useState({});
  const [showSim, setShowSim]     = useState(false);

  const reload = () => {
    api.get('/v1/fms/routes').then(d => {
      if (d?.ok) { setRoutes(d.routes || []); setStats(d.stats || []); }
    });
    api.get('/v1/fms/channels/health').then(d => { if (d?.ok) setHealth(d); });
  };
  useEffect(() => { reload(); }, []);

  const statFor = (ch) => stats.find(s => s.channel === ch) || {};

  const addRoute = async () => {
    if (!form.target.trim()) { setMsg({ ok: false, text: tx('대상(target)을 입력하세요.', 'Enter a target.') }); return; }
    setBusy(true); setMsg(null);
    const r = await api.post('/v1/fms/routes', form);
    setBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, text: tx('라우트가 추가되었습니다.', 'Route added.') });
      setForm({ channel: form.channel, target: '', min_priority: 'P2', enabled: true });
      reload();
    } else {
      setMsg({ ok: false, text: r?.error || tx('추가 실패', 'Add failed') });
    }
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setEditBuf({ channel: r.channel, target: r.target, min_priority: r.min_priority, enabled: !!r.enabled });
  };
  const saveEdit = async () => {
    const r = await api.put(`/v1/fms/routes/${editingId}`, editBuf);
    if (r?.ok) { setEditingId(null); reload(); } else { setMsg({ ok: false, text: r?.error || tx('저장 실패', 'Save failed') }); }
  };
  const removeRoute = async (id) => {
    if (!confirm(tx('이 라우트를 삭제할까요?', 'Delete this route?'))) return;
    const r = await api.del(`/v1/fms/routes/${id}`);
    if (r?.ok) reload(); else setMsg({ ok: false, text: r?.error || tx('삭제 실패', 'Delete failed') });
  };
  const toggleEnabled = async (row) => {
    const r = await api.put(`/v1/fms/routes/${row.id}`, { enabled: !row.enabled });
    if (r?.ok) reload();
  };

  const testRoute = async (row) => {
    setBusy(true); setMsg(null);
    // Use /routes/:id/test if available; otherwise the simulate endpoint
    const r = await api.post(`/v1/fms/routes/${row.id}/test`, {
      priority: row.min_priority,
      message: tx('C-Flex FMS 테스트 알람입니다.', 'C-Flex FMS test alarm.'),
    });
    setBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, text: `[${row.channel}] ${tx('테스트 전송 성공', 'Test sent OK')}` });
    } else {
      setMsg({ ok: false, text: `[${row.channel}] ${r?.error || tx('테스트 실패', 'Test failed')}` });
    }
  };

  const cur = CHANNEL_META[form.channel] || {};

  return (
    <>
      <Section title={tx('알림 채널 라우트 추가', 'Add notification route')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 18 }}>
          <div style={{ fontSize: 12, color: C.inkMuted, marginBottom: 14 }}>
            {tx('알람이 발생하면 등록된 채널로 자동 전송됩니다. 우선순위 P1~P4 별로 다른 채널을 라우팅할 수 있습니다.', 'Alarms are auto-dispatched to registered channels. You can route different priorities (P1–P4) to different channels.')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 100px 100px auto', gap: 10, alignItems: 'flex-end' }}>
            <div>
              <div style={labelStyle}>{tx('채널', 'Channel')}</div>
              <select value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value, target: '' })} style={fieldStyle}>
                {Object.keys(CHANNEL_META).map(k => <option key={k} value={k}>{CHANNEL_META[k].label}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>{tx('대상 (URL/주소/키)', 'Target (URL/address/key)')}</div>
              <input value={form.target} onChange={e => setForm({ ...form, target: e.target.value })} style={fieldStyle} placeholder={cur.placeholder || ''} />
            </div>
            <div>
              <div style={labelStyle}>{tx('최소 우선순위', 'Min priority')}</div>
              <select value={form.min_priority} onChange={e => setForm({ ...form, min_priority: e.target.value })} style={fieldStyle}>
                {['P1','P2','P3','P4'].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>{tx('활성', 'Enabled')}</div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 36, padding: '0 10px', border: `1px solid ${C.hairline}` }}>
                <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
                <span style={{ fontSize: 12 }}>{form.enabled ? tx('켜짐', 'On') : tx('꺼짐', 'Off')}</span>
              </label>
            </div>
            <button onClick={addRoute} disabled={busy}
              style={{ height: 36, padding: '0 18px', background: C.primary, color: '#fff', border: 'none', cursor: busy ? 'wait' : 'pointer', fontWeight: 600 }}>
              {tx('추가', 'Add')}
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: C.inkSubtle, lineHeight: 1.5 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: cur.dot || C.inkSubtle, marginRight: 6 }} />
            {cur.help ? tx(cur.help.ko, cur.help.en) : ''}
          </div>
          {msg && (
            <div style={{ marginTop: 12, padding: '8px 12px', fontSize: 12,
                          background: msg.ok ? C.okSoft : C.criticalSoft,
                          color: msg.ok ? C.ok : C.critical, border: `1px solid ${msg.ok ? C.ok : C.critical}` }}>
              {msg.text}
            </div>
          )}
        </div>
      </Section>

      <Section title={`${tx('등록된 라우트', 'Registered routes')} · ${routes.length}`}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}` }}>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 90px 90px 180px 220px',
                        gap: 8, padding: '10px 14px', fontSize: 11, fontWeight: 700, color: C.inkMuted,
                        textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: `1px solid ${C.hairline}` }}>
            <div>{tx('채널', 'Channel')}</div>
            <div>{tx('대상', 'Target')}</div>
            <div>{tx('최소', 'Min')}</div>
            <div>{tx('상태', 'State')}</div>
            <div>{tx('최근 7일 전송', 'Last 7d sent')}</div>
            <div style={{ textAlign: 'right' }}>{tx('동작', 'Actions')}</div>
          </div>
          {routes.length === 0 && (
            <div style={{ padding: 24, fontSize: 12, color: C.inkSubtle, textAlign: 'center' }}>
              {tx('등록된 라우트가 없습니다. 위에서 추가하세요.', 'No routes yet. Add one above.')}
            </div>
          )}
          {routes.map(r => {
            const m = CHANNEL_META[r.channel] || { label: r.channel, dot: C.inkSubtle };
            const s = statFor(r.channel);
            const isEdit = editingId === r.id;
            return (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 90px 90px 180px 220px',
                                       gap: 8, padding: '10px 14px', alignItems: 'center',
                                       borderBottom: `1px solid ${C.hairline}`, fontSize: 13 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 8, background: m.dot }} />
                  <span style={{ fontWeight: 500 }}>{m.label}</span>
                </div>
                {isEdit ? (
                  <input style={{ ...fieldStyle, fontSize: 12 }} value={editBuf.target}
                         onChange={e => setEditBuf({ ...editBuf, target: e.target.value })} />
                ) : (
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: C.inkMuted,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                       title={r.target}>{r.target}</div>
                )}
                {isEdit ? (
                  <select style={fieldStyle} value={editBuf.min_priority}
                          onChange={e => setEditBuf({ ...editBuf, min_priority: e.target.value })}>
                    {['P1','P2','P3','P4'].map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <div style={{ fontWeight: 600, color: sevColor(r.min_priority).fg }}>{r.min_priority}+</div>
                )}
                <button onClick={() => toggleEnabled(r)}
                        style={{ height: 24, padding: '0 8px', fontSize: 11, fontWeight: 600,
                                 background: r.enabled ? C.okSoft : '#f4f4f4',
                                 color: r.enabled ? C.ok : C.inkMuted,
                                 border: `1px solid ${r.enabled ? C.ok : C.hairline}`,
                                 cursor: 'pointer' }}>
                  {r.enabled ? tx('활성', 'ENABLED') : tx('비활성', 'DISABLED')}
                </button>
                <div style={{ fontSize: 11, color: C.inkMuted }}>
                  {s.total ? (
                    <>
                      <span style={{ color: C.ink, fontWeight: 600 }}>{s.ok_count || 0}/{s.total}</span>
                      <span style={{ color: C.inkSubtle }}> · {fmtTime(s.last_at)}</span>
                    </>
                  ) : <span style={{ color: C.inkSubtle }}>—</span>}
                </div>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  {isEdit ? (
                    <>
                      <button onClick={saveEdit} style={btnPrimaryMini}>{tx('저장', 'Save')}</button>
                      <button onClick={() => setEditingId(null)} style={btnGhostMini}>{tx('취소', 'Cancel')}</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => testRoute(r)} disabled={busy} style={btnGhostMini}>{tx('테스트', 'Test')}</button>
                      <button onClick={() => startEdit(r)} style={btnGhostMini}>{tx('수정', 'Edit')}</button>
                      <button onClick={() => removeRoute(r.id)} style={btnDangerMini}>{tx('삭제', 'Delete')}</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {health && health.channels && health.channels.length > 0 && (
        <Section title={tx('채널 헬스 (롤링 24h / 7d / 30d)', 'Channel health (rolling 24h / 7d / 30d)')}>
          <div style={{ background: C.card, border: `1px solid ${C.hairline}` }}>
            <div style={{ display: 'grid', gridTemplateColumns: '160px 120px 1fr 1fr 1fr 150px',
                          gap: 8, padding: '10px 14px', fontSize: 11, fontWeight: 700, color: C.inkMuted,
                          textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: `1px solid ${C.hairline}` }}>
              <div>{tx('채널', 'Channel')}</div>
              <div>{tx('상태', 'State')}</div>
              <div>24h</div>
              <div>7d</div>
              <div>30d</div>
              <div>{tx('마지막 성공/실패', 'Last OK / Fail')}</div>
            </div>
            {health.channels.map(c => {
              const m = CHANNEL_META[c.channel] || { label: c.channel, dot: C.inkSubtle };
              const stateColor = c.status === 'healthy'  ? C.ok
                              : c.status === 'degraded' ? C.warn
                              : c.status === 'failing'  ? C.critical
                              : C.inkSubtle;
              const stateLabel = { healthy: tx('정상', 'HEALTHY'), degraded: tx('저하', 'DEGRADED'),
                                   failing: tx('실패', 'FAILING'), idle: tx('대기', 'IDLE') }[c.status] || c.status;
              const cellBucket = (b) => b.total === 0
                ? <span style={{ color: C.inkSubtle }}>—</span>
                : (
                  <span>
                    <span style={{ fontWeight: 600, color: b.ratio === 100 ? C.ok : b.ratio >= 90 ? C.warn : C.critical }}>
                      {b.ratio}%
                    </span>
                    <span style={{ color: C.inkSubtle, fontSize: 11 }}> ({b.ok}/{b.total})</span>
                  </span>
                );
              return (
                <div key={c.channel} style={{ display: 'grid', gridTemplateColumns: '160px 120px 1fr 1fr 1fr 150px',
                                              gap: 8, padding: '10px 14px', alignItems: 'center',
                                              borderBottom: `1px solid ${C.hairline}`, fontSize: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 8, background: m.dot }} />
                    <span style={{ fontWeight: 500 }}>{m.label}</span>
                  </div>
                  <div>
                    <span style={{ padding: '2px 8px', fontSize: 10, fontWeight: 700,
                                   background: stateColor + '22', color: stateColor,
                                   border: `1px solid ${stateColor}` }}>{stateLabel}</span>
                  </div>
                  <div>{cellBucket(c.h24)}</div>
                  <div>{cellBucket(c.d7)}</div>
                  <div>{cellBucket(c.d30)}</div>
                  <div style={{ fontSize: 11, color: C.inkMuted }}>
                    {c.last_ok_at ? <><span style={{ color: C.ok }}>✓</span> {fmtTime(c.last_ok_at)}</> : '—'}
                    <br/>
                    {c.last_fail_at ? <><span style={{ color: C.critical }}>✗</span> {fmtTime(c.last_fail_at)}</> : ''}
                  </div>
                </div>
              );
            })}
          </div>
          {health.recent_failures && health.recent_failures.length > 0 && (
            <details style={{ marginTop: 10, padding: 12, background: C.criticalSoft, border: `1px solid ${C.critical}` }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: C.critical, fontSize: 12 }}>
                {tx('최근 실패', 'Recent failures')} · {health.recent_failures.length}
              </summary>
              <div style={{ marginTop: 8, fontSize: 11, fontFamily: 'monospace', maxHeight: 200, overflow: 'auto' }}>
                {health.recent_failures.map((f, i) => (
                  <div key={i} style={{ padding: '4px 0', borderBottom: `1px solid ${C.critical}22` }}>
                    <span style={{ color: C.inkMuted }}>{fmtTime(f.sent_at)}</span>
                    {' · '}<strong>{f.channel}</strong>
                    {' · '}<span style={{ color: C.inkSubtle }}>{(f.target || '').slice(0, 40)}</span>
                    {' · '}<span style={{ color: C.critical }}>{(f.error || '').slice(0, 120)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Section>
      )}

      <Section title={tx('파이프라인 시뮬레이션', 'Pipeline simulation')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 18 }}>
          <div style={{ fontSize: 12, color: C.inkMuted, marginBottom: 12 }}>
            {tx('가상 알람을 알림 파이프라인 전체에 통과시켜 활성화된 모든 라우트가 정상 작동하는지 확인합니다.',
                'Fires a fake alarm through the whole pipeline and verifies every enabled route dispatches OK.')}
          </div>
          <button onClick={() => setShowSim(true)}
                  style={{ height: 36, padding: '0 18px', background: C.primary, color: '#fff',
                           border: 'none', cursor: 'pointer', fontWeight: 600 }}>
            {tx('시뮬레이션 실행', 'Run simulation')}
          </button>
        </div>
      </Section>

      <ActiveMutesPanel />

      {showSim && <SimulateAlarmModal onClose={() => setShowSim(false)} />}
    </>
  );
}

function ActiveMutesPanel() {
  const [mutes, setMutes] = useState([]);
  const reload = () => api.get('/v1/fms/mutes').then(d => { if (d?.ok) setMutes(d.mutes || []); });
  useEffect(() => { reload(); const id = setInterval(reload, 60000); return () => clearInterval(id); }, []);
  const unmute = async (id) => {
    if (!confirm(tx('이 음소거를 해제할까요?', 'Clear this mute?'))) return;
    const r = await api.del(`/v1/fms/mutes/${id}`);
    if (r?.ok) reload();
  };
  if (!mutes.length) return null;
  return (
    <Section title={`${tx('활성 음소거', 'Active mutes')} · ${mutes.length}`}>
      <div style={{ background: C.card, border: `1px solid ${C.hairline}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 150px 1fr 150px 100px',
                      gap: 8, padding: '10px 14px', fontSize: 11, fontWeight: 700, color: C.inkMuted,
                      textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: `1px solid ${C.hairline}` }}>
          <div>{tx('장치', 'Device')}</div>
          <div>{tx('지표', 'Metric')}</div>
          <div>{tx('해제 예정', 'Expires')}</div>
          <div>{tx('음소거한 사람', 'Muted by')}</div>
          <div>{tx('출처', 'Source')}</div>
          <div></div>
        </div>
        {mutes.map(m => {
          const remaining = m.muted_until - Date.now();
          const mins = Math.max(0, Math.ceil(remaining / 60000));
          return (
            <div key={m.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 150px 1fr 150px 100px',
                                     gap: 8, padding: '10px 14px', alignItems: 'center',
                                     borderBottom: `1px solid ${C.hairline}`, fontSize: 12 }}>
              <div style={{ fontFamily: 'monospace', color: C.ink }}>{m.device_id}</div>
              <div style={{ fontFamily: 'monospace', color: C.inkMuted }}>{m.metric || tx('전체', '*')}</div>
              <div style={{ color: C.inkMuted }}>
                {mins > 60 ? `${Math.round(mins/60)}h` : `${mins}m`}
                <span style={{ color: C.inkSubtle, fontSize: 11 }}> · {fmtAbs(m.muted_until)}</span>
              </div>
              <div style={{ color: C.inkMuted }}>{m.muted_by || '—'}</div>
              <div style={{ fontSize: 11, color: C.inkSubtle, textTransform: 'uppercase' }}>{m.muted_via || '—'}</div>
              <div style={{ textAlign: 'right' }}>
                <button onClick={() => unmute(m.id)} style={btnDangerMini}>{tx('해제', 'Unmute')}</button>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const btnPrimaryMini = { height: 26, padding: '0 10px', fontSize: 11, fontWeight: 600, background: C.primary, color: '#fff', border: 'none', cursor: 'pointer' };
const btnGhostMini   = { height: 26, padding: '0 10px', fontSize: 11, fontWeight: 500, background: '#fff', color: C.ink, border: `1px solid ${C.hairline}`, cursor: 'pointer' };
const btnDangerMini  = { height: 26, padding: '0 10px', fontSize: 11, fontWeight: 600, background: '#fff', color: C.critical, border: `1px solid ${C.critical}`, cursor: 'pointer' };

function SimulateAlarmModal({ onClose }) {
  const [form, setForm] = useState({ priority: 'P2', metric: 'battery_pct', value: 28, threshold: 50, device_id: 'TEST',
                                     message: tx('C-Flex FMS 시뮬레이션 알람', 'C-Flex FMS simulated alarm') });
  const [busy, setBusy]       = useState(false);
  const [results, setResults] = useState(null);
  const run = async () => {
    setBusy(true);
    const r = await api.post('/v1/fms/routes/simulate', form);
    setBusy(false);
    setResults(r);
  };
  return (
    <Modal title={tx('알림 파이프라인 시뮬레이션', 'Notification pipeline simulation')} onClose={onClose} width={720}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <Field label={tx('우선순위', 'Priority')}>
          <select style={fieldStyle} value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
            {['P1','P2','P3','P4'].map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label={tx('지표', 'Metric')}>
          <input style={fieldStyle} value={form.metric} onChange={e => setForm({ ...form, metric: e.target.value })} />
        </Field>
        <Field label={tx('값', 'Value')}>
          <input type="number" style={fieldStyle} value={form.value} onChange={e => setForm({ ...form, value: parseFloat(e.target.value) })} />
        </Field>
        <Field label={tx('임계', 'Threshold')}>
          <input type="number" style={fieldStyle} value={form.threshold} onChange={e => setForm({ ...form, threshold: parseFloat(e.target.value) })} />
        </Field>
        <Field label={tx('장치 ID', 'Device ID')}>
          <input style={fieldStyle} value={form.device_id} onChange={e => setForm({ ...form, device_id: e.target.value })} />
        </Field>
        <Field label={tx('메시지', 'Message')}>
          <input style={fieldStyle} value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} />
        </Field>
      </div>
      <button onClick={run} disabled={busy}
              style={{ height: 36, padding: '0 18px', background: C.primary, color: '#fff', border: 'none',
                       cursor: busy ? 'wait' : 'pointer', fontWeight: 600 }}>
        {busy ? tx('전송 중…', 'Sending…') : tx('시뮬레이션 발사', 'Fire simulation')}
      </button>
      {results && (
        <div style={{ marginTop: 16 }}>
          <div style={{ ...labelStyle, marginBottom: 8 }}>{tx('결과', 'Results')}</div>
          {(results.results || []).length === 0 && (
            <div style={{ padding: 14, fontSize: 12, color: C.inkSubtle, background: '#f4f4f4' }}>
              {tx('일치하는 활성 라우트가 없습니다.', 'No enabled routes matched.')}
            </div>
          )}
          {(results.results || []).map((r, i) => (
            <div key={i} style={{ padding: '8px 12px', fontSize: 12, marginBottom: 4,
                                  background: r.ok ? C.okSoft : C.criticalSoft,
                                  color: r.ok ? C.ok : C.critical, border: `1px solid ${r.ok ? C.ok : C.critical}` }}>
              <strong>{r.channel}</strong> · {r.ok ? 'OK' : (typeof r.error === 'string' ? r.error : JSON.stringify(r.error || r))}
            </div>
          ))}
          {results.error && (
            <div style={{ padding: 12, fontSize: 12, color: C.critical, background: C.criticalSoft, border: `1px solid ${C.critical}` }}>
              {results.error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── Admin → Reports subtab ─ monthly PDF download + email + history ─
function ReportsAdmin({ user }) {
  const now = new Date();
  // Default: previous month
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const [year, setYear] = useState(prev.getFullYear());
  const [month, setMonth] = useState(prev.getMonth() + 1);
  const [recipients, setRecipients] = useState(user?.email || '');
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const reload = () => api.get('/v1/fms/reports/monthly/history').then(d => d?.ok && setHistory(d.history));
  useEffect(() => { reload(); }, []);

  const download = () => {
    const url = `/v1/fms/reports/monthly/pdf?year=${year}&month=${month}`;
    const tok = localStorage.getItem('cflex_token') || localStorage.getItem('token');
    fetch(url, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `fms-monthly-${year}-${String(month).padStart(2, '0')}.pdf`;
        a.click();
      });
  };

  const sendEmail = async () => {
    const to = recipients.split(',').map(s => s.trim()).filter(Boolean);
    if (!to.length) { setMsg({ ok: false, text: tx('수신자를 입력하세요.', 'Enter at least one recipient.') }); return; }
    setBusy(true); setMsg(null);
    const r = await api.post('/v1/fms/reports/monthly/send', { year, month, to });
    setBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, text: tx('이메일 발송 완료', 'Email sent') + ` · ${to.join(', ')}` });
      reload();
    } else {
      setMsg({ ok: false, text: r?.error || tx('발송 실패', 'Send failed') });
    }
  };

  const monthOptions = Array.from({ length: 12 }, (_, i) => i + 1);
  const yearOptions = [now.getFullYear() - 1, now.getFullYear()];

  return (
    <>
      <Section title={tx('월간 PDF 리포트', 'Monthly PDF report')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 18 }}>
          <div style={{ fontSize: 12, color: C.inkMuted, marginBottom: 14 }}>
            {tx('대상 월을 선택하고 PDF를 다운로드하거나 이메일로 발송할 수 있습니다. 매월 1일 09:00 UTC에 전월 리포트가 자동 발송됩니다.', 'Pick a target month then download or email. Auto-send runs on the 1st of each month at 09:00 UTC for the previous month.')}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={labelStyle}>{tx('연도', 'Year')}</div>
              <select value={year} onChange={e => setYear(parseInt(e.target.value, 10))} style={{ ...fieldStyle, width: 100 }}>
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>{tx('월', 'Month')}</div>
              <select value={month} onChange={e => setMonth(parseInt(e.target.value, 10))} style={{ ...fieldStyle, width: 80 }}>
                {monthOptions.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={labelStyle}>{tx('이메일 수신자 (콤마 구분)', 'Recipients (comma-separated)')}</div>
              <input value={recipients} onChange={e => setRecipients(e.target.value)} style={fieldStyle} placeholder="fms@haeaus.com, ops@example.com" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button onClick={download} style={{ ...iconBtn, marginLeft: 0 }}>
              <Upload size={13} style={{ transform: 'rotate(180deg)' }} /> {tx('PDF 다운로드', 'Download PDF')}
            </button>
            <button onClick={sendEmail} disabled={busy} style={{
              ...iconBtn, background: C.primary, color: '#fff', borderColor: C.primary, opacity: busy ? 0.6 : 1,
            }}>
              <CheckCircle2 size={13} /> {busy ? tx('발송 중…', 'Sending…') : tx('이메일 발송', 'Send Email')}
            </button>
          </div>
          {msg && (
            <div style={{
              marginTop: 12, padding: 10, fontSize: 12,
              background: msg.ok ? C.okSoft : C.criticalSoft,
              color: msg.ok ? C.ok : C.critical,
            }}>{msg.ok ? '✓ ' : '⚠ '}{msg.text}</div>
          )}
        </div>
      </Section>

      <Section title={tx('발송 이력', 'Send history')}>
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, overflowX: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '100px 90px 1fr 80px 130px', minWidth: 560,
            padding: '10px 14px', fontSize: 10, fontWeight: 700, color: C.inkSubtle, letterSpacing: '0.4px',
            textTransform: 'uppercase', borderBottom: `1px solid ${C.hairline}`, background: '#fafafa',
          }}>
            <div>{tx('발송 시각', 'Sent')}</div>
            <div>{tx('대상 월', 'Period')}</div>
            <div>{tx('수신자', 'Recipients')}</div>
            <div>{tx('상태', 'Status')}</div>
            <div>{tx('메시지', 'Message')}</div>
          </div>
          {history.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>
              {tx('발송 이력 없음', 'No send history yet')}
            </div>
          ) : history.map(h => (
            <div key={h.id} style={{
              display: 'grid', gridTemplateColumns: '100px 90px 1fr 80px 130px', minWidth: 560,
              padding: '10px 14px', fontSize: 12, borderBottom: `1px solid ${C.hairline}`, alignItems: 'center',
            }}>
              <div style={{ color: C.inkMuted }}>{fmtTime(h.sent_at)}</div>
              <div style={{ fontFamily: 'monospace' }}>{h.year}-{String(h.month).padStart(2, '0')}</div>
              <div style={{ color: C.inkMuted, fontSize: 11 }}>{h.recipients}</div>
              <div>
                <span style={{
                  padding: '2px 8px', fontSize: 10, fontWeight: 700,
                  background: h.ok ? C.okSoft : C.criticalSoft,
                  color: h.ok ? C.ok : C.critical,
                }}>{h.ok ? 'OK' : 'FAIL'}</span>
              </div>
              <div style={{ fontSize: 11, color: C.inkSubtle }}>{h.error || (h.ok ? tx('성공', 'sent') : '—')}</div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Device editing modals
// ═══════════════════════════════════════════════════════════════════
function Modal({ title, children, onClose, width = 640 }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(22,22,22,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT,
      padding: 8,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.card, width: '100%', maxWidth: width, maxHeight: '92vh', overflow: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)', border: `1px solid ${C.hairline}`,
      }}>
        <div style={{
          padding: '14px 20px', borderBottom: `1px solid ${C.hairline}`,
          display: 'flex', alignItems: 'center',
        }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, flex: 1, color: C.ink }}>{title}</h2>
          <XIcon size={18} color={C.inkMuted} onClick={onClose} style={{ cursor: 'pointer' }} />
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

const fieldStyle = {
  width: '100%', padding: '7px 10px', fontSize: 13, fontFamily: FONT,
  border: `1px solid ${C.hairline}`, outline: 'none', background: '#fff',
};
const labelStyle = {
  fontSize: 10, fontWeight: 700, color: C.inkMuted, letterSpacing: '0.4px',
  textTransform: 'uppercase', marginBottom: 4, display: 'block',
};

function Field({ label, children }) {
  return <label style={{ display: 'block' }}><span style={labelStyle}>{label}</span>{children}</label>;
}

function DeviceEditModal({ asset, onClose, onSaved }) {
  const { isMobile } = useViewport();
  const [f, setF] = useState({
    label: asset.label || '',
    ip: asset.ip || '',
    snmp_community: asset.snmp_community || 'public',
    snmp_port: asset.snmp_port || 161,
    snmp_version: asset.snmp_version || 'v2c',
    snmp_v3_user: asset.snmp_v3_user || '',
    snmp_v3_auth_password: '',
    snmp_v3_priv_password: '',
    snmp_v3_auth_protocol: asset.snmp_v3_auth_protocol || 'SHA',
    snmp_v3_priv_protocol: asset.snmp_v3_priv_protocol || 'AES',
    location: asset.location || '',
    room: asset.room || '',
    rack: asset.rack || '',
    lat: asset.lat ?? '',
    lng: asset.lng ?? '',
    criticality: asset.criticality || 'routine',
    polling_enabled: !!asset.polling_enabled,
    polling_interval_sec: asset.polling_interval_sec || 60,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  const save = async () => {
    setBusy(true); setErr('');
    const payload = { ...f };
    if (f.snmp_version !== 'v3') {
      delete payload.snmp_v3_user;
      delete payload.snmp_v3_auth_password;
      delete payload.snmp_v3_priv_password;
      delete payload.snmp_v3_auth_protocol;
      delete payload.snmp_v3_priv_protocol;
    } else {
      if (!payload.snmp_v3_auth_password) delete payload.snmp_v3_auth_password;
      if (!payload.snmp_v3_priv_password) delete payload.snmp_v3_priv_password;
    }
    const r = await api.put(`/v1/fms/assets/${asset.id}`, payload);
    setBusy(false);
    if (r?.ok) onSaved();
    else setErr(r?.error || 'save failed');
  };

  return (
    <Modal title={`${tx('장치 편집', 'Edit Device')} · ${asset.label}`} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
        <Field label={tx('라벨', 'Label')}><input style={fieldStyle} value={f.label} onChange={e => set('label', e.target.value)} /></Field>
        <Field label="IP"><input style={fieldStyle} value={f.ip} onChange={e => set('ip', e.target.value)} placeholder="10.0.0.42" /></Field>
        <Field label={tx('SNMP 버전', 'SNMP Version')}>
          <select style={fieldStyle} value={f.snmp_version} onChange={e => set('snmp_version', e.target.value)}>
            <option value="v1">v1</option><option value="v2c">v2c</option><option value="v3">v3</option>
          </select>
        </Field>
        <Field label={tx('SNMP 포트', 'SNMP Port')}><input type="number" style={fieldStyle} value={f.snmp_port} onChange={e => set('snmp_port', e.target.value)} /></Field>
        {f.snmp_version !== 'v3' ? (
          <Field label={tx('Community', 'Community')}><input style={fieldStyle} value={f.snmp_community} onChange={e => set('snmp_community', e.target.value)} /></Field>
        ) : (
          <>
            <Field label="v3 User"><input style={fieldStyle} value={f.snmp_v3_user} onChange={e => set('snmp_v3_user', e.target.value)} /></Field>
            <Field label="Auth Protocol">
              <select style={fieldStyle} value={f.snmp_v3_auth_protocol} onChange={e => set('snmp_v3_auth_protocol', e.target.value)}>
                <option>MD5</option><option>SHA</option><option>SHA256</option>
              </select>
            </Field>
            <Field label="Auth Password"><input type="password" style={fieldStyle} value={f.snmp_v3_auth_password} onChange={e => set('snmp_v3_auth_password', e.target.value)} placeholder={tx('변경 시에만 입력', 'leave empty to keep')} /></Field>
            <Field label="Priv Protocol">
              <select style={fieldStyle} value={f.snmp_v3_priv_protocol} onChange={e => set('snmp_v3_priv_protocol', e.target.value)}>
                <option>DES</option><option>AES</option><option>AES256</option>
              </select>
            </Field>
            <Field label="Priv Password"><input type="password" style={fieldStyle} value={f.snmp_v3_priv_password} onChange={e => set('snmp_v3_priv_password', e.target.value)} placeholder={tx('변경 시에만 입력', 'leave empty to keep')} /></Field>
          </>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${C.hairline}`, marginTop: 18, paddingTop: 14 }} />
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr 1fr', gap: 12 }}>
        <Field label={tx('위치 (사이트)', 'Location (site)')}><input style={fieldStyle} value={f.location} onChange={e => set('location', e.target.value)} /></Field>
        <Field label={tx('룸', 'Room')}><input style={fieldStyle} value={f.room} onChange={e => set('room', e.target.value)} /></Field>
        <Field label={tx('랙', 'Rack')}><input style={fieldStyle} value={f.rack} onChange={e => set('rack', e.target.value)} /></Field>
        <Field label={tx('위도', 'Latitude')}><input style={fieldStyle} value={f.lat} onChange={e => set('lat', e.target.value)} placeholder="33.6595" /></Field>
        <Field label={tx('경도', 'Longitude')}><input style={fieldStyle} value={f.lng} onChange={e => set('lng', e.target.value)} placeholder="-117.8487" /></Field>
        <Field label={tx('중요도', 'Criticality')}>
          <select style={fieldStyle} value={f.criticality} onChange={e => set('criticality', e.target.value)}>
            <option value="routine">{tx('일반', 'Routine')}</option>
            <option value="production">{tx('운영', 'Production')}</option>
            <option value="critical">{tx('중요', 'Critical')}</option>
          </select>
        </Field>
      </div>

      <div style={{ borderTop: `1px solid ${C.hairline}`, marginTop: 18, paddingTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label={tx('폴링 활성', 'Polling enabled')}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, paddingTop: 4 }}>
            <input type="checkbox" checked={f.polling_enabled} onChange={e => set('polling_enabled', e.target.checked)} />
            {f.polling_enabled ? tx('활성', 'On') : tx('비활성', 'Off')}
          </label>
        </Field>
        <Field label={tx('폴링 주기 (초)', 'Polling interval (sec)')}>
          <input type="number" style={fieldStyle} value={f.polling_interval_sec} onChange={e => set('polling_interval_sec', e.target.value)} />
        </Field>
      </div>

      {err && <div style={{ marginTop: 14, padding: 10, background: C.criticalSoft, color: C.critical, fontSize: 12 }}>⚠ {err}</div>}
      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} style={iconBtn}>{tx('취소', 'Cancel')}</button>
        <button onClick={save} disabled={busy} style={{ ...iconBtn, background: C.primary, color: '#fff', borderColor: C.primary }}>
          <CheckCircle2 size={13} /> {busy ? tx('저장중…', 'Saving…') : tx('저장', 'Save')}
        </button>
      </div>
    </Modal>
  );
}

function ThresholdEditModal({ deviceId, onClose, onSaved }) {
  const [t, setT] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/v1/fms/assets/${deviceId}/thresholds`).then(r => {
      if (r?.ok) { setT(r.thresholds); setDefaults(r.defaults); setCustom(r.custom); }
    });
  }, [deviceId]);
  if (!t) return <Modal title={tx('임계치 편집', 'Edit Thresholds')} onClose={onClose}>Loading…</Modal>;

  const set = (k, v) => setT(s => ({ ...s, [k]: v === '' ? '' : parseFloat(v) }));
  const save = async () => {
    setBusy(true);
    const r = await api.put(`/v1/fms/assets/${deviceId}/thresholds`, t);
    setBusy(false);
    if (r?.ok) onSaved();
  };
  const reset = async () => {
    setBusy(true);
    await api.put(`/v1/fms/assets/${deviceId}/thresholds`, {
      battery_warn: '', battery_critical: '', load_warn: '', load_critical: '',
      temp_warn: '', temp_critical: '', runtime_warn: '', runtime_critical: '',
    });
    setBusy(false); onSaved();
  };

  const groups = [
    { key: 'battery', label: tx('배터리 %', 'Battery %'),  dir: 'below', warnDef: defaults.battery_warn, critDef: defaults.battery_critical },
    { key: 'load',    label: tx('부하 %', 'Load %'),         dir: 'above', warnDef: defaults.load_warn,    critDef: defaults.load_critical },
    { key: 'temp',    label: tx('온도 °C', 'Temp °C'),        dir: 'above', warnDef: defaults.temp_warn,    critDef: defaults.temp_critical },
    { key: 'runtime', label: tx('런타임 분', 'Runtime min'),  dir: 'below', warnDef: defaults.runtime_warn, critDef: defaults.runtime_critical },
  ];

  return (
    <Modal title={tx('임계치 편집', 'Edit Thresholds')} onClose={onClose} width={560}>
      <div style={{ fontSize: 12, color: C.inkMuted, marginBottom: 14 }}>
        {custom
          ? tx('이 장치는 커스텀 임계치를 사용 중입니다.', 'This device uses custom thresholds.')
          : tx('기본 임계치를 사용 중입니다. 값을 수정하면 커스텀이 적용됩니다.', 'Using defaults. Edit values to apply custom thresholds.')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 100px', gap: 10, alignItems: 'center' }}>
        <div style={{ ...labelStyle, marginBottom: 0 }}>{tx('지표', 'Metric')}</div>
        <div style={{ ...labelStyle, marginBottom: 0, color: C.warn }}>{tx('경고', 'Warning')}</div>
        <div style={{ ...labelStyle, marginBottom: 0, color: C.critical }}>{tx('위험', 'Critical')}</div>
        {groups.map(g => (
          <React.Fragment key={g.key}>
            <div style={{ fontSize: 13 }}>
              {g.label}
              <div style={{ fontSize: 10, color: C.inkSubtle }}>
                {g.dir === 'below' ? tx('이하 시 알람', 'alarm when below') : tx('이상 시 알람', 'alarm when above')} · {tx('기본', 'default')} {g.warnDef}/{g.critDef}
              </div>
            </div>
            <input type="number" step="0.1" style={fieldStyle} value={t[g.key + '_warn'] ?? ''} onChange={e => set(g.key + '_warn', e.target.value)} placeholder={String(g.warnDef)} />
            <input type="number" step="0.1" style={fieldStyle} value={t[g.key + '_critical'] ?? ''} onChange={e => set(g.key + '_critical', e.target.value)} placeholder={String(g.critDef)} />
          </React.Fragment>
        ))}
      </div>
      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button onClick={reset} disabled={busy || !custom} style={{ ...iconBtn, color: custom ? C.critical : C.inkSubtle }}>
          {tx('기본값으로 초기화', 'Reset to defaults')}
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={iconBtn}>{tx('취소', 'Cancel')}</button>
          <button onClick={save} disabled={busy} style={{ ...iconBtn, background: C.primary, color: '#fff', borderColor: C.primary }}>
            <CheckCircle2 size={13} /> {busy ? tx('저장중…', 'Saving…') : tx('저장', 'Save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Click-through modals — every dashboard click pops one of these
// ═══════════════════════════════════════════════════════════════════
function DeviceDetailModal({ id, onClose }) {
  return (
    <Modal title={tx('장치 상세', 'Device Detail')} onClose={onClose} width={960}>
      <DeviceDetail id={id} onBack={onClose} />
    </Modal>
  );
}

function AlarmDetailModal({ alert, onClose }) {
  const { openTicket, openDevice } = useFmsModal();
  const [ticket, setTicket] = useState(null);
  const [rcaPreview, setRcaPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [muted, setMuted] = useState(alert.muted_until && alert.muted_until > Date.now());

  useEffect(() => {
    api.get(`/v1/fms/alerts/${alert.id}/ticket`).then(d => {
      const tk = d?.ticket || null;
      setTicket(tk);
      setLoading(false);
      if (tk?.id) {
        // pull RCA snippet
        api.get(`/v1/fms/tickets/${tk.id}`).then(t => {
          if (t?.ok && t.rca?.summary) setRcaPreview(t.rca);
        });
      }
    });
  }, [alert.id]);

  const sc = sevColor(alert.priority);
  const numericId = parseInt(String(alert.device_id || '').replace(/^ups-/, ''), 10);

  const createTicket = async () => {
    setBusy(true);
    const r = await api.post('/v1/fms/tickets/from-alert', {
      alert_id: alert.id,
      note: note || undefined,
    });
    setBusy(false);
    if (r?.ok) setTicket(r.ticket);
  };

  const muteDevice = async (hours) => {
    if (!numericId) return;
    setBusy(true);
    await api.post(`/v1/fms/devices/${numericId}/mute`, { hours, reason: `from alarm ${alert.id}` });
    setBusy(false);
    setMuted(true);
  };

  return (
    <Modal title={
      <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
        <span style={{ padding: '3px 10px', fontSize: 11, fontWeight: 700, background: sc.fg, color: '#fff' }}>{alert.priority}</span>
        {tx('알람 상세', 'Alarm Detail')}
      </span>
    } onClose={onClose} width={620}>
      <div style={{ background: sc.bg, padding: 14, borderLeft: `3px solid ${sc.fg}`, marginBottom: 16, fontSize: 14 }}>
        <div style={{ fontWeight: 700, color: sc.fg, marginBottom: 4 }}>{alert.message}</div>
        <div style={{ fontSize: 12, color: C.inkMuted }}>
          {alert.device_label || alert.device_id} · {alert.metric}
          {alert.value != null && ` = ${alert.value}`}
          {alert.threshold != null && ` (${tx('임계', 'threshold')} ${alert.threshold})`}
        </div>
        <div style={{ fontSize: 11, color: C.inkSubtle, marginTop: 4 }}>{fmtAbs(alert.received_at)}</div>
      </div>

      {/* Ticket section */}
      <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 14, marginBottom: 14 }}>
        <div style={{ ...labelStyle, marginBottom: 8 }}>{tx('연결된 티켓', 'Linked Ticket')}</div>
        {loading ? (
          <div style={{ fontSize: 12, color: C.inkSubtle }}>Loading…</div>
        ) : ticket ? (
          <>
            <div onClick={() => openTicket(ticket)} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: 10,
              background: C.primarySoft, border: `1px solid ${C.primary}30`, cursor: 'pointer',
            }}>
              <span style={{ fontFamily: 'monospace', fontWeight: 700, color: C.primary }}>{ticket.ticket_no}</span>
              <span style={{ fontSize: 12, color: C.inkMuted, flex: 1 }}>{ticket.title}</span>
              <span style={{ padding: '2px 8px', fontSize: 10, fontWeight: 700, background: '#fff', border: `1px solid ${C.hairline}`, textTransform: 'uppercase' }}>{ticket.status}</span>
              <ChevronRight size={14} color={C.primary} />
            </div>
            {rcaPreview?.summary && (
              <div onClick={() => openTicket(ticket)} style={{
                marginTop: 8, padding: 10, fontSize: 12, lineHeight: 1.5,
                borderLeft: `3px solid ${C.primary}`, background: '#fafafa', cursor: 'pointer', color: C.ink,
              }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: C.primary, letterSpacing: '1px', marginBottom: 4 }}>AI RCA</div>
                {rcaPreview.summary.length > 180 ? rcaPreview.summary.slice(0, 180) + '…' : rcaPreview.summary}
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: C.inkSubtle, marginBottom: 8 }}>
              {tx('이 알람에 연결된 티켓이 없습니다. 티켓을 생성하면 운영팀이 처리합니다.', 'No ticket linked. Create one so the ops team can take over.')}
            </div>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              placeholder={tx('티켓에 추가할 메모 (선택)', 'Optional note for the ticket')}
              rows={2} style={{ ...fieldStyle, fontFamily: FONT, resize: 'vertical', marginBottom: 8 }} />
            <button onClick={createTicket} disabled={busy} style={{
              padding: '8px 14px', background: C.primary, color: '#fff', border: 'none',
              cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'inline-flex', gap: 6, alignItems: 'center',
            }}>
              <CheckCircle2 size={13} /> {busy ? tx('생성 중…', 'Creating…') : tx('티켓 생성', 'Create Ticket')}
            </button>
          </>
        )}
      </div>

      {/* Quick actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {numericId > 0 && (
          <button onClick={() => { onClose(); openDevice(numericId); }} style={iconBtn}>
            <Server size={13} /> {tx('장치 상세', 'Device detail')}
          </button>
        )}
        {!muted && numericId > 0 && (
          <>
            <button onClick={() => muteDevice(1)} disabled={busy} style={iconBtn}><VolumeX size={13} /> 1h</button>
            <button onClick={() => muteDevice(4)} disabled={busy} style={iconBtn}><VolumeX size={13} /> 4h</button>
            <button onClick={() => muteDevice(24)} disabled={busy} style={iconBtn}><VolumeX size={13} /> 24h</button>
          </>
        )}
        {muted && <span style={{ fontSize: 11, color: C.inkSubtle, padding: '6px 10px' }}><VolumeX size={11} /> {tx('음소거됨', 'Muted')}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={iconBtn}>{tx('닫기', 'Close')}</button>
      </div>
    </Modal>
  );
}

function TicketDetailModal({ ticket, onClose }) {
  const { isMobile } = useViewport();
  const [data, setData] = useState({ ticket, rca: null, ai_enabled: null });
  const [rcaBusy, setRcaBusy] = useState(false);
  const reload = () => api.get(`/v1/fms/tickets/${ticket.id}`).then(d => {
    if (d?.ok) setData({ ticket: d.ticket, rca: d.rca, ai_enabled: d.ai_enabled });
  });
  useEffect(() => { reload(); }, [ticket.id]);

  const t = data.ticket;
  const rca = data.rca;

  const regen = async () => {
    setRcaBusy(true);
    const r = await api.post(`/v1/fms/tickets/${ticket.id}/rca`);
    setRcaBusy(false);
    reload();
    if (r?.error && !r?.ok) {
      // surface the error inline via reload (rca_error will be set)
    }
  };

  return (
    <Modal title={
      <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
        <span style={{ fontFamily: 'monospace', color: C.primary }}>{t.ticket_no}</span>
        {tx('티켓', 'Ticket')}
      </span>
    } onClose={onClose} width={680}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '90px 1fr' : '120px 1fr', gap: '8px 16px', fontSize: 13, marginBottom: 14 }}>
        <Row k={tx('상태', 'Status')} v={<span style={{ padding: '2px 8px', fontSize: 10, fontWeight: 700, background: t.status === 'open' ? C.criticalSoft : C.okSoft, color: t.status === 'open' ? C.critical : C.ok, textTransform: 'uppercase' }}>{t.status}</span>} />
        <Row k={tx('우선순위', 'Priority')} v={<span style={{ fontWeight: 700, color: sevColor(t.priority).fg }}>{t.priority}</span>} />
        <Row k={tx('장치', 'Device')} v={t.device_label || t.device_id} />
        <Row k={tx('사이트', 'Site')} v={t.site || '—'} />
        <Row k={tx('담당', 'Assignee')} v={t.assignee || tx('미지정', 'Unassigned')} />
        <Row k={tx('생성', 'Created')} v={fmtAbs(t.created_at)} />
      </div>
      <div style={{ background: C.bg, padding: 12, fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: 14 }}>
        <div style={{ ...labelStyle, marginBottom: 6 }}>{tx('제목', 'Title')}</div>
        {t.title}
        {t.description && <>
          <div style={{ ...labelStyle, marginTop: 10, marginBottom: 6 }}>{tx('설명', 'Description')}</div>
          <div style={{ color: C.inkMuted }}>{t.description}</div>
        </>}
      </div>

      {/* ─── AI RCA ─── */}
      <div style={{ background: C.card, border: `1px solid ${C.primary}40`, borderLeft: `3px solid ${C.primary}`, padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.primary, letterSpacing: '1px' }}>AI 근본원인 분석 · RCA</span>
          <span style={{ flex: 1 }} />
          {rca && rca.generated_at && (
            <span style={{ fontSize: 10, color: C.inkSubtle }}>{fmtTime(rca.generated_at)}</span>
          )}
          <button onClick={regen} disabled={rcaBusy || data.ai_enabled === false} style={{
            ...iconBtn, marginLeft: 0, opacity: (rcaBusy || data.ai_enabled === false) ? 0.5 : 1,
          }}>
            <RefreshCw size={11} /> {rcaBusy ? tx('분석 중…', 'Analyzing…') : tx('다시 생성', 'Regenerate')}
          </button>
        </div>

        {data.ai_enabled === false && !rca?.summary && (
          <div style={{ padding: 10, background: C.warnSoft, color: C.warn, fontSize: 12 }}>
            ⚠ {tx('AI 킬스위치가 OFF입니다. 서버에서 ', 'AI kill-switch is OFF. Enable on the server: ')}<code style={{ fontFamily: 'monospace' }}>cflex-ai on 30</code>{tx(' 후 다시 시도하세요.', '')}
          </div>
        )}

        {!rca && !data.ai_enabled === false && (
          <div style={{ fontSize: 13, color: C.inkSubtle, padding: 8 }}>
            {t.priority === 'P1' ? tx('생성 중입니다 — 잠시 후 새로고침하세요.', 'Generating — refresh in a moment.') : tx('P1이 아닌 티켓은 자동 분석되지 않습니다. "다시 생성" 버튼으로 수동 실행.', 'Non-P1 tickets aren\'t analyzed automatically. Click Regenerate.')}
          </div>
        )}

        {rca?.error && !rca.summary && (
          <div style={{ padding: 10, background: C.criticalSoft, color: C.critical, fontSize: 12 }}>
            ⚠ {rca.error}
          </div>
        )}

        {rca?.summary && (
          <>
            <div style={{ fontSize: 14, color: C.ink, lineHeight: 1.6, marginBottom: 10 }}>
              {rca.summary}
            </div>
            {rca.actions && rca.actions.length > 0 && (
              <>
                <div style={{ ...labelStyle, marginBottom: 6 }}>{tx('권장 조치', 'Recommended actions')}</div>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: C.inkMuted, lineHeight: 1.6 }}>
                  {rca.actions.map((a, i) => <li key={i} style={{ marginBottom: 4 }}>{a}</li>)}
                </ol>
              </>
            )}
            <div style={{ display: 'flex', gap: 12, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.hairline}`, fontSize: 10, color: C.inkSubtle }}>
              {rca.confidence != null && <span>{tx('확신도', 'Confidence')} <strong style={{ color: rca.confidence >= 0.7 ? C.ok : rca.confidence >= 0.4 ? C.warn : C.critical }}>{Math.round(rca.confidence * 100)}%</strong></span>}
              {rca.model && <span>{tx('모델', 'Model')} <code style={{ fontFamily: 'monospace' }}>{rca.model.replace('claude-', '').replace('-20251001', '')}</code></span>}
              {rca.cost_usd > 0 && <span>{tx('비용', 'Cost')} ${rca.cost_usd.toFixed(5)}</span>}
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} style={iconBtn}>{tx('닫기', 'Close')}</button>
      </div>
    </Modal>
  );
}

function SiteDetailModal({ site, onClose }) {
  return (
    <Modal title={`${tx('사이트', 'Site')} · ${site.name}`} onClose={onClose} width={500}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 14 }}>
        {[
          { label: tx('전체', 'Total'),   value: site.total,    color: C.primary },
          { label: tx('위험', 'Critical'), value: site.critical, color: C.critical },
          { label: tx('경고', 'Warning'),  value: site.warn,     color: C.warn },
        ].map(t => (
          <div key={t.label} style={{ background: C.card, padding: 14, borderTop: `3px solid ${t.color}`, border: `1px solid ${C.hairline}` }}>
            <div style={{ fontSize: 10, color: C.inkSubtle, letterSpacing: '0.4px', fontWeight: 700, textTransform: 'uppercase' }}>{t.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: t.color }}>{t.value}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: C.inkSubtle, padding: 12, background: C.bg }}>
        {tx('이 사이트의 장치 목록은 좌측 \"장치\" 섹션에서 룸/랙별로 확인하세요.', 'Drill into Devices section to view per-rack device list for this site.')}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={onClose} style={iconBtn}>{tx('닫기', 'Close')}</button>
      </div>
    </Modal>
  );
}

// ─── KPI 타일 클릭 시 ── 상태별 장치 필터 목록 모달 ────────────────
function DevicesByStatusModal({ statusKey, title, onClose }) {
  const { openDevice, cbu } = useFmsModal();
  const [assets, setAssets] = useState(null);
  useEffect(() => {
    api.get(withCbu('/v1/fms/assets', cbu)).then(d => {
      if (!d?.ok) return;
      const filtered = d.assets.filter(a => {
        if (statusKey === 'critical') return a.status === 'critical' || a.status === 'unreachable';
        return a.status === statusKey;
      });
      setAssets(filtered);
    });
  }, [statusKey, cbu]);

  return (
    <Modal title={title} onClose={onClose} width={760}>
      {!assets ? <Loading /> : assets.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>
          {tx('해당 상태의 장치가 없습니다.', 'No devices in this status.')}
        </div>
      ) : (
        <div style={{ border: `1px solid ${C.hairline}` }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 140px 80px 80px 80px 110px', minWidth: 640,
            padding: '10px 14px', fontSize: 10, fontWeight: 700, color: C.inkSubtle,
            letterSpacing: '0.4px', textTransform: 'uppercase', borderBottom: `1px solid ${C.hairline}`, background: '#fafafa',
          }}>
            <div>{tx('장치 · 룸 / 랙', 'Device · room / rack')}</div>
            <div>{tx('IP', 'IP')}</div>
            <div>{tx('배터리', 'Batt')}</div>
            <div>{tx('부하', 'Load')}</div>
            <div>{tx('온도', 'Temp')}</div>
            <div style={{ textAlign: 'right' }}>{tx('마지막', 'Last')}</div>
          </div>
          {assets.map(a => (
            <div key={a.id} onClick={() => { onClose(); openDevice(a.id); }} style={{
              display: 'grid', gridTemplateColumns: '1fr 140px 80px 80px 80px 110px', minWidth: 640,
              padding: '10px 14px', borderBottom: `1px solid ${C.hairline}`, cursor: 'pointer', fontSize: 13, alignItems: 'center',
            }}
              onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
              onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
              <div>
                <div style={{ fontWeight: 600 }}>{a.label}</div>
                <div style={{ fontSize: 10, color: C.inkSubtle, marginTop: 2 }}>{a.room || '—'} · {a.rack || '—'}</div>
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 12, color: C.inkMuted }}>{a.ip || '—'}</div>
              <div>{a.battery_pct != null ? `${Math.round(a.battery_pct)}%` : '—'}</div>
              <div>{a.load_pct != null ? `${Math.round(a.load_pct)}%` : '—'}</div>
              <div>{a.temp_c != null ? `${Math.round(a.temp_c)}°` : '—'}</div>
              <div style={{ textAlign: 'right', fontSize: 11, color: C.inkSubtle }}>{fmtTime(a.last_polled)}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 14, fontSize: 11, color: C.inkSubtle }}>
        {assets ? `${assets.length} ${tx('장치', 'devices')}` : ''}
      </div>
    </Modal>
  );
}

// ─── 사이트 KPI 클릭 시 ── 사이트 목록 모달 ───────────────────────
function SitesListModal({ onClose }) {
  const { openSiteDevices } = useFmsModal();
  const [sites, setSites] = useState(null);
  useEffect(() => { api.get('/v1/fms/sites-map').then(d => d?.ok && setSites(d.sites)); }, []);

  return (
    <Modal title={tx('사이트 목록', 'Sites')} onClose={onClose} width={600}>
      {!sites ? <Loading /> : sites.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>
          {tx('등록된 사이트가 없습니다.', 'No sites registered.')}
        </div>
      ) : (
        <div style={{ border: `1px solid ${C.hairline}` }}>
          {sites.map((s, i) => {
            const sev = s.critical > 0 ? 'critical' : s.warn > 0 ? 'warn' : 'ok';
            const sc = statusColor(sev);
            return (
              <div key={i} onClick={() => openSiteDevices(s.cbu)} style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
                borderBottom: `1px solid ${C.hairline}`, borderLeft: `3px solid ${sc.fg}`,
                cursor: 'pointer', fontSize: 13,
              }}
                onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: C.inkSubtle, marginTop: 2 }}>
                    {s.total} {tx('UPS', 'UPS')}
                    {s.critical > 0 && <> · <span style={{ color: C.critical, fontWeight: 700 }}>{s.critical} {tx('위험', 'critical')}</span></>}
                    {s.warn > 0 && <> · <span style={{ color: C.warn, fontWeight: 700 }}>{s.warn} {tx('경고', 'warning')}</span></>}
                  </div>
                  {s.address && <div style={{ fontSize: 11, color: C.inkSubtle, marginTop: 2 }}>{s.address}</div>}
                </div>
                <ChevronRight size={14} color={C.inkSubtle} />
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ─── Bell click → unified notification center ─────────────────────
function NotificationsModal({ onClose }) {
  const { openAlarm, openTicket } = useFmsModal();
  const [alerts, setAlerts] = useState(null);
  const [tickets, setTickets] = useState(null);
  const [tab, setTab] = useState('all');

  useEffect(() => {
    api.get('/v1/fms/alerts?hours=24').then(d => d?.ok && setAlerts(d.alerts || []));
    api.get('/v1/fms/tickets?status=open').then(d => d?.ok && setTickets(d.tickets || []));
  }, []);

  const loading = alerts === null || tickets === null;
  const p1Tickets = (tickets || []).filter(t => t.priority === 'P1');
  const p1Alerts = (alerts || []).filter(a => a.priority === 'P1');
  const recentAlerts = (alerts || []).slice(0, 30);

  const items = useMemo(() => {
    if (loading) return [];
    const list = [];
    p1Tickets.forEach(t => list.push({
      kind: 'ticket', ts: t.created_at, priority: 'P1', title: t.title,
      sub: `${t.ticket_no} · ${t.device_label || t.device_id}`, payload: t,
    }));
    recentAlerts.forEach(a => list.push({
      kind: 'alert', ts: a.received_at, priority: a.priority, title: a.message,
      sub: `${a.device_label || a.device_id}${a.metric ? ' · ' + a.metric : ''}`, payload: a,
    }));
    return list.sort((a, b) => b.ts - a.ts);
  }, [loading, p1Tickets.length, recentAlerts.length]);

  const filtered = tab === 'all' ? items
    : tab === 'p1' ? items.filter(i => i.priority === 'P1')
    : tab === 'tickets' ? items.filter(i => i.kind === 'ticket')
    : items.filter(i => i.kind === 'alert');

  const tabs = [
    { id: 'all',     label: tx('전체', 'All'),       count: items.length },
    { id: 'p1',      label: 'P1',                     count: items.filter(i => i.priority === 'P1').length },
    { id: 'tickets', label: tx('티켓', 'Tickets'),    count: p1Tickets.length },
    { id: 'alerts',  label: tx('알람', 'Alerts'),     count: recentAlerts.length },
  ];

  const handleClick = (item) => {
    onClose();
    if (item.kind === 'ticket') openTicket(item.payload);
    else openAlarm(item.payload);
  };

  return (
    <Modal title={
      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        <Bell size={16} color={C.primary} /> {tx('알림 센터', 'Notifications')}
      </span>
    } onClose={onClose} width={620}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${C.hairline}`, marginBottom: 12 }}>
        {tabs.map(t => (
          <div key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '8px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            color: tab === t.id ? C.primary : C.inkMuted,
            borderBottom: tab === t.id ? `2px solid ${C.primary}` : '2px solid transparent',
            marginBottom: -1,
          }}>
            {t.label} <span style={{ fontSize: 10, color: C.inkSubtle, marginLeft: 4 }}>{t.count}</span>
          </div>
        ))}
      </div>

      {loading ? <Loading /> : filtered.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>
          {tx('알림 없음', 'Nothing to show')}
        </div>
      ) : (
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {filtered.map((item, i) => {
            const sc = sevColor(item.priority);
            return (
              <div key={i} onClick={() => handleClick(item)} style={{
                display: 'flex', gap: 12, padding: '12px 10px', borderBottom: `1px solid ${C.hairline}`,
                cursor: 'pointer', fontSize: 13, alignItems: 'flex-start',
              }}
                onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                <span style={{
                  padding: '3px 8px', fontSize: 10, fontWeight: 700, background: sc.fg, color: '#fff',
                  minWidth: 28, textAlign: 'center', flexShrink: 0, marginTop: 1,
                }}>{item.priority || '—'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{
                      padding: '1px 5px', fontSize: 9, fontWeight: 700, color: C.inkMuted,
                      background: '#f0f0f0', textTransform: 'uppercase', flexShrink: 0,
                    }}>{item.kind === 'ticket' ? tx('티켓', 'TICKET') : tx('알람', 'ALERT')}</span>
                    <span style={{ fontWeight: 600, color: C.ink, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.inkSubtle, marginTop: 3 }}>{item.sub}</div>
                </div>
                <span style={{ fontSize: 11, color: C.inkSubtle, flexShrink: 0, marginTop: 2 }}>{fmtTime(item.ts)}</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 14, padding: '10px 0', borderTop: `1px solid ${C.hairline}`, fontSize: 11, color: C.inkSubtle, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span>● <strong style={{ color: C.critical }}>{p1Tickets.length}</strong> {tx('미해결 P1 티켓', 'open P1 tickets')}</span>
        <span>● <strong>{p1Alerts.length}</strong> {tx('24h P1 알람', '24h P1 alerts')}</span>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Reusable
// ═══════════════════════════════════════════════════════════════════
const iconBtn = {
  padding: '6px 10px', background: C.card, border: `1px solid ${C.hairline}`,
  cursor: 'pointer', fontSize: 11, fontWeight: 600, color: C.inkMuted,
  display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 6,
};
const zoomBtn = {
  width: 28, height: 28, padding: 0, background: '#fff', border: 'none',
  cursor: 'pointer', fontSize: 16, fontWeight: 700, color: C.inkMuted,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: C.inkMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>{title}</h3>
      {children}
    </div>
  );
}
function Row({ k, v }) {
  return <><div style={{ color: C.inkSubtle }}>{k}</div><div>{v}</div></>;
}
function Loading() {
  return <div style={{ padding: 48, textAlign: 'center', color: C.inkSubtle, fontSize: 13 }}>Loading…</div>;
}

// Stylised SVG silhouette of an APC UPS, varies by family.
// Three families covered: SRT rackmount, Modular Ultra, Symmetra LX.
// Real-photo-traced APC UPS icons (served from public/assets/ups/).
// iconForModel resolves the marketing model string → icon id.
const UPS_ICON_META = {
  srt3000:    { aspect: 480 / 116, label: 'Smart-UPS SRT 3000' },
  srt5000:    { aspect: 480 / 248, label: 'Smart-UPS SRT 5000' },
  srt8000:    { aspect: 480 / 244, label: 'Smart-UPS SRT 8000' },
  modular20k: { aspect: 480 / 330, label: 'Smart-UPS Modular Ultra 20kW' },
  modular15k: { aspect: 480 / 330, label: 'Smart-UPS Modular Ultra 15kW' },
  symmetra_lx:{ aspect: 300 / 440, label: 'Symmetra LX 16000' },
};
const STATUS_STYLE = {
  ok:          { ring: '#24a148', screen: '#cdd6d2', label: 'Online' },
  normal:      { ring: '#24a148', screen: '#cdd6d2', label: 'Online' },
  warn:        { ring: '#f1c21b', screen: '#f3d79a', label: 'Warning' },
  warning:     { ring: '#f1c21b', screen: '#f3d79a', label: 'Warning' },
  critical:    { ring: '#da1e28', screen: '#f3b3b3', label: 'Critical' },
  unreachable: { ring: '#8d8d8d', screen: '#3a3f47', label: 'Offline' },
  offline:     { ring: '#8d8d8d', screen: '#3a3f47', label: 'Offline' },
  unknown:     { ring: '#a8a8a8', screen: '#3a3f47', label: '—' },
};
function iconIdForModel(model) {
  const m = String(model || '');
  if (m.includes('SRT 3000') || /SRT3000/i.test(m)) return 'srt3000';
  if (m.includes('SRT 5000') || /SRT5K/i.test(m))   return 'srt5000';
  if (m.includes('SRT 8000') || /SRT8K/i.test(m))   return 'srt8000';
  if (/Modular Ultra 20/i.test(m) || /SRYLF20K/i.test(m)) return 'modular20k';
  if (/Modular Ultra 15/i.test(m) || /SRYLF15K/i.test(m)) return 'modular15k';
  if (/Symmetra/i.test(m)) return 'symmetra_lx';
  return 'srt5000'; // sensible default
}

// UpsIcon — real APC product photo trace, with a colored status ring + LCD tint.
//   mode="img"   : fast <img> render (default)
//   mode="inline": fetch + inline SVG so #lcd-screen can be tinted per status
// UpsIcon renders the device illustration safely inside any container.
// Both `img` and `inline` modes fully contain the SVG (no overflow), respect
// the model's aspect ratio, and never escape their bounding box.
function UpsModelIcon({ model = '', size = 64, fitBox, accent, status = 'unknown', mode = 'img', label, showStatusDot = true }) {
  const iconId = iconIdForModel(model);
  const meta   = UPS_ICON_META[iconId];
  const aspect = meta.aspect;
  // Sizing strategy:
  //   fitBox={w,h} — fit the icon as large as possible inside the box (preferred)
  //   size        — treat `size` as the longer side; the other follows the aspect
  let w, h;
  if (fitBox && fitBox.width && fitBox.height) {
    if (fitBox.width / aspect <= fitBox.height) {
      w = fitBox.width;  h = Math.round(w / aspect);
    } else {
      h = fitBox.height; w = Math.round(h * aspect);
    }
  } else {
    w = aspect >= 1 ? size : Math.round(size * aspect);
    h = aspect >= 1 ? Math.round(size / aspect) : size;
  }
  const st     = STATUS_STYLE[status] || STATUS_STYLE.unknown;
  const ring   = accent || st.ring;
  const src    = `/assets/ups/${iconId}.svg`;

  return (
    <span style={{
      display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      flexShrink: 0, lineHeight: 0,
    }}>
      <span style={{
        position: 'relative', display: 'block', width: w, height: h, overflow: 'visible',
        boxSizing: 'border-box',
      }}>
        {mode === 'img' ? (
          <img src={src} alt={meta.label}
            style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
            onError={(e) => { e.currentTarget.style.opacity = '0.3'; }} />
        ) : (
          <InlineUpsSvg src={src} status={status} />
        )}
        {showStatusDot && (
          <span aria-hidden style={{
            position: 'absolute', top: -6, right: -6, width: 14, height: 14, borderRadius: '50%',
            background: ring, boxShadow: '0 0 0 3px #fff, 0 0 8px rgba(0,0,0,0.18)',
            animation: (status === 'critical' || status === 'unreachable' || status === 'offline')
              ? 'fmsPulseDot 1.8s ease-in-out infinite' : undefined,
          }} />
        )}
      </span>
      {label && (
        <span style={{ fontSize: 10, color: C.inkSubtle, lineHeight: 1 }}>{label}</span>
      )}
    </span>
  );
}

// Inlines an SVG so we can tint the LCD screen rect per status.
// Strips the root <svg> width/height attributes so the markup follows the
// container size rather than its intrinsic dimensions.
function InlineUpsSvg({ src, status }) {
  const ref = React.useRef(null);
  const [markup, setMarkup] = useState('');
  const uid = React.useRef('u' + Math.random().toString(36).slice(2, 8)).current;
  useEffect(() => {
    let alive = true;
    fetch(src).then(r => r.text()).then(raw => {
      if (!alive) return;
      const ns = raw
        .replace(/id="([^"]+)"/g, `id="${uid}-$1"`)
        // Single url(#X) rewrite covers fill/stroke/filter AND clip-path attributes.
        // (The old code re-applied the prefix to clip-path, double-namespacing the id
        //  and breaking the clip — that's why honeycomb meshes leaked outside the
        //  display rectangle.)
        .replace(/url\(#([^)]+)\)/g, `url(#${uid}-$1)`)
        // Force the inlined SVG to fill its wrapper exactly.
        .replace(/<svg\b([^>]*?)\swidth="[^"]*"/i,  '<svg$1')
        .replace(/<svg\b([^>]*?)\sheight="[^"]*"/i, '<svg$1')
        .replace(/<svg\b/i, '<svg preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:100%"');
      setMarkup(ns);
    });
    return () => { alive = false; };
  }, [src, uid]);
  useEffect(() => {
    const el = ref.current?.querySelector(`#${uid}-lcd-screen`);
    if (el) el.setAttribute('fill', (STATUS_STYLE[status] || STATUS_STYLE.unknown).screen);
  }, [markup, status, uid]);
  return (
    <span ref={ref} style={{ display: 'block', width: '100%', height: '100%' }}
      dangerouslySetInnerHTML={{ __html: markup }} />
  );
}

// Compact model + power tag, used in lists/cards
function ModelTag({ model, accent = C.primary }) {
  const m = String(model || '');
  const kw = m.match(/(\d{1,2})\s*kW/);
  const va = m.match(/SRT\s*(\d{4,5})/);
  const power = kw ? `${kw[1]}kW` : va ? `${(parseInt(va[1], 10) / 1000)}kVA` : '—';
  const family = /Modular Ultra/i.test(m) ? 'Modular' : /Symmetra/i.test(m) ? 'Symmetra' : 'SRT';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700,
      padding: '3px 8px', background: C.bg, color: C.inkMuted, letterSpacing: '0.5px',
      borderLeft: `2px solid ${accent}`,
    }}>
      <span style={{ color: accent }}>{family}</span>
      <span style={{ color: C.ink }}>{power}</span>
    </span>
  );
}

// CBU toggle — top bar segmented control with live device counts
function CbuToggle({ cbu, onChange, isMobile }) {
  const [list, setList] = useState([]);
  useEffect(() => {
    const fetch = () => api.get('/v1/fms/summary').then(d => d?.ok && setList(d.cbu_list || []));
    fetch();
    const t = setInterval(fetch, 60 * 1000);
    return () => clearInterval(t);
  }, []);
  const options = [{ cbu: 'all', label: tx('전체', 'All'), total: list.reduce((s, x) => s + x.total, 0) },
                   ...list.map(x => ({ cbu: x.cbu, label: x.cbu.replace('_', ' '), total: x.total, critical: x.critical, warn: x.warn }))];

  if (isMobile) {
    return (
      <select value={cbu} onChange={e => onChange(e.target.value)} style={{
        padding: '6px 8px', fontSize: 11, fontFamily: FONT, border: `1px solid ${C.hairline}`,
        background: C.card, color: C.ink, fontWeight: 700, flexShrink: 0,
      }}>
        {options.map(o => <option key={o.cbu} value={o.cbu}>{o.label} ({o.total})</option>)}
      </select>
    );
  }

  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${C.hairline}`, flexShrink: 0 }}>
      {options.map(o => {
        const active = cbu === o.cbu;
        const hasAlarm = (o.critical || 0) + (o.warn || 0) > 0;
        return (
          <div key={o.cbu} onClick={() => onChange(o.cbu)} style={{
            padding: '5px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 700,
            background: active ? C.ink : 'transparent',
            color: active ? '#fff' : C.inkMuted,
            borderRight: `1px solid ${C.hairline}`,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
            {o.label}
            <span style={{ fontSize: 10, opacity: 0.7, fontWeight: 600 }}>{o.total}</span>
            {hasAlarm && <span style={{ width: 5, height: 5, borderRadius: '50%', background: o.critical > 0 ? C.critical : C.warn }} />}
          </div>
        );
      })}
    </div>
  );
}

// ThresholdGraph — multi-series sparkline with threshold zone shading
function ThresholdGraph({ series }) {
  const W = 900, H = 240, P = 36;
  const data = series[0].data;
  if (!data || data.length === 0) return <div style={{ padding: 24, textAlign: 'center', color: C.inkSubtle }}>No data</div>;
  const xs = data.map(d => d.ts);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const xScale = (t) => P + ((t - xMin) / Math.max(1, xMax - xMin)) * (W - P * 2);

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H + 40}`} width="100%" preserveAspectRatio="xMidYMid meet">
        {/* Axis */}
        <line x1={P} y1={H} x2={W - P} y2={H} stroke="#e0e0e0" />
        {series.map((s, idx) => {
          const vals = s.data.map(d => d[s.key]).filter(v => v != null);
          if (!vals.length) return null;
          const yMin = Math.min(...vals, 0), yMax = Math.max(...vals, 100);
          const yScale = (v) => H - P - ((v - yMin) / Math.max(1, yMax - yMin)) * (H - P * 2);

          // Threshold zones (only render first series's zone to avoid clutter)
          let zones = null;
          if (idx === 0 && s.threshold) {
            const th = s.threshold;
            const cy = yScale(th.critical), wy = yScale(th.warn);
            if (th.direction === 'below') {
              // critical zone below critical line (toward bottom)
              zones = (
                <>
                  <rect x={P} y={cy} width={W - P * 2} height={Math.max(0, H - P - cy)} fill={C.critical} opacity="0.07" />
                  <rect x={P} y={wy} width={W - P * 2} height={Math.max(0, cy - wy)} fill={C.warn} opacity="0.07" />
                  <line x1={P} y1={cy} x2={W - P} y2={cy} stroke={C.critical} strokeWidth="1" strokeDasharray="4,4" opacity="0.5" />
                  <line x1={P} y1={wy} x2={W - P} y2={wy} stroke={C.warn} strokeWidth="1" strokeDasharray="4,4" opacity="0.5" />
                </>
              );
            } else {
              zones = (
                <>
                  <rect x={P} y={P} width={W - P * 2} height={Math.max(0, cy - P)} fill={C.critical} opacity="0.07" />
                  <rect x={P} y={cy} width={W - P * 2} height={Math.max(0, wy - cy)} fill={C.warn} opacity="0.07" />
                  <line x1={P} y1={cy} x2={W - P} y2={cy} stroke={C.critical} strokeWidth="1" strokeDasharray="4,4" opacity="0.5" />
                  <line x1={P} y1={wy} x2={W - P} y2={wy} stroke={C.warn} strokeWidth="1" strokeDasharray="4,4" opacity="0.5" />
                </>
              );
            }
          }

          const path = s.data.filter(d => d[s.key] != null).map((d, i) =>
            `${i === 0 ? 'M' : 'L'} ${xScale(d.ts)} ${yScale(d[s.key])}`).join(' ');
          return (
            <React.Fragment key={s.key}>
              {zones}
              <path d={path} stroke={s.color} strokeWidth={1.6} fill="none" />
            </React.Fragment>
          );
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 6, fontSize: 11, color: C.inkMuted }}>
        {series.map(s => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 12, height: 2, background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
