/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { compileJsonFields, payloadString, jsonError, formatJson, contentTypeFor } from '../client/lib/payload';

const f = (key, value, type = 'string') => ({ key, value, type, enabled: true });

describe('compileJsonFields', () => {
  it('quotes strings, keeps numbers/booleans/null bare', () => {
    const out = compileJsonFields([f('name', 'Ada'), f('age', '42', 'number'), f('ok', 'true', 'boolean'), f('x', '', 'null')]);
    expect(JSON.parse(out)).toEqual({ name: 'Ada', age: 42, ok: true, x: null });
  });
  it('wraps expression values as "${…}" (kept literal)', () => {
    expect(compileJsonFields([f('id', 'orderId', 'expression')])).toContain('"id": "${orderId}"');
    expect(compileJsonFields([f('id', '${orderId}', 'expression')])).toContain('"${orderId}"');
  });
  it('emits raw values verbatim (unquoted expression / nested json)', () => {
    expect(compileJsonFields([f('n', '${count}', 'raw')])).toContain('"n": ${count}');
    expect(compileJsonFields([f('o', '{"a":1}', 'raw')])).toContain('"o": {"a":1}');
  });
  it('skips disabled and keyless rows; empty -> {}', () => {
    expect(compileJsonFields([{ key: 'a', value: '1', type: 'string', enabled: false }, f('', 'x')])).toBe('{}');
  });
});

describe('payloadString / contentType', () => {
  it('json mode compiles the builder', () => {
    const st = { bodyType: 'json', jsonFields: [f('a', '1', 'number')] };
    expect(JSON.parse(payloadString(st))).toEqual({ a: 1 });
    expect(contentTypeFor(st)).toBe('application/json');
  });
  it('raw mode returns the body; urlencoded joins form rows', () => {
    expect(payloadString({ bodyType: 'raw', body: 'hi' })).toBe('hi');
    expect(payloadString({ bodyType: 'urlencoded', form: [f('a', '1'), f('b', '2')] })).toBe('a=1&b=2');
  });
  it('none / form-data have no textual payload', () => {
    expect(payloadString({ bodyType: 'none' })).toBeNull();
    expect(payloadString({ bodyType: 'form', form: [f('a', '1')] })).toBeNull();
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
