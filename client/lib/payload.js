/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Payload builder for POST / PUT / PATCH bodies.
 *
 * The structured builder is a TREE of nodes so any JSON shape works — objects, arrays,
 * arrays of objects, objects whose values are arrays, nested to any depth. A node is:
 *   { key, type, value, enabled, children }
 * `key` matters only when the node is a child of an object. `value` is used by scalar
 * types; `children` by object/array. ${…} expressions are kept literal (they resolve at
 * runtime — the connector evaluates the payload inputParameter).
 *
 * `payloadString` is the single source of truth for the literal body across live-send,
 * the connector config, and the live preview.
 */
import { RAW_TYPES } from './constants';

export const JSON_TYPES = [
  ['object', 'Object'],
  ['array', 'Array'],
  ['string', 'String'],
  ['number', 'Number'],
  ['boolean', 'Boolean'],
  ['null', 'Null'],
  ['expression', 'Expression'],
  ['raw', 'Raw']
];

export const isContainer = (type) => type === 'object' || type === 'array';

export const jsonNode = (type = 'string') => ({ key: '', type, value: '', enabled: true, children: [] });
export const jsonRoot = () => ({ key: '', type: 'object', value: '', enabled: true, children: [jsonNode()] });

const hasExpr = (s) => /\$\{[^}]*\}/.test(s);

// The JSON literal a scalar node contributes.
function scalarLiteral(node) {
  const v = node.value != null ? String(node.value) : '';
  switch (node.type) {
    case 'number': return v.trim() === '' ? '0' : v.trim();
    case 'boolean': return v.trim().toLowerCase() === 'true' ? 'true' : 'false';
    case 'null': return 'null';
    case 'raw': return v.trim() === '' ? 'null' : v;                 // verbatim: unquoted ${…}, nested JSON
    case 'expression': return JSON.stringify(hasExpr(v) ? v : '${' + v.trim() + '}'); // quoted "${…}"
    default: return JSON.stringify(v);                              // string
  }
}

function compileNode(node, indent) {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  if (node.type === 'object') {
    const rows = (node.children || []).filter((c) => c.enabled && c.key);
    if (!rows.length) return '{}';
    return '{\n' + rows.map((c) => inner + JSON.stringify(c.key) + ': ' + compileNode(c, indent + 1)).join(',\n') + '\n' + pad + '}';
  }
  if (node.type === 'array') {
    const rows = (node.children || []).filter((c) => c.enabled);
    if (!rows.length) return '[]';
    return '[\n' + rows.map((c) => inner + compileNode(c, indent + 1)).join(',\n') + '\n' + pad + ']';
  }
  return scalarLiteral(node);
}

// Compile the tree into a JSON string (pretty). Root defaults to an empty object.
export function compileJson(root) {
  return compileNode(root || jsonRoot(), 0);
}

// Every scalar value in the tree — used to detect ${…} expressions for the Inputs sidebar.
export function collectJsonValues(node, out = []) {
  if (!node) return out;
  if (isContainer(node.type)) (node.children || []).forEach((c) => collectJsonValues(c, out));
  else out.push(node.value);
  return out;
}

// Immutably map the node at `path` (array of child indices from the root) through `fn`.
export function mapNodeAt(root, path, fn) {
  if (!path.length) return fn(root);
  const [i, ...rest] = path;
  const children = root.children.slice();
  children[i] = mapNodeAt(children[i], rest, fn);
  return { ...root, children };
}

// Literal payload string for the current body mode (${…} kept). null = no textual body.
export function payloadString(state) {
  if (state.bodyType === 'raw') return state.body && state.body.trim() ? state.body : null;
  if (state.bodyType === 'json') return compileJson(state.jsonRoot);
  if (state.bodyType === 'urlencoded') {
    const parts = (state.form || []).filter((r) => r.enabled && r.key).map((r) => r.key + '=' + r.value);
    return parts.length ? parts.join('&') : null;
  }
  return null; // form-data is multipart — assembled only at send time
}

export function contentTypeFor(state) {
  if (state.bodyType === 'json') return 'application/json';
  if (state.bodyType === 'raw') return RAW_TYPES[state.rawType];
  if (state.bodyType === 'urlencoded') return 'application/x-www-form-urlencoded';
  return null;
}

/* ---- payload as a script (Groovy / JS) — build the object + serialize it ---- */

function gStr(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'"; }

// The scalar node as a language literal. `expression` becomes a bare variable reference
// (the ${…} inner), so the generated script reads it from a process variable.
function codeScalar(node, lang) {
  const v = node.value != null ? String(node.value) : '';
  switch (node.type) {
    case 'number': return v.trim() === '' ? '0' : v.trim();
    case 'boolean': return v.trim().toLowerCase() === 'true' ? 'true' : 'false';
    case 'null': return 'null';
    case 'raw': return v.trim() === '' ? 'null' : v;
    case 'expression': { const m = /^\$\{([\s\S]*)\}$/.exec(v.trim()); return (m ? m[1] : v).trim() || 'null'; }
    default: return lang === 'js' ? JSON.stringify(v) : gStr(v);
  }
}

function codeNode(node, lang, indent) {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  if (node.type === 'object') {
    const rows = (node.children || []).filter((c) => c.enabled && c.key);
    if (!rows.length) return lang === 'js' ? '{}' : '[:]';   // Groovy empty map is [:]
    const key = (k) => (lang === 'js' ? JSON.stringify(k) : gStr(k)) + ': ';
    const items = rows.map((c) => inner + key(c.key) + codeNode(c, lang, indent + 1));
    return (lang === 'js' ? '{' : '[') + '\n' + items.join(',\n') + '\n' + pad + (lang === 'js' ? '}' : ']');
  }
  if (node.type === 'array') {
    const rows = (node.children || []).filter((c) => c.enabled);
    if (!rows.length) return '[]';
    const items = rows.map((c) => inner + codeNode(c, lang, indent + 1));
    return '[\n' + items.join(',\n') + '\n' + pad + ']';
  }
  return codeScalar(node, lang);
}

// Generate a script (lang = 'groovy' | 'js') whose RESULT is the payload — the return
// form a connector `camunda:script` input parameter uses (also what the preview shows).
// Object→JSON uses Camunda/FINOS Spin: the global `JSON(...)` builds a JSON document from
// the object and `.toString()` serializes it (Spin's script functions are registered in
// the engine's script env — no import needed). Covers the builder + raw editor.
export function payloadCode(state, lang) {
  const js = lang === 'js';
  if (state.bodyType === 'json') {
    const lit = codeNode(state.jsonRoot || jsonRoot(), lang, 0);
    return 'JSON(' + lit + ').toString()';
  }
  if (state.bodyType === 'raw') {
    const b = state.body || '';
    return js
      ? '`' + b.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'
      : '"""' + b.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"') + '"""';
  }
  return null;
}

// null when the string parses as JSON (with ${…} treated as a placeholder), else the error message.
export function jsonError(str) {
  if (!str || !str.trim()) return null;
  try { JSON.parse(str.replace(/\$\{[^}]*\}/g, '0')); return null; } catch (e) { return e.message; }
}

// Pretty-print a raw JSON string, preserving ${…} exactly (whether quoted or bare).
export function formatJson(str) {
  if (!str) return str;
  const exprs = [];
  const masked = str.replace(/\$\{[^}]*\}/g, (m) => { exprs.push(m); return String(900000000 + exprs.length - 1); });
  try {
    const out = JSON.stringify(JSON.parse(masked), null, 2);
    return out.replace(/9000000\d\d/g, (tok) => {
      const i = Number(tok) - 900000000;
      return (i >= 0 && i < exprs.length) ? exprs[i] : tok;
    });
  } catch (_) {
    return str;
  }
}
