/* SPDX-License-Identifier: Apache-2.0 */
/**
 * BPMN round-trip for a Connector Service Task's camunda:Connector config.
 *
 * WRITE ("Save to Task") produces two things on the element's extensionElements:
 *   1. A functional `camunda:Connector` with connectorId `http-connector` and an
 *      `inputOutput` (url / method / headers-Map / payload input params, plus one
 *      groovy output param per Outputs row). This is what the engine actually runs —
 *      ${…} expressions are kept literal so they resolve from process variables.
 *   2. A `camunda:Properties` entry `fluxnova:restClientConfig` holding a JSON snapshot
 *      of the full popup state, so reopening restores the builder EXACTLY (test data,
 *      auth, outputs, codegen choice) — things the connector params alone can't carry.
 *
 * READ (prefill on open) prefers the JSON snapshot; if absent (a connector authored
 * without this plugin) it reconstructs what it can from the inputOutput params.
 *
 * Pure and framework-free: WRITE takes a `create(type, props)` factory (bpmnFactory /
 * moddle) so it is unit-testable without Electron. `writeConnector` is the thin
 * bpmn-js wrapper that applies the result through modeling (undoable, marks dirty).
 */
import { navGroovy } from './navigation';
import { payloadString, contentTypeFor, payloadCode } from './payload';
import { compileHandler, HANDLER_OUTPUT, needsRetry, RETRY_CYCLE } from './connectorCompile';

export const CONNECTOR_ID = 'http-connector';
export const CONFIG_PROP = 'fluxnova:restClientConfig';

// State keys persisted in the JSON snapshot (everything design-time; nothing transient).
const PERSIST_KEYS = [
  'method', 'url', 'params', 'headers',
  'authType', 'bearerToken', 'basicUser', 'basicPass', 'apiKeyName', 'apiKeyValue', 'apiKeyIn',
  'bodyType', 'rawType', 'body', 'form', 'jsonRoot', 'payloadSave',
  'inputs', 'outputs',
  'techExceptions', 'bizExceptions', 'bizFormat'
];

function getBo(element) { return (element && (element.businessObject || element)) || null; }
function typeOf(el) { return el && (el.$type || el.type); }
function values(container) {
  if (!container) return [];
  return (typeof container.get === 'function' ? container.get('values') : container.values) || [];
}

function findConnector(bo) {
  return values(bo && bo.extensionElements).find((v) => typeOf(v) === 'camunda:Connector') || null;
}
function findProperties(bo) {
  return values(bo && bo.extensionElements).find((v) => typeOf(v) === 'camunda:Properties') || null;
}

/* ------------------------------------------------------------------ READ ---- */

function inputValueString(ip) {
  if (ip == null) return '';
  // Plain string value (attribute or body); definitions (Map/Script/List) handled elsewhere.
  return ip.value != null ? String(ip.value) : '';
}

function readHeaders(ip) {
  const def = ip && ip.definition;
  if (!def || typeOf(def) !== 'camunda:Map') return [];
  return (def.entries || []).map((e) => ({
    key: e.key != null ? String(e.key) : '',
    value: e.value != null ? String(e.value) : '',
    desc: '',
    enabled: true
  }));
}

// Restore the full popup state from the JSON snapshot when present.
function readSnapshot(bo) {
  const props = findProperties(bo);
  if (!props) return null;
  const p = (props.values || []).find((x) => x.name === CONFIG_PROP);
  if (!p || !p.value) return null;
  try {
    const parsed = JSON.parse(p.value);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Best-effort reconstruction from a plain http-connector's inputOutput.
function readInputOutput(bo) {
  const connector = findConnector(bo);
  if (!connector || !connector.inputOutput) return null;
  const ins = connector.inputOutput.inputParameters || [];
  const by = (name) => ins.find((ip) => ip.name === name);

  const out = {};
  const url = by('url');
  const method = by('method');
  const headers = by('headers');
  const payload = by('payload');

  if (url) out.url = inputValueString(url);
  if (method) { const m = inputValueString(method).toUpperCase(); if (m) out.method = m; }
  if (headers) { const rows = readHeaders(headers); if (rows.length) out.headers = rows; }
  if (payload && inputValueString(payload)) { out.bodyType = 'raw'; out.body = inputValueString(payload); }

  return Object.keys(out).length ? out : null;
}

/**
 * Return a partial popup-state patch to merge over the fresh state on open, or null
 * when the element carries no REST-client / connector config we can read.
 */
export function readConnector(element) {
  const bo = getBo(element);
  if (!bo) return null;
  return readSnapshot(bo) || readInputOutput(bo);
}

/* ----------------------------------------------------------------- WRITE ---- */

function strInput(create, name, value) {
  return create('camunda:InputParameter', { name, value });
}

function headersInput(create, rows) {
  const entries = (rows || [])
    .filter((r) => r.enabled && r.key)
    .map((r) => create('camunda:Entry', { key: r.key, value: r.value }));
  const map = create('camunda:Map', { entries });
  return create('camunda:InputParameter', { name: 'headers', definition: map });
}

// One groovy output param per Outputs row: parse `response`, then null-safe navigate.
function outputParams(create, outputs) {
  return (outputs || [])
    .filter((o) => o.name && o.path)
    .map((o) => {
      const script = [
        'import groovy.json.JsonSlurper',
        'def body = response ? new JsonSlurper().parseText(response) : null',
        navGroovy('body', o.path)
      ].join('\n');
      const def = create('camunda:Script', { scriptFormat: 'groovy', value: script });
      return create('camunda:OutputParameter', { name: o.name, definition: def });
    });
}

// Header rows augmented with a Content-Type when the body implies one and none is set.
function headerRowsFor(state, hasPayload) {
  const rows = (state.headers || []).filter((r) => r.enabled && r.key);
  const ct = contentTypeFor(state);
  const hasCt = rows.some((r) => /^content-type$/i.test(r.key));
  if (hasPayload && ct && !hasCt) return [...rows, { key: 'Content-Type', value: ct, enabled: true }];
  return rows;
}

// The payload inputParameter — a plain JSON string, or a native script that returns the
// payload, per the "Save payload as" setting. Returns null when there's no body.
function payloadInput(create, state) {
  const mode = state.payloadSave || 'json';
  const scripted = (mode === 'groovy' || mode === 'js') && (state.bodyType === 'json' || state.bodyType === 'raw' || state.bodyType === 'urlencoded');
  if (scripted) {
    const script = payloadCode(state, mode);
    if (!script) return null;
    const scriptFormat = mode === 'js' ? 'javascript' : 'groovy';
    return create('camunda:InputParameter', { name: 'payload', definition: create('camunda:Script', { scriptFormat, value: script }) });
  }
  const value = payloadString(state);
  return value != null ? strInput(create, 'payload', value) : null;
}

function buildConnector(create, state) {
  const payload = payloadInput(create, state);
  const inputs = [
    strInput(create, 'url', state.url || ''),
    strInput(create, 'method', state.method || 'GET'),
    headersInput(create, headerRowsFor(state, !!payload))
  ];
  if (payload) inputs.push(payload);

  // Output params: the user's variable mappings + the native exception-handling script.
  const outputs = outputParams(create, state.outputs);
  const handler = compileHandler(state);
  if (handler) {
    outputs.push(create('camunda:OutputParameter', {
      name: HANDLER_OUTPUT,
      definition: create('camunda:Script', { scriptFormat: handler.scriptFormat, value: handler.script })
    }));
  }

  const inputOutput = create('camunda:InputOutput', { inputParameters: inputs, outputParameters: outputs });
  return create('camunda:Connector', { connectorId: CONNECTOR_ID, inputOutput });
}

function snapshotOf(state) {
  const snap = {};
  PERSIST_KEYS.forEach((k) => { if (state[k] !== undefined) snap[k] = state[k]; });
  return JSON.stringify(snap);
}

// Reuse an existing camunda:Properties (keeping unrelated properties), else make one.
function buildProperties(create, existing, state) {
  const others = existing
    ? (existing.values || []).filter((p) => p.name !== CONFIG_PROP)
    : [];
  const ours = create('camunda:Property', { name: CONFIG_PROP, value: snapshotOf(state) });
  if (existing) { existing.values = [...others, ours]; return existing; }
  return create('camunda:Properties', { values: [ours] });
}

/**
 * Build the full extensionElements `values` array for `state`, preserving any
 * unrelated extension elements already on the element. Pure — returns moddle-shaped
 * objects from `create`. Exposed for tests.
 */
export function buildExtensionValues(create, bo, state) {
  const existing = values(bo && bo.extensionElements);
  const props = findProperties(bo);
  const preserved = existing.filter((v) =>
    typeOf(v) !== 'camunda:Connector' && v !== props && typeOf(v) !== 'camunda:FailedJobRetryTimeCycle');
  const out = [...preserved, buildConnector(create, state), buildProperties(create, props, state)];
  // Retry actions need the async job executor — add a retry cycle (asyncBefore is set separately).
  if (needsRetry(state)) out.push(create('camunda:FailedJobRetryTimeCycle', { body: RETRY_CYCLE }));
  return out;
}

/**
 * Apply the built connector config to the element through bpmn-js modeling so the
 * change is a single undoable command that marks the diagram dirty.
 * `services` = { bpmnFactory, modeling } (from the properties-panel DI).
 */
export function writeConnector(services, element, state) {
  const { bpmnFactory, modeling } = services;
  const bo = getBo(element);
  const create = (t, p) => bpmnFactory.create(t, p);

  const newValues = buildExtensionValues(create, bo, state);
  const extensionElements = bo.extensionElements || create('bpmn:ExtensionElements', { values: [] });
  extensionElements.values = newValues;
  extensionElements.$parent = bo;
  newValues.forEach((v) => { v.$parent = extensionElements; });

  // asyncBefore is required for the job executor to retry; only turn it ON (never clobber it off).
  const props = needsRetry(state) ? { extensionElements, asyncBefore: true } : { extensionElements };
  modeling.updateProperties(element, props);
}
