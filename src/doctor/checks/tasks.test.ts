/**
 * Regression cover for the 2026-08-11 → 08-15 silent loop failure: both
 * scheduled series failed every run for four days, the host counted the
 * streak, wrote it to a log file, and told nobody.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { interpretSeries, TASK_FAIL_STREAK, type SeriesHealth } from './tasks.js';

function series(over: Partial<SeriesHealth> = {}): SeriesHealth {
  return {
    seriesKey: 'trip-planner-build-722c',
    group: 'loop-builder',
    status: 'pending',
    streak: 0,
    recurrence: '0 2 * * *',
    nextRun: '2026-08-16T06:00:00.000Z',
    ...over,
  };
}

describe('interpretSeries', () => {
  it('keys results on the series id so escalation can track it across runs', () => {
    expect(interpretSeries(series()).id).toBe('task:trip-planner-build-722c');
  });

  it('passes a healthy armed series', () => {
    const r = interpretSeries(series({ streak: 0 }));
    expect(r.status).toBe('pass');
    expect(r.remediation).toEqual([]);
  });

  it('still passes at one failure — a single miss is usually transient', () => {
    expect(interpretSeries(series({ streak: 1 })).status).toBe('pass');
  });

  it('fails at the streak threshold, long before the scheduler gives up at 8', () => {
    expect(TASK_FAIL_STREAK).toBe(2);
    const r = interpretSeries(series({ streak: 2 }));

    expect(r.status).toBe('fail');
    expect(r.detail.join('\n')).toContain('2 consecutive failed runs');
    expect(r.detail.join('\n')).toContain('agent is not being woken');
    // Point the reader at the gate script — that is what actually exited non-zero.
    expect(r.remediation.join('\n')).toContain('gate script');
  });

  it('reports an auto-paused series as failing and gives the resume command', () => {
    const r = interpretSeries(series({ status: 'paused', streak: 8 }));

    expect(r.status).toBe('fail');
    expect(r.detail.join('\n')).toContain('AUTO-PAUSED');
    expect(r.detail.join('\n')).toContain('no longer running at all');
    expect(r.remediation.join('\n')).toContain('ncl tasks resume trip-planner-build-722c');
  });

  it('describes a one-shot task without inventing a cadence', () => {
    const r = interpretSeries(series({ recurrence: null }));
    expect(r.detail.join('\n')).toContain('one-shot');
  });
});
