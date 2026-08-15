import { describe, it, expect, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { runChecks } from './runner.js';
import type { Check, CheckResult } from './types.js';

function result(id: string, status: CheckResult['status']): CheckResult {
  return { id, status, title: id, detail: [], remediation: [] };
}

describe('runChecks', () => {
  it('flattens results from every check', async () => {
    const checks: Check[] = [
      { name: 'a', run: async () => [result('a:1', 'pass'), result('a:2', 'fail')] },
      { name: 'b', run: async () => [result('b:1', 'pass')] },
    ];
    const results = await runChecks(checks);
    expect(results.map((r) => r.id)).toEqual(['a:1', 'a:2', 'b:1']);
  });

  it('converts a throwing check to one inconclusive result and keeps going', async () => {
    const checks: Check[] = [
      { name: 'good', run: async () => [result('g:1', 'pass'), result('g:2', 'pass')] },
      {
        name: 'broken',
        run: async () => {
          throw new Error('docker exploded');
        },
      },
    ];

    const results = await runChecks(checks);

    // Two from the good check + one synthesized for the broken one.
    expect(results).toHaveLength(3);
    const failure = results[2];
    expect(failure.status).toBe('inconclusive');
    expect(failure.id).toBe('check-error:broken');
    expect(failure.detail).toContain('docker exploded');
  });

  it('runs later checks even when an earlier one throws', async () => {
    const after = vi.fn(async () => [result('after:1', 'pass')]);
    await runChecks([
      {
        name: 'first',
        run: async () => {
          throw new Error('nope');
        },
      },
      { name: 'after', run: after },
    ]);
    expect(after).toHaveBeenCalledOnce();
  });
});
