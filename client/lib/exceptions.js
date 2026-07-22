/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Exception-handling model for the request — engine-agnostic design-time metadata
 * (persisted in the connector's JSON snapshot, not tied to any one FluxNova/Camunda
 * delegate).
 *
 *  - Technical exceptions: how each HTTP failure CLASS (and any custom status code)
 *    is handled — log & ignore, retry, raise an incident, or throw a BPMN error that
 *    an error boundary event can catch.
 *  - Business exceptions: named checks. Each is a small script (Groovy/JS) over the
 *    response; if the script THROWS, that's a business exception → run the action.
 */

// Actions shared by technical rows. `error` surfaces `bpmnError` for a boundary event.
export const TECH_ACTIONS = [
  ['ignore', 'Log & ignore'],
  ['retry', 'Retry'],
  ['incident', 'Throw incident'],
  ['error', 'Throw BPMN error']
];

// Actions for business checks.
export const BIZ_ACTIONS = [
  ['logInfo', 'Log info'],
  ['logError', 'Log error'],
  ['error', 'Throw BPMN error']
];

export const BIZ_FORMATS = [['groovy', 'Groovy'], ['js', 'JavaScript']];

// The fixed HTTP failure classes, with sensible default handling + a BPMN error code
// an error boundary can listen for. Mirrors common HTTP-connector failure semantics.
export const TECH_CLASSES = [
  { key: 'client', label: 'Client error', match: '4xx', action: 'error', bpmnError: 'http-client-error' },
  { key: 'server', label: 'Server error', match: '5xx', action: 'retry', bpmnError: 'http-server-error' },
  { key: 'auth', label: 'Auth error', match: '401, 403', action: 'error', bpmnError: 'http-auth-error' },
  { key: 'rateLimit', label: 'Rate limited', match: '429', action: 'retry', bpmnError: 'http-rate-limit' },
  { key: 'timeout', label: 'Timeout / network', match: 'timeout', action: 'retry', bpmnError: 'http-timeout' }
];

export const techCustomRow = () => ({ code: '', action: 'error', bpmnError: '' });
export const bizRow = () => ({ name: '', script: '', action: 'error', bpmnError: '' });

// Fresh defaults for a new request: the fixed classes (cloned) + one blank custom row.
export function defaultTechExceptions() {
  return { classes: TECH_CLASSES.map((c) => ({ ...c })), custom: [techCustomRow()] };
}
