// ============================================================
// C-Flex — Microsoft 365 SSO routes
//
// Admin (per-tenant config, authenticated as tenant admin):
//   POST   /v1/admin/m365/config          save Azure tenant_id + client_id + secret + domains
//   GET    /v1/admin/m365/config          read current config (secret never returned)
//   DELETE /v1/admin/m365/config          disconnect
//   POST   /v1/admin/m365/test            verify config by calling discovery endpoint
//   GET    /v1/admin/m365/groups          (later) Graph API → AD group dropdown
//   POST   /v1/admin/m365/role-mapping    add group→role mapping
//   GET    /v1/admin/m365/role-mapping    list mappings
//   DELETE /v1/admin/m365/role-mapping/:id
//
// End-user (unauthenticated initially):
//   GET    /v1/auth/m365/login?tenant=...  start PKCE flow
//   GET    /v1/auth/m365/callback          code → tokens → user → C-Flex JWT
// ============================================================

const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const crypto  = require("crypto");
const db      = require("../config/database");
const jwt     = require("jsonwebtoken");
const m365    = require("./m365.lib");

const { verifyToken } = require("../middlewares/auth.middleware");

// PKCE state cache (in-memory; fine for single-node). Expires in 10 min.
const pkceStore = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pkceStore.entries()) if (v.createdAt < cutoff) pkceStore.delete(k);
}, 60 * 1000);

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://fms.runless.co.uk";

function tenantOfReq(req) {
  return req.user?.tenantId || (req.user?.tenant_id) || null;
}

// ── ADMIN: save / read / delete config ─────────────────────────
router.post("/admin/m365/config", verifyToken, (req, res) => {
  const tid = tenantOfReq(req);
  if (!tid) return res.status(400).json({ error: "tenant scope required" });
  if (!["super_admin", "admin", "customer_admin", "fms_admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "admin role required" });
  }
  const { azure_tenant_id, client_id, client_secret, allowed_domains, password_login_disabled } = req.body || {};
  if (!/^[0-9a-f-]{32,40}$/i.test(String(azure_tenant_id))) {
    return res.status(400).json({ error: "azure_tenant_id must be a valid GUID" });
  }
  if (!/^[0-9a-f-]{32,40}$/i.test(String(client_id))) {
    return res.status(400).json({ error: "client_id must be a valid GUID" });
  }
  if (!client_secret || String(client_secret).length < 8) {
    return res.status(400).json({ error: "client_secret required" });
  }
  let domains = Array.isArray(allowed_domains) ? allowed_domains : [];
  domains = domains.map(d => String(d).trim().toLowerCase()).filter(Boolean);

  const enc = m365.encryptSecret(client_secret);
  db.prepare(`INSERT INTO tenant_m365_config
    (tenant_id, azure_tenant_id, client_id, client_secret_enc, allowed_domains,
     password_login_disabled, connected_by, connected_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      azure_tenant_id = excluded.azure_tenant_id,
      client_id = excluded.client_id,
      client_secret_enc = excluded.client_secret_enc,
      allowed_domains = excluded.allowed_domains,
      password_login_disabled = excluded.password_login_disabled,
      connected_by = excluded.connected_by,
      connected_at = excluded.connected_at`)
    .run(tid, azure_tenant_id, client_id, enc, JSON.stringify(domains),
         password_login_disabled ? 1 : 0, req.user.userId || req.user.id, Date.now());
  res.json({ ok: true });
});

router.get("/admin/m365/config", verifyToken, (req, res) => {
  const tid = tenantOfReq(req);
  if (!tid) return res.status(400).json({ error: "tenant scope required" });
  const row = db.prepare(`SELECT tenant_id, azure_tenant_id, client_id, allowed_domains,
                                 password_login_disabled, connected_by, connected_at
                          FROM tenant_m365_config WHERE tenant_id=?`).get(tid);
  if (!row) return res.json({ ok: true, connected: false });
  let domains = [];
  try { domains = JSON.parse(row.allowed_domains || "[]"); } catch {}
  res.json({
    ok: true, connected: true,
    azure_tenant_id: row.azure_tenant_id,
    client_id: row.client_id,
    allowed_domains: domains,
    password_login_disabled: !!row.password_login_disabled,
    connected_at: row.connected_at,
    redirect_uri: `${BASE_URL}/v1/auth/m365/callback`,
  });
});

router.delete("/admin/m365/config", verifyToken, (req, res) => {
  const tid = tenantOfReq(req);
  if (!tid) return res.status(400).json({ error: "tenant scope required" });
  db.prepare("DELETE FROM tenant_m365_config WHERE tenant_id=?").run(tid);
  db.prepare("DELETE FROM m365_role_mapping WHERE tenant_id=?").run(tid);
  res.json({ ok: true });
});

// ── ADMIN: test config by calling tenant discovery endpoint ────
router.post("/admin/m365/test", verifyToken, async (req, res) => {
  const tid = tenantOfReq(req);
  if (!tid) return res.status(400).json({ error: "tenant scope required" });
  const cfg = db.prepare("SELECT azure_tenant_id, client_id FROM tenant_m365_config WHERE tenant_id=?").get(tid);
  if (!cfg) return res.status(404).json({ error: "not configured" });
  try {
    const url = `https://login.microsoftonline.com/${cfg.azure_tenant_id}/v2.0/.well-known/openid-configuration`;
    const r = await axios.get(url, { timeout: 6000 });
    res.json({ ok: true, issuer: r.data.issuer, tenant_region: r.data.tenant_region_scope });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.response?.data?.error_description || e.message });
  }
});

// ── ADMIN: role mapping CRUD ───────────────────────────────────
router.get("/admin/m365/role-mapping", verifyToken, (req, res) => {
  const tid = tenantOfReq(req);
  if (!tid) return res.status(400).json({ error: "tenant scope required" });
  const rows = db.prepare("SELECT id, ad_group_id, ad_group_name, cflex_role, created_at FROM m365_role_mapping WHERE tenant_id=? ORDER BY id")
    .all(tid);
  res.json({ ok: true, mappings: rows });
});

router.post("/admin/m365/role-mapping", verifyToken, (req, res) => {
  const tid = tenantOfReq(req);
  if (!tid) return res.status(400).json({ error: "tenant scope required" });
  const { ad_group_id, ad_group_name, cflex_role } = req.body || {};
  if (!ad_group_id || !cflex_role) return res.status(400).json({ error: "ad_group_id + cflex_role required" });
  try {
    const r = db.prepare(`INSERT INTO m365_role_mapping
      (tenant_id, ad_group_id, ad_group_name, cflex_role, created_by, created_at)
      VALUES (?,?,?,?,?,?)`)
      .run(tid, ad_group_id, ad_group_name || null, cflex_role, req.user.userId || req.user.id, Date.now());
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/admin/m365/role-mapping/:id", verifyToken, (req, res) => {
  const tid = tenantOfReq(req);
  if (!tid) return res.status(400).json({ error: "tenant scope required" });
  const r = db.prepare("DELETE FROM m365_role_mapping WHERE id=? AND tenant_id=?")
    .run(parseInt(req.params.id, 10), tid);
  if (r.changes === 0) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// ── END-USER: start M365 login (PKCE) ──────────────────────────
//   GET /v1/auth/m365/login?domain=haeaus.com
//   We look up which tenant owns that domain, build the auth URL.
router.get("/auth/m365/login", (req, res) => {
  const domain = String(req.query.domain || "").toLowerCase();
  const explicitTenant = parseInt(req.query.tenant_id || 0, 10);
  let cfg = null;

  if (explicitTenant) {
    cfg = db.prepare("SELECT * FROM tenant_m365_config WHERE tenant_id=?").get(explicitTenant);
  } else if (domain) {
    // Find tenant whose allowed_domains include this domain
    const all = db.prepare("SELECT * FROM tenant_m365_config").all();
    cfg = all.find(c => {
      try { return JSON.parse(c.allowed_domains || "[]").includes(domain); }
      catch { return false; }
    });
  }
  if (!cfg) {
    return res.status(404).json({ error: "no M365 config for that domain/tenant. Ask your admin to connect Microsoft 365 first." });
  }

  const { verifier, challenge } = m365.generatePkce();
  const state = crypto.randomBytes(16).toString("hex");
  pkceStore.set(state, { verifier, tenantId: cfg.tenant_id, createdAt: Date.now() });

  const url = m365.loginUrl({
    azureTenantId: cfg.azure_tenant_id,
    clientId: cfg.client_id,
    redirectUri: `${BASE_URL}/v1/auth/m365/callback`,
    state, codeChallenge: challenge,
  });
  res.redirect(url);
});

// ── END-USER: callback ─────────────────────────────────────────
router.get("/auth/m365/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res.redirect(`/login?m365_error=${encodeURIComponent(error_description || error)}`);
  }
  const session = pkceStore.get(String(state || ""));
  if (!session) return res.status(400).send("invalid or expired state");
  pkceStore.delete(String(state));

  const cfg = db.prepare("SELECT * FROM tenant_m365_config WHERE tenant_id=?").get(session.tenantId);
  if (!cfg) return res.status(404).send("tenant config disappeared");

  const ip = req.ip || req.headers["x-forwarded-for"] || "?";

  try {
    const clientSecret = m365.decryptSecret(cfg.client_secret_enc);
    const tokens = await m365.exchangeCode({
      azureTenantId: cfg.azure_tenant_id,
      clientId: cfg.client_id,
      clientSecret,
      code: String(code),
      redirectUri: `${BASE_URL}/v1/auth/m365/callback`,
      codeVerifier: session.verifier,
    });
    const payload = await m365.verifyIdToken(tokens.id_token, cfg.azure_tenant_id, cfg.client_id);

    const oid = payload.oid || payload.sub;
    const upn = payload.preferred_username || payload.upn || payload.email;
    const emailLower = String(upn || "").toLowerCase();
    const groups = payload.groups || [];

    // Domain enforcement
    let allowed = [];
    try { allowed = JSON.parse(cfg.allowed_domains || "[]"); } catch {}
    if (allowed.length > 0) {
      const dom = emailLower.split("@")[1] || "";
      if (!allowed.includes(dom)) {
        db.prepare(`INSERT INTO m365_auth_log (tenant_id, azure_oid, upn, login_at, ip, ok, error)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(session.tenantId, oid, upn, Date.now(), ip, 0, "domain not allowed: " + dom);
        return res.redirect("/login?m365_error=" + encodeURIComponent("Your domain is not authorized for this tenant"));
      }
    }

    // Find or auto-provision user
    let user = db.prepare("SELECT * FROM users WHERE azure_oid=?").get(oid);
    if (!user) user = db.prepare("SELECT * FROM users WHERE email=?").get(emailLower);

    // Resolve role from group mapping
    let mappedRole = null;
    if (groups.length > 0) {
      const placeholders = groups.map(() => "?").join(",");
      const m = db.prepare(`SELECT cflex_role FROM m365_role_mapping
                            WHERE tenant_id=? AND ad_group_id IN (${placeholders}) LIMIT 1`)
        .get(session.tenantId, ...groups);
      if (m) mappedRole = m.cflex_role;
    }

    if (!user) {
      const role = mappedRole || "customer_viewer";
      const r = db.prepare(`INSERT INTO users
        (tenant_id, email, password_hash, name, role, is_active, created_at,
         azure_oid, azure_tenant_id, microsoft_upn, auto_provisioned)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(session.tenantId, emailLower, "!m365-sso!",
             payload.name || emailLower, role, 1, Date.now(),
             oid, cfg.azure_tenant_id, upn, 1);
      user = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
    } else {
      // Update Azure linkage + apply mapped role if found
      const newRole = mappedRole || user.role;
      db.prepare(`UPDATE users SET azure_oid=?, azure_tenant_id=?, microsoft_upn=?, role=?, last_login=?
                  WHERE id=?`)
        .run(oid, cfg.azure_tenant_id, upn, newRole, Date.now(), user.id);
      user.role = newRole;
    }

    db.prepare(`INSERT INTO m365_auth_log (tenant_id, user_id, azure_oid, upn, login_at, ip, ok)
                VALUES (?,?,?,?,?,?,?)`)
      .run(session.tenantId, user.id, oid, upn, Date.now(), ip, 1);

    // Issue C-Flex JWT (mirrors auth.middleware.issueToken signature)
    const token = jwt.sign(
      { userId: user.id, tenantId: user.tenant_id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    // Redirect to frontend with token in URL fragment (not query) so it doesn't hit access logs
    res.redirect(`/auth/m365/complete#token=${token}`);
  } catch (e) {
    console.error("[m365/callback]", e.message);
    db.prepare(`INSERT INTO m365_auth_log (tenant_id, login_at, ip, ok, error) VALUES (?,?,?,?,?)`)
      .run(session.tenantId, Date.now(), ip, 0, e.message);
    res.redirect("/login?m365_error=" + encodeURIComponent(e.message));
  }
});

module.exports = router;
