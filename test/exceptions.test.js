/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { retryCycle, defaultRetryPolicy } from '../client/lib/exceptions';

describe('retryCycle', () => {
  it('one interval -> R{attempts}/PT{n}{unit}', () => {
    expect(retryCycle({ attempts: 3, intervals: [{ value: 30, unit: 's' }] })).toBe('R3/PT30S');
    expect(retryCycle({ attempts: 5, intervals: [{ value: 2, unit: 'm' }] })).toBe('R5/PT2M');
    expect(retryCycle({ attempts: 2, intervals: [{ value: 1, unit: 'h' }] })).toBe('R2/PT1H');
  });
  it('several intervals -> a staged, comma-separated backoff', () => {
    expect(retryCycle({ attempts: 3, intervals: [{ value: 10, unit: 's' }, { value: 1, unit: 'm' }, { value: 5, unit: 'm' }] }))
      .toBe('PT10S,PT1M,PT5M');
  });
  it('ignores blank intervals and has a sane default', () => {
    expect(retryCycle({ attempts: 4, intervals: [{ value: '', unit: 's' }] })).toBe('R4/PT30S');
    expect(retryCycle(defaultRetryPolicy())).toBe('R3/PT30S');
  });
});
