/* SPDX-License-Identifier: Apache-2.0 */
/**
 * JSON-path engine — the SINGLE source of truth for both the live Outputs preview
 * and the deterministic code generator, so they can never disagree.
 *
 * `parsePath` tokenizes a dot/bracket path into { k: 'key'|'index'|'wild', v }.
 * `evalTokens` walks a parsed token list against a value (null-safe, [*] wildcards
 * fan out over arrays). `navigate` is the convenience `parse + eval`.
 *
 * Handles: dot + bracket, root arrays ([0] / [*]), nested indices, [*] wildcards,
 * quoted / special-char keys (['content-type']), and a leading $ (JSONPath-ish).
 */

export function parsePath(path) {
  let s = (path || '').trim();
  if (s[0] === '$') s = s.slice(1);
  const t = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '.') { i++; continue; }
    if (c === '[') {
      const end = s.indexOf(']', i);
      if (end === -1) { const w = s.slice(i + 1); if (w) t.push({ k: 'key', v: w }); break; }
      let inner = s.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === '*') t.push({ k: 'wild' });
      else if (/^-?\d+$/.test(inner)) t.push({ k: 'index', v: parseInt(inner, 10) });
      else t.push({ k: 'key', v: inner.replace(/^['"]|['"]$/g, '') });
    } else if (c === '*') { t.push({ k: 'wild' }); i++; }
    else {
      let j = i;
      while (j < n && s[j] !== '.' && s[j] !== '[') j++;
      const w = s.slice(i, j); i = j;
      if (w === '*') t.push({ k: 'wild' });
      else if (/^-?\d+$/.test(w)) t.push({ k: 'index', v: parseInt(w, 10) });
      else if (w) t.push({ k: 'key', v: w });
    }
  }
  return t;
}

export function evalTokens(cur, tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (cur == null) return undefined;
    const t = tokens[i];
    if (t.k === 'wild') {
      if (!Array.isArray(cur)) return undefined;
      const rest = tokens.slice(i + 1);
      return cur.map((el) => evalTokens(el, rest));
    }
    cur = (typeof cur === 'object' && cur !== null) ? cur[t.v] : undefined;
  }
  return cur;
}

export function navigate(obj, path) {
  return evalTokens(obj, parsePath(path));
}
