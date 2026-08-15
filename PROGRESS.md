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

---

## 2026-08-15 (later) — deployed; escalation verified live; gates ported to node

**Done**

- Deployed. `pnpm run build`, `launchctl kickstart -k`. New PID 65794 at 11:53:13, migration
  `health-state` applied to the live DB at 11:53:15, all three adapters reconnected. DB backed
  up first to `data/v2.db.bak-pre-doctor-20260815` (integrity_check ok, 12 sessions).
- **The escalation path works end to end on the real install.** First sweep fired 12:08:38 —
  one interval after boot, as designed:
  ```
  INFO Signal message sent platformId="+13474649890" length=826
  INFO Doctor alert delivered approver="signal:+13474649890" channelType="signal"
  WARN Doctor state changed failing=["task:trip-planner-watch-6049","task:trip-planner-build-722c"]
  ```
  The alert text reconstructed from live data read-only is **826 chars — byte-exact against the
  delivery log**, so what is recorded here is what was received.
- 8 subjects in `health_state`: both mounts pass; `morning-calendar-briefin-a188`,
  `dropped-messages-watch-cd49`, `session-heartbeat-57de`, `decline-gymnastics-b903` pass; the
  two trip-planner series fail, both stamped `last_notified_at`.
- **No duplicate on the second sweep.** 1 alert delivered, 1 state-change event across two
  sweeps. Positive proof the second sweep actually RAN rather than being skipped: `docker events`
  shows two anonymous containers created 12:23:41 (`inspiring_panini`, `nifty_saha`) — nameless
  `docker run --rm --entrypoint true` probes, one per configured mount. Silence was a decision,
  not an absence.
- **Both gate scripts ported from python3 to node.** `gate-build.sh` was a trivial 30-line
  translation. `gate-trip-planner.sh` is 185 lines of table parsing, sha256 fingerprinting, date
  arithmetic and atomic state writes — too much to translate on trust, so equivalence was proven
  instead: original Python vs new node, same repo, same seeded state, 8 cases covering every
  branch (cold start / live state / corrupt state file / build-in-flight / state-changed /
  quiet-active / quiet-elapsed / blocker-date carry-forward). Identical exit code, wake decision,
  stderr line, state file and JSON in all 8. Only diff: python `round(x,1)` emits `0.0` where JS
  emits `0` — same JSON number; the rounding formula was checked empirically across five values.
- Both gates now exit 0 inside `nanoclaw-agent-v2-fc2314cf:latest` with the real mounts.
- `ncl tasks resume trip-planner-build-722c` → `touched: 1`. Both series `pending`:
  builder 2026-08-16T06:00Z, warden 2026-08-16T11:00Z.

**Current state**

Doctor live and quiet. Both loops armed with working gates. Neither has had a successful run
yet — `trailingFailedRuns` reads occurrence history, so both still report failing until a run
completes. That is correct: resuming is not evidence.

**What's next**

- 02:00 builder, 07:00 warden. First green run resets the streak; the doctor's next sweep then
  reports pass and sends the recovery DM. **That DM is the remaining unverified half of
  `ncl-doctor-2`.**
- Phase 3 still gated on #2504 (no reply; deadline 08-22). Phases 4.2 and 5 not started.

**features.json — deliberately still all `failing`**

The rule is verification against the running application, and partial is not verified:
- `ncl-doctor-1`: the exists-but-125 case was proven on `/Volumes/manual backup/nanoclaw-youtube`,
  but that path is not a *configured* mount, so the criterion is not met as written.
- `ncl-doctor-2`: failing-side verified live and de-duplication proven; the recovery DM has not
  happened yet.
- `ncl-doctor-3`: no exit-125 spawn has occurred since deploy. Unit-tested only.
- `ncl-doctor-6`: four of five criteria verified live; "a single failed run does not alert" has
  not been observed on the running install.

**Broken / known issues**

- The container test of the warden gate wrote real state — `last_digest` in
  `groups/loop-warden/loop-state/trip_planner.json` moved 08-11 → 08-15. No behavioural impact:
  `build_in_flight` short-circuits to wake daily and never consults it while the build is
  unfinished.
- `groups/*` is gitignored, so neither gate fix is under version control. They exist only in this
  install. A `groups/` wipe loses both.

---

## 2026-08-15 (afternoon) — builder ran green; the gate fix was only half the fix

**Done**

- `CONTAINER_IDLE_CEILING_MIN` added to config (default 30, set to 90 here).
  `ABSOLUTE_CEILING_MS` now reads it. **Worth recording why this matters less than it
  looks:** the ceiling gates *heartbeat age*, not runtime, and `touchHeartbeat()` fires on
  every SDK event (`poll-loop.ts:488`); host-sweep also widens it to a declared Bash timeout.
  A working agent is never reaped by it. It only kills containers that go SILENT — which is
  exactly what happened to loop-builder nightly while its gate was failing. Raising the
  ceiling would not have saved the loops; it would have made each corpse linger longer.
- `ncl tasks run --id trip-planner-build-722c` at 13:14:57. Container spawned 13:15:32, row
  `trip-planner-build-722c-5251` **completed** by 13:17. First successful agent wake since
  08-11. `loop/trip-planner` branch created.
- **The gate fix was necessary but not sufficient.** trip_planner is a *Python* project;
  PLAN.md Step 1 is venv + pytest + ClaudeCLIClient. The agent woke, got one step further,
  and filed `install_packages` for `python3 python3-venv python3-pip` — approval
  `appr-1786814201213-66t7tw`, DM sent 13:16:50, **still pending, awaiting smergler**. Its
  own words: "The container currently has no python3 binary at all (contradicting PLAN.md's
  assumption of a system Python 3.11.2)". That version is precisely what the old
  locally-built image 935e29407532 carried — independent confirmation the plan was written
  against the pre-hardened image.
  Porting the gates addressed the gate only. The `packages_apt` route — dismissed in the
  morning write-up as "standing on the same loose floorboard" — was the right call for the
  builder all along. The warden port stands: it is a read-only reporter that never needed
  Python.
- Recovery verified end to end. 13:29:40 sweep: `failing=[] recovered=["trip-planner-build-722c"]`,
  100-char DM. **Two doctor DMs, ever** — 12:08 failing, 13:29 recovered.
- **Defect found on the live install and fixed.** That same sweep refreshed
  `trip-planner-watch-6049`'s `last_notified_at` to 17:29:40 — a series that stayed failing
  and was *not* named in that message. `delivered` is a per-run boolean and was being applied
  to every failing subject. No behavioural impact (the retry path reads only null vs
  non-null) but the stored time was a lie. Now stamps only ids in the delivered transition
  set. Regression test added. Deployed 13:31:49 (PID 25942); pending approval survived.

**Current state**

`health_state`: 7 pass, 1 fail (`trip-planner-watch-6049`, correctly — it has not had a
successful run yet; its next is 07:00 tomorrow). Builder armed for 02:00, unchanged by the
manual run. 1312 tests green.

**features.json**

`ncl-doctor-2` → **passing**. All five criteria verified against the running host: exactly two
DMs across healthy→failing→healthy; no repeat across three sweeps while failing; a recovery DM
naming the recovery; no re-fire after the 13:14 restart; and silence on the 12:23 sweep —
proven to have RUN by two nameless probe containers in `docker events`, not inferred from
absent log lines. The rest stay `failing`; see the previous entry for which criteria are and
are not live-verified.

**Broken / known issues**

- **The builder cannot proceed until the `install_packages` approval is answered.** Nothing
  else unblocks it.
- Approving builds a derived image and stamps `image_tag` on loop-builder's config, pinning
  the group to that base. Future base-image updates will not reach it until someone rebuilds.
  That is the same class of silent drift that caused this incident, in mirror image — and
  **nothing checks for it.** No doctor check compares a derived image against its base. Worth
  a Phase 5 check.
- `groups/*` is gitignored; both gate ports exist only in this install.

---

## 2026-08-15 (late) — python3 installed for loop-builder, via the operator path

**Done**

- smergler asked me to approve the build on their behalf. Did it as an **operator action**, not
  by answering the approval card in their name — forging a Signal response would put their user
  id on an approval they never clicked:
  `ncl groups config add-package --id ag-dbb65390-… --apt python3|python3-venv|python3-pip`
  then `ncl groups restart --id … --rebuild` → `{"restarted":0,"rebuilt":true}`.
- Derived image `nanoclaw-agent-v2-fc2314cf:ag-dbb65390-df2f-4168-8f2c-7781394a46c5` built and
  stamped on `container_configs.image_tag`. Verified in the image: **Python 3.13.5**, `venv` OK,
  `pip 25.1.1`.
- Verified the rebuild is not inert: `configFromDb` (`container-config.ts:69`) maps
  `image_tag → imageTag`, `materializeContainerJson` returns it, `buildContainerArgs` uses
  `containerConfig.imageTag || CONTAINER_IMAGE`. The next loop-builder spawn gets the derived
  image. The on-disk `groups/loop-builder/container.json` still shows the old values — it is
  regenerated at spawn, so that staleness is expected, not a bug.

**Broken / known issues**

- **Version skew.** PLAN.md assumes system Python **3.11.2**; the derived image ships **3.13.5**
  (Debian trixie). trip_planner's deps have never been resolved against 3.13. If Step 1 fails on
  a dependency, this is the first thing to check — not the container.
- **`appr-1786814201213-66t7tw` is still `pending`.** The effect was applied out-of-band, so the
  handler never ran and the agent was never sent the "approved" note. It is not blocked (its turn
  ended at 13:17) and its 02:00 run will simply find python3. Clearing the row means either
  tapping the card (idempotent now — packages dedupe, rebuild is cached) or a raw DB delete.
- **loop-builder is now pinned** to today's base via `image_tag`. Base-image updates will not
  reach it until someone rebuilds, and **no check compares a derived image against its base.**
  Same class of silent drift as the incident that started this, inverted.
- The task check has a hole worth naming: it only inspects series that are ARMED
  (`status IN ('pending','paused')`) and counts trailing FAILED occurrences. A series that is
  cancelled, deleted, or never re-armed produces no failures and no armed row — it vanishes from
  the results, `pruneHealthState` drops its row, and the silence is total. It catches loops that
  break; it does not catch loops that disappear.
