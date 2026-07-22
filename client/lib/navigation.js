/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Turn a dot/bracket JSON path into null-safe navigation source for Groovy / JS.
 * Shares `parsePath` with the live Outputs preview, so the code written into the
 * connector's output parameters extracts exactly what the preview showed.
 */
import { parsePath } from './paths';

export function isIdent(k) { return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k); }

// Groovy null-safe navigation. [*] wildcard → ?.collect { it?.… } (nests recursively).
export function groovyFrom(base, tokens) {
  let e = base;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === 'wild') {
      const rest = tokens.slice(i + 1);
      return rest.length ? e + '?.collect { ' + groovyFrom('it', rest) + ' }' : e;
    }
    if (t.k === 'index') e += '?.getAt(' + t.v + ')';
    else if (isIdent(t.v)) e += '?.' + t.v;
    else e += "?.get('" + String(t.v).replace(/'/g, "\\'") + "')";
  }
  return e;
}
export function navGroovy(base, path) { return groovyFrom(base, parsePath(path)); }

// JS null-safe navigation. [*] wildcard → (… ?? []).map(it => …) (nests recursively).
export function jsFrom(base, tokens) {
  let e = base;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === 'wild') {
      const rest = tokens.slice(i + 1);
      return rest.length ? '(' + e + ' ?? []).map(it => ' + jsFrom('it', rest) + ')' : e;
    }
    if (t.k === 'index') e += '?.[' + t.v + ']';
    else if (isIdent(t.v)) e += '?.' + t.v;
    else e += '?.[' + JSON.stringify(String(t.v)) + ']';
  }
  return e;
}
export function navJs(base, path) { return jsFrom(base, parsePath(path)); }
