/**
 * Doctor entry point: run every check, escalate the edges.
 *
 * No CLI surface here — Phase 3 is gated on nanocoai/nanoclaw#2504, which
 * decides whether this becomes `ncl doctor run` or `ncl status --check`. The
 * runner, the probes, the transition store and the alert are identical either
 * way, so none of them wait on that answer.
 */
import { log } from '../log.js';
import { mountCheck } from './checks/mounts.js';
import { taskCheck } from './checks/tasks.js';
import { escalate } from './escalate.js';
import { runChecks } from './runner.js';
import type { Check, CheckResult } from './types.js';

export const DEFAULT_CHECKS: Check[] = [mountCheck, taskCheck];

/**
 * One pass. Returns the results so a future CLI surface can render them.
 *
 * Silent when healthy — no log line, no DM. Any routine output on a healthy
 * install trains the reader to ignore it, which is the failure mode this
 * whole module exists to avoid.
 */
export async function runDoctor(checks: Check[] = DEFAULT_CHECKS): Promise<CheckResult[]> {
  const results = await runChecks(checks);
  const transitions = await escalate(results);

  if (transitions.length > 0) {
    log.warn('Doctor state changed', {
      failing: transitions.filter((t) => t.kind === 'failing').map((t) => t.result.id),
      recovered: transitions.filter((t) => t.kind === 'recovered').map((t) => t.result.id),
    });
  }

  return results;
}
