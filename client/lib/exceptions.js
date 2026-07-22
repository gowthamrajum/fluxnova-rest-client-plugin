/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Exception-handling model for the request — engine-agnostic design-time metadata
 * (persisted in the connector's JSON snapshot, not tied to any one FluxNova/Camunda
 * delegate).
 *
 *  - Technical exceptions: each HTTP failure CLASS (and any custom status code) can
 *    have MULTIPLE actions toggled on at once — Log (with a message), Throw Incident
 *    (with a message), Throw BPMN Error (with a code an error boundary event catches),
 *    and Retry.
 *  - Business exceptions: named checks. Each is a small script (Groovy/JS) over the
 *    response; if the script THROWS, that's a business exception → run whichever
 *    actions are toggled on (Log / Incident / BPMN Error).
 */

// An action definition: which toggle to show, and whether it carries a free-text field.
// `field` is the label for the text input; null = a bare on/off toggle (e.g. Retry).
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

// Fresh action state for a def set: every action off, each with an empty value.
export function emptyActions(defs) {
  const a = {};
  defs.forEach((d) => { a[d.key] = { on: false, value: '' }; });
  return a;
}

// Convenience: build action state with some actions pre-enabled (and optional values).
// `preset` = { error: 'http-client-error', retry: true }.
function withActions(defs, preset) {
  const a = emptyActions(defs);
  Object.keys(preset || {}).forEach((k) => {
    if (!a[k]) return;
    const v = preset[k];
    a[k] = { on: true, value: typeof v === 'string' ? v : '' };
  });
  return a;
}

// The fixed HTTP failure classes, with sensible default handling.
export const TECH_CLASS_DEFS = [
  { key: 'client', label: 'Client error', match: '4xx', preset: { error: 'http-client-error' } },
  { key: 'server', label: 'Server error', match: '5xx', preset: { retry: true } },
  { key: 'auth', label: 'Auth error', match: '401, 403', preset: { error: 'http-auth-error' } },
  { key: 'rateLimit', label: 'Rate limited', match: '429', preset: { retry: true } },
  { key: 'timeout', label: 'Timeout / network', match: 'timeout', preset: { retry: true } }
];

export const techCustomRow = () => ({ code: '', actions: emptyActions(TECH_ACTION_DEFS) });
export const bizRow = () => ({ name: '', script: '', actions: emptyActions(BIZ_ACTION_DEFS) });

// Fresh defaults for a new request: the fixed classes (with defaults) + one blank custom row.
export function defaultTechExceptions() {
  return {
    classes: TECH_CLASS_DEFS.map((c) => ({
      key: c.key, label: c.label, match: c.match, actions: withActions(TECH_ACTION_DEFS, c.preset)
    })),
    custom: [techCustomRow()]
  };
}

// True when at least one action is toggled on (used for badge counts / "configured").
export function anyActionOn(actions) {
  return !!actions && Object.keys(actions).some((k) => actions[k] && actions[k].on);
}
