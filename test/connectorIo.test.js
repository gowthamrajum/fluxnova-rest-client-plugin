/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { buildExtensionValues, readConnector, CONNECTOR_ID, CONFIG_PROP } from '../client/lib/connectorIo';

// Fake moddle factory: real bpmnFactory.create(type, props) returns an object whose
// properties are readable as plain JS — this stand-in has the same shape, so the pure
// read/write helpers run without Electron or a real moddle instance.
const create = (type, props) => ({ $type: type, ...(props || {}) });

function fullState() {
  return {
    method: 'POST',
    url: 'https://api.example.com/orders/${orderId}',
    params: [{ key: 'page', value: '1', desc: '', enabled: true }],
    headers: [{ key: 'Accept', value: 'application/json', desc: '', enabled: true }],
    authType: 'bearer', bearerToken: '${token}', basicUser: '', basicPass: '',
    apiKeyName: '', apiKeyValue: '', apiKeyIn: 'header',
    bodyType: 'raw', rawType: 'json', body: '{"note":"${msg}"}', form: [],
    inputs: { '${orderId}': '99', '${token}': 'secret', '${msg}': 'hi' },
    outputs: [{ name: 'status', path: 'status' }, { name: 'firstId', path: 'items[0].id' }],
    gen: { lang: 'groovy', scope: 'call' }
  };
}

function boFrom(values) {
  return { businessObject: { extensionElements: { values } } };
}

describe('writeConnector output shape', () => {
  it('produces an http-connector with url/method/headers/payload + output params', () => {
    const values = buildExtensionValues(create, { extensionElements: null }, fullState());

    const connector = values.find((v) => v.$type === 'camunda:Connector');
    expect(connector.connectorId).toBe(CONNECTOR_ID);

    const ins = connector.inputOutput.inputParameters;
    const byName = (n) => ins.find((p) => p.name === n);
    expect(byName('url').value).toBe('https://api.example.com/orders/${orderId}'); // ${} kept literal
    expect(byName('method').value).toBe('POST');
    expect(byName('headers').definition.$type).toBe('camunda:Map');
    expect(byName('headers').definition.entries[0]).toMatchObject({ key: 'Accept', value: 'application/json' });
    expect(byName('payload').value).toBe('{"note":"${msg}"}');

    const outs = connector.inputOutput.outputParameters;
    expect(outs.map((o) => o.name)).toEqual(['status', 'firstId']);
    expect(outs[1].definition.$type).toBe('camunda:Script');
    expect(outs[1].definition.value).toContain('body?.items?.getAt(0)?.id');

    const props = values.find((v) => v.$type === 'camunda:Properties');
    expect(props.values.find((p) => p.name === CONFIG_PROP)).toBeTruthy();
  });
});

describe('round-trip via the JSON snapshot', () => {
  it('readConnector restores the exact design-time state (incl. test data + outputs)', () => {
    const st = fullState();
    const values = buildExtensionValues(create, { extensionElements: null }, st);
    const restored = readConnector(boFrom(values));

    // Everything persisted comes back byte-for-byte.
    expect(restored.url).toBe(st.url);
    expect(restored.method).toBe(st.method);
    expect(restored.authType).toBe('bearer');
    expect(restored.bearerToken).toBe('${token}');
    expect(restored.inputs).toEqual(st.inputs);      // test data survives
    expect(restored.outputs).toEqual(st.outputs);    // output mappings survive
    expect(restored.gen).toEqual(st.gen);
  });
});

describe('read a plain http-connector (no plugin snapshot)', () => {
  it('reconstructs url/method/headers/body from inputOutput', () => {
    const connector = create('camunda:Connector', {
      connectorId: CONNECTOR_ID,
      inputOutput: create('camunda:InputOutput', {
        inputParameters: [
          create('camunda:InputParameter', { name: 'url', value: 'https://x.test/y' }),
          create('camunda:InputParameter', { name: 'method', value: 'get' }),
          create('camunda:InputParameter', {
            name: 'headers',
            definition: create('camunda:Map', { entries: [create('camunda:Entry', { key: 'Accept', value: 'text/plain' })] })
          }),
          create('camunda:InputParameter', { name: 'payload', value: 'hello' })
        ],
        outputParameters: []
      })
    });
    const restored = readConnector(boFrom([connector]));
    expect(restored.url).toBe('https://x.test/y');
    expect(restored.method).toBe('GET');
    expect(restored.headers[0]).toMatchObject({ key: 'Accept', value: 'text/plain' });
    expect(restored.bodyType).toBe('raw');
    expect(restored.body).toBe('hello');
  });
});

describe('preserves unrelated extension elements', () => {
  it('keeps a foreign extension value and replaces only the connector', () => {
    const foreign = create('camunda:ExecutionListener', { event: 'start' });
    const first = buildExtensionValues(create, { extensionElements: { values: [foreign] } }, fullState());
    expect(first).toContain(foreign);
    expect(first.filter((v) => v.$type === 'camunda:Connector')).toHaveLength(1);
  });
});
