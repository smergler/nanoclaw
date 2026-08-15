import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { DAEMON_REFUSED } from '../../container-runtime.js';
import { collectMountSubjects, interpretProbe, probeMount, usefulStderrLine, type ProbeOutcome } from './mounts.js';

beforeEach(() => {
  vi.clearAllMocks();
});

const subject = { hostPath: '/Volumes/backup/media', groups: ['loop-builder'], image: 'nanoclaw:latest' };

function outcome(over: Partial<ProbeOutcome>): ProbeOutcome {
  return { code: 0, timedOut: false, stderr: '', ...over };
}

describe('collectMountSubjects', () => {
  const resolve = (id: string) => `folder-${id}`;

  it('dedupes by host path and carries every owning group', () => {
    const subjects = collectMountSubjects(
      [
        {
          agent_group_id: 'ag-1',
          image_tag: null,
          additional_mounts: JSON.stringify([{ hostPath: '/shared', containerPath: 'shared' }]),
        },
        {
          agent_group_id: 'ag-2',
          image_tag: null,
          additional_mounts: JSON.stringify([{ hostPath: '/shared', containerPath: 'shared', readonly: true }]),
        },
      ],
      resolve,
      'default:image',
    );

    expect(subjects).toHaveLength(1);
    expect(subjects[0].hostPath).toBe('/shared');
    expect(subjects[0].groups).toEqual(['folder-ag-1', 'folder-ag-2']);
  });

  it('uses the group image tag when set and the install default otherwise', () => {
    const subjects = collectMountSubjects(
      [
        {
          agent_group_id: 'ag-1',
          image_tag: 'custom:tag',
          additional_mounts: JSON.stringify([{ hostPath: '/a', containerPath: 'a' }]),
        },
        {
          agent_group_id: 'ag-2',
          image_tag: null,
          additional_mounts: JSON.stringify([{ hostPath: '/b', containerPath: 'b' }]),
        },
      ],
      resolve,
      'default:image',
    );
    expect(subjects.map((s) => s.image)).toEqual(['custom:tag', 'default:image']);
  });

  it('skips a group with unparseable additional_mounts instead of throwing', () => {
    const subjects = collectMountSubjects(
      [
        { agent_group_id: 'ag-bad', image_tag: null, additional_mounts: 'not json' },
        {
          agent_group_id: 'ag-ok',
          image_tag: null,
          additional_mounts: JSON.stringify([{ hostPath: '/a', containerPath: 'a' }]),
        },
      ],
      resolve,
      'default:image',
    );
    expect(subjects.map((s) => s.hostPath)).toEqual(['/a']);
  });
});

describe('usefulStderrLine', () => {
  it("skips docker's own 'Run --help' trailer for the daemon's actual complaint", () => {
    const stderr = [
      "docker: Error response from daemon: error while creating mount source path '/host_mnt/Volumes/x': mkdir /host_mnt/Volumes/x: file exists",
      '',
      "Run 'docker run --help' for more information",
    ].join('\n');

    expect(usefulStderrLine(stderr)).toContain('error while creating mount source path');
    expect(usefulStderrLine(stderr)).not.toContain('--help');
  });

  it('returns null for empty stderr', () => {
    expect(usefulStderrLine('   \n  \n')).toBeNull();
  });

  it('falls back to the first real line when nothing matches the known shapes', () => {
    expect(usefulStderrLine('something odd\nsecond line')).toBe('something odd');
  });
});

describe('interpretProbe — the four exit mappings', () => {
  it('exit 0 passes', () => {
    const r = interpretProbe(subject, outcome({ code: 0 }), true);
    expect(r.status).toBe('pass');
    expect(r.id).toBe('mount:/Volumes/backup/media');
    expect(r.remediation).toEqual([]);
  });

  it('exit 125 with an existing host path names the contradiction explicitly', () => {
    const r = interpretProbe(subject, outcome({ code: DAEMON_REFUSED }), true);

    expect(r.status).toBe('fail');
    // This sentence is the deliverable. Without it the reader spends twenty
    // minutes ls-ing a directory that is demonstrably fine.
    expect(r.detail.join('\n')).toContain('host path EXISTS and is readable');
    expect(r.detail.join('\n')).toContain('Docker VM share problem');
    expect(r.remediation.join('\n')).toContain('Restart Docker Desktop');
  });

  it('exit 125 with a missing host path does NOT claim the path exists', () => {
    const r = interpretProbe(subject, outcome({ code: DAEMON_REFUSED }), false);

    expect(r.status).toBe('fail');
    expect(r.detail.join('\n')).not.toContain('host path EXISTS');
    expect(r.detail.join('\n')).toContain('host path does not exist');
  });

  it('a non-125 non-zero exit is a distinct category — image, not mount', () => {
    const r = interpretProbe(subject, outcome({ code: 127 }), true);

    expect(r.status).toBe('fail');
    expect(r.detail.join('\n')).toContain('the mount was accepted');
    expect(r.detail.join('\n')).toContain('nanoclaw:latest');
    // Must NOT send the reader off to restart Docker over an image problem.
    expect(r.remediation.join('\n')).not.toContain('Restart Docker Desktop');
  });

  it('a timeout is inconclusive, never a failure', () => {
    const r = interpretProbe(subject, outcome({ code: null, timedOut: true }), true);

    expect(r.status).toBe('inconclusive');
    expect(r.detail.join('\n')).toContain('killed');
  });
});

describe('probeMount', () => {
  it('builds a read-only probe that runs nothing in the image', async () => {
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) => cb(null, '', ''));

    await probeMount('/Volumes/backup', 'img:tag');

    const [bin, args] = mockExecFile.mock.calls[0];
    expect(bin).toBe('docker');
    expect(args).toEqual(['run', '--rm', '--entrypoint', 'true', '-v', '/Volumes/backup:/probe:ro', 'img:tag']);
  });

  it('maps a killed child to timedOut rather than an exit code', async () => {
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
      const err = Object.assign(new Error('timeout'), { killed: true });
      cb(err, '', '');
    });

    const result = await probeMount('/Volumes/backup', 'img:tag');
    expect(result).toEqual({ code: null, timedOut: true, stderr: '' });
  });

  it('surfaces the daemon exit code and stderr', async () => {
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
      const err = Object.assign(new Error('boom'), { code: DAEMON_REFUSED });
      cb(err, '', 'error while creating mount source path');
    });

    const result = await probeMount('/Volumes/backup', 'img:tag');
    expect(result.code).toBe(DAEMON_REFUSED);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain('mount source path');
  });
});
