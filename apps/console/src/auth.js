// auth.js — local accounts (spec 01 §2.2): password hashing and policy, the
// three roles, sessions in Redis, and the login lockout.
//
// Sessions and failure counters are in Redis, not memory, so a user logged in
// through app01 stays logged in when app01 stops and app02 answers (SAT 6),
// and five wrong passwords lock the account on both nodes, not five per node.
//
// The session token is 32 random bytes in an HttpOnly, SameSite=Strict
// cookie. Redis holds only its SHA-256, so a Redis dump is not a set of live
// sessions.
const crypto = require('crypto');

const ROLES = Object.freeze({ viewer: 1, operator: 2, admin: 3 });
const can = (role, need) => (ROLES[role] || 0) >= (ROLES[need] || 99);

// ── passwords ──────────────────────────────────────────────────────────────
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length,
    { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(want, got);
}

// A hash to compare against when the user does not exist, so a wrong username
// takes as long as a wrong password and the timing does not list the accounts.
const DUMMY_HASH = hashPassword(crypto.randomBytes(18).toString('base64'));

/**
 * Policy: at least 12 characters, three of the four character classes, and
 * not containing the username. Returns null when acceptable, or the reason.
 */
function passwordProblem(pw, username = '') {
  const s = String(pw || '');
  if (s.length < 12) return 'at least 12 characters';
  if (s.length > 256) return 'at most 256 characters';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(s)).length;
  if (classes < 3) return 'three of: lower case, upper case, digit, symbol';
  if (username && s.toLowerCase().includes(String(username).toLowerCase())) return 'must not contain the username';
  return null;
}

// ── sessions ───────────────────────────────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * @param {object} redis   redis.js client (or anything with get/set/del)
 * @param {object} o       { idleS, absoluteS, prefix }
 */
function createSessions(redis, { idleS = 1800, absoluteS = 43200, prefix = 'cflex:console:' } = {}) {
  const key = (token) => `${prefix}sess:${sha(token)}`;

  async function create(user, meta = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const s = { uid: user.id, username: user.username, role: user.role, created: Date.now(), ...meta };
    await redis.set(key(token), JSON.stringify(s), idleS);
    return { token, session: s };
  }

  /** The session for a token, its idle timer restarted; null when absent or past the absolute limit. */
  async function get(token) {
    if (!token || token.length > 128) return null;
    const raw = await redis.get(key(token));
    if (!raw) return null;
    const s = JSON.parse(raw);
    const left = Math.floor((s.created + absoluteS * 1000 - Date.now()) / 1000);
    if (left <= 0) { await redis.del(key(token)); return null; }
    await redis.expire(key(token), Math.min(idleS, left));
    return s;
  }

  const destroy = (token) => (token ? redis.del(key(token)) : 0);

  return { create, get, destroy };
}

// ── lockout ────────────────────────────────────────────────────────────────
function createLockout(redis, { maxFails = 5, windowS = 900, prefix = 'cflex:console:' } = {}) {
  const key = (u) => `${prefix}fail:${String(u).toLowerCase()}`;
  return {
    async locked(u) { return (parseInt(await redis.get(key(u)), 10) || 0) >= maxFails; },
    async fail(u) {
      const n = await redis.incr(key(u));
      if (n === 1) await redis.expire(key(u), windowS);
      return n;
    },
    clear: (u) => redis.del(key(u)),
  };
}

module.exports = { ROLES, can, hashPassword, verifyPassword, passwordProblem, DUMMY_HASH, createSessions, createLockout, sha };
