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
