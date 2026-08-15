/**
 * Mount reachability probe — the check that would have caught 2026-08-12.
 *
 * On that date every container spawn on this install failed for 13 hours with
 * exit 125 ("error while creating mount source path ... file exists"). An
 * external drive named in a group's `additional_mounts` had been attached
 * AFTER Docker Desktop started, so the VM held a stale virtiofs entry for it.
 *
 * The existing existence check — `fs.realpathSync` at
 * `src/modules/mount-security/index.ts:214` — passed for the entire outage.
 * The host path existed. `ls` listed its contents. `realpathSync` resolved it.
 * And `docker run` refused every time, because the host's view of the
 * filesystem and the Docker VM's view had diverged.
 *
 * There is no way to detect that by reading state. The only reliable probe is
 * attempting the thing.
 */
import { execFile } from 'child_process';
import fs from 'fs';

import { CONTAINER_IMAGE } from '../../config.js';
import type { AdditionalMountConfig } from '../../container-config.js';
import { CONTAINER_RUNTIME_BIN, DAEMON_REFUSED, readonlyMountArgs } from '../../container-runtime.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getAllContainerConfigs } from '../../db/container-configs.js';
import { log } from '../../log.js';
import type { Check, CheckResult } from '../types.js';

const PROBE_TIMEOUT_MS = 20_000;

/**
 * Pull the one useful line out of docker's stderr.
 *
 * Naively tailing the last lines yields "Run 'docker run --help' for more
 * information", which tells the reader nothing. The line that matters is the
 * daemon's own complaint.
 */
export function usefulStderrLine(stderr: string): string | null {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Run '.*--help'/.test(l) && !/^See '.*--help'/.test(l));
  if (lines.length === 0) return null;
  return lines.find((l) => /Error response from daemon|error while creating|^docker:/i.test(l)) ?? lines[0];
}

export interface ProbeOutcome {
  /** null when the runtime never produced an exit code (spawn error / timeout). */
  code: number | null;
  timedOut: boolean;
  stderr: string;
}

/**
 * `docker run --rm --entrypoint true -v <hostPath>:/probe:ro <image>`.
 *
 * `--entrypoint true` so nothing in the image runs: the only thing under test
 * is whether the daemon can create the bind mount. Killed hard on timeout —
 * a hung probe must not wedge the sweep that called it.
 */
export async function probeMount(hostPath: string, image: string): Promise<ProbeOutcome> {
  const args = ['run', '--rm', '--entrypoint', 'true', ...readonlyMountArgs(hostPath, '/probe'), image];

  return new Promise((resolve) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      args,
      { timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ code: 0, timedOut: false, stderr: '' });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        // execFile sets killed=true when it enforced the timeout.
        if (e.killed) return resolve({ code: null, timedOut: true, stderr: String(stderr ?? '') });
        const code = typeof e.code === 'number' ? e.code : null;
        resolve({ code, timedOut: false, stderr: String(stderr ?? '') });
      },
    );
  });
}

/** One distinct host path, plus every group that mounts it. */
interface MountSubject {
  hostPath: string;
  groups: string[];
  image: string;
}

/**
 * Dedupe configured mounts by host path. Two groups sharing one mount produce
 * one probe, not two — the subject under test is the path, not the group.
 *
 * The image comes from the first owning group's `image_tag` (falling back to
 * the install default) so the probe exercises what a real spawn would. When
 * owners disagree on image the difference is immaterial: a wrong image shows
 * up as a non-125 exit, which is reported as its own category.
 */
export function collectMountSubjects(
  configs: Array<{ agent_group_id: string; image_tag: string | null; additional_mounts: string }>,
  resolveGroupName: (id: string) => string,
  defaultImage: string,
): MountSubject[] {
  const byPath = new Map<string, MountSubject>();

  for (const cfg of configs) {
    let mounts: AdditionalMountConfig[];
    try {
      mounts = JSON.parse(cfg.additional_mounts) as AdditionalMountConfig[];
    } catch {
      log.warn('Doctor: unparseable additional_mounts, skipping group', { agentGroupId: cfg.agent_group_id });
      continue;
    }
    if (!Array.isArray(mounts)) continue;

    for (const m of mounts) {
      if (!m?.hostPath) continue;
      const existing = byPath.get(m.hostPath);
      if (existing) {
        existing.groups.push(resolveGroupName(cfg.agent_group_id));
        continue;
      }
      byPath.set(m.hostPath, {
        hostPath: m.hostPath,
        groups: [resolveGroupName(cfg.agent_group_id)],
        image: cfg.image_tag || defaultImage,
      });
    }
  }

  return [...byPath.values()];
}

/**
 * Turn one probe outcome into a result.
 *
 * The non-obvious requirement: when a path fails with 125 AND exists on the
 * host, the output must say so in as many words. Without that line the reader
 * spends the first twenty minutes `ls`-ing a directory that is demonstrably
 * fine — which is exactly how the 2026-08-12 diagnosis started. That sentence
 * is the deliverable, not decoration.
 */
export function interpretProbe(subject: MountSubject, outcome: ProbeOutcome, hostPathExists: boolean): CheckResult {
  const id = `mount:${subject.hostPath}`;
  const title = `mount ${subject.hostPath}`;
  const owners = `mounted by: ${subject.groups.join(', ')}`;

  if (outcome.timedOut) {
    return {
      id,
      status: 'inconclusive',
      title,
      detail: [owners, `probe exceeded ${PROBE_TIMEOUT_MS / 1000}s and was killed`],
      remediation: ['Nothing proven — the container runtime did not answer. Re-run before acting on this.'],
    };
  }

  if (outcome.code === 0) {
    return { id, status: 'pass', title, detail: [owners], remediation: [] };
  }

  if (outcome.code === DAEMON_REFUSED) {
    const detail = [owners, `${CONTAINER_RUNTIME_BIN} refused the bind mount (exit ${DAEMON_REFUSED})`];
    if (hostPathExists) {
      detail.push('host path EXISTS and is readable — this is a Docker VM share problem, not a missing directory');
    } else {
      detail.push('host path does not exist');
    }
    const line = usefulStderrLine(outcome.stderr);
    if (line) detail.push(line);

    return {
      id,
      status: 'fail',
      title,
      detail,
      remediation: hostPathExists
        ? [
            'Restart Docker Desktop so it re-enumerates its share of the parent volume.',
            'Do not bother inspecting the host path — it is fine. The VM disagrees with the host.',
          ]
        : ['Reattach the volume, or remove the mount with `ncl groups config remove-mount`.'],
    };
  }

  // Non-125 non-zero: the daemon accepted the mount and something else broke.
  // A distinct category on purpose — this means image/entrypoint is wrong, and
  // sending the reader to go restart Docker over it wastes their time.
  return {
    id,
    status: 'fail',
    title,
    detail: [
      owners,
      `probe exited ${outcome.code ?? 'with no code'} — the mount was accepted, the image or entrypoint was not`,
      `image: ${subject.image}`,
      ...(usefulStderrLine(outcome.stderr) ? [usefulStderrLine(outcome.stderr) as string] : []),
    ],
    remediation: [`Check that image \`${subject.image}\` exists locally and can run \`true\`.`],
  };
}

export const mountCheck: Check = {
  name: 'mounts',
  async run(): Promise<CheckResult[]> {
    const subjects = collectMountSubjects(
      getAllContainerConfigs(),
      (id) => getAgentGroup(id)?.folder ?? id,
      CONTAINER_IMAGE,
    );

    const results: CheckResult[] = [];
    for (const subject of subjects) {
      const outcome = await probeMount(subject.hostPath, subject.image);
      let exists = false;
      try {
        fs.accessSync(subject.hostPath, fs.constants.R_OK);
        exists = true;
      } catch {
        exists = false;
      }
      results.push(interpretProbe(subject, outcome, exists));
    }
    return results;
  },
};
