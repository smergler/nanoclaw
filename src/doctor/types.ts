/**
 * Doctor check interface.
 *
 * The point of this module is not "a health command" — it is turning a
 * condition the host already knows about into a message a human receives.
 * See `plans/ncl-doctor/PLAN.md`.
 *
 * Two shapes matter here and both are load-bearing for Phase 2:
 *
 *   1. `inconclusive` is a first-class status, not a flavour of `fail`. A
 *      probe that times out has not proven anything, and paging an operator
 *      because Docker was briefly busy is how a monitor teaches its reader
 *      to ignore it.
 *
 *   2. `CheckResult.id` MUST be stable and deterministic per subject —
 *      `mount:/Volumes/foo`, `task:trip-planner-build-722c`. Escalation keys
 *      transition state on this string, so an id containing a timestamp, a
 *      run counter, or an array index silently breaks alerting: every run
 *      looks like a brand-new subject going from unknown to failing.
 */

export type CheckStatus = 'pass' | 'fail' | 'inconclusive';

export interface CheckResult {
  /** Stable, deterministic identity for the SUBJECT — see module header. */
  id: string;
  status: CheckStatus;
  /** One line naming the subject, e.g. "mount /Volumes/backup". */
  title: string;
  /** Evidence. Rendered verbatim into reports and alert DMs. */
  detail: string[];
  /** What the reader should do about it. Empty for a passing result. */
  remediation: string[];
}

export interface Check {
  name: string;
  /** One check may yield many results — one per mount, one per task series. */
  run(): Promise<CheckResult[]>;
}
