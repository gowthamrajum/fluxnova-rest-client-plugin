/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Deterministic design-time code generator (Groovy / JavaScript, full-call or
 * parse-only). Ships in-bundle — a few KB, no runtime engine, always correct.
 *
 * `callTemplate` builds a RAW (un-substituted, ${…} kept literal) view of the exact
 * request so generated code interpolates process variables at runtime. `navGroovy` /
 * `navJs` turn dot/bracket paths into null-safe navigation, sharing `parsePath` with
 * the live preview so eval and codegen never diverge.
 */
import { BODY_METHODS, RAW_TYPES } from './constants';
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

// Groovy double-quoted string (interpolates ${processVar}); triple-quoted for bodies.
export function gStr(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
export function gBody(v) { return '"""' + String(v).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"') + '"""'; }
export function jStr(v) { return '`' + String(v).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'; }

export function callTemplate(s) {
  let url = s.url.trim();
  const qp = s.params.filter((r) => r.enabled && r.key).map((r) => r.key + '=' + r.value);

  const headers = [];
  s.headers.filter((r) => r.enabled && r.key).forEach((r) => headers.push([r.key, r.value]));
  if (s.authType === 'bearer' && s.bearerToken) headers.push(['Authorization', 'Bearer ' + s.bearerToken]);
  else if (s.authType === 'basic' && (s.basicUser || s.basicPass)) headers.push(['Authorization', 'Basic <base64(' + s.basicUser + ':' + s.basicPass + ')>']);
  else if (s.authType === 'apikey' && s.apiKeyName) {
    if (s.apiKeyIn === 'query') qp.push(s.apiKeyName + '=' + s.apiKeyValue);
    else headers.push([s.apiKeyName, s.apiKeyValue]);
  }
  if (qp.length) url += (url.includes('?') ? '&' : '?') + qp.join('&');

  let bodyText = null, contentType = null;
  if (BODY_METHODS.includes(s.method) && s.bodyType !== 'none') {
    if (s.bodyType === 'raw' && s.body.trim()) { bodyText = s.body; contentType = RAW_TYPES[s.rawType]; }
    else if (s.bodyType === 'urlencoded') { bodyText = s.form.filter((f) => f.enabled && f.key).map((f) => f.key + '=' + f.value).join('&'); contentType = 'application/x-www-form-urlencoded'; }
    else if (s.bodyType === 'form') { bodyText = s.form.filter((f) => f.enabled && f.key).map((f) => f.key + '=' + f.value).join('&'); contentType = 'multipart/form-data (adjust manually)'; }
  }
  const outs = s.outputs.filter((o) => o.name && o.path);
  return { method: s.method, url, headers, bodyText, contentType, outs };
}

export function genGroovy(t, scope) {
  const L = [];
  const sets = t.outs.length
    ? t.outs.map((o) => "execution.setVariable('" + o.name + "', " + navGroovy('body', o.path) + ')')
    : ['// (add rows in Outputs to extract values, e.g.)', "// execution.setVariable('id', body?.id)"];

  if (scope === 'parse') {
    L.push('import groovy.json.JsonSlurper', '');
    L.push('// `response` = raw JSON string from the HTTP call; parses to a Map or List (or falls back to text)');
    L.push('def body = null');
    L.push('if (response?.toString()?.trim()) {');
    L.push('  try { body = new JsonSlurper().parseText(response.toString()) } catch (ignored) { body = response }');
    L.push('}', '');
    return L.concat(sets).join('\n');
  }
  L.push('import java.net.URI');
  L.push('import java.net.http.HttpClient');
  L.push('import java.net.http.HttpRequest');
  L.push('import java.net.http.HttpResponse');
  L.push('import groovy.json.JsonSlurper', '');
  L.push('def http = HttpClient.newHttpClient()');
  L.push('def req = HttpRequest.newBuilder(URI.create(' + gStr(t.url) + '))');
  t.headers.forEach(([k, v]) => L.push('    .header(' + gStr(k) + ', ' + gStr(v) + ')'));
  if (t.bodyText != null) {
    if (t.contentType) L.push('    .header("Content-Type", ' + gStr(t.contentType) + ')');
    L.push("    .method('" + t.method + "', HttpRequest.BodyPublishers.ofString(" + gBody(t.bodyText) + '))');
  } else {
    L.push("    .method('" + t.method + "', HttpRequest.BodyPublishers.noBody())");
  }
  L.push('    .build()');
  L.push('def resp = http.send(req, HttpResponse.BodyHandlers.ofString())');
  L.push('def raw = resp.body()');
  L.push('// parses to a Map or List; falls back to the raw text for non-JSON responses');
  L.push('def body = null');
  L.push('if (raw?.trim()) {');
  L.push('  try { body = new JsonSlurper().parseText(raw) } catch (ignored) { body = raw }');
  L.push('}', '');
  return L.concat(sets).join('\n');
}

export function genJs(t, scope) {
  const L = [];
  if (scope === 'parse') {
    const sets = t.outs.length
      ? t.outs.map((o) => "execution.setVariable('" + o.name + "', " + navJs('body', o.path) + ');')
      : ['// (add rows in Outputs to extract values, e.g.)', "// execution.setVariable('id', body?.id);"];
    L.push('// `response` = raw JSON string from the HTTP call; parses to an object or array (or falls back to text)');
    L.push('var body = null;');
    L.push('try { body = response ? JSON.parse(response) : null; } catch (e) { body = response; }', '');
    return L.concat(sets).join('\n');
  }
  // Full call — async fetch (Node 18+ / external worker / browser)
  const hdrs = t.headers.map(([k, v]) => '    ' + JSON.stringify(k) + ': ' + jStr(v) + ',');
  if (t.bodyText != null && t.contentType) hdrs.push('    "Content-Type": ' + jStr(t.contentType) + ',');
  L.push('async function call() {');
  L.push('  const res = await fetch(' + jStr(t.url) + ', {');
  L.push("    method: '" + t.method + "',");
  if (hdrs.length) { L.push('    headers: {'); hdrs.forEach((h) => L.push('  ' + h)); L.push('    },'); }
  if (t.bodyText != null) L.push('    body: ' + jStr(t.bodyText) + ',');
  L.push('  });');
  L.push('  const text = await res.text();');
  L.push('  let body; try { body = JSON.parse(text); } catch (e) { body = text; } // Map, List, or raw text');
  if (t.outs.length) {
    L.push('  return {');
    t.outs.forEach((o) => L.push('    ' + (isIdent(o.name) ? o.name : JSON.stringify(o.name)) + ': ' + navJs('body', o.path) + ','));
    L.push('  };');
  } else {
    L.push('  return body; // (add rows in Outputs to shape the result)');
  }
  L.push('}');
  return L.join('\n');
}

export function generateCode(state) {
  const t = callTemplate(state);
  return state.gen.lang === 'groovy' ? genGroovy(t, state.gen.scope) : genJs(t, state.gen.scope);
}
