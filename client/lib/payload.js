/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Payload builder for POST / PUT / PATCH bodies.
 *
 * The structured JSON builder turns key / type / value rows into a JSON body string
 * with ${…} expressions kept literal (they resolve at runtime — the connector evaluates
 * the payload inputParameter). `payloadString` is the single source of truth for the
 * literal body across live-send, the connector config, and the live preview.
 */
import { RAW_TYPES } from './constants';

export const JSON_TYPES = [
  ['string', 'String'],
  ['number', 'Number'],
  ['boolean', 'Boolean'],
  ['null', 'Null'],
  ['expression', 'Expression'],
  ['raw', 'Raw']
];

export const jsonFieldRow = () => ({ key: '', value: '', type: 'string', enabled: true });

const hasExpr = (s) => /\$\{[^}]*\}/.test(s);

// The JSON literal a single field contributes (value side of "key": <here>).
function fieldLiteral(f) {
  const v = f.value != null ? String(f.value) : '';
  switch (f.type) {
    case 'number': return v.trim() === '' ? '0' : v.trim();
    case 'boolean': return v.trim().toLowerCase() === 'true' ? 'true' : 'false';
    case 'null': return 'null';
    case 'raw': return v.trim() === '' ? 'null' : v;                 // verbatim: numbers, nested JSON, unquoted ${…}
    case 'expression': return JSON.stringify(hasExpr(v) ? v : '${' + v.trim() + '}'); // quoted "${…}"
    default: return JSON.stringify(v);                              // string
  }
}

// Compile the builder rows into a JSON object string (pretty by default).
export function compileJsonFields(fields, pretty = true) {
  const rows = (fields || []).filter((f) => f.enabled && f.key);
  if (!rows.length) return '{}';
  const entries = rows.map((f) => JSON.stringify(f.key) + (pretty ? ': ' : ':') + fieldLiteral(f));
  return pretty ? '{\n' + entries.map((e) => '  ' + e).join(',\n') + '\n}' : '{' + entries.join(',') + '}';
}

// Literal payload string for the current body mode (${…} kept). null = no textual body.
export function payloadString(state) {
  if (state.bodyType === 'raw') return state.body && state.body.trim() ? state.body : null;
  if (state.bodyType === 'json') return compileJsonFields(state.jsonFields);
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

// null when the string parses as JSON (with ${…} treated as a placeholder), else the error message.
export function jsonError(str) {
  if (!str || !str.trim()) return null;
  try { JSON.parse(str.replace(/\$\{[^}]*\}/g, '0')); return null; } catch (e) { return e.message; }
}

// Pretty-print a raw JSON string, preserving ${…} exactly (whether quoted or bare).
// Returns the input unchanged if it doesn't parse.
export function formatJson(str) {
  if (!str) return str;
  const exprs = [];
  // Mask each ${…} as a distinct sentinel number — valid JSON in both string and bare positions.
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
