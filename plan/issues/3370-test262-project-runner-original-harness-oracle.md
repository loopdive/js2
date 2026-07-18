---
id: 3370
title: "Test262 project runner: make the original harness the verdict oracle"
status: ready
created: 2026-07-17
updated: 2026-07-18
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: test262-runner
goal: test262-conformance
assignee: codex/root
related: [3362, 3369]
files:
  - .github/workflows/refresh-baseline.yml
  - .github/workflows/test262-sharded.yml
  - .github/workflows/ci.yml
  - scripts/check-baseline-trap-growth.ts
  - tests/issue-3303.test.ts
  - tests/test262-original-harness.ts
  - tests/test262-runner.ts
  - tests/test262-shared.ts
  - scripts/test262-worker.mjs
  - scripts/run-test262-fyi.mjs
  - scripts/test262-fyi-reader.mjs
  - tests/test262-oracle-version.ts
  - tests/issue-3370.test.ts
regressions-allow:
  count: 20700
  reason: "#3370 replaces the synthetic Test262 wrapper with the literal upstream harness; latest merge-group measurement: standalone 20561, with 139 tests of bounded merge-window headroom"
trap-growth-allow:
  count: 47
  reason: "#3370 changes the compiled harness workload; measured oracle-v7 to v8 maximum per-category growth is unreachable +47"
---

# #3370 — make the original Test262 harness the project-runner oracle

## Problem

The synthetic `wrapTest()` runner reported 50/50 passes for the deterministic
array sample while test262.fyi's literal upstream harness reported only 25/50.
The wrapper silently changed observable semantics:

- `stripUndefinedThrowGuards()` removed sparse-hole failure checks;
- moving raw script code inside `export function test()` converted top-level
  module-global state into locals, bypassing global representation failures;
- synthetic `assert.throws` and `Test262Error` shims replaced the upstream
  harness's real exception and constructor-identity behavior.

As a result, the project's pass count could describe successful execution of a
rewritten surrogate rather than the upstream test.

## Acceptance criteria

- Assemble project-runner inputs from the runtime shim, upstream harness
  includes, `assert.js`, `sta.js`, and the unmodified test body.
- Do not use `wrapTest()` transformations to decide Test262 pass/fail status.
- Preserve Test262 strict reruns and negative/async verdict semantics.
- Make the canonical local/CI runner and `runTest262File()` use the same literal
  harness contract.
- Add a regression proving a deliberately failing undefined guard cannot be
  erased into a pass.
- The deterministic first 50 array records have identical statuses in the
  project runner and test262.fyi original-harness lane.
- Bump the Test262 oracle version for the intentional honesty reclassification.

## Resolution

- Added one literal-harness assembler shared by `runTest262File()` and the
  sharded CI runner. It preserves upstream source text and Test262's sloppy +
  strict execution variants.
- Kept `wrapTest()` only as the explicitly named
  `runSyntheticTest262File()` diagnostic lane; it no longer contributes
  conformance verdicts.
- Made successful top-level module initialization the positive verdict, with
  async completion/failure markers and phase/type-correct negative handling.
- Tightened both the project and test262.fyi lanes so wrong-phase negative
  failures cannot count as passes.
- Bumped the Test262 oracle from v7 to v8. Landing requires an
  `ORACLE_REBASE=1` baseline refresh.
- Recorded a 20,700-test v7-to-v8 rebaseline ceiling. The latest merge group
  measured 20,561 standalone reclassifications after concurrent main fixes;
  the remaining 139-test margin is bounded merge-window headroom. The
  standalone transition removes the synthetic lane's host-dependent raw
  passes from conformance accounting.
- Recorded a separate 47-test, per-category trap-growth ceiling for this
  oracle bump. It authorizes the measured `unreachable` 8-to-55 transition
  without relaxing the ratchet for same-oracle or later changes.
- Kept two commits in both baseline-writer checkouts so the post-merge push can
  resolve `HEAD^1`, find this issue in the landed change set, and consume the
  scoped trap ceiling exactly once. The first oracle-v8 promotion exposed the
  former depth-1 checkout by seeing an empty issue diff and correctly refusing
  to publish `oob +4` / `unreachable +47` with tolerance zero.
- Reject a merge-group predecessor artifact when its stamped oracle differs
  from the published baseline oracle. This prevents an already-landed v8 group
  artifact from converting the stranded v7-to-v8 recovery into a same-oracle
  flake comparison before the v8 baseline has actually been published; equal
  versions continue to use predecessor isolation normally. The stamp is read
  from the predecessor JSONL itself because the group artifact does not publish
  `test262-report-merged.json`; relying on that nonexistent file left the first
  recovery rerun on the same 84-regression flake comparison.

## Validation

- `pnpm run typecheck`
- `pnpm exec vitest run tests/issue-3370.test.ts tests/test262-fyi-runner.test.ts --reporter=dot`
  — 10/10 passed.
- Deliberately failing undefined guards are failures in both the in-process
  runner and unified CI worker.
- Wrong-phase negative probes fail in both verdict paths.
- `node scripts/run-test262-fyi.mjs --filter language/expressions/array --limit 50`
  — original harness 50/50.
- Unified CI worker on the identical sorted 50-test sample, including strict
  reruns — 50/50.
- `pnpm exec vitest run tests/issue-3303.test.ts --reporter=dot` pins the
  baseline-writer merge-parent checkout contract and the forward-bump-only
  allowance behavior.
