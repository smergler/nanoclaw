/**
 * Per-agent-group spawn backoff.
 *
 * On 2026-08-12 the 60s host sweep retried an unsatisfiable spawn ~2,193
 * times across 13 hours. `container-runner.ts` logged each `code=125` and
 * moved on: no failure-count state, so every tick was the first tick.
 *
 * Exit 125 specifically means the daemon **refused** — never worth an
 * identical retry. Other non-zero exits mean the container ran and then
 * something inside it failed, which is not a spawn problem and must not
 * throttle the group.
 *
 * This is the half that stops the bleeding; escalation only detects. Neither
 * replaces the other.
 *
 * In-memory on purpose, matching `deliveryAttempts` in `delivery.ts`: a host
 * restart is a legitimate fresh chance, and persisting the counter would mean
 * a restart-to-fix cycle stays throttled after the fix.
 */
import { log } from '../log.js';

/** Cap. 13 hours at this interval is ~26 attempts, versus 2,193. */
const BACKOFF_CAP_MIN = 30;

interface BackoffState {
  fails: number;
  nextAttemptAt: number;
}

const state = new Map<string, BackoffState>();

/** 1, 2, 4, 8, 16, 30, 30… minutes for fails = 1, 2, 3… */
export function spawnBackoffMinutes(fails: number): number {
  return Math.min(2 ** (fails - 1), BACKOFF_CAP_MIN);
}

/**
 * True while this group is inside its backoff window.
 *
 * Never permanently disables: once the window elapses the next attempt is
 * allowed through, and if it fails again the window re-arms at the cap.
 */
export function shouldSkipSpawn(agentGroupId: string, now: number = Date.now()): boolean {
  const s = state.get(agentGroupId);
  return s !== undefined && now < s.nextAttemptAt;
}

/** Seconds until the next attempt is permitted. 0 when not backed off. */
export function backoffRemainingSec(agentGroupId: string, now: number = Date.now()): number {
  const s = state.get(agentGroupId);
  if (!s || now >= s.nextAttemptAt) return 0;
  return Math.ceil((s.nextAttemptAt - now) / 1000);
}

export function recordSpawnFailure(agentGroupId: string, now: number = Date.now()): number {
  const fails = (state.get(agentGroupId)?.fails ?? 0) + 1;
  const waitMin = spawnBackoffMinutes(fails);
  state.set(agentGroupId, { fails, nextAttemptAt: now + waitMin * 60_000 });
  log.warn('Container spawn refused by the daemon — backing off', {
    agentGroupId,
    fails,
    nextAttemptInMin: waitMin,
  });
  return fails;
}

export function recordSpawnSuccess(agentGroupId: string): void {
  if (state.delete(agentGroupId)) {
    log.info('Container spawn recovered — backoff cleared', { agentGroupId });
  }
}

/** Test seam. */
export function resetSpawnBackoff(): void {
  state.clear();
}
