// ============================================================
// C-Flex — Microsoft 365 (Entra ID) authentication helpers
//   • crypto:    AES-256-GCM client_secret at-rest encryption
//   • jwks:      JWKS cache for ID-token signature verification
//   • verifyIdToken: validates issuer, aud, exp, signature
//   • exchangeCode: PKCE code → tokens via /oauth2/v2.0/token
//   • adminConsentUrl + loginUrl: build auth URLs per tenant
// ============================================================

const crypto     = require("crypto");
const axios      = require("axios");
const jwt        = require("jsonwebtoken");

// ── At-rest encryption for client_secret ────────────────────────
// Uses M365_SECRETS_KEY (32 bytes, hex) from env. If not set, derives
// from JWT_SECRET — fine for dev, rotate before production.
function getKey() {
  const hex = process.env.M365_SECRETS_KEY;
  if (hex && hex.length >= 64) return Buffer.from(hex.slice(0, 64), "hex");
  return crypto.createHash("sha256").update(String(process.env.JWT_SECRET || "cflex-dev")).digest();
}

function encryptSecret(plain) {
  const key = getKey();
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct  = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  // Layout: [12B iv][16B tag][ct]
  return Buffer.concat([iv, tag, ct]);
}

function decryptSecret(buf) {
  if (!buf || buf.length < 28) throw new Error("invalid client_secret_enc");
  const key = getKey();
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const d   = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// ── JWKS cache per Azure tenant ─────────────────────────────────
const jwksCache = new Map(); // azureTenantId → { keys, fetchedAt }
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getSigningKey(azureTenantId, kid) {
  let entry = jwksCache.get(azureTenantId);
  if (!entry || Date.now() - entry.fetchedAt > JWKS_TTL_MS) {
    const url = `https://login.microsoftonline.com/${azureTenantId}/discovery/v2.0/keys`;
    const r = await axios.get(url, { timeout: 8000 });
    entry = { keys: r.data.keys || [], fetchedAt: Date.now() };
    jwksCache.set(azureTenantId, entry);
  }
  const k = entry.keys.find(k => k.kid === kid);
  if (!k) throw new Error(`no signing key for kid=${kid}`);
  // Microsoft JWKS returns x5c chain — wrap in PEM
  const x5c = k.x5c && k.x5c[0];
  if (!x5c) throw new Error("missing x5c");
  return "-----BEGIN CERTIFICATE-----\n" +
         x5c.match(/.{1,64}/g).join("\n") +
         "\n-----END CERTIFICATE-----\n";
}

// Verify an Azure ID token. Returns the decoded payload.
// expectedTenantId — Azure tenant we expect the token to be from
// expectedClientId — our app's client_id (token aud)
async function verifyIdToken(idToken, expectedTenantId, expectedClientId) {
  const header = JSON.parse(Buffer.from(idToken.split(".")[0], "base64url").toString("utf8"));
  if (!header.kid) throw new Error("missing kid in token header");
  const pem = await getSigningKey(expectedTenantId, header.kid);
  const payload = jwt.verify(idToken, pem, {
    algorithms: ["RS256"],
    audience: expectedClientId,
    issuer: [
      `https://login.microsoftonline.com/${expectedTenantId}/v2.0`,
      `https://sts.windows.net/${expectedTenantId}/`,
    ],
    clockTolerance: 60,
  });
  return payload;
}

// Exchange auth code for tokens (PKCE)
async function exchangeCode({ azureTenantId, clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const url = `https://login.microsoftonline.com/${azureTenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    scope: "openid profile email User.Read GroupMember.Read.All offline_access",
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });
  const r = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000,
  });
  return r.data; // { id_token, access_token, refresh_token, expires_in, ... }
}

// Build URLs
function loginUrl({ azureTenantId, clientId, redirectUri, state, codeChallenge }) {
  const u = new URL(`https://login.microsoftonline.com/${azureTenantId}/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", "openid profile email User.Read GroupMember.Read.All offline_access");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

function adminConsentUrl({ azureTenantId, clientId, redirectUri, state }) {
  const u = new URL(`https://login.microsoftonline.com/${azureTenantId}/v2.0/adminconsent`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

// PKCE helpers
function generatePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

module.exports = {
  encryptSecret, decryptSecret,
  verifyIdToken, exchangeCode,
  loginUrl, adminConsentUrl, generatePkce,
};
