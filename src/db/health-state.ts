/**
 * Accessors for `health_state` — the doctor's transition store.
 * See `src/db/migrations/022-health-state.ts`.
 */
import { getDb } from './connection.js';

export interface HealthStateRow {
  check_id: string;
  status: string;
  since: string;
  last_notified_at: string | null;
}

export function getHealthState(checkId: string): HealthStateRow | undefined {
  return getDb().prepare('SELECT * FROM health_state WHERE check_id = ?').get(checkId) as HealthStateRow | undefined;
}

export function getAllHealthState(): HealthStateRow[] {
  return getDb().prepare('SELECT * FROM health_state').all() as HealthStateRow[];
}

/**
 * Record the current status for a subject.
 *
 * `since` is only advanced when the status actually CHANGES — an unchanged
 * status keeps its original first-observed timestamp, which is what makes
 * "failing for 4 days" reportable.
 */
export function upsertHealthState(checkId: string, status: string, notifiedAt?: string | null): void {
  const now = new Date().toISOString();
  const existing = getHealthState(checkId);
  const since = existing && existing.status === status ? existing.since : now;
  const lastNotified = notifiedAt === undefined ? (existing?.last_notified_at ?? null) : notifiedAt;

  getDb()
    .prepare(
      `INSERT INTO health_state (check_id, status, since, last_notified_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(check_id) DO UPDATE SET status = excluded.status, since = excluded.since,
                                           last_notified_at = excluded.last_notified_at`,
    )
    .run(checkId, status, since, lastNotified);
}

/** Drop state for subjects that no longer exist, so they can't linger as stale rows. */
export function pruneHealthState(liveCheckIds: string[]): void {
  const all = getAllHealthState();
  const live = new Set(liveCheckIds);
  const stmt = getDb().prepare('DELETE FROM health_state WHERE check_id = ?');
  for (const row of all) {
    if (!live.has(row.check_id)) stmt.run(row.check_id);
  }
}
