/**
 * Escalation — the actual feature.
 *
 * `plans/ncl-doctor/PLAN.md`: "The escalation is the feature; the command is
 * the demo. If Phase 2 is skipped this project has failed even if Phases 1, 3
 * and 4 all ship."
 *
 * Three rules, each earned from a specific way monitoring goes wrong:
 *
 *   - **Transitions, not events.** A check that logs 96 lines a day instead
 *     of 2,193 is the same bug with better manners. Alert on healthy→failing
 *     and failing→healthy, once each.
 *   - **`inconclusive` holds the previous state.** A flaky Docker daemon must
 *     not page anyone at 3am, and a timed-out probe must not "recover" a
 *     subject that is still broken.
 *   - **Silent when healthy.** Any output on a healthy install trains the
 *     reader to ignore it.
 */
import { getDeliveryAdapter } from '../delivery.js';
import { getAllHealthState, getHealthState, pruneHealthState, upsertHealthState } from '../db/health-state.js';
import type { HealthStateRow } from '../db/health-state.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { log } from '../log.js';
import { pickApprover } from '../modules/approvals/primitive.js';
import { getUserDm } from '../modules/permissions/db/user-dms.js';
import type { MessagingGroup } from '../types.js';
import type { CheckResult } from './types.js';

export type TransitionKind = 'failing' | 'recovered';

export interface Transition {
  result: CheckResult;
  kind: TransitionKind;
}

/**
 * Compare each result to its stored row and emit only genuine transitions.
 *
 * The one non-obvious case is the **undelivered retry**: a subject already
 * stored as failing but with `last_notified_at IS NULL` never actually
 * reached a human (no adapter, no cached DM, adapter threw). That re-emits,
 * because the alternative is consuming the transition and going quiet — the
 * exact failure this module exists to prevent.
 */
export function detectTransitions(results: CheckResult[], prior: Map<string, HealthStateRow>): Transition[] {
  const transitions: Transition[] = [];

  for (const result of results) {
    // Holds the previous state: no transition, and (in escalate) no write.
    if (result.status === 'inconclusive') continue;

    const before = prior.get(result.id);

    if (result.status === 'fail') {
      const wasFailing = before?.status === 'fail';
      if (!wasFailing || before?.last_notified_at == null) {
        transitions.push({ result, kind: 'failing' });
      }
      continue;
    }

    if (before?.status === 'fail') {
      transitions.push({ result, kind: 'recovered' });
    }
  }

  return transitions;
}

/**
 * Resolve an approver's DM **from cache only**.
 *
 * Deliberately not `ensureUserDm`: on a cache miss that calls the adapter's
 * `openDM`, and the installed Signal adapter has no `openDM` (verified: 0
 * occurrences). A cache miss during an outage would fail silently inside the
 * one code path whose entire job is to not fail silently. A miss here is a
 * hard, loud error instead.
 */
export function cachedDm(userId: string): MessagingGroup | null {
  const idx = userId.indexOf(':');
  if (idx < 0) return null;
  const channelType = userId.slice(0, idx);
  const cached = getUserDm(userId, channelType);
  if (!cached) return null;
  return getMessagingGroup(cached.messaging_group_id) ?? null;
}

/**
 * Alert body.
 *
 * Leads with the SCOPE of the outage, not the check name. This DM lands on
 * the same Signal thread, from the same agent, as routine chatter — including
 * a build loop that has said "still blocked" five times. The severity does
 * not transmit on its own; the message has to carry it.
 */
export function composeAlert(transitions: Transition[]): string {
  const failing = transitions.filter((t) => t.kind === 'failing').map((t) => t.result);
  const recovered = transitions.filter((t) => t.kind === 'recovered').map((t) => t.result);

  const lines: string[] = [];

  if (failing.length > 0) {
    const mounts = failing.filter((r) => r.id.startsWith('mount:'));
    const tasks = failing.filter((r) => r.id.startsWith('task:'));
    const scope: string[] = [];
    if (mounts.length > 0) {
      scope.push(`${mounts.length} container mount(s) unreachable — affected groups cannot start containers`);
    }
    if (tasks.length > 0) {
      scope.push(`${tasks.length} scheduled task series not running`);
    }
    const other = failing.length - mounts.length - tasks.length;
    if (other > 0) scope.push(`${other} other check(s) failing`);

    lines.push(`NANOCLAW HEALTH — ${scope.join('; ')}`);
    lines.push('');

    for (const r of failing) {
      lines.push(`FAILING: ${r.title}`);
      for (const d of r.detail) lines.push(`  ${d}`);
      for (const rem of r.remediation) lines.push(`  -> ${rem}`);
      lines.push('');
    }
  }

  if (recovered.length > 0) {
    if (failing.length === 0) lines.push(`NANOCLAW HEALTH — ${recovered.length} check(s) recovered`);
    for (const r of recovered) lines.push(`RECOVERED: ${r.title}`);
  }

  return lines.join('\n').trimEnd();
}

/** Deliver the alert to the first reachable approver. Returns true if it landed. */
async function deliverAlert(text: string): Promise<boolean> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('Doctor alert undeliverable: no delivery adapter registered', { textLength: text.length });
    return false;
  }

  const approvers = pickApprover(null);
  if (approvers.length === 0) {
    log.error('Doctor alert undeliverable: no owner or global admin configured');
    return false;
  }

  for (const userId of approvers) {
    const dm = cachedDm(userId);
    if (!dm) continue;
    try {
      await adapter.deliver(dm.channel_type, dm.platform_id, null, 'chat-sdk', JSON.stringify({ text }));
      log.info('Doctor alert delivered', { approver: userId, channelType: dm.channel_type });
      return true;
    } catch (err) {
      log.error('Doctor alert delivery threw', { approver: userId, err });
    }
  }

  // Every approver unreachable from cache. Loud, and NOT swallowed as a
  // retryable miss — see cachedDm().
  log.error('Doctor alert undeliverable: no cached DM for any eligible approver', { approvers });
  return false;
}

/**
 * Apply results to the transition store and alert on the edges.
 *
 * Returns the transitions that fired, so callers (and tests) can assert on
 * them without reaching into the DB.
 */
export async function escalate(results: CheckResult[]): Promise<Transition[]> {
  const prior = new Map<string, HealthStateRow>(getAllHealthState().map((r) => [r.check_id, r]));
  const transitions = detectTransitions(results, prior);

  let delivered = false;
  if (transitions.length > 0) {
    delivered = await deliverAlert(composeAlert(transitions));
  }

  for (const result of results) {
    // inconclusive holds the previous state — no write at all, so `since`
    // keeps counting from the last thing we actually established.
    if (result.status === 'inconclusive') continue;

    if (result.status === 'fail') {
      const alreadyNotified = getHealthState(result.id)?.last_notified_at ?? null;
      const notifiedAt = delivered ? new Date().toISOString() : alreadyNotified;
      upsertHealthState(result.id, 'fail', notifiedAt);
    } else {
      // Clearing last_notified_at on recovery re-arms the next failure.
      upsertHealthState(result.id, 'pass', null);
    }
  }

  // Subjects that no longer exist (mount removed, series deleted) must not
  // linger — a stale failing row would suppress the alert if it came back.
  // Inconclusive ids ARE live: excluding them here would delete the very row
  // that "inconclusive holds the previous state" depends on.
  pruneHealthState(results.map((r) => r.id));

  return transitions;
}
