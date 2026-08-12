# PLAN — `ncl doctor`: a health runner that pushes

**Slug:** `ncl-doctor`
**Branch:** `feature/ncl-doctor` (branched from `channels-signal-discord`, not `main` — see §PR hygiene)
**Source notes:** `NanoClaw Notes/desired fixes/` fixes [01](#), [01a](#), [07](#)
**Written:** 2026-08-12
**Status:** PLANNED, NOT IMPLEMENTED. Phase 3 is gated — see §Gate.

---

## The problem in one sentence

On 2026-08-12 every container spawn on this install failed for 13 hours, emitted 2,193 identical
`code=125` warnings, and reached nobody — the outage was found by noticing a Signal channel had
gone quiet.

## What this is actually for

Not "a health command." The specific job is **turning a condition the host already knows about
into a message a human receives.** Four separate failures on this install share that shape:

| Signal that existed | Where it went |
|---|---|
| `unregistered_senders.seen_count` incrementing, `no_agent_wired`, 2026-07-18 → 08-07 | a table nobody reads |
| `MissingChannelAdapterError` on every dropped message | `nanoclaw.error.log` |
| `Additional mount REJECTED` on every spawn | `nanoclaw.error.log` |
| `Container exited non-zero code=125` × 2,193 | `nanoclaw.error.log` |

A command that renders these to whoever types it is a marginal improvement. **The escalation is
the feature; the command is the demo.** If Phase 2 is skipped this project has failed even if
Phases 1, 3, and 4 all ship.

## Design constraints (violate these and the thing is decorative)

1. **Periodic, not boot-time.** The 2026-08-12 outage began ~7h after host start and ran 13h with
   the same PID throughout. A boot assertion ran at 14:08, found everything healthy, and stayed
   quiet. Boot is a third call site, not the design.
2. **Probing, not reading.** `fs.realpathSync` (`src/modules/mount-security/index.ts:214`) passed
   for the entire outage. The host path existed and `ls` listed it while `docker run` returned 125.
   Host-view and Docker-VM-view had diverged. **There is no way to detect this without doing the
   thing.**
3. **Transitions, not events.** A check that logs 96 lines a day instead of 2,193 is the same bug
   with better manners. Alert on healthy→failing and failing→healthy, once each.
4. **Silent when healthy.** Any output on a healthy install trains the reader to ignore it.

---

## Gate

Issue [#2504](https://github.com/nanocoai/nanoclaw/issues/2504) asks for `ncl status`. A comment
was posted 2026-08-12 ([#5269430924](https://github.com/nanocoai/nanoclaw/issues/2504#issuecomment-5269430924))
asking the one question that decides the CLI surface:

> Does `ncl status` stay a pure read-only reporter with assertions in a separate `ncl doctor`, or
> does it grow a `--check` / `--exit-code` mode?

**Phases 1 and 2 do not depend on the answer.** The check interface, the mount probe, the
transition store, and the spawn backoff are identical either way. Only Phase 3 — roughly 40 lines
of `register()` call — changes shape.

**Deadline: 2026-08-22.** If no maintainer has replied by then, build Phase 3 as a separate
`ncl doctor run`, note in the PR that #2504 got no response, and offer to fold it into `ncl status`.

**Kill switch:** if #2504 *and* #2689 are both still silent on 2026-08-22, stop treating this as an
upstream contribution. Build Phases 1–3 for this install only, drop Phase 5, and stop writing these
notes as though a maintainer will read them.

---

## Phase 1 — the runner and the probe *(not gated)*

### Task 1.1 — Check interface

New `src/doctor/types.ts`.

- `CheckStatus = 'pass' | 'fail' | 'inconclusive'`. Three states, not two — a probe that times out
  is not a failure and must not page anyone.
- `CheckResult { id, status, title, detail: string[], remediation: string[] }`. `id` must be
  **stable and deterministic per subject** (e.g. `mount:/Volumes/foo`), because Phase 2 keys
  transition state on it. An `id` containing a timestamp or array index silently breaks escalation.
- `Check { name, run(): Promise<CheckResult[]> }` — one check may yield many results (one per mount).

**Done when:** types compile, no implementation.

### Task 1.2 — Runner

New `src/doctor/runner.ts`. `runChecks(checks): Promise<CheckResult[]>`.

- Runs each check, catches throws and converts them to `inconclusive` results — one broken check
  must never take down the run.
- No I/O of its own, no formatting, no escalation. Pure orchestration so it stays unit-testable.

**Done when:** a test registers two fake checks, one of which throws, and gets three results back.

### Task 1.3 — Mount probe *(the check that would have caught it)*

New `src/doctor/checks/mounts.ts`.

- Read every group's `additional_mounts` from `container_configs` (`src/db/container-configs.ts`).
- **Dedupe by `hostPath`**, carrying the list of owning groups for the report.
- For each distinct path: `docker run --rm --entrypoint true -v "<hostPath>:/probe:ro" <image>`,
  using `CONTAINER_RUNTIME_BIN` and `readonlyMountArgs` from `src/container-runtime.ts` rather than
  hand-building argv. Use the group's configured image tag so the probe exercises what a real spawn
  would.
- Exit mapping: `0` → pass. `125` → **fail** (daemon refused; never transient). other non-zero →
  fail, but a *distinct* category — that means image/entrypoint is wrong, not the mount.
  timeout → `inconclusive`.
- Hard timeout, and kill the child on expiry. A hung probe must not wedge the sweep.

**Done when:** unit tests cover all four exit mappings against a stubbed spawn.

### Task 1.4 — Report formatter

New `src/doctor/format.ts`, matching fix 01a's block style.

**The one non-obvious requirement:** when a path fails with 125 *and* exists on the host, the output
must say so in as many words —

```
host path EXISTS and is readable — this is a Docker VM share problem
```

Without that line the reader spends the first twenty minutes `ls`-ing a directory that is
demonstrably fine. That is exactly how the 2026-08-12 diagnosis started. This sentence is the
deliverable, not decoration.

**Done when:** a snapshot test asserts the contradiction line appears for exists-but-125, and does
not appear for genuinely-missing.

---

## Phase 2 — escalation *(not gated — this is the actual feature)*

### Task 2.1 — Transition store

New table (migration in `src/db/migrations/`): `health_state (check_id TEXT PRIMARY KEY, status
TEXT, since TEXT, last_notified_at TEXT)`.

Must be **persisted**, not in-memory: a host restart during a failing period must not re-fire the
alert. Timestamps `new Date().toISOString()` — never `datetime('now')`, per CLAUDE.md.

### Task 2.2 — Transition detection

`src/doctor/escalate.ts`. Compare each `CheckResult` to its stored row, emit a transition only on
`pass→fail` or `fail→pass`. **`inconclusive` never triggers a transition** — it holds the previous
state. Otherwise a flaky Docker daemon pages the operator all night.

**Done when:** a test drives pass→fail→fail→fail→pass and asserts exactly two transitions.

### Task 2.3 — Deliver the DM

Use `pickApprover(agentGroupId)` + `pickApprovalDelivery` from
`src/modules/approvals/primitive.ts`. This path exists and is currently unused for host health.

Note the ordering hazard: approvers resolve from `user_roles`, and **an unreachable mount may be
why the delivery container cannot start.** Delivery must not depend on spawning a container. Verify
which adapters can send without one; if none can, that limitation goes in the plan's failure notes
rather than being discovered at 3am.

**Done when:** healthy→failing→healthy produces exactly two DMs (`features.json` `ncl-doctor-2`).

### Task 2.4 — Spawn backoff at the source

`src/container-runner.ts:202` is today a bare `log.warn` with no failure-count state. Add per-group
failure counting and exponential backoff, capped — never permanently disable a group.

This is the half that **stops the bleeding**; Phase 2.3 only **detects**. Neither replaces the
other. 2,193 attempts in 13 hours is the number to beat.

---

## Phase 3 — CLI surface *(GATED on #2504 — see §Gate)*

### Task 3.1 — Register the command

`register()` in `src/cli/registry.ts` is the primitive; `groups restart` in
`src/cli/resources/groups.ts` is the precedent for a non-CRUD operation.

Three things the notes do not mention:

1. **`ncl` grammar is strictly `<resource> <verb>`.** A bare `ncl doctor` breaks it. Either
   `ncl doctor run` or `ncl status --check`. This is itself an argument that the maintainer has an
   opinion worth waiting for.
2. **`hostOnly: true` is required.** The probe makes the host spawn containers; an agent must never
   trigger that, regardless of `cli_scope`.
3. **`register()` demands a guard** — `defineGuardedAction(commandGuardSpec(def))` runs inside
   `register()`, so the command cannot exist without a guard-catalog entry. Check
   `src/guard/conformance.test.ts` passes after adding it.

Use `formatHuman` for the box report; leave `data` as structured JSON.

### Task 3.2 — Exit code

Non-zero when any check fails. Without this the command is a viewer, not a detector, and cannot be
cron'd. Called out explicitly in the #2504 comment.

---

## Phase 4 — cadence *(gated behind Phase 3 landing)*

### Task 4.1 — Sweep integration

`src/host-sweep.ts` runs every 60s. **Do not probe every sweep** — that is 1,440 extra containers a
day for a condition that changes rarely. Run every ~15 minutes, or on demand after a spawn returns
125.

### Task 4.2 — Boot call site

Same function, called after adapter registration in `src/index.ts`. **Warn, never exit non-zero** —
`KeepAlive=true` plus a failing boot assertion is a crash loop, and a half-configured install must
still boot so you can run `ncl` to fix it.

---

## Phase 5 — fix 01's DB checks *(cheap, do last)*

Set arithmetic over the central DB, dropped into the Phase 1 interface:

- `messaging_groups.channel_type` with no registered adapter — needs a `listRegistered()` accessor
  on `src/channels/channel-registry.ts`.
- `messaging_groups` with zero `messaging_group_agents` rows.
- Suppress deliberate cases (`denied_at` set; Signal Note-to-Self `mg-1784412584469-wf3nva` is
  *correctly* unwired and must stay quiet or it becomes the noise this plan exists to prevent).

Deliberately last: these are pure reads that only change when *you* change config, which is the
failure class the existing tooling already half-covers. The mount probe is the one that was
actually invisible.

---

## PR hygiene

This branch is cut from `channels-signal-discord`, which carries the Signal + Discord adapter
installs. A PR from here to `nanocoai/nanoclaw` would drag those in.

**At PR time:** cherry-pick the `src/doctor/` commits onto a branch cut from `upstream/main`. Do not
merge this branch. Exclude `init.sh`, `PROGRESS.md`, `features.json`, `plans/`, and the CLAUDE.md
"Working conventions" section — all fork-local scaffolding.

Prior art already searched: #2504 (`ncl status`, open, now commented), #1792 (stale mount),
#2640 (readonly outbound.db, benign), #2226 (`MissingChannelAdapterError`, merged — reactive, which
is why this exists).

## Acceptance

`features.json`, ids `ncl-doctor-1` … `ncl-doctor-5`. The two that matter most:

- **`ncl-doctor-1`**: a mount that *exists and is readable* but that Docker refuses is reported.
  Reproduce by unplugging and replugging an external drive under a running Docker Desktop. A naive
  existence check misses this, and missing it is the entire reason this plan exists.
- **`ncl-doctor-2`**: healthy→failing→healthy sends exactly two DMs. Not 2,193.
