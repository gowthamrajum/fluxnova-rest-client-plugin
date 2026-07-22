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
export const TECH_ACTION_DEFS = [
  { key: 'log', label: 'Log', field: 'Log message', placeholder: 'message name' },
  { key: 'incident', label: 'Throw incident', field: 'Incident message', placeholder: 'message name' },
  { key: 'error', label: 'Throw BPMN error', field: 'BPMN error code', placeholder: 'error code' },
  { key: 'retry', label: 'Retry', field: null }
];

// Business checks fire after a successful response, so Retry doesn't apply.
export const BIZ_ACTION_DEFS = [
  { key: 'log', label: 'Log', field: 'Log message', placeholder: 'message name' },
  { key: 'incident', label: 'Throw incident', field: 'Incident message', placeholder: 'message name' },
  { key: 'error', label: 'Throw BPMN error', field: 'BPMN error code', placeholder: 'error code' }
];

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
