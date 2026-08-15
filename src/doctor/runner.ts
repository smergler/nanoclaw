/**
 * Check orchestration. Pure — no I/O, no formatting, no escalation, so it
 * stays unit-testable without a Docker daemon or a DB.
 */
import { log } from '../log.js';
import type { Check, CheckResult } from './types.js';

/**
 * Run every check and return the flattened results.
 *
 * A check that throws is converted to a single `inconclusive` result rather
 * than propagating. One broken check must never take down the run — the
 * whole reason this exists is to report on a degraded install, which is
 * exactly when a check is most likely to blow up.
 *
 * `inconclusive` and not `fail` on purpose: a check that crashed has not
 * established that its subject is unhealthy, and Phase 2 must not alert on
 * it. See `escalate.ts`.
 */
export async function runChecks(checks: Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    try {
      results.push(...(await check.run()));
    } catch (err) {
      log.error('Doctor check threw', { check: check.name, err });
      results.push({
        id: `check-error:${check.name}`,
        status: 'inconclusive',
        title: `check "${check.name}" failed to run`,
        detail: [err instanceof Error ? err.message : String(err)],
        remediation: [`This is a bug in the "${check.name}" check itself, not a finding about the install.`],
      });
    }
  }

  return results;
}
