// ============================================================
// M365SsoPage — Standalone admin page mounted on cflex.runless.co.uk
// (and reachable from fms.runless.co.uk).
// Self-service Microsoft 365 SSO configuration for the tenant.
// ============================================================
import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../hooks/useAuth';

const C = {
  primary: '#0f62fe', primarySoft: '#edf5ff',
  ok: '#24a148', okSoft: '#defbe6',
  warn: '#f1c21b', warnSoft: '#fff8e1',
  danger: '#da1e28', dangerSoft: '#fff1f1',
  ink: '#161616', inkMuted: '#525252', inkSubtle: '#8d8d8d',
  bg: '#f4f4f4', card: '#fff', hairline: '#e0e0e0',
};
const FONT = '"IBM Plex Sans","Helvetica Neue",Arial,sans-serif';

const auth = () => {
  const t = localStorage.getItem('cflex_token') || localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const api = {
  get:  (p)        => fetch(p, { headers: auth() }).then(r => r.json()),
  post: (p, body)  => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() }, body: JSON.stringify(body) }).then(r => r.json()),
  del:  (p)        => fetch(p, { method: 'DELETE', headers: auth() }).then(r => r.json()),
};

const fmtAbs = (ms) => ms ? new Date(ms).toLocaleString() : '—';

const fieldStyle = {
  width: '100%', padding: '8px 12px', fontSize: 13, fontFamily: FONT,
  background: '#fff', border: `1px solid ${C.hairline}`, borderRadius: 0, outline: 'none',
};
const labelStyle = {
  fontSize: 11, fontWeight: 600, color: C.inkMuted, marginBottom: 4,
  textTransform: 'uppercase', letterSpacing: '0.3px', display: 'block',
};
const btnPrimary = { height: 36, padding: '0 18px', background: C.primary, color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13, fontFamily: FONT };
const btnGhost   = { height: 36, padding: '0 16px', background: '#fff', color: C.ink, border: `1px solid ${C.hairline}`, cursor: 'pointer', fontSize: 13, fontFamily: FONT };
const btnDanger  = { height: 36, padding: '0 16px', background: '#fff', color: C.danger, border: `1px solid ${C.danger}`, cursor: 'pointer', fontSize: 13, fontFamily: FONT };
const btnGhostMini  = { height: 26, padding: '0 10px', fontSize: 11, fontWeight: 500, background: '#fff', color: C.ink, border: `1px solid ${C.hairline}`, cursor: 'pointer' };
const btnDangerMini = { height: 26, padding: '0 10px', fontSize: 11, fontWeight: 600, background: '#fff', color: C.danger, border: `1px solid ${C.danger}`, cursor: 'pointer' };

const ROLE_OPTIONS = ['fms_admin', 'customer_admin', 'customer_viewer', 'engineer', 'noc_operator', 'admin'];

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: C.inkMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>{title}</h3>
      {children}
    </div>
  );
}

export default function M365SsoPage() {
  const { user, tenant } = useAuth();
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ azure_tenant_id: '', client_id: '', client_secret: '',
                                     allowed_domains: '', password_login_disabled: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [mappings, setMappings] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupSearch, setGroupSearch] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const [newMap, setNewMap] = useState({ ad_group_id: '', ad_group_name: '', cflex_role: 'fms_admin' });

  const reload = () => {
    setLoading(true);
    api.get('/v1/admin/m365/config').then(d => {
      if (d?.ok) {
        setCfg(d);
        if (d.connected) setForm(f => ({
          ...f,
          azure_tenant_id: d.azure_tenant_id || '',
          client_id: d.client_id || '',
          client_secret: '',
          allowed_domains: (d.allowed_domains || []).join(', '),
          password_login_disabled: !!d.password_login_disabled,
        }));
      }
      setLoading(false);
    });
    api.get('/v1/admin/m365/role-mapping').then(d => { if (d?.ok) setMappings(d.mappings || []); });
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    setMsg(null); setBusy(true);
    const domains = form.allowed_domains.split(',').map(s => s.trim()).filter(Boolean);
    const r = await api.post('/v1/admin/m365/config', {
      azure_tenant_id: form.azure_tenant_id.trim(),
      client_id: form.client_id.trim(),
      client_secret: form.client_secret,
      allowed_domains: domains,
      password_login_disabled: !!form.password_login_disabled,
    });
    setBusy(false);
    if (r?.ok) { setMsg({ ok: true, text: 'Saved' }); setForm(f => ({ ...f, client_secret: '' })); reload(); }
    else setMsg({ ok: false, text: r?.error || 'Save failed' });
  };
  const test = async () => {
    setBusy(true); setMsg(null);
    const r = await api.post('/v1/admin/m365/test', {});
    setBusy(false);
    if (r?.ok) setMsg({ ok: true, text: `Connected — issuer: ${r.issuer}` });
    else setMsg({ ok: false, text: r?.error || 'Test failed' });
  };
  const disconnect = async () => {
    if (!confirm('Disconnect Microsoft 365? Role mappings will also be removed.')) return;
    const r = await api.del('/v1/admin/m365/config');
    if (r?.ok) reload();
  };
  const loadGroups = async () => {
    setGroupBusy(true);
    const q = groupSearch ? `?search=${encodeURIComponent(groupSearch)}` : '';
    const r = await api.get('/v1/admin/m365/groups' + q);
    setGroupBusy(false);
    if (r?.ok) setGroups(r.groups || []);
    else setMsg({ ok: false, text: r?.error || 'Group lookup failed' });
  };
  const addMapping = async () => {
    if (!newMap.ad_group_id) { setMsg({ ok: false, text: 'Pick a group' }); return; }
    const r = await api.post('/v1/admin/m365/role-mapping', newMap);
    if (r?.ok) { setNewMap({ ad_group_id: '', ad_group_name: '', cflex_role: 'fms_admin' }); reload(); }
    else setMsg({ ok: false, text: r?.error || 'Add failed' });
  };
  const delMapping = async (id) => {
    if (!confirm('Delete mapping?')) return;
    const r = await api.del(`/v1/admin/m365/role-mapping/${id}`);
    if (r?.ok) reload();
  };

  const connected = cfg?.connected;
  const redirectUri = cfg?.redirect_uri || (window.location.origin + '/v1/auth/m365/callback');

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: C.inkSubtle, fontFamily: FONT }}>Loading…</div>;

  return (
    <div style={{ padding: 24, maxWidth: 1100, fontFamily: FONT, color: C.ink }}>
      <h1 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 700 }}>Microsoft 365 SSO</h1>
      <p style={{ margin: '0 0 18px', color: C.inkMuted, fontSize: 13 }}>
        Connect this tenant ({tenant?.display_name || tenant?.name || '—'}) to Microsoft 365 so members can sign in
        with their corporate identity. Configuration is per-tenant and self-service.
      </p>

      <Section title="Microsoft 365 connection">
        <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 18 }}>
          <div style={{ marginBottom: 14, padding: '10px 14px', fontSize: 13,
                        background: connected ? C.okSoft : C.warnSoft,
                        border: `1px solid ${connected ? C.ok : C.warn}` }}>
            <strong style={{ color: connected ? C.ok : '#8a6d3b' }}>
              {connected ? '✓ Connected' : '○ Not connected'}
            </strong>
            {connected && cfg?.connected_at && (
              <span style={{ color: C.inkMuted, marginLeft: 10, fontSize: 12 }}>· {fmtAbs(cfg.connected_at)}</span>
            )}
          </div>

          <details style={{ marginBottom: 14, background: C.bg, padding: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 12, color: C.inkMuted, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              How to register an Azure AD app (single-tenant)
            </summary>
            <ol style={{ fontSize: 12, color: C.inkMuted, lineHeight: 1.7, margin: '10px 0 0 18px' }}>
              <li><a href="https://portal.azure.com" target="_blank" rel="noopener" style={{ color: C.primary }}>portal.azure.com</a> → Microsoft Entra ID → App registrations → <strong>New registration</strong></li>
              <li>Name: <code>C-Flex FMS</code>, Supported account types: <strong>Single tenant</strong></li>
              <li>Redirect URI (Web): <code style={{ background: '#fff', padding: '2px 6px', userSelect: 'all' }}>{redirectUri}</code></li>
              <li>Copy <strong>Application (client) ID</strong> and <strong>Directory (tenant) ID</strong> from Overview → paste below</li>
              <li><strong>Certificates &amp; secrets</strong> → <strong>New client secret</strong> → copy the value (shown once) → paste below</li>
              <li><strong>API permissions</strong> → Microsoft Graph → Delegated: <code>User.Read</code> · Application: <code>GroupMember.Read.All</code> · <strong>Grant admin consent</strong></li>
              <li><strong>Token configuration</strong> → Add optional claim → ID → <code>groups</code></li>
            </ol>
          </details>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={labelStyle}>Directory (Tenant) ID</div>
              <input style={fieldStyle} value={form.azure_tenant_id}
                     onChange={e => setForm({ ...form, azure_tenant_id: e.target.value })}
                     placeholder="00000000-0000-0000-0000-000000000000" />
            </div>
            <div>
              <div style={labelStyle}>Application (Client) ID</div>
              <input style={fieldStyle} value={form.client_id}
                     onChange={e => setForm({ ...form, client_id: e.target.value })}
                     placeholder="00000000-0000-0000-0000-000000000000" />
            </div>
            <div>
              <div style={labelStyle}>{connected ? 'Client Secret (only when changing)' : 'Client Secret'}</div>
              <input style={fieldStyle} type="password" value={form.client_secret}
                     onChange={e => setForm({ ...form, client_secret: e.target.value })}
                     placeholder={connected ? 'Leave empty to keep current' : ''} />
            </div>
            <div>
              <div style={labelStyle}>Allowed domains (comma-separated)</div>
              <input style={fieldStyle} value={form.allowed_domains}
                     onChange={e => setForm({ ...form, allowed_domains: e.target.value })}
                     placeholder="haeaus.com, hyundai.com" />
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.password_login_disabled}
                   onChange={e => setForm({ ...form, password_login_disabled: e.target.checked })} />
            <span>Disable password login (Microsoft 365 only)</span>
          </label>

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button onClick={save}
                    disabled={busy || !form.azure_tenant_id || !form.client_id || (!connected && !form.client_secret)}
                    style={btnPrimary}>
              {connected ? 'Update' : 'Save & Connect'}
            </button>
            {connected && (
              <>
                <button onClick={test} disabled={busy} style={btnGhost}>Test connection</button>
                <button onClick={disconnect} style={btnDanger}>Disconnect</button>
              </>
            )}
          </div>

          {msg && (
            <div style={{ marginTop: 12, padding: '8px 12px', fontSize: 12,
                          background: msg.ok ? C.okSoft : C.dangerSoft,
                          color: msg.ok ? C.ok : C.danger,
                          border: `1px solid ${msg.ok ? C.ok : C.danger}` }}>
              {msg.text}
            </div>
          )}
        </div>
      </Section>

      {connected && (
        <Section title="Azure AD group → role mapping">
          <div style={{ background: C.card, border: `1px solid ${C.hairline}`, padding: 18 }}>
            <div style={{ fontSize: 12, color: C.inkMuted, marginBottom: 12 }}>
              When AD group members sign in, they receive the mapped C-Flex role automatically.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr auto', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
              <div>
                <div style={labelStyle}>Search groups (name prefix)</div>
                <input style={fieldStyle} value={groupSearch}
                       onChange={e => setGroupSearch(e.target.value)}
                       placeholder="e.g. HAEA-FMS" />
              </div>
              <button onClick={loadGroups} disabled={groupBusy} style={btnGhost}>
                {groupBusy ? 'Loading…' : 'Fetch groups'}
              </button>
            </div>

            {groups.length > 0 && (
              <div style={{ marginBottom: 14, maxHeight: 220, overflow: 'auto', border: `1px solid ${C.hairline}` }}>
                {groups.map(g => (
                  <div key={g.id}
                       style={{ padding: '8px 12px', fontSize: 12, cursor: 'pointer',
                                background: newMap.ad_group_id === g.id ? C.primarySoft : '#fff',
                                borderBottom: `1px solid ${C.hairline}` }}
                       onClick={() => setNewMap({ ...newMap, ad_group_id: g.id, ad_group_name: g.displayName })}>
                    <div style={{ fontWeight: 600 }}>{g.displayName}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 10, color: C.inkSubtle }}>{g.id}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
              <div>
                <div style={labelStyle}>Selected group</div>
                <input style={fieldStyle} value={newMap.ad_group_name || newMap.ad_group_id}
                       onChange={e => setNewMap({ ...newMap, ad_group_name: e.target.value })}
                       placeholder="Click a group above or paste a group ID" />
              </div>
              <div>
                <div style={labelStyle}>Assigned role</div>
                <select style={fieldStyle} value={newMap.cflex_role}
                        onChange={e => setNewMap({ ...newMap, cflex_role: e.target.value })}>
                  {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <button onClick={addMapping} style={btnPrimary}>Add mapping</button>
            </div>

            <div style={{ borderTop: `1px solid ${C.hairline}`, paddingTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.inkMuted, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 8 }}>
                Active mappings · {mappings.length}
              </div>
              {mappings.length === 0 ? (
                <div style={{ padding: 16, fontSize: 12, color: C.inkSubtle, textAlign: 'center', background: C.bg }}>
                  No mappings. Without mappings, new users default to customer_viewer.
                </div>
              ) : mappings.map(m => (
                <div key={m.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 10,
                                         padding: '8px 12px', fontSize: 12, alignItems: 'center',
                                         borderBottom: `1px solid ${C.hairline}` }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{m.ad_group_name || '—'}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 10, color: C.inkSubtle }}>{m.ad_group_id}</div>
                  </div>
                  <div style={{ fontWeight: 600, color: C.primary }}>{m.cflex_role}</div>
                  <button onClick={() => delMapping(m.id)} style={btnDangerMini}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
