# Progress Log

Rules: APPEND-ONLY — never edit or delete existing entries. Newest at the bottom.
Each entry records: date, what was done, current state, what's next, anything broken.

---

## 2026-08-12 — kickoff: ncl-doctor scaffolding + plan

**Done**

- Worked the "Recommended order" in `NanoClaw Notes/desired fixes/README.md`, items 3–5.
- Item 5 (fix 04, plist): `ProgramArguments:0` repointed from the `fnm_multishells/92779_…`
  session symlink to `~/.local/share/fnm/aliases/default/bin/node`. Backup at
  `com.nanoclaw-v2-fc2314cf.plist.bak-20260812-115807`. Service reloaded, verified running
  (PID 53005, exit 0), Signal + Discord reconnected. **Host-machine change, not in this repo.**
- Item 3 (issue #2504): comment posted — `#issuecomment-5269430924`. Asks whether `ncl status`
  stays a pure reporter with a separate `ncl doctor`, or grows `--check`/`--exit-code`.
- Item 4 (PR #2689): comment posted — `#issuecomment-5269533005`. Duplicate-identity evidence
  from this two-account install. Cherry-pick deliberately NOT done pending a migration answer.
- Created this scaffolding + `plans/ncl-doctor/PLAN.md`.

**Current state**

Branch `feature/ncl-doctor`, branched from `channels-signal-discord` (NOT from `main` — the
Signal/Discord adapters live there and the mount probe needs a working install to test against).
No implementation written. Nothing under `src/doctor/` exists yet.

**What's next**

Nothing, deliberately. The plan is **gated** — see PLAN.md §Gate. Do not start Phase 3
(command surface) before a maintainer answers #2504 or 2026-08-22 passes, whichever is first.
Phases 1–2 are surface-independent and may be built at any time.

**Broken / known issues**

- `sess-1784346851456-5m8tcr` has a corrupted session DB — `[agent-runner] Fatal error: database
  disk image is malformed`. Not addressed. Not in any of the seven fix notes.
- Fix 02's `grep 'signal:\${'` test was stale and gave a false negative; corrected in the note.
- ✅ **FIXED and VERIFIED ON A LIVE CONTAINER 2026-08-12 — Loop Builder's trip_planner mount is
  read-write.** `readonly: false` set on the stored config; run fired early with
  `ncl tasks run --id trip-planner-build-722c`. `docker inspect` on the resulting container:
  `/Users/smergler/funstuff/trip_planner -> /workspace/extra/trip_planner RW=true`. All four links
  confirmed: stored config → `validateAdditionalMounts` → re-materialized `container.json` →
  live mount. A `:ro` probe on the same image reproduces the agent's exact error string
  ("Read-only file system"), closing the loop on the diagnosis. Original write-up below:
- **Loop Builder's trip_planner mount is read-only when it should be read-write.** Root cause
  found — and an earlier note in this log calling it architectural was **wrong**. RW mounts are
  supported (`container-runner.ts:512-518` branches on `mount.readonly`). But
  `mount-security/index.ts:368` requires `readonly === false` *explicitly*, and the stored config
  omits the key, so it is denied by default. The allowlist has granted `allowReadWrite: true` for
  that path all along. Fix is one field on `container_configs.additional_mounts` + a group restart.
  5 consecutive task failures traced to this; auto-pause at 8.
- **`ncl groups config add-mount` cannot create a read-write mount at all.**
  `cli/resources/groups.ts:469` sets `readonly: true` for `--ro` and otherwise *omits* the key —
  never `false`. So every mount added via the CLI is read-only regardless of the allowlist, and
  `allowReadWrite: true` is silently unreachable through the supported interface. Novel; worth
  reporting upstream. Fix: add a `--rw` flag emitting `readonly: false`, leave the omitted case
  read-only so the safe default is unchanged.
- Details and the exact SQL: `groups/loop-builder/QUEUE.md` (gitignored).

---

## 2026-08-15 — Phase 1 (1.1–1.3) + Phase 2 built; new task-health check

**Done**

- **The mount fix from 08-12 was real and irrelevant.** Both loops kept failing every night
  after it. Actual root cause: **`python3` is not in the agent image.** Both gate scripts
  (`gate-build.sh:19`, `gate-trip-planner.sh`) `die` on `command -v python3`. Single-variable
  proof — same script, same mounts, only the image differs:
  `nanoclaw-agent-v2-fc2314cf:latest` (12bb3657, the live tag) → `gate: python3 missing`, exit 1;
  untagged image 935e29407532 (locally built 2026-08-09) → exit 0, `{"wakeAgent": true}`.
  The old image had Python 3.11.2 transitively via the `chromium` apt line in
  `container/Dockerfile:31`; commit `d75f350c` ("setup: fetch a hardened agent image instead of
  building it") swapped it for an image that does not. `node` v22 and `bun` are present.
  **The gate scripts are NOT yet fixed** — see What's next.
- Built `src/doctor/`: `types.ts` (1.1), `runner.ts` (1.2), `checks/mounts.ts` (1.3),
  `escalate.ts` + `db/health-state.ts` + migration `022-health-state` (2.1–2.3),
  `spawn-backoff.ts` wired into `container-runner.ts` (2.4), and `index.ts` as the entry point.
- **New: `checks/tasks.ts`, not in the original plan.** The plan would not have caught this
  week's failure — its only real probe is the mount probe. The host already knew
  (`trailingFailedRuns()` counted the streak, `recurrence.ts:78` logged the auto-pause, the run
  log got a note) and told nobody: the plan's own table, fourth row. Fails at 2 consecutive
  failed runs, not the scheduler's cap of 8.
- Sweep call site in `host-sweep.ts` on a 15-minute clock (`MODULE-HOOK:doctor-sweep`). This is
  Task 4.1, which the plan gated behind Phase 3 — ungated deliberately: Phase 3 is the CLI
  surface, and without a call site Phase 2 is dead code on this install.
- 47 new tests. Full suite 1311 passed / 106 files (baseline 1264 / 101). `tsc --noEmit` clean.
  eslint unchanged at 11 pre-existing errors; the 6 new warnings are the `no-catch-all` pattern
  already used throughout `host-sweep.ts`.

**Verified against live state (read-only, no DB writes, no DMs sent)**

- `ncl-doctor-1`'s hardest criterion reproduced **without unplugging anything** — the external
  drive is in the divergent state right now. `/Volumes/manual backup/nanoclaw-youtube` exists,
  is readable (`ls` lists bin/downloads/logs), and `docker run -v ...:ro` returns 125. The real
  `interpretProbe` emits "host path EXISTS and is readable — this is a Docker VM share problem".
  Both currently-configured mounts (`council/tasks`, `trip_planner`) probe exit 0.
- The task check, run against the live session DBs read-only, flags
  `trip-planner-build-722c` (paused, 8 fails) and `trip-planner-watch-6049` (4 fails), and
  passes the two healthy `dm-with-smergler` hourly series. Warden would have alerted on 08-13.

**Current state**

Branch `feature/ncl-doctor`, local only, no PR. **Not deployed** — the running daemon (PID
53005) is on `dist/` from before this work, so nothing above is live yet. Every `features.json`
entry stays `failing`: the rule is verification against the *running* application, and the
checks have only been exercised standalone.

**What's next**

1. Fix the two gate scripts (`python3` heredoc → `node -e`). This is what actually unblocks the
   loops; the doctor only reports on them. Then `ncl tasks resume trip-planner-build-722c`.
2. Deploy (`pnpm run build` + `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-fc2314cf`)
   and flip features to `passing` once observed live.
3. Phase 3 (CLI surface) still gated on #2504 — no maintainer reply as of today, deadline 08-22.
4. Phase 5 (orphaned messaging groups) not started.

**Broken / known issues**

- Loop Builder and Loop Warden are still dark. Nothing in this session fixed them.
- `pnpm exec tsx setup:auto` fires on a bare `./nanoclaw.sh --help`; it truncated
  `logs/setup.log`, losing the 2026-08-11 12:20 entries. No other effect — daemon untouched.
- `init.sh` fails at the agent-runner typecheck because `bun` is not on PATH on this host. The
  host suite runs fine via `pnpm test` directly. Pre-existing.
