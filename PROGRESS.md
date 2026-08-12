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
