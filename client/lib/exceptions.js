/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Exception-handling model for the request — engine-agnostic design-time metadata
 * (persisted in the connector's JSON snapshot, not tied to any one FluxNova/Camunda
 * delegate).
 *
 *  - Technical exceptions: a list of rules you add on demand ("+ Add error rule").
 *    Each rule matches a status (an HTTP class preset or a specific code) and can have
 *    MULTIPLE actions toggled on — Log (message), Throw Incident (message), Throw BPMN
 *    Error (code an error boundary event catches), Retry.
 *  - Business exceptions: checks you add on demand. Each is a small script (Groovy/JS)
 *    over the response; if it THROWS, run whichever actions are toggled on.
 */

// An action definition: which toggle to show, and whether it carries a free-text field.
// `error` throws a BpmnError, routed to an error boundary event.
export const TECH_ACTION_DEFS = [
  { key: 'log', label: 'Log', field: 'Log message', placeholder: 'message name' },
  { key: 'incident', label: 'Throw incident', field: 'Incident message', placeholder: 'message name' },
  { key: 'retry', label: 'Retry', field: null },
  { key: 'error', label: 'Error boundary event', field: 'BPMN error code', placeholder: 'error code' }
];

// Data-exception actions (fire when parsing/validation fails) — the same set.
export const BIZ_ACTION_DEFS = TECH_ACTION_DEFS;

/* ---- retry policy (task-level: attempts + interval(s) -> failedJobRetryTimeCycle) ---- */

export const RETRY_UNITS = [['s', 'seconds'], ['m', 'minutes'], ['h', 'hours']];
export const retryInterval = () => ({ value: 30, unit: 's' });
export function defaultRetryPolicy() {
  return { attempts: 3, intervals: [retryInterval()] };
}
function isoDuration(i) {
  const n = parseInt(i.value, 10) || 0;
  return 'PT' + n + (i.unit === 'm' ? 'M' : i.unit === 'h' ? 'H' : 'S');
}
// Compile to a Camunda retry cycle: one interval -> R{attempts}/PT30S; several -> a staged list.
export function retryCycle(policy) {
  const p = policy || defaultRetryPolicy();
  const ints = (p.intervals || []).filter((i) => (parseInt(i.value, 10) || 0) > 0);
  if (!ints.length) return 'R' + (parseInt(p.attempts, 10) || 3) + '/PT30S';
  if (ints.length === 1) return 'R' + (parseInt(p.attempts, 10) || 3) + '/' + isoDuration(ints[0]);
  return ints.map(isoDuration).join(',');
}

export const BIZ_FORMATS = [['groovy', 'Groovy'], ['js', 'JavaScript']];

// Status a technical rule matches. 'custom' reveals a free-text code field (e.g. 404, 5xx).
export const STATUS_PRESETS = [
  ['client', 'Client error — 4xx'],
  ['server', 'Server error — 5xx'],
  ['auth', 'Auth error — 401 / 403'],
  ['rateLimit', 'Rate limited — 429'],
  ['timeout', 'Timeout / network'],
  ['custom', 'Specific status code…']
];

// A short chip label for a rule's status (what shows before the code, if any).
export function statusShort(status) {
  const map = { client: '4xx', server: '5xx', auth: '401 / 403', rateLimit: '429', timeout: 'timeout' };
  return map[status] || '';
}

// Fresh action state for a def set: every action off, each with an empty value.
export function emptyActions(defs) {
  const a = {};
  defs.forEach((d) => { a[d.key] = { on: false, value: '' }; });
  return a;
}

export const techRule = () => ({ status: 'client', code: '', actions: emptyActions(TECH_ACTION_DEFS) });
export const bizRow = () => ({ name: '', script: '', actions: emptyActions(BIZ_ACTION_DEFS) });

// New requests start with no rules — the author adds them via "+".
export function defaultTechExceptions() {
  return { rules: [] };
}

// True when at least one action is toggled on.
export function anyActionOn(actions) {
  return !!actions && Object.keys(actions).some((k) => actions[k] && actions[k].on);
}
