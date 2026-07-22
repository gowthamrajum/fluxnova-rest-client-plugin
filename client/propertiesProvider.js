/* SPDX-License-Identifier: Apache-2.0 */
import { h } from 'preact';

/*
 * A Camunda-Platform properties-panel provider that adds a "Build request…" button into the
 * Implementation group of a Service Task whose implementation is a Connector. Clicking it opens
 * the Postman-style popup (rendered by the client plugin) via a small window handoff.
 *
 * Model utils are inlined so we don't have to bundle bpmn-js.
 */

function getBo(el) {
  return el && (el.businessObject || el);
}

function is(el, type) {
  const bo = getBo(el);
  if (!bo) return false;
  if (typeof bo.$instanceOf === 'function') return bo.$instanceOf(type);
  return bo.$type === type;
}

function extensionValues(bo) {
  const ext = bo && bo.extensionElements;
  if (!ext) return [];
  return (typeof ext.get === 'function' ? ext.get('values') : ext.values) || [];
}

function isConnectorServiceTask(el) {
  if (!is(el, 'bpmn:ServiceTask')) return false;
  return extensionValues(getBo(el)).some((v) => (v && (v.$type || v.type)) === 'camunda:Connector');
}

function makeBuildButton(element, services) {
  return function BuildButton() {
    return h(
      'div',
      { class: 'bio-properties-panel-entry rc-build-entry' },
      h(
        'button',
        {
          type: 'button',
          class: 'rc-build-btn',
          onClick: () => {
            if (window.__fluxnovaRestClient) {
              // Hand the popup both the element and the model services it needs to
              // prefill from / save back to the connector config (undoable edits).
              window.__fluxnovaRestClient.open(element, services);
            }
          }
        },
        'Build request…'
      )
    );
  };
}

function RestClientPropertiesProvider(propertiesPanel, modeling, bpmnFactory, commandStack) {
  const services = { modeling, bpmnFactory, commandStack };

  this.getGroups = function (element) {
    return function (groups) {
      try {
        if (isConnectorServiceTask(element)) {
          const entry = { id: 'rest-client-build', component: makeBuildButton(element, services) };
          const impl = groups.find(
            (g) => /implementation/i.test(g.id || '') || /implementation/i.test(g.label || '')
          );
          if (impl && Array.isArray(impl.entries)) {
            impl.entries.push(entry);
          } else {
            groups.push({ id: 'rest-client', label: 'REST Client', entries: [entry] });
          }
        }
      } catch (e) {
        // never break the panel
        console.error('[fluxnova-rest-client] provider error', e);
      }
      return groups;
    };
  };

  propertiesPanel.registerProvider(500, this);
}

RestClientPropertiesProvider.$inject = ['propertiesPanel', 'modeling', 'bpmnFactory', 'commandStack'];

export default {
  __init__: ['restClientPropertiesProvider'],
  restClientPropertiesProvider: ['type', RestClientPropertiesProvider]
};
