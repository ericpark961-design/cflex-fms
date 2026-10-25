// contract/schema.js — the contract's JSON Schemas, used two ways.
//
//   validate(name, payload) — the contract test (§7): is what we are about to
//                             send what the Portal will accept?
//   prune(name, payload)    — the data-minimisation whitelist (§5): drop every
//                             key the schema does not name, and say which.
//
// A validator of our own rather than ajv: the collector runs on RHEL with no
// internet and only Satellite AppStream, so every dependency is one more thing
// to carry in the bundle. It covers the subset of draft 2020-12 the schema
// files use, and throws on any keyword outside that subset — a schema that
// grows a keyword this file ignores must fail loudly, not pass silently.
const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = process.env.CFLEX_SCHEMA_DIR
  || path.resolve(__dirname, '../../../docs/spec/schemas');

const NAMES = ['heartbeat', 'inventory', 'telemetry', 'events', 'files', 'commands', 'config', 'error'];

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$comment', '$defs']);
const ASSERTIONS = new Set([
  '$ref', 'type', 'enum', 'const', 'required', 'properties', 'additionalProperties',
  'propertyNames', 'items', 'minItems', 'maxItems', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'oneOf',
]);

const cache = new Map();
function load(name) {
  if (!cache.has(name)) {
    if (!NAMES.includes(name)) throw new Error(`unknown contract schema: ${name}`);
    const file = path.join(SCHEMA_DIR, `${name}.schema.json`);
    cache.set(name, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return cache.get(name);
}

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`only local $ref is supported: ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part];
    if (node === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  }
  return node;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

const typeMatches = (want, v) => {
  const got = typeOf(v);
  return got === want || (want === 'number' && got === 'integer');
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(root, schema, v, at, errors) {
  if (schema === true) return;
  if (schema === false) { errors.push(`${at}: not allowed`); return; }
  for (const k of Object.keys(schema)) {
    if (!ANNOTATIONS.has(k) && !ASSERTIONS.has(k) && !k.startsWith('x-')) {
      throw new Error(`schema keyword not supported by contract/schema.js: ${k} (at ${at})`);
    }
  }
  if (schema.$ref) check(root, resolve(root, schema.$ref), v, at, errors);

  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some(t => typeMatches(t, v))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(v)}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.some(e => deepEqual(e, v))) {
    errors.push(`${at}: ${JSON.stringify(v)} not in enum`);
  }
  if ('const' in schema && !deepEqual(schema.const, v)) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.oneOf) {
    const n = schema.oneOf.filter(s => { const e = []; check(root, s, v, at, e); return !e.length; }).length;
    if (n !== 1) errors.push(`${at}: matched ${n} of oneOf, need exactly 1`);
  }

  const t = typeOf(v);
  if (t === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength != null && v.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && v.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum != null && v < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (t === 'array') {
    if (schema.minItems != null && v.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && v.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((item, i) => check(root, schema.items, item, `${at}[${i}]`, errors));
  }
  if (t === 'object') {
    for (const r of schema.required || []) {
      if (!(r in v)) errors.push(`${at}: missing ${r}`);
    }
    const props = schema.properties || {};
    for (const [k, val] of Object.entries(v)) {
      if (schema.propertyNames) check(root, schema.propertyNames, k, `${at}{${k}}`, errors);
      if (k in props) check(root, props[k], val, `${at}.${k}`, errors);
      else if (schema.additionalProperties !== undefined) check(root, schema.additionalProperties, val, `${at}.${k}`, errors);
    }
  }
}

/** Validate against a contract schema, or one of its $defs (`'events#/$defs/response'`). */
function validate(name, payload) {
  const [file, frag] = name.split('#');
  const root = load(file);
  const errors = [];
  check(root, frag ? resolve(root, `#${frag}`) : root, payload, '$', errors);
  return { ok: errors.length === 0, errors };
}

// Follow $ref until we reach a node with structure of its own.
function deref(root, schema) {
  let s = schema;
  for (let i = 0; s && s.$ref && i < 16; i++) s = resolve(root, s.$ref);
  return s;
}

function strip(root, schema, v, at, blocked) {
  const s = deref(root, schema);
  if (!s || typeof s !== 'object') return v;
  if (Array.isArray(v)) return s.items ? v.map((x, i) => strip(root, s.items, x, `${at}[${i}]`, blocked)) : v;
  if (v === null || typeof v !== 'object') return v;
  const props = s.properties || {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (k in props) out[k] = strip(root, props[k], val, `${at}.${k}`, blocked);
    else if (s.additionalProperties === false) blocked.push(`${at}.${k}`);
    else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      out[k] = strip(root, s.additionalProperties, val, `${at}.${k}`, blocked);
    } else out[k] = val;
  }
  return out;
}

/**
 * The §5 whitelist: a copy of `payload` with every key the schema does not
 * allow removed, and the paths that were removed. Values are never altered —
 * a value of the wrong type is validate()'s business, not this one's.
 */
function prune(name, payload) {
  const root = load(name);
  const blocked = [];
  const value = strip(root, root, payload, '$', blocked);
  return { value, blocked };
}

module.exports = { validate, prune, load, NAMES, SCHEMA_DIR };
