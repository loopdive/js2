---
name: project_next_session
description: "Cold-start state for the next session — ≤ES5 goal position, the pull order (#4147 repair FIRST, it gates #4098's stages), held claims, and what to verify before dispatching."
metadata: 
  node_type: memory
  type: project
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-04T03:35:55.517Z
---

## As of 2026-08-04 (window suspended, not frozen)

**Goal** (stakeholder, 2026-08-01): 95.4 % test262 standalone on ES5+untagged,
**ex-dynamic-code**. Position: **6,644 / 8,650 = 76.8 %**, gap ≈ 1,608.
Overall standalone 30,982 / 43,505. Main tip carried #4100 (`instance-tombstones.ts`
verified present).

**Full handoff**: `plan/agent-context/handoff-2026-08-04-es5-gap-window.md`
(PR #4108). Retro: `plan/log/retrospectives/window-2026-08-04-es5-gap.md`.
`freeze-sprint.mjs` deliberately NOT forced — 97 % spent vs its 99 % trigger;
forcing re-tags hundreds of open issues prematurely.

## Pull order

1. **#4147** — `runTest262File` links no `js2wasm:runtime-eval` provider, so the
   entire propertyHelper population is unmeasurable locally and reads as `fail`.
   **Gating**: blocks every #4098 successor stage's local control. Acceptance:
   an unlinkable provider must return `skip`/`error`, NEVER `fail`.
2. **#4098 G1 stages 2–4** (124-file prize). Stage 1 merged (#4100). Read the
   **G1 STAGE 1 addendum** first; stages 3/4 must filter `bag[k] === bag` when
   adding the instance arm to `__carrier_bag_of` or the tombstone marker
   enumerates as a real own property. Order fixed by #4010's ordering law.
3. **#4119** — PR #4109 open and CLEAN at suspend (toString arm). Check whether
   it merged before re-dispatching; its `## Suspended Work` has the resume point.
4. **#3661** (G2, re-measure first) and the **G5** bundle (#4095/#4131/#4116).

## Held claims — resume or release deliberately

`ttraenkler/dev-4098-g1` on #4098 · `ttraenkler/dev-4119-g4` on #4119. Both
agents are gone; the claims mark the work resumable, not owned.

## Unclaimed, dispatchable

#4143 (define-over-inherited silent no-op, 14 files) · #4146 (host `Object.create`
applier gap + mirror standalone gap) · #4147 · #4148 · #4151 · two gaps recorded
but unfiled in #4098's file (`in` vs `hasOwnProperty` disagreement; `static`
field under a dynamic key).

## Verify before trusting anything

- PR merges **by content** on `upstream/main`, never by PR field.
- `origin` is the FORK. Agent worktrees seed from the **fork tip** — check
  `git merge-base --is-ancestor HEAD upstream/main` before branching.
- Never `--no-verify` a commit; use `SKIP_SLOW_PRECOMMIT=1` (landed in #4102).

Related: [[reference_prettier_check_on_ignored_path_checks_zero_files]],
[[reference_origin_is_the_fork_verify_against_upstream_main]],
[[es5-standalone-goal-ex-dynamic-code]].
