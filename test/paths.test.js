/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { parsePath, navigate } from '../client/lib/paths';
import { navJs, navGroovy } from '../client/lib/navigation';

// The path engine is the single source of truth for the live preview AND codegen.
// These cases assert (a) tokenization, (b) live eval, and (c) that the generated JS
// navigation evaluates to the SAME value the live preview shows — so they can't drift.

const BODY = {
  id: 7,
  name: 'root',
  meta: { 'content-type': 'application/json' },
  data: [
    { id: 1, tags: ['a', 'b'] },
    { id: 2, tags: ['c'] }
  ],
  list: [{ v: 10 }, { v: 20 }, { v: 30 }]
};

const CASES = [
  { path: 'id', expect: 7 },
  { path: 'meta.content-type', expect: 'application/json' },
  { path: "meta['content-type']", expect: 'application/json' },
  { path: 'data[0].id', expect: 1 },
  { path: 'data[1].tags[0]', expect: 'c' },
  { path: '$.name', expect: 'root' },
  { path: 'data[*].id', expect: [1, 2] },
  { path: 'list[*].v', expect: [10, 20, 30] },
  { path: 'data[*].tags[*]', expect: [['a', 'b'], ['c']] },
  { path: 'missing.deep.path', expect: undefined },
  { path: 'data[9].id', expect: undefined },
  { path: '', expect: BODY } // empty path = whole body
];

// Evaluate a generated JS navigation expression `navJs('body', path)` against BODY.
function evalJs(expr, body) {
  // eslint-disable-next-line no-new-func
  return Function('body', 'return (' + expr + ');')(body);
}

describe('parsePath', () => {
  it('tokenizes dot, bracket, index, wildcard and quoted keys', () => {
    expect(parsePath('a.b[0]')).toEqual([{ k: 'key', v: 'a' }, { k: 'key', v: 'b' }, { k: 'index', v: 0 }]);
    expect(parsePath('items[*].name')).toEqual([{ k: 'key', v: 'items' }, { k: 'wild' }, { k: 'key', v: 'name' }]);
    expect(parsePath("m['content-type']")).toEqual([{ k: 'key', v: 'm' }, { k: 'key', v: 'content-type' }]);
    expect(parsePath('$.x')).toEqual([{ k: 'key', v: 'x' }]);
  });
});

describe('navigate + codegen agreement', () => {
  CASES.forEach(({ path, expect: want }) => {
    it(`"${path || '(empty)'}" resolves and matches generated JS`, () => {
      expect(navigate(BODY, path)).toEqual(want);
      // Generated JS navigation must produce the same value the live preview does.
      expect(evalJs(navJs('body', path), BODY)).toEqual(want);
      // Groovy is asserted structurally (can't eval here) — spot-check a couple of shapes.
      expect(typeof navGroovy('body', path)).toBe('string');
    });
  });

  it('generates the expected Groovy navigation shapes', () => {
    expect(navGroovy('body', 'data[0].id')).toBe('body?.data?.getAt(0)?.id');
    expect(navGroovy('body', "meta['content-type']")).toBe("body?.meta?.get('content-type')");
    expect(navGroovy('body', 'list[*].v')).toBe('body?.list?.collect { it?.v }');
  });
});
