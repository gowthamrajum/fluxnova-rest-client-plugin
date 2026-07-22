/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ${expression} detection + substitution.
 *
 * `collectStrings` gathers every user-entered string in the request that could
 * carry a ${…} token. `detectExpressions` returns the distinct tokens in first-seen
 * order (drives the Inputs sidebar). `subst` replaces tokens with their filled test
 * values (empty string when unfilled) so the request can actually run.
 *
 * State-shaped input: these take the plain popup-state object, not the React class.
 */
import { EXPR_RE } from './constants';

export function collectStrings(s) {
  const out = [s.url];
  s.params.forEach((r) => out.push(r.key, r.value));
  s.headers.forEach((r) => out.push(r.key, r.value));
  out.push(s.bearerToken, s.basicUser, s.basicPass, s.apiKeyName, s.apiKeyValue);
  if (s.bodyType === 'raw') out.push(s.body);
  if (s.bodyType === 'json') (s.jsonFields || []).forEach((r) => out.push(r.value));
  if (s.bodyType === 'urlencoded' || s.bodyType === 'form') s.form.forEach((r) => out.push(r.key, r.value));
  return out.filter(Boolean);
}

export function detectExpressions(s) {
  const seen = [];
  const set = new Set();
  collectStrings(s).forEach((str) => {
    EXPR_RE.lastIndex = 0;
    let m;
    while ((m = EXPR_RE.exec(str)) !== null) {
      if (!set.has(m[0])) { set.add(m[0]); seen.push(m[0]); }
    }
  });
  return seen;
}

export function subst(str, inputs) {
  if (!str) return str;
  return str.replace(EXPR_RE, (full) => {
    const v = inputs[full];
    return v != null && v !== '' ? v : '';
  });
}
