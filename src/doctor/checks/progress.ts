/**
 * Progress check — does a loop that RUNS actually ACCOMPLISH anything?
 *
 * `checks/tasks.ts` answers "is this series executing". That is liveness, and
 * liveness is not progress. Demonstrated on this install 2026-08-15: the
 * builder ran, exhausted its Claude session quota mid-task, exited cleanly,
 * and acked `completed`. Nothing in the pipeline can distinguish that from a
 * productive run — the container exited 0, the agent produced a final message,
 * the occurrence was marked completed, and the doctor reported `pass`. Repeat
 * that nightly and you get a week of green runs, zero commits, and a health
 * check insisting everything is fine.
 *
 * That is the same failure shape as the four silent days this module was built
 * for, one layer up: the machinery works, the work does not happen, and the
 * monitor is looking at the machinery.
 *
 * The signal used here is commits on the loop's work branch, which is the
 * durable record of the work — `gate-build.sh` already computes it on every
 * single run and throws it away.
 *
 * ## Distinguishing "finished" from "stalled"
 *
 * A completed project also produces no commits. Without a done-test this check
 * would flag every finished loop forever, and a monitor that cries wolf about
 * success is worse than no monitor. `doneWhenAllExist` is that test: when every
 * named artifact is present the loop is done, and silence is the correct state.
 *
 * ## No stored counter
 *
 * The window is derived from occurrence history, matching `trailingFailedRuns`
 * in modules/scheduling/db.ts — nothing to update, reset, or leave stale.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, withInboundDb } from '../../session-manager.js';
import type { Check, CheckResult } from '../types.js';

const GIT_TIMEOUT_MS = 10_000;

/**
 * `groups/<folder>/progress.json`. Absent = this group makes no progress claim
 * and is not checked, so the check is opt-in and silent everywhere else.
 *
 * Paths are HOST paths: the doctor runs on the host, not in the container, so
 * `/workspace/extra/...` would be meaningless here.
 */
export interface ProgressConfig {
  /** Task series whose runs are counted. */
  series: string;
  /** Host path to the git repo. */
  repo: string;
  /** Work branch the loop commits to. */
  branch: string;
  /** Base to diff against. */
  base: string;
  /** Repo-relative paths; all present = the loop is finished, not stalled. */
  doneWhenAllExist: string[];
  /** Completed runs with zero commits before this is called a stall. */
  runsWithoutProgress?: number;
}

export const DEFAULT_RUNS_WITHOUT_PROGRESS = 2;

export interface ProgressInput {
  seriesKey: string;
  group: string;
  branch: string;
  /** Every doneWhenAllExist artifact is present. */
  complete: boolean;
  /** Completed occurrences found, capped at requiredRuns. */
  runsInWindow: number;
  requiredRuns: number;
  /** Commits on branch since the window opened. null = git unreadable. */
  commitsInWindow: number | null;
  windowStart: string | null;
}

export function interpretProgress(i: ProgressInput): CheckResult {
  const id = `progress:${i.seriesKey}`;
  const title = `progress of ${i.seriesKey} (${i.group})`;

  // Finished is not stalled. Checked before everything else so a completed
  // loop can never be reported as broken.
  if (i.complete) {
    return {
      id,
      status: 'pass',
      title,
      detail: ['definition of done met — no further commits expected'],
      remediation: [],
    };
  }

  if (i.commitsInWindow === null) {
    return {
      id,
      status: 'inconclusive',
      title,
      detail: [`could not read git history for ${i.branch}`],
      remediation: ['Nothing proven. Check the repo path and branch in progress.json.'],
    };
  }

  if (i.runsInWindow < i.requiredRuns) {
    return {
      id,
      status: 'pass',
      title,
      detail: [`only ${i.runsInWindow} completed run(s) so far — not enough history to judge`],
      remediation: [],
    };
  }

  if (i.commitsInWindow === 0) {
    return {
      id,
      status: 'fail',
      title,
      detail: [
        `${i.runsInWindow} runs completed since ${i.windowStart ?? 'unknown'} and produced ZERO commits on ${i.branch}`,
        'the series is running and reporting success — it is just not getting anything done',
      ],
      remediation: [
        `Read the tail of the run log: groups/<group>/tasks/${i.seriesKey}.md — the agent usually says why.`,
        'Common causes: session/quota limit hit mid-task, work left uncommitted, or the agent blocked on an unanswered approval.',
      ],
    };
  }

  return {
    id,
    status: 'pass',
    title,
    detail: [`${i.commitsInWindow} commit(s) on ${i.branch} across the last ${i.runsInWindow} runs`],
    remediation: [],
  };
}

export function readProgressConfig(groupFolder: string): ProgressConfig | null {
  const p = path.join(GROUPS_DIR, groupFolder, 'progress.json');
  if (!fs.existsSync(p)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as ProgressConfig;
    if (!cfg.series || !cfg.repo || !cfg.branch || !cfg.base) {
      log.warn('Doctor: progress.json missing required fields, ignoring', { groupFolder });
      return null;
    }
    return cfg;
  } catch (err) {
    log.warn('Doctor: unreadable progress.json, ignoring', { groupFolder, err });
    return null;
  }
}

/** Commits on `branch` (relative to `base`) authored since `sinceIso`. null when git fails. */
export function countCommitsSince(repo: string, base: string, branch: string, sinceIso: string): number | null {
  try {
    const out = execFileSync(
      'git',
      [
        '-c',
        'safe.directory=*',
        '--no-optional-locks',
        '-C',
        repo,
        'rev-list',
        '--count',
        `--since=${sinceIso}`,
        `${base}..${branch}`,
      ],
      { timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    // Missing repo, missing branch, missing base — all "cannot judge", not "stalled".
    return null;
  }
}

export const progressCheck: Check = {
  name: 'progress',
  async run(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];

    for (const session of getActiveSessions()) {
      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) continue;

      const cfg = readProgressConfig(agentGroup.folder);
      if (!cfg) continue;
      if (!fs.existsSync(inboundDbPath(agentGroup.id, session.id))) continue;

      const requiredRuns = cfg.runsWithoutProgress ?? DEFAULT_RUNS_WITHOUT_PROGRESS;

      let windowStart: string | null = null;
      let runsInWindow = 0;
      try {
        withInboundDb(agentGroup.id, session.id, (db) => {
          const rows = db
            .prepare(
              `SELECT timestamp FROM messages_in
                WHERE (series_id = ? OR id = ?) AND kind = 'task' AND status = 'completed'
                ORDER BY seq DESC LIMIT ?`,
            )
            .all(cfg.series, cfg.series, requiredRuns) as Array<{ timestamp: string }>;
          runsInWindow = rows.length;
          windowStart = rows.length > 0 ? rows[rows.length - 1].timestamp : null;
        });
      } catch {
        continue;
      }

      // No completed runs for this series in this session — nothing to say.
      if (runsInWindow === 0) continue;

      const complete = cfg.doneWhenAllExist.every((rel) => fs.existsSync(path.join(cfg.repo, rel)));
      const commitsInWindow =
        complete || windowStart === null ? 0 : countCommitsSince(cfg.repo, cfg.base, cfg.branch, windowStart);

      results.push(
        interpretProgress({
          seriesKey: cfg.series,
          group: agentGroup.folder,
          branch: cfg.branch,
          complete,
          runsInWindow,
          requiredRuns,
          commitsInWindow,
          windowStart,
        }),
      );
    }

    return results;
  },
};
