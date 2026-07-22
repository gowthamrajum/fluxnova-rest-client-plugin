/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Turns the popup state into a concrete { url, opts } pair ready for fetch (or the
 * main-process proxy). ${…} tokens are substituted from state.inputs here, so the
 * request that goes out matches what the user sees in the Inputs sidebar.
 *
 * Pure and framework-free — the same builder feeds live-send and the proxy path.
 */
import { BODY_METHODS, RAW_TYPES } from './constants';
import { subst } from './expressions';
import { compileJson } from './payload';

// A row is "active" when enabled and it has a key. Shared by params/headers/form.
export function activeRows(rows) {
  return (rows || []).filter((r) => r.enabled && r.key);
}

export function b64(s) {
  try { return btoa(unescape(encodeURIComponent(s))); } catch (_) { return btoa(s); }
}

export function buildRequest(state) {
  const { method, url, authType, bearerToken, basicUser, basicPass,
    apiKeyName, apiKeyValue, apiKeyIn, bodyType, rawType, body } = state;
  const sub = (str) => subst(str, state.inputs);

  const u = new URL(sub(url).trim());
  activeRows(state.params).forEach((p) => u.searchParams.append(sub(p.key), sub(p.value)));

  const hdrs = {};
  activeRows(state.headers).forEach((h) => { hdrs[sub(h.key)] = sub(h.value); });

  if (authType === 'bearer' && bearerToken) {
    hdrs['Authorization'] = 'Bearer ' + sub(bearerToken);
  } else if (authType === 'basic' && (basicUser || basicPass)) {
    hdrs['Authorization'] = 'Basic ' + b64(sub(basicUser) + ':' + sub(basicPass));
  } else if (authType === 'apikey' && apiKeyName) {
    if (apiKeyIn === 'query') u.searchParams.append(sub(apiKeyName), sub(apiKeyValue));
    else hdrs[sub(apiKeyName)] = sub(apiKeyValue);
  }

  const opts = { method, headers: hdrs };
  if (BODY_METHODS.includes(method) && bodyType !== 'none') {
    if (bodyType === 'json') {
      opts.body = sub(compileJson(state.jsonRoot));
      if (!hdrs['Content-Type']) hdrs['Content-Type'] = 'application/json';
    } else if (bodyType === 'raw' && body.trim()) {
      opts.body = sub(body);
      if (!hdrs['Content-Type']) hdrs['Content-Type'] = RAW_TYPES[rawType];
    } else if (bodyType === 'urlencoded') {
      const usp = new URLSearchParams();
      activeRows(state.form).forEach((f) => usp.append(sub(f.key), sub(f.value)));
      opts.body = usp.toString();
      if (!hdrs['Content-Type']) hdrs['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (bodyType === 'form') {
      const fd = new FormData();
      activeRows(state.form).forEach((f) => fd.append(sub(f.key), sub(f.value)));
      opts.body = fd;
    }
  }
  return { url: u.toString(), opts };
}
