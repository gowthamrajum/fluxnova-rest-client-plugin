/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { compileJson, jsonNode, jsonRoot, payloadString, jsonError, formatJson, contentTypeFor, collectJsonValues, mapNodeAt } from '../client/lib/payload';

// Build a scalar/leaf node.
const n = (key, value, type = 'string') => ({ ...jsonNode(type), key, value });
// Build a container node with children.
const c = (key, type, children) => ({ ...jsonNode(type), key, children });

describe('compileJson — scalars', () => {
  it('quotes strings, keeps numbers/booleans/null bare', () => {
    const root = c('', 'object', [n('name', 'Ada'), n('age', '42', 'number'), n('ok', 'true', 'boolean'), n('x', '', 'null')]);
    expect(JSON.parse(compileJson(root))).toEqual({ name: 'Ada', age: 42, ok: true, x: null });
  });
  it('expression values become "${…}"; raw is verbatim', () => {
    expect(compileJson(c('', 'object', [n('id', 'orderId', 'expression')]))).toContain('"id": "${orderId}"');
    expect(compileJson(c('', 'object', [n('n', '${count}', 'raw')]))).toContain('"n": ${count}');
  });
});

describe('compileJson — nested shapes', () => {
  it('object with an array value', () => {
    const root = c('', 'object', [c('tags', 'array', [n('', 'a'), n('', 'b')])]);
    expect(JSON.parse(compileJson(root))).toEqual({ tags: ['a', 'b'] });
  });
  it('array of objects', () => {
    const root = c('', 'array', [
      c('', 'object', [n('id', '1', 'number')]),
      c('', 'object', [n('id', '2', 'number')])
    ]);
    expect(JSON.parse(compileJson(root))).toEqual([{ id: 1 }, { id: 2 }]);
  });
  it('deeply nested: object -> array -> object -> array', () => {
    const root = c('', 'object', [
      c('items', 'array', [
        c('', 'object', [n('sku', 'A'), c('sizes', 'array', [n('', 'S'), n('', 'M')])])
      ])
    ]);
    expect(JSON.parse(compileJson(root))).toEqual({ items: [{ sku: 'A', sizes: ['S', 'M'] }] });
  });
  it('empty containers compile to {} / []', () => {
    expect(compileJson(c('', 'object', []))).toBe('{}');
    expect(compileJson(c('', 'object', [c('a', 'array', [])]))).toContain('"a": []');
  });
});

describe('payloadString / contentType', () => {
  it('json mode compiles the tree', () => {
    const st = { bodyType: 'json', jsonRoot: c('', 'object', [n('a', '1', 'number')]) };
    expect(JSON.parse(payloadString(st))).toEqual({ a: 1 });
    expect(contentTypeFor(st)).toBe('application/json');
  });
  it('none / form-data have no textual payload', () => {
    expect(payloadString({ bodyType: 'none' })).toBeNull();
    expect(payloadString({ bodyType: 'form', form: [n('a', '1')] })).toBeNull();
  });
});

describe('collectJsonValues + mapNodeAt', () => {
  it('gathers every leaf value (for ${…} detection)', () => {
    const root = c('', 'object', [n('a', '${x}'), c('b', 'array', [n('', '${y}')])]);
    expect(collectJsonValues(root)).toEqual(['${x}', '${y}']);
  });
  it('mapNodeAt updates a node by path immutably', () => {
    const root = c('', 'object', [c('b', 'array', [n('', 'old')])]);
    const next = mapNodeAt(root, [0, 0], (nd) => ({ ...nd, value: 'new' }));
    expect(next.children[0].children[0].value).toBe('new');
    expect(root.children[0].children[0].value).toBe('old'); // original untouched
  });
});

describe('jsonError + formatJson', () => {
  it('treats ${…} as valid and flags real errors', () => {
    expect(jsonError('{"id": "${x}"}')).toBeNull();
    expect(jsonError('{"id": }')).toBeTruthy();
  });
  it('formats while preserving ${…} exactly', () => {
    const out = formatJson('{"id":"${orderId}","n":${count}}');
    expect(out).toContain('"${orderId}"');
    expect(out).toContain('${count}');
    expect(out).toContain('\n');
  });
});

describe('jsonRoot default', () => {
  it('is an object with one blank field', () => {
    const r = jsonRoot();
    expect(r.type).toBe('object');
    expect(r.children).toHaveLength(1);
  });
});
