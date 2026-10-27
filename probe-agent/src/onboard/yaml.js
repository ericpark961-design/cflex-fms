// onboard/yaml.js — the YAML subset site.yaml and onboard-credentials.yaml use.
//
// Same subset as the installer's loader (install/lib/cflex_install/siteconf.py):
// block mappings and sequences, one-line flow {..} / [..], quoted and plain
// scalars, comments. Anything else is an error with a line number, never a
// guess. No YAML package is added for the onboarding tool (the only new
// dependency is ssh2), and the same file must load the same way here as in
// the installer.
//
// Error messages carry the line number and a short reason, never the line's
// text: the credentials file holds passwords.

class YamlError extends Error {}

function stripComment(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q && !(q === '"' && text[i - 1] === '\\')) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function scalar(tok, lineno) {
  const t = tok.trim();
  if (t === '' || t === '~' || /^null$/i.test(t)) return null;
  if (t[0] === '"') {
    if (t.length < 2 || t[t.length - 1] !== '"') throw new YamlError(`line ${lineno}: unterminated string`);
    try { return JSON.parse(t); } catch { throw new YamlError(`line ${lineno}: bad quoted string`); }
  }
  if (t[0] === "'") {
    if (t.length < 2 || t[t.length - 1] !== "'") throw new YamlError(`line ${lineno}: unterminated string`);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)$/.test(t)) return parseFloat(t);
  if ('&*!|>%@`'.includes(t[0])) throw new YamlError(`line ${lineno}: YAML feature not supported here`);
  return t;
}

/** One-line flow collection: {a: b, c: [d, e]}. */
function flow(s, lineno) {
  let i = 0;
  const err = (m) => { throw new YamlError(`line ${lineno}: ${m} (col ${i + 1})`); };
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };
  function value(stops) {
    ws();
    if (i >= s.length) err('value expected');
    if (s[i] === '{') return map();
    if (s[i] === '[') return seq();
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]; let j = i + 1;
      while (j < s.length && !(s[j] === q && !(q === '"' && s[j - 1] === '\\'))) j++;
      if (j >= s.length) err('unterminated string');
      const v = scalar(s.slice(i, j + 1), lineno); i = j + 1; return v;
    }
    let j = i;
    while (j < s.length && !stops.includes(s[j])) j++;
    const v = scalar(s.slice(i, j), lineno); i = j; return v;
  }
  function map() {
    i++; const out = {};
    for (;;) {
      ws();
      if (s[i] === '}') { i++; return out; }
      let j = i;
      while (j < s.length && s[j] !== ':' && s[j] !== '}' && s[j] !== ',') j++;
      if (s[j] !== ':') err('key: value expected');
      const k = String(scalar(s.slice(i, j), lineno)); i = j + 1;
      out[k] = value(',}');
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return out; }
      err("',' or '}' expected");
    }
  }
  function seq() {
    i++; const out = [];
    for (;;) {
      ws();
      if (s[i] === ']') { i++; return out; }
      out.push(value(',]'));
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return out; }
      err("',' or ']' expected");
    }
  }
  const v = value('');
  ws();
  if (i < s.length) err('trailing text');
  return v;
}

function inlineValue(text, lineno) {
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') return flow(t, lineno);
  return scalar(t, lineno);
}

/** Split `key: rest` at the first ': ' (or trailing ':') outside quotes. */
function splitKey(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function parse(src) {
  const lines = [];
  String(src).split(/\r?\n/).forEach((raw, n) => {
    if (raw.includes('\t') && /^\s*\t/.test(raw)) throw new YamlError(`line ${n + 1}: tab indentation`);
    const text = stripComment(raw);
    if (!text.trim() || text.trim() === '---') return;
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), lineno: n + 1 });
  });
  let pos = 0;

  function block(indent) {
    const first = lines[pos];
    if (first.text.startsWith('- ') || first.text === '-') return sequence(indent);
    return mapping(indent);
  }
  function child(parentIndent, lineno) {
    if (pos < lines.length && lines[pos].indent > parentIndent) return block(lines[pos].indent);
    return null;
  }
  function mapping(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const { text, lineno } = lines[pos];
      if (text.startsWith('- ')) throw new YamlError(`line ${lineno}: sequence item where a key was expected`);
      const kv = splitKey(text);
      if (!kv) throw new YamlError(`line ${lineno}: key: value expected`);
      const key = String(scalar(kv[0], lineno));
      pos++;
      out[key] = kv[1] === '' ? child(indent, lineno) : inlineValue(kv[1], lineno);
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new YamlError(`line ${lines[pos].lineno}: bad indentation`);
    return out;
  }
  function sequence(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const { text, lineno } = lines[pos];
      const rest = text === '-' ? '' : text.slice(2).trim();
      pos++;
      if (rest === '') { out.push(child(indent, lineno)); continue; }
      const kv = rest[0] !== '{' && rest[0] !== '[' && rest[0] !== '"' && rest[0] !== "'" ? splitKey(rest) : null;
      if (kv) {
        // "- key: value" starts a mapping whose further keys are indented to the key.
        const itemIndent = indent + 2;
        const item = {};
        item[String(scalar(kv[0], lineno))] = kv[1] === '' ? child(itemIndent, lineno) : inlineValue(kv[1], lineno);
        if (pos < lines.length && lines[pos].indent === itemIndent && !lines[pos].text.startsWith('- ')) Object.assign(item, mapping(itemIndent));
        out.push(item);
      } else out.push(inlineValue(rest, lineno));
    }
    return out;
  }

  if (!lines.length) return {};
  const v = block(lines[0].indent);
  if (pos < lines.length) throw new YamlError(`line ${lines[pos].lineno}: unexpected content`);
  return v;
}

module.exports = { parse, YamlError };
