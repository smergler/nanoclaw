import type { Migration } from './index.js';

/**
 * Persisted health state, one row per doctor check subject.
 *
 * Must survive a host restart. The 2026-08-12 outage ran 13 hours under a
 * single PID, but the failure mode this guards against is the opposite: an
 * in-memory map means every launchd restart during a failing period re-fires
 * the alert, and an alert that repeats is an alert that gets muted.
 *
 * `check_id` is the check's stable per-subject id (`mount:/Volumes/foo`,
 * `task:trip-planner-build-722c`) — see `src/doctor/types.ts`.
 *
 * `since` is when the CURRENT status was first observed, not when the row was
 * last touched, so a report can say how long something has been broken.
 */
export const migration022: Migration = {
  version: 22,
  name: 'health-state',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS health_state (
        check_id         TEXT PRIMARY KEY,
        status           TEXT NOT NULL,
        since            TEXT NOT NULL,
        last_notified_at TEXT
      );
    `);
  },
};
