/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { compileHandler, statusExpr, needsRetry, BPMN_ERROR_CLASS, HANDLER_OUTPUT } from '../client/lib/connectorCompile';

const acts = (over = {}) => ({
  log: { on: false, value: '' }, incident: { on: false, value: '' },
  error: { on: false, value: '' }, retry: { on: false, value: '' }, ...over
});
const techRule = (status, actions, code = '') => ({ status, code, actions });
const bizRule = (name, script, actions) => ({ name, script, actions });

describe('statusExpr', () => {
  it('maps classes to integer comparisons', () => {
    expect(statusExpr(techRule('client', acts()))).toBe('sc >= 400 && sc < 500');
    expect(statusExpr(techRule('auth', acts()))).toBe('sc == 401 || sc == 403');
    expect(statusExpr(techRule('rateLimit', acts()))).toBe('sc == 429');
  });
  it('parses custom codes and Nxx patterns', () => {
    expect(statusExpr(techRule('custom', acts(), '404'))).toBe('sc == 404');
    expect(statusExpr(techRule('custom', acts(), '5xx'))).toBe('(sc >= 500 && sc < 600)');
    expect(statusExpr(techRule('custom', acts(), '404, 409'))).toBe('sc == 404 || sc == 409');
  });
  it('timeout has no output-script match (handled by the connector)', () => {
    expect(statusExpr(techRule('timeout', acts()))).toBeNull();
  });
});

describe('compileHandler — technical', () => {
  it('emits a status guard + BpmnError throw for an error action', () => {
    const h = compileHandler({
      bizFormat: 'groovy',
      techExceptions: { rules: [techRule('client', acts({ error: { on: true, value: 'http-client-error' }, log: { on: true, value: 'boom' } }))] },
      bizExceptions: []
    });
    expect(h.scriptFormat).toBe('groovy');
    expect(h.script).toContain('if (sc >= 400 && sc < 500) {');
    expect(h.script).toContain("__log.info('boom')");
    expect(h.script).toContain('throw new ' + BPMN_ERROR_CLASS + "('http-client-error'");
  });

  it('retry/incident throw a plain exception; needsRetry tracks Retry', () => {
    const state = {
      bizFormat: 'groovy',
      techExceptions: { rules: [techRule('server', acts({ retry: { on: true, value: '' } }))] },
      bizExceptions: []
    };
    expect(compileHandler(state).script).toContain('throw new RuntimeException(');
    expect(needsRetry(state)).toBe(true);
  });
});

describe('compileHandler — business', () => {
  it('wraps the user script in try/catch and runs the action on throw', () => {
    const h = compileHandler({
      bizFormat: 'groovy',
      techExceptions: { rules: [] },
      bizExceptions: [bizRule('reject', "if (body?.rejected) throw new RuntimeException('x')", acts({ error: { on: true, value: 'order-rejected' } }))]
    });
    expect(h.script).toContain('} catch (Exception __e) {');
    expect(h.script).toContain("if (body?.rejected) throw new RuntimeException('x')");
    expect(h.script).toContain("'order-rejected'");
  });

  it('JS format emits a Java.type BpmnError + JSON.parse preamble', () => {
    const h = compileHandler({
      bizFormat: 'js',
      techExceptions: { rules: [techRule('client', acts({ error: { on: true, value: 'e' } }))] },
      bizExceptions: []
    });
    expect(h.scriptFormat).toBe('javascript');
    expect(h.script).toContain("Java.type('" + BPMN_ERROR_CLASS + "')");
    expect(h.script).toContain('JSON.parse(__respStr)');
  });

  it('returns null when nothing is actionable', () => {
    expect(compileHandler({ bizFormat: 'groovy', techExceptions: { rules: [] }, bizExceptions: [] })).toBeNull();
  });
});

describe('handler output name', () => {
  it('is a stable identifier', () => { expect(HANDLER_OUTPUT).toBe('restClientChecks'); });
});
