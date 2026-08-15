import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  backoffRemainingSec,
  recordSpawnFailure,
  recordSpawnSuccess,
  resetSpawnBackoff,
  shouldSkipSpawn,
  spawnBackoffMinutes,
} from './spawn-backoff.js';

const MIN = 60_000;

beforeEach(() => {
  resetSpawnBackoff();
});

describe('spawnBackoffMinutes', () => {
  it('doubles and caps at 30', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map(spawnBackoffMinutes)).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
  });
});

describe('spawn backoff', () => {
  it('does not suppress a group that has never failed', () => {
    expect(shouldSkipSpawn('ag-1')).toBe(false);
  });

  it('suppresses spawns inside the window and allows one through after it', () => {
    const t0 = 1_000_000;
    recordSpawnFailure('ag-1', t0);

    expect(shouldSkipSpawn('ag-1', t0 + 30_000)).toBe(true);
    expect(shouldSkipSpawn('ag-1', t0 + 1 * MIN + 1)).toBe(false);
  });

  it('is per group — one broken group does not throttle another', () => {
    const t0 = 1_000_000;
    recordSpawnFailure('ag-broken', t0);
    expect(shouldSkipSpawn('ag-broken', t0)).toBe(true);
    expect(shouldSkipSpawn('ag-fine', t0)).toBe(false);
  });

  it('backs off exponentially and caps, never permanently disabling the group', () => {
    let t = 1_000_000;
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      recordSpawnFailure('ag-1', t);
      waits.push(backoffRemainingSec('ag-1', t) / 60);
      // Advance past the window so the next attempt is permitted.
      t += waits[waits.length - 1] * MIN + 1;
      expect(shouldSkipSpawn('ag-1', t)).toBe(false);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
  });

  it('beats the 2026-08-12 outage by two orders of magnitude', () => {
    // 2,193 identical attempts in 13 hours is the number to beat.
    const THIRTEEN_HOURS = 13 * 60 * MIN;
    let t = 0;
    let attempts = 0;
    while (t < THIRTEEN_HOURS) {
      if (!shouldSkipSpawn('ag-1', t)) {
        attempts++;
        recordSpawnFailure('ag-1', t);
      }
      t += MIN; // the sweep ticks far more often than this, but only these get through
    }
    expect(attempts).toBeLessThan(40);
  });

  it('clears state on a successful spawn', () => {
    const t0 = 1_000_000;
    recordSpawnFailure('ag-1', t0);
    recordSpawnFailure('ag-1', t0);
    expect(shouldSkipSpawn('ag-1', t0)).toBe(true);

    recordSpawnSuccess('ag-1');

    expect(shouldSkipSpawn('ag-1', t0)).toBe(false);
    // And the streak restarts from the bottom of the ramp, not where it left off.
    recordSpawnFailure('ag-1', t0);
    expect(backoffRemainingSec('ag-1', t0)).toBe(60);
  });
});
