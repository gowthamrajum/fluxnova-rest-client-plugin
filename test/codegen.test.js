/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { generateCode, callTemplate } from '../client/lib/codegen';

function state(over = {}) {
  return {
    method: 'GET', url: 'https://api.example.com/users',
    params: [], headers: [],
    authType: 'none', bearerToken: '', basicUser: '', basicPass: '',
    apiKeyName: '', apiKeyValue: '', apiKeyIn: 'header',
    bodyType: 'none', rawType: 'json', body: '', form: [],
    outputs: [],
    gen: { lang: 'groovy', scope: 'call' },
    ...over
  };
}
const row = (key, value) => ({ key, value, desc: '', enabled: true });

describe('callTemplate', () => {
  it('keeps ${…} literal and folds query + auth in', () => {
    const t = callTemplate(state({
      method: 'POST',
      url: 'https://api.example.com/u/${id}',
      params: [row('page', '2')],
      authType: 'bearer', bearerToken: '${token}',
      bodyType: 'raw', body: '{"x":1}'
    }));
    expect(t.url).toBe('https://api.example.com/u/${id}?page=2');
    expect(t.headers).toContainEqual(['Authorization', 'Bearer ${token}']);
    expect(t.bodyText).toBe('{"x":1}');
    expect(t.contentType).toBe('application/json');
  });
});

describe('generateCode — Groovy', () => {
  it('full call emits an HttpClient script with setVariable outputs', () => {
    const code = generateCode(state({
      gen: { lang: 'groovy', scope: 'call' },
      outputs: [{ name: 'userId', path: 'data[0].id' }]
    }));
    expect(code).toContain('import java.net.http.HttpClient');
    expect(code).toContain('URI.create("https://api.example.com/users")');
    expect(code).toContain("execution.setVariable('userId', body?.data?.getAt(0)?.id)");
  });

  it('parse scope only parses the response variable', () => {
    const code = generateCode(state({ gen: { lang: 'groovy', scope: 'parse' }, outputs: [{ name: 'ok', path: 'ok' }] }));
    expect(code).toContain('new JsonSlurper().parseText(response.toString())');
    expect(code).not.toContain('HttpClient');
    expect(code).toContain("execution.setVariable('ok', body?.ok)");
  });
});

describe('generateCode — JavaScript', () => {
  it('full call emits an async fetch returning mapped outputs', () => {
    const code = generateCode(state({
      gen: { lang: 'js', scope: 'call' },
      method: 'POST', bodyType: 'raw', body: '{"a":1}',
      outputs: [{ name: 'id', path: 'id' }, { name: 'tag', path: "meta['x-tag']" }]
    }));
    expect(code).toContain('async function call()');
    expect(code).toContain('await fetch(');
    expect(code).toContain('id: body?.id,');
    expect(code).toContain('tag: body?.meta?.["x-tag"],');
  });

  it('parse scope uses JSON.parse(response)', () => {
    const code = generateCode(state({ gen: { lang: 'js', scope: 'parse' }, outputs: [{ name: 'n', path: 'list[*].v' }] }));
    expect(code).toContain('JSON.parse(response)');
    expect(code).toContain("execution.setVariable('n', (body?.list ?? []).map(it => it?.v));");
  });
});
