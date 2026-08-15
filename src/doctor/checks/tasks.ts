/**
 * Task series health.
 *
 * This check exists because of a miss the mount probe would not have caught.
 *
 * From 2026-08-11 to 2026-08-15 both scheduled loops on this install
 * (`trip-planner-build-722c`, `trip-planner-watch-6049`) failed every single
 * run: their pre-task gate scripts call `python3`, and the hardened agent
 * image fetched by `setup.sh` has no `python3` — the old locally-built image
 * only had it transitively, via chromium's apt dependencies. Every night a
 * container spawned, the gate exited 1, the agent was never woken, and the
 * container idled until the 30-minute ceiling killed it.
 *
 * The host KNEW. `trailingFailedRuns()` counted the streak. `recurrence.ts`
 * logged `Task series auto-paused: script keeps failing` at the cap and
 * appended a note to the series run log. Then it stopped. No DM, no alert —
 * four days of silence discovered by asking.
 *
 * That is the fourth row of the table in `plans/ncl-doctor/PLAN.md`: a signal
 * that existed, delivered to a file nobody reads. The mount probe checks
 * mounts; nothing checked whether the scheduled work was actually running.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { trailingFailedRuns } from '../../modules/scheduling/db.js';
import { inboundDbPath, withInboundDb } from '../../session-manager.js';
import type { Check, CheckResult } from '../types.js';
import fs from 'fs';

/**
 * Consecutive failed runs before a series is called unhealthy.
 *
 * Two, not eight. Eight is `SCRIPT_FAIL_PAUSE_CAP` — the point at which the
 * scheduler gives up entirely. Alerting there means the operator hears about
 * it only once the series is already dead, which for a nightly task is eight
 * days late. Two is the first point at which "transient" stops being the
 * likely explanation.
 */
export const TASK_FAIL_STREAK = 2;

/** A task series still armed on a session, with its trailing failure streak. */
export interface SeriesHealth {
  seriesKey: string;
  group: string;
  status: string;
  streak: number;
  recurrence: string | null;
  nextRun: string | null;
}

export function interpretSeries(s: SeriesHealth): CheckResult {
  const id = `task:${s.seriesKey}`;
  const title = `task series ${s.seriesKey} (${s.group})`;
  const cadence = s.recurrence ? `cron \`${s.recurrence}\`` : 'one-shot';

  if (s.status === 'paused') {
    return {
      id,
      status: 'fail',
      title,
      detail: [
        `AUTO-PAUSED after ${s.streak} consecutive failed runs — this series is no longer running at all`,
        `${cadence}, re-armed at ${s.nextRun ?? 'unknown'} but will not fire while paused`,
      ],
      remediation: [
        "Run the series' pre-task gate script by hand and read its exit code — a non-zero exit is what counts as a failed run.",
        `Then: \`ncl tasks resume ${s.seriesKey}\``,
      ],
    };
  }

  if (s.streak >= TASK_FAIL_STREAK) {
    return {
      id,
      status: 'fail',
      title,
      detail: [
        `${s.streak} consecutive failed runs — the agent is not being woken`,
        `${cadence}, next attempt ${s.nextRun ?? 'unknown'}`,
        `will auto-pause at 8 consecutive failures`,
      ],
      remediation: [
        'A failed run almost always means the pre-task gate script exited non-zero. Run it by hand against the same image the container uses.',
      ],
    };
  }

  return {
    id,
    status: 'pass',
    title,
    detail: [`${cadence}, ${s.streak} trailing failure(s)`],
    remediation: [],
  };
}

interface ArmedRow {
  id: string;
  series_id: string | null;
  status: string;
  recurrence: string | null;
  process_after: string | null;
}

/** Every armed (pending or paused) task series across all active sessions. */
export function collectSeries(): SeriesHealth[] {
  const out: SeriesHealth[] = [];

  for (const session of getActiveSessions()) {
    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) continue;
    if (!fs.existsSync(inboundDbPath(agentGroup.id, session.id))) continue;

    try {
      withInboundDb(agentGroup.id, session.id, (db) => {
        const rows = db
          .prepare(
            `SELECT id, series_id, status, recurrence, process_after
               FROM messages_in
              WHERE kind = 'task' AND status IN ('pending', 'paused')`,
          )
          .all() as ArmedRow[];

        for (const row of rows) {
          const seriesKey = row.series_id ?? row.id;
          out.push({
            seriesKey,
            group: agentGroup.folder,
            status: row.status,
            streak: trailingFailedRuns(db, seriesKey),
            recurrence: row.recurrence,
            nextRun: row.process_after,
          });
        }
      });
    } catch {
      // A session DB we cannot open is not a finding about task health.
      // runChecks() only converts a THROWN check to inconclusive; swallowing
      // here keeps one unreadable session from hiding every other series.
      continue;
    }
  }

  return out;
}

export const taskCheck: Check = {
  name: 'tasks',
  async run(): Promise<CheckResult[]> {
    return collectSeries().map(interpretSeries);
  },
};
