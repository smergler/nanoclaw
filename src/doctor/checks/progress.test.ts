/**
 * Cover for the gap demonstrated on the live install 2026-08-15: the builder
 * hit its Claude session quota mid-task, exited cleanly, acked `completed`,
 * and the task check reported `pass`. Liveness is not progress.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { DEFAULT_RUNS_WITHOUT_PROGRESS, interpretProgress, type ProgressInput } from './progress.js';

function input(over: Partial<ProgressInput> = {}): ProgressInput {
  return {
    seriesKey: 'trip-planner-build-722c',
    group: 'loop-builder',
    branch: 'loop/trip-planner',
    complete: false,
    runsInWindow: 2,
    requiredRuns: 2,
    commitsInWindow: 1,
    windowStart: '2026-08-14T06:00:00.000Z',
    ...over,
  };
}

describe('interpretProgress', () => {
  it('keys on the series so escalation tracks it across runs', () => {
    expect(interpretProgress(input()).id).toBe('progress:trip-planner-build-722c');
  });

  it('passes when commits landed', () => {
    const r = interpretProgress(input({ commitsInWindow: 3 }));
    expect(r.status).toBe('pass');
    expect(r.detail.join('\n')).toContain('3 commit(s)');
  });

  it('FAILS when runs complete but produce nothing — the quota-exhaustion case', () => {
    const r = interpretProgress(input({ commitsInWindow: 0 }));

    expect(r.status).toBe('fail');
    expect(r.detail.join('\n')).toContain('ZERO commits');
    expect(r.detail.join('\n')).toContain('not getting anything done');
    // Point the reader at where the agent explains itself.
    expect(r.remediation.join('\n')).toContain('trip-planner-build-722c.md');
    expect(r.remediation.join('\n')).toContain('quota');
  });

  it('never flags a FINISHED loop — done is not stalled', () => {
    // The decisive case: a completed project also produces zero commits, and a
    // monitor that cries wolf about success is worse than no monitor.
    const r = interpretProgress(input({ complete: true, commitsInWindow: 0 }));
    expect(r.status).toBe('pass');
    expect(r.detail.join('\n')).toContain('definition of done met');
  });

  it('done beats every other signal, including an unreadable repo', () => {
    expect(interpretProgress(input({ complete: true, commitsInWindow: null })).status).toBe('pass');
  });

  it('holds fire until there is enough history to judge', () => {
    const r = interpretProgress(input({ runsInWindow: 1, commitsInWindow: 0 }));
    expect(r.status).toBe('pass');
    expect(r.detail.join('\n')).toContain('not enough history');
  });

  it('is inconclusive, never failing, when git cannot be read', () => {
    // An unreadable repo has not established that the loop is stalled.
    const r = interpretProgress(input({ commitsInWindow: null }));
    expect(r.status).toBe('inconclusive');
    expect(r.detail.join('\n')).toContain('could not read git history');
  });

  it('defaults to two runs before calling a stall', () => {
    expect(DEFAULT_RUNS_WITHOUT_PROGRESS).toBe(2);
  });

  it('names the window start so the reader knows the period being judged', () => {
    const r = interpretProgress(input({ commitsInWindow: 0, windowStart: '2026-08-10T06:00:00.000Z' }));
    expect(r.detail.join('\n')).toContain('2026-08-10T06:00:00.000Z');
  });
});
