// Tiny template runtime for the 2.0 screen templates (sc-for / sc-if / {{dotted.path}}).
export function evalLogic(source, props) {
  class DCLogic { constructor(p) { this.props = p || {}; this.state = {}; } setState(s) { Object.assign(this.state, s); } }
  const Component = new Function('DCLogic', source + '; return Component;')(DCLogic);
  const inst = new Component(props); return inst.renderVals ? inst.renderVals() : {};
}
const look = (scope, path) => {
  path = path.trim(); if (path === 'true') return true; if (path === 'false') return false;
  const parts = path.split('.');
  for (const s of scope) { if (s && parts[0] in s) { let v = s; for (const p of parts) v = v == null ? undefined : v[p]; return v; } }
  return undefined;
};
// Interpolated values are translated too: the sample data in screens/*.logic.js is Korean.
const sub = (str, scope) => str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, p) => { const v = look(scope, p); return v == null ? '' : t(String(v)); });
import { t, tNode } from './i18n';

// The HTML parser foster-parents unknown elements out of <table>/<tbody>: an
// <sc-for> written inside a <tbody> is moved before the table and loses its
// children, while the <tr> it wrapped is parsed as a literal row. The alarm centre
// and the device alarm history are both built that way, so each rendered a single
// blank row instead of its list — silently, because nothing throws.
//
// <template> is the one element the parser is required to keep in table context,
// so the directives are rewritten to <template> before parsing and their bodies
// read back from .content. The templates themselves are untouched.
const asTemplates = (html) => html
  .replace(/<sc-for\b/gi, '<template data-sc-for')
  .replace(/<\/sc-for>/gi, '</template>')
  .replace(/<sc-if\b/gi, '<template data-sc-if')
  .replace(/<\/sc-if>/gi, '</template>');

// Clone a directive body, insert it, then walk it — walk() needs a parent in place
// so a nested directive can replace itself.
const expand = (nodes, frag, scope) => nodes.forEach(t => { const c = t.cloneNode(true); frag.appendChild(c); walk(c, scope); });

function walk(node, scope) {
  if (node.nodeType === 3) {
    // Translate first — dictionary keys are the raw template text, {{path}} included.
    node.nodeValue = tNode(node.nodeValue);
    if (node.nodeValue.includes('{{')) node.nodeValue = sub(node.nodeValue, scope);
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.tagName.toLowerCase();
  if (tag === 'template' && node.hasAttribute('data-sc-for')) {
    const list = look(scope, (node.getAttribute('list') || '').replace(/[{}]/g, '')) || []; const as = node.getAttribute('as') || 'item';
    const body = Array.from(node.content.childNodes); const frag = document.createDocumentFragment();
    list.forEach((it, i) => { const s = { [as]: it, $index: i }; expand(body, frag, [s, ...scope]); });
    node.replaceWith(frag); return;
  }
  if (tag === 'template' && node.hasAttribute('data-sc-if')) {
    const v = look(scope, (node.getAttribute('value') || '').replace(/[{}]/g, ''));
    if (!v) { node.remove(); return; }
    const frag = document.createDocumentFragment();
    expand(Array.from(node.content.childNodes), frag, scope);
    node.replaceWith(frag); return;
  }
  for (const a of Array.from(node.attributes)) {
    let v = a.value;
    if (a.name === 'placeholder' || a.name === 'title' || a.name === 'aria-label') v = t(v);
    if (v.includes('{{')) v = sub(v, scope);
    if (v !== a.value) node.setAttribute(a.name, v);
  }
  Array.from(node.childNodes).forEach(c => walk(c, scope));
}
export function render(container, html, data) {
  container.innerHTML = asTemplates(html);
  walk(container, [data]);
}
