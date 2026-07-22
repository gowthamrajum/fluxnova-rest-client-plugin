/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { buildRequest, activeRows } from '../client/lib/request';
import { subst } from '../client/lib/expressions';

// Minimal fresh-state factory mirroring RestClientPlugin.freshState() defaults, so
// tests build requests the same way the popup does.
function state(over = {}) {
  return {
    method: 'GET', url: 'https://api.example.com/things',
    params: [], headers: [],
    authType: 'none', bearerToken: '', basicUser: '', basicPass: '',
    apiKeyName: '', apiKeyValue: '', apiKeyIn: 'header',
    bodyType: 'none', rawType: 'json', body: '', form: [],
    inputs: {},
    ...over
  };
}
const row = (key, value, enabled = true) => ({ key, value, desc: '', enabled });

describe('activeRows', () => {
  it('keeps only enabled rows with a key', () => {
    expect(activeRows([row('a', '1'), row('', 'x'), row('b', '2', false)])).toHaveLength(1);
  });
});

describe('buildRequest — query + expression substitution', () => {
  it('appends params and substitutes ${…} from inputs', () => {
    const { url } = buildRequest(state({
      url: 'https://api.example.com/${id}',
      params: [row('q', '${term}')],
      inputs: { '${id}': '42', '${term}': 'hello world' }
    }));
    expect(url).toBe('https://api.example.com/42?q=hello+world');
  });
});

describe('buildRequest — auth', () => {
  it('bearer sets Authorization', () => {
    const { opts } = buildRequest(state({ authType: 'bearer', bearerToken: 'abc' }));
    expect(opts.headers.Authorization).toBe('Bearer abc');
  });
  it('basic base64-encodes user:pass', () => {
    const { opts } = buildRequest(state({ authType: 'basic', basicUser: 'u', basicPass: 'p' }));
    expect(opts.headers.Authorization).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
  });
  it('apikey in header vs query', () => {
    const h = buildRequest(state({ authType: 'apikey', apiKeyName: 'X-Key', apiKeyValue: 'k', apiKeyIn: 'header' }));
    expect(h.opts.headers['X-Key']).toBe('k');
    const q = buildRequest(state({ authType: 'apikey', apiKeyName: 'api_key', apiKeyValue: 'k', apiKeyIn: 'query' }));
    expect(q.url).toContain('api_key=k');
  });
});

describe('buildRequest — body', () => {
  it('raw JSON sets body + default Content-Type', () => {
    const { opts } = buildRequest(state({ method: 'POST', bodyType: 'raw', rawType: 'json', body: '{"a":1}' }));
    expect(opts.body).toBe('{"a":1}');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });
  it('urlencoded serializes form rows', () => {
    const { opts } = buildRequest(state({ method: 'POST', bodyType: 'urlencoded', form: [row('a', '1'), row('b', '2')] }));
    expect(opts.body).toBe('a=1&b=2');
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
  it('form-data produces a FormData body', () => {
    const { opts } = buildRequest(state({ method: 'POST', bodyType: 'form', form: [row('a', '1')] }));
    expect(opts.body).toBeInstanceOf(FormData);
  });
  it('body ignored for GET', () => {
    const { opts } = buildRequest(state({ method: 'GET', bodyType: 'raw', body: 'x' }));
    expect(opts.body).toBeUndefined();
  });
});

describe('subst', () => {
  it('replaces known tokens, blanks unknown ones', () => {
    expect(subst('a=${x}&b=${y}', { '${x}': '1' })).toBe('a=1&b=');
  });
});
