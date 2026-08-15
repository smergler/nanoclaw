import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const deliver = vi.fn(
  async (
    _channelType: string,
    _platformId: string,
    _threadId: string | null,
    _kind: string,
    _content: string,
  ): Promise<string | undefined> => 'platform-msg-id',
);
vi.mock('../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver }),
}));

vi.mock('../modules/approvals/primitive.js', () => ({
  pickApprover: () => ['signal:+15550001111'],
}));

vi.mock('../modules/permissions/db/user-dms.js', () => ({
  getUserDm: (userId: string) => (userId === 'signal:+15550001111' ? { messaging_group_id: 'mg-dm' } : undefined),
}));

vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroup: (id: string) =>
    id === 'mg-dm' ? { id: 'mg-dm', channel_type: 'signal', platform_id: '+15550001111', name: null } : undefined,
}));

import { initTestDb, closeDb } from '../db/connection.js';
import { getHealthState } from '../db/health-state.js';
import { runMigrations } from '../db/migrations/index.js';
import { composeAlert, detectTransitions, escalate, type Transition } from './escalate.js';
import type { CheckResult } from './types.js';

function res(id: string, status: CheckResult['status'], over: Partial<CheckResult> = {}): CheckResult {
  return { id, status, title: id, detail: [], remediation: [], ...over };
}

/** The alert text handed to the adapter on the Nth call. */
function sentText(call: number): string {
  return (JSON.parse(deliver.mock.calls[call][4]) as { text: string }).text;
}

describe('detectTransitions', () => {
  it('emits exactly two transitions across pass -> fail -> fail -> fail -> pass', () => {
    const prior = new Map();
    const sequence: CheckResult['status'][] = ['pass', 'fail', 'fail', 'fail', 'pass'];
    const fired: Transition[] = [];

    for (const status of sequence) {
      const results = [res('mount:/a', status)];
      const transitions = detectTransitions(results, prior);
      fired.push(...transitions);
      // Simulate the store write escalate() performs.
      prior.set('mount:/a', {
        check_id: 'mount:/a',
        status,
        since: 'now',
        last_notified_at: transitions.length > 0 ? 'now' : (prior.get('mount:/a')?.last_notified_at ?? null),
      });
    }

    expect(fired.map((t) => t.kind)).toEqual(['failing', 'recovered']);
  });

  it('alerts on the first observation of a failing subject', () => {
    expect(detectTransitions([res('task:x', 'fail')], new Map()).map((t) => t.kind)).toEqual(['failing']);
  });

  it('stays quiet on the first observation of a healthy subject', () => {
    expect(detectTransitions([res('task:x', 'pass')], new Map())).toEqual([]);
  });

  it('never transitions on inconclusive — a flaky daemon must not page anyone', () => {
    const prior = new Map([['mount:/a', { check_id: 'mount:/a', status: 'pass', since: 'x', last_notified_at: null }]]);
    expect(detectTransitions([res('mount:/a', 'inconclusive')], prior)).toEqual([]);
  });

  it('does not let an inconclusive run "recover" a subject that is still failing', () => {
    const prior = new Map([['mount:/a', { check_id: 'mount:/a', status: 'fail', since: 'x', last_notified_at: 'y' }]]);
    // Inconclusive holds the previous state...
    expect(detectTransitions([res('mount:/a', 'inconclusive')], prior)).toEqual([]);
    // ...so the eventual real recovery is still reported.
    expect(detectTransitions([res('mount:/a', 'pass')], prior).map((t) => t.kind)).toEqual(['recovered']);
  });

  it('re-emits a failing subject whose alert was never delivered', () => {
    const prior = new Map([['mount:/a', { check_id: 'mount:/a', status: 'fail', since: 'x', last_notified_at: null }]]);
    expect(detectTransitions([res('mount:/a', 'fail')], prior).map((t) => t.kind)).toEqual(['failing']);
  });
});

describe('composeAlert', () => {
  it('leads with outage scope, not the check name', () => {
    const text = composeAlert([
      { kind: 'failing', result: res('mount:/a', 'fail', { title: 'mount /a' }) },
      { kind: 'failing', result: res('task:t1', 'fail', { title: 'task series t1' }) },
    ]);
    const first = text.split('\n')[0];

    expect(first).toContain('1 container mount(s) unreachable');
    expect(first).toContain('1 scheduled task series not running');
  });

  it('carries the evidence and the remediation into the message body', () => {
    const text = composeAlert([
      {
        kind: 'failing',
        result: res('mount:/a', 'fail', {
          title: 'mount /a',
          detail: ['host path EXISTS and is readable'],
          remediation: ['Restart Docker Desktop'],
        }),
      },
    ]);
    expect(text).toContain('host path EXISTS and is readable');
    expect(text).toContain('-> Restart Docker Desktop');
  });

  it('says recovered on the way back up', () => {
    const text = composeAlert([{ kind: 'recovered', result: res('mount:/a', 'pass', { title: 'mount /a' }) }]);
    expect(text).toContain('recovered');
    expect(text).toContain('RECOVERED: mount /a');
  });
});

describe('escalate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliver.mockResolvedValue('platform-msg-id');
    runMigrations(initTestDb());
  });
  afterEach(() => {
    closeDb();
  });

  it('healthy -> failing -> healthy sends exactly two DMs', async () => {
    await escalate([res('mount:/a', 'pass')]);
    expect(deliver).not.toHaveBeenCalled();

    await escalate([res('mount:/a', 'fail', { title: 'mount /a' })]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sentText(0)).toContain('FAILING');

    await escalate([res('mount:/a', 'pass', { title: 'mount /a' })]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sentText(1)).toContain('RECOVERED');
  });

  it('sends nothing at all on a healthy install', async () => {
    await escalate([res('mount:/a', 'pass'), res('task:t', 'pass')]);
    await escalate([res('mount:/a', 'pass'), res('task:t', 'pass')]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not re-notify while a subject stays failing', async () => {
    for (let i = 0; i < 5; i++) {
      await escalate([res('task:t', 'fail')]);
    }
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('survives a host restart without re-firing — state lives in the DB, not memory', async () => {
    await escalate([res('task:t', 'fail')]);
    expect(deliver).toHaveBeenCalledTimes(1);

    // Nothing in this module is cached in memory: the same DB is the entire
    // store, so a fresh process sees exactly this and stays quiet.
    expect(getHealthState('task:t')?.status).toBe('fail');
    expect(getHealthState('task:t')?.last_notified_at).not.toBeNull();

    await escalate([res('task:t', 'fail')]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('retries the alert on the next run when delivery failed', async () => {
    deliver.mockRejectedValueOnce(new Error('signal down'));

    await escalate([res('task:t', 'fail')]);
    expect(getHealthState('task:t')?.last_notified_at).toBeNull();

    await escalate([res('task:t', 'fail')]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(getHealthState('task:t')?.last_notified_at).not.toBeNull();
  });

  it('holds stored state through an inconclusive run', async () => {
    await escalate([res('mount:/a', 'fail')]);
    const before = getHealthState('mount:/a');

    await escalate([res('mount:/a', 'inconclusive')]);

    const after = getHealthState('mount:/a');
    expect(after?.status).toBe('fail');
    expect(after?.since).toBe(before?.since);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('prunes subjects that no longer exist so a returning failure alerts again', async () => {
    await escalate([res('mount:/gone', 'fail')]);
    expect(deliver).toHaveBeenCalledTimes(1);

    // Mount removed from config — it stops appearing in results.
    await escalate([res('mount:/other', 'pass')]);
    expect(getHealthState('mount:/gone')).toBeUndefined();

    // Re-added and broken again: this is news, not a duplicate.
    await escalate([res('mount:/gone', 'fail'), res('mount:/other', 'pass')]);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('only stamps last_notified_at on subjects actually named in the message', async () => {
    // Observed live 2026-08-15: a recovery DM about one series refreshed the
    // notified timestamp of an unrelated series that stayed failing and was
    // not mentioned in it.
    await escalate([res('task:a', 'fail'), res('task:b', 'fail')]);
    const bStamp = getHealthState('task:b')?.last_notified_at;
    expect(bStamp).not.toBeNull();

    // task:a recovers (that IS the alert); task:b is unchanged and unmentioned.
    await escalate([res('task:a', 'pass'), res('task:b', 'fail')]);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sentText(1)).toContain('RECOVERED');
    expect(sentText(1)).not.toContain('task:b');
    expect(getHealthState('task:b')?.last_notified_at).toBe(bStamp);
  });

  it('batches every transition in one run into a single DM', async () => {
    await escalate([res('mount:/a', 'fail'), res('task:t', 'fail'), res('mount:/b', 'fail')]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sentText(0)).toContain('2 container mount(s) unreachable');
  });
});
