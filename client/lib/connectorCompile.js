/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Compile the modal's exception rules into a NATIVE connector output-mapping script
 * (Groovy or JavaScript) — the engine runs it with its own script engine, so no custom
 * backend/delegate is needed. This is what makes "Save to Task" produce real, executable
 * connector configuration rather than an inert JSON blob.
 *
 * In scope inside the script (provided by the http-connector output mapping):
 *   statusCode, response (raw body string), headers. We add: `body` = parsed JSON (or the
 *   raw string when it isn't JSON), and `sc` = numeric status. Business scripts run against
 *   these; if a script throws, that check's actions fire.
 *
 * Actions map to standard engine mechanics:
 *   Log            -> slf4j logger.info(message)
 *   Throw incident -> throw a plain exception (uncaught -> incident, per retry config)
 *   Retry          -> throw a plain exception + the task is set asyncBefore with a retry cycle
 *   Throw BPMN err -> throw BpmnError(code, message) -> caught by an error boundary event
 */
import { statusShort, anyActionOn } from './exceptions';

// FluxNova's BpmnError. For stock Camunda 7 this is org.camunda.bpm.engine.delegate.BpmnError.
export const BPMN_ERROR_CLASS = 'org.finos.fluxnova.bpm.engine.delegate.BpmnError';
export const HANDLER_OUTPUT = 'restClientChecks';
export const RETRY_CYCLE = 'R3/PT30S';

// A single-quoted string literal (same syntax works for Groovy and JS).
function q(s) {
  return "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
}

// Numeric status-match expression (identical in Groovy and JS — plain integer comparisons).
export function statusExpr(rule) {
  switch (rule.status) {
    case 'client': return 'sc >= 400 && sc < 500';
    case 'server': return 'sc >= 500 && sc < 600';
    case 'auth': return 'sc == 401 || sc == 403';
    case 'rateLimit': return 'sc == 429';
    case 'timeout': return null; // a timeout throws before output mapping — handled by the connector itself
    case 'custom': return customMatch(rule.code);
    default: return null;
  }
}

function customMatch(code) {
  const c = (code || '').trim();
  if (!c) return null;
  const parts = c.split(',').map((s) => s.trim()).filter(Boolean);
  const exprs = [];
  parts.forEach((p) => {
    if (/^\d{3}$/.test(p)) exprs.push('sc == ' + p);
    else {
      const m = /^(\d)xx$/i.exec(p);
      if (m) { const d = Number(m[1]); exprs.push('(sc >= ' + d + '00 && sc < ' + (d + 1) + '00)'); }
    }
  });
  return exprs.length ? exprs.join(' || ') : null;
}

// The lines an action set emits: log (non-terminating) first, then at most one throw.
function actionLines(lang, actions, pad, ctx) {
  const L = [];
  const log = actions.log, incident = actions.incident, error = actions.error, retry = actions.retry;
  if (log && log.on) L.push(pad + '__log.info(' + q(log.value || ('REST client: ' + ctx)) + ')');
  if (error && error.on) {
    const code = error.value || 'rest-client-error';
    const ctor = lang === 'js' ? 'new BpmnError(' : 'new ' + BPMN_ERROR_CLASS + '(';
    L.push(pad + 'throw ' + ctor + q(code) + ', ' + q('REST client: ' + ctx) + ')');
  } else if ((incident && incident.on) || (retry && retry.on)) {
    const msg = (incident && incident.on && incident.value) ? incident.value : ('REST client: ' + ctx);
    L.push(pad + 'throw new ' + (lang === 'js' ? 'Error(' : 'RuntimeException(') + q(msg) + ')');
  }
  return L;
}

function preamble(lang) {
  if (lang === 'js') {
    return [
      "var BpmnError = Java.type('" + BPMN_ERROR_CLASS + "');",
      "var __log = Java.type('org.slf4j.LoggerFactory').getLogger('fluxnova-rest-client');",
      "var sc = (typeof statusCode === 'number') ? statusCode : parseInt('' + statusCode, 10);",
      'if (isNaN(sc)) { sc = -1; }',
      "var __respStr = (response == null) ? null : ('' + response);",
      'var body = __respStr;',
      'try { if (__respStr && __respStr.trim().length) { body = JSON.parse(__respStr); } } catch (e) { body = __respStr; }',
      ''
    ];
  }
  return [
    'import groovy.json.JsonSlurper',
    '',
    "def __log = org.slf4j.LoggerFactory.getLogger('fluxnova-rest-client')",
    'def sc = (statusCode instanceof Number) ? statusCode.intValue() : (("" + statusCode).isInteger() ? ("" + statusCode).toInteger() : -1)',
    'def __respStr = (response == null) ? null : response.toString()',
    'def body = __respStr',
    'try { if (__respStr != null && __respStr.trim()) body = new JsonSlurper().parseText(__respStr) } catch (ignored) { body = __respStr }',
    ''
  ];
}

// Rules worth compiling: technical rules that match a status and act, business checks with a script that act.
export function activeTech(state) {
  return ((state.techExceptions && state.techExceptions.rules) || [])
    .filter((r) => statusExpr(r) && anyActionOn(r.actions));
}
export function activeBiz(state) {
  return (state.bizExceptions || []).filter((r) => r.script && r.script.trim() && anyActionOn(r.actions));
}

// True when any rule (technical or data-exception) opts into Retry — drives asyncBefore
// + the failedJobRetryTimeCycle on the task.
export function needsRetry(state) {
  const on = (r) => r.actions.retry && r.actions.retry.on;
  return activeTech(state).some(on) || activeBiz(state).some(on);
}

/**
 * Return the { scriptFormat, script } for the handler output parameter, or null when
 * there's nothing to handle. Language follows the business-check toggle (default groovy).
 */
export function compileHandler(state) {
  const tech = activeTech(state);
  const biz = activeBiz(state);
  const parse = (state.parseScript || '').trim();
  if (!tech.length && !biz.length && !parse) return null;

  const lang = state.bizFormat === 'js' ? 'js' : 'groovy';
  const L = preamble(lang).slice();

  if (tech.length) {
    L.push('// --- Technical exceptions (by HTTP status) ---');
    tech.forEach((r) => {
      const ctx = r.status === 'custom' ? ('status ' + (r.code || '')) : ('HTTP ' + (statusShort(r.status) || r.status));
      L.push('if (' + statusExpr(r) + ') {');
      actionLines(lang, r.actions, '  ', ctx).forEach((x) => L.push(x));
      L.push('}');
    });
    L.push('');
  }

  if (parse) {
    // The user's parse script — runs in the output mapping (execution.setVariable to persist).
    L.push('// --- Parse the data ---');
    parse.split(/\r?\n/).forEach((line) => L.push(line));
    L.push('');
  }

  if (biz.length) {
    L.push('// --- Business exceptions (a throw = an exception) ---');
    biz.forEach((r, i) => {
      const ctx = r.name || ('business check ' + (i + 1));
      L.push(lang === 'js' ? 'try {' : 'try {');
      r.script.split(/\r?\n/).forEach((line) => L.push('  ' + line));
      L.push(lang === 'js' ? '} catch (__e) {' : '} catch (Exception __e) {');
      actionLines(lang, r.actions, '  ', ctx).forEach((x) => L.push(x));
      L.push('}');
    });
    L.push('');
  }

  L.push(lang === 'js' ? 'null;' : 'null');
  return { scriptFormat: lang === 'js' ? 'javascript' : 'groovy', script: L.join('\n') };
}
