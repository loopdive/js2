---
id: 3496
title: "FYI original harness must initialize module fixtures without null global properties"
status: done
sprint: 73
created: 2026-07-20
updated: 2026-07-21
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: test262-conformance
lane: A
related: [3491, 3492, 3493, 3495]
files:
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/index.ts
  - tests/test262-shared.ts
  - tests/issue-3492-test262-fyi-top-level-await-parity.test.ts
  - tests/issue-3496-fyi-original-harness-module-init.test.ts
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/operator-assignment.ts
---

# #3496 — FYI original harness must initialize module fixtures without null global properties

## Problem

After #3493 preserves top-level `globalThis` assignments and #3495 fixes
generic indexed reads from compiler vectors, the project runner passes the
official module graph but the literal FYI harness still fails during module
initialization:

```text
language/module-code/top-level-await/pending-async-dep-from-cycle.js
```

Authoritative Node 25 FYI result:

```text
wasm exception during module init
TypeError: Cannot access property on null or undefined at 4:1
```

The same fixture graph and a reduced `assert.compareArray`-shaped check pass
without the extra original-harness prelude. This isolates a compiler/harness
initialization interaction rather than the graph order or vector contents.

## Evidence (2026-07-20)

- #3493 reduced the original failure from `illegal cast` to a later module-init
  exception by preserving fixture setup and multi-source member dispatch.
- #3495 changes direct exact-string graph scoring from **1/63** to **63/63**.
- The current project standalone runner reaches the official assertion and
  passes **1/1** after #3493/#3495.
- The FYI lane uses test262.fyi's literal assembly: `doneprintHandle.js`,
  requested includes, runtime host shim, `assert.js`, `sta.js`, then the raw
  module test, with fixtures linked separately.
- Removing Wasm start only for diagnosis and invoking the exported initializer
  exposes `TypeError: Cannot access property on null or undefined at 4:1`.
- A reduced graph with the same five log strings and compareArray-shaped reads
  passes, so changing expected strings or async completion would hide the bug.

## Root cause

The literal prelude exposed three independently general multi-source gaps, in
sequence:

1. `var $262 = { global: globalThis }` makes TypeScript's structural
   `typeof globalThis` reachable while compiling the object-literal field. Once
   that structural type had been registered as a Wasm struct, a later
   `globalThis.logs = []` write fell through the generic struct resolver. The
   native standalone global object failed the unrelated struct cast, producing
   null and the reported property-access TypeError. Global-object reads already
   had a dedicated externref path; writes did not consistently mirror it.
2. After preserving the realm write, `assert.compareArray(...)` reached the
   multi-source `__call_m_compareArray_2` closed-method dispatcher. The
   dispatcher was reserved correctly, but `generateMultiModule` omitted the
   established `fillClosedMethodDispatch` finalizer, so its placeholder body
   remained `unreachable`.
3. After the assertion succeeded, `$DONE` reached `console.log`, but
   `generateMultiModule` had not minted the standalone stdout sink before body
   compilation. The project runner's special in-process fixture lane also did
   not copy that sink into its completion-marker buffer, although the unified
   worker and direct original-harness runner already did.

The fixes keep `globalThis` on its intrinsic realm-object representation,
mirror the single-source finalization/pre-body steps in `compileMulti`, and make
the in-process fixture executor consume the same host-free output contract as
the worker. No harness source, fixture source, property name, expected value, or
Test262 path is rewritten or special-cased.

The merge-queue corpus exposed the compound form of the same receiver bug in
`dfs-invariant.js`: `globalThis.test262 += ...` resolved `typeof globalThis` as
a Wasm struct before either dedicated realm-object lowering ran. Compound
property writes now force `globalThis` through the externref read/write path,
matching plain property reads and `=` assignments.

## Acceptance criteria

- Reduce the FYI-only failure to the smallest literal prelude/fixture
  interaction and identify which property receiver becomes null or undefined.
- Preserve the unmodified test262.fyi source assembly and pinned Test262
  fixture sources.
- Correct compiler initialization/representation ordering generally; do not
  special-case Test262 filenames, `logs`, `$DONE`, or expected strings.
- The exact official FYI standalone path reaches `$DONE` and passes under the
  authoritative Node 25 runtime.
- The project runner remains 1/1 on the same path and both runners report
  `reached_test: true`.
- Reduced original-harness, multi-source globalThis, member dispatch, vector
  index, async completion, and standalone import-leak regressions remain green.

## Validation

- Reduced and exact original-harness regression: 9/9 pass in
  `tests/issue-3496-fyi-original-harness-module-init.test.ts`.
- Layered #3492–#3496 plus standalone harness/stdout regressions: 50 pass,
  1 existing todo.
- Authoritative Node 25 FYI standalone lane, freshly rebuilt compiler bundle:
  1/1 pass with `reachedTest: true`.
- Node 25 project standalone runner, official scope and the same exact path:
  1/1 pass with `reached_test: true`.
- The #3492 parity regression now records the honest static-cycle pass while
  retaining #3494's explicit compile refusal for unsupported literal dynamic
  fixture imports.
- Typecheck, Prettier, issue-ID/spec-coverage, and Test262 hard-error gates pass.
  The LOC gate accepts this issue's `assignment.ts` growth and reports only
  integrated-branch overages in untouched `src/compiler.ts` and
  `src/codegen/expressions/calls.ts`.
- The historical 3,472-path comparison sweep remains an integration-level
  follow-up; the targeted exact path and all directly affected regressions are
  green in this worktree.
