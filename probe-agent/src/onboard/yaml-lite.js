// onboard/yaml-lite.js — the site.yaml subset, the same subset and the same
// errors as the installer's loader (install/lib/cflex_install/siteconf.py):
// block mappings and sequences, one-line flow {..} / [..], quoted and plain
// scalars, comments. Anything else is an error with a line number, never a
// guess. A port rather than a YAML package so site.yaml and
// onboard-credentials.yaml load the same way here as in the installer, and so
// cflex-onboard adds no dependency beyond ssh2.
class YamlError extends Error {}

function stripComment(text) {
  let out = '', q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q && !(q === '"' && i && text[i - 1] === '\\')) q = null; }
    else if (ch === "'" || ch === '"') q = ch;
    else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) break;
    out += ch;
  }
  return out.replace(/\s+$/, '');
}

function scalar(tok, n) {
  const t = tok.trim();
  if (t === '' || ['~', 'null', 'Null', 'NULL'].includes(t)) return null;
  if (t[0] === '"') {
    if (t.length < 2 || t[t.length - 1] !== '"') throw new YamlError(`line ${n}: unterminated string`);
    return JSON.parse(t);
  }
  if (t[0] === "'") {
    if (t.length < 2 || t[t.length - 1] !== "'") throw new YamlError(`line ${n}: unterminated string`);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (['true', 'True', 'TRUE'].includes(t)) return true;
  if (['false', 'False', 'FALSE'].includes(t)) return false;
  if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)$/.test(t)) return parseFloat(t);
  if ('&*!|>%@`'.includes(t[0])) throw new YamlError(`line ${n}: YAML feature not supported here`);
  return t;
}

class Flow {
  constructor(s, n) { this.s = s; this.i = 0; this.n = n; }
  err(msg) { throw new YamlError(`line ${this.n}: ${msg} (col ${this.i + 1})`); }
  ws() { while (this.i < this.s.length && ' \t'.includes(this.s[this.i])) this.i++; }
  value(stops) {
    this.ws();
    if (this.i >= this.s.length) this.err('value expected');
    const c = this.s[this.i];
    if (c === '{') return this.mapping();
    if (c === '[') return this.seq();
    if (c === "'" || c === '"') {
      let j = this.i + 1;
      while (j < this.s.length && !(this.s[j] === c && !(c === '"' && this.s[j - 1] === '\\'))) j++;
      if (j >= this.s.length) this.err('unterminated string');
      const tok = this.s.slice(this.i, j + 1);
      this.i = j + 1;
      return scalar(tok, this.n);
    }
    let j = this.i;
    while (j < this.s.length && !stops.includes(this.s[j])) j++;
    const tok = this.s.slice(this.i, j);
    this.i = j;
    return scalar(tok, this.n);
  }
  key() {
    this.ws();
    let j = this.i;
    if (j < this.s.length && (this.s[j] === "'" || this.s[j] === '"')) return this.value(':');
    while (j < this.s.length) {
      if (this.s[j] === ':' && (j + 1 === this.s.length || ' \t,}'.includes(this.s[j + 1]))) break;
      if (',}'.includes(this.s[j])) { this.i = j; this.err("':' expected after key"); }
      j++;
    }
    const k = this.s.slice(this.i, j).trim();
    this.i = j;
    return k;
  }
  mapping() {
    this.i++;
    const out = {};
    this.ws();
    if (this.s[this.i] === '}') { this.i++; return out; }
    for (;;) {
      const k = this.key();
      this.ws();
      if (this.s[this.i] !== ':') this.err("':' expected");
      this.i++;
      if (Object.prototype.hasOwnProperty.call(out, k)) this.err(`duplicate key ${k}`);
      out[k] = this.value(',}');
      this.ws();
      if (this.i >= this.s.length) this.err("'}' expected");
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === '}') { this.i++; return out; }
      this.err("',' or '}' expected");
    }
  }
  seq() {
    this.i++;
    const out = [];
    this.ws();
    if (this.s[this.i] === ']') { this.i++; return out; }
    for (;;) {
      out.push(this.value(',]'));
      this.ws();
      if (this.i >= this.s.length) this.err("']' expected");
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === ']') { this.i++; return out; }
      this.err("',' or ']' expected");
    }
  }
}

function inline(text, n) {
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') {
    const f = new Flow(t, n);
    const v = f.value('');
    f.ws();
    if (f.i !== t.length) f.err('trailing text');
    return v;
  }
  return scalar(t, n);
}

function splitKey(text, n) {
  let q = null, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q) q = null; continue; }
    if ((ch === "'" || ch === '"') && i === 0) q = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      let k = text.slice(0, i).trim();
      if (k[0] === "'" || k[0] === '"') k = scalar(k, n);
      return [k, text.slice(i + 1).trim()];
    }
  }
  return null;
}

function lines(src) {
  const out = [];
  String(src).split(/\r?\n/).forEach((raw, idx) => {
    const n = idx + 1;
    const lead = raw.slice(0, raw.length - raw.replace(/^\s+/, '').length);
    if (lead.includes('\t')) throw new YamlError(`line ${n}: tab in indentation`);
    const body = stripComment(raw);
    const t = body.trim();
    if (!t || t === '---' || t === '...') return;
    out.push([body.length - body.replace(/^ +/, '').length, t, n]);
  });
  return out;
}

const isItem = (t) => t === '-' || t.startsWith('- ');
const block = (L, i, ind) => (isItem(L[i][1]) ? seqBlock(L, i, ind) : mapBlock(L, i, ind));

function mapBlock(L, i, indent) {
  const out = {};
  while (i < L.length && L[i][0] === indent) {
    const [, text, n] = L[i];
    if (isItem(text)) break;
    const kv = splitKey(text, n);
    if (!kv) throw new YamlError(`line ${n}: 'key: value' expected`);
    const [k, rest] = kv;
    if (Object.prototype.hasOwnProperty.call(out, k)) throw new YamlError(`line ${n}: duplicate key ${k}`);
    i++;
    if (rest) out[k] = inline(rest, n);
    else if (i < L.length && L[i][0] > indent) [out[k], i] = block(L, i, L[i][0]);
    else if (i < L.length && L[i][0] === indent && isItem(L[i][1])) [out[k], i] = seqBlock(L, i, indent);
    else out[k] = null;
  }
  if (i < L.length && L[i][0] > indent) throw new YamlError(`line ${L[i][2]}: unexpected indentation`);
  return [out, i];
}

function seqBlock(L, i, indent) {
  const out = [];
  while (i < L.length && L[i][0] === indent && isItem(L[i][1])) {
    const [, text, n] = L[i];
    const content = text.slice(1).replace(/^ +/, '');
    if (!content) {
      i++;
      let v = null;
      if (i < L.length && L[i][0] > indent) [v, i] = block(L, i, L[i][0]);
      out.push(v);
      continue;
    }
    if (!'{["\''.includes(content[0]) && splitKey(content, n)) {
      const col = indent + (text.length - content.length);
      L[i] = [col, content, n];
      let v;
      [v, i] = mapBlock(L, i, col);
      out.push(v);
      continue;
    }
    out.push(inline(content, n));
    i++;
  }
  return [out, i];
}

function loads(src) {
  const L = lines(src);
  if (!L.length) return {};
  if (L[0][0] !== 0) throw new YamlError(`line ${L[0][2]}: top level must start at column 1`);
  const [data, i] = block(L, 0, 0);
  if (i !== L.length) throw new YamlError(`line ${L[i][2]}: could not parse`);
  return data;
}

module.exports = { loads, YamlError };
