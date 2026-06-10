// ============================================================
// C-Flex FMS — Tenant Model
// ============================================================

const db = require("../config/database");

function hydrate(t) {
  if (!t) return t;
  if (typeof t.feature_flags === "string") {
    try { t.feature_flags = JSON.parse(t.feature_flags); } catch (e) {}
  }
  if (typeof t.enabled_modules === "string") {
    try { t.enabled_modules = JSON.parse(t.enabled_modules); } catch (e) { t.enabled_modules = []; }
  }
  if (typeof t.sku === "string") {
    try { t.sku = JSON.parse(t.sku); } catch (e) {}
  }
  return t;
}

exports.findById = (id) => hydrate(db.prepare("SELECT * FROM tenants WHERE id = ?").get(id));

exports.findByCode = (tenantCode) => hydrate(db.prepare("SELECT * FROM tenants WHERE tenant_code = ?").get(tenantCode));

exports.findBySubdomain = (subdomain) => hydrate(db.prepare("SELECT * FROM tenants WHERE subdomain = ?").get(subdomain));

exports.create = ({ tenantCode, displayName, subdomain, featureFlags, brandingLogo, primaryColor, secondaryColor }) => {
  const result = db.prepare(`INSERT INTO tenants
    (tenant_code, display_name, subdomain,
     branding_logo_url, branding_primary_color, branding_secondary_color,
     feature_flags, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    tenantCode, displayName, subdomain,
    brandingLogo || null,
    primaryColor || "#3B82F6",
    secondaryColor || "#06B6D4",
    featureFlags ? JSON.stringify(featureFlags) : null,
    Date.now()
  );
  return { id: result.lastInsertRowid, tenantCode };
};

exports.listAll = () => {
  return db.prepare("SELECT * FROM tenants ORDER BY created_at DESC").all().map(hydrate);
};
