// seal.js — AES-256-GCM for the secrets the console stores (SNMP community /
// v3 keys, SMTP password, Teams webhook, ServiceNow credentials). Spec 01 §4:
// encrypted at rest, never in a log line, never back out of the API.
//
// The key is 32 bytes in a 0600 file (CONSOLE_SECRET_KEY_FILE), the same on
// app01 and app02. Without a key the console refuses to store a secret rather
// than storing it in the clear.
const crypto = require('crypto');

function keyFrom(material) {
  if (!material) return null;
  const s = String(material).trim();
  const k = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (k.length !== 32) throw new Error('CONSOLE_SECRET_KEY_FILE must hold 32 bytes (64 hex or base64)');
  return k;
}

function createSealer(material) {
  const key = keyFrom(material);
  return {
    available: !!key,
    seal(obj) {
      if (!key) throw Object.assign(new Error('no secret key configured (CONSOLE_SECRET_KEY_FILE)'), { status: 503, code: 'no_secret_key' });
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
      return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
    },
    open(sealed) {
      if (!sealed) return null;
      if (!key) throw Object.assign(new Error('no secret key configured'), { status: 503, code: 'no_secret_key' });
      const [v, iv, tag, ct] = String(sealed).split('.');
      if (v !== 'v1') throw new Error('unknown sealed format');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
    },
  };
}

module.exports = { createSealer };
