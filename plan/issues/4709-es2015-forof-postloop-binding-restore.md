---
id: 4709
title: "ES2015 for-of restores the outer lexical head binding after the loop"
status: in-progress
sprint: current
created: 2026-08-25
updated: 2026-08-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: for-of
es_edition: 2015
goal: es6
related: [4706]
loc-budget-max: 180
loc-budget-allow:
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForOfArray
---

# #4709 — ES2015 for-of post-loop lexical binding restoration

## Scope

This issue is the bounded follow-up split from blocked #4706. It owns only
restoring the outer lexical head binding after a synchronous `for (let ... of
...)` loop completes. The exact Test262 target is:

- `language/statements/for-of/scope-body-lex-close.js`.

The direct simple outer-binding restoration control is part of the acceptance
cohort. The implementation must remain within 180 changed source lines.

This issue explicitly excludes `scope-body-lex-open.js` (destructuring-head
TDZ), #4700 head TDZ behavior, #4702 fresh-binding behavior, async for-of,
Set/Map iteration, and IteratorClose semantics.

## Baseline and #4706 evidence

Blocked #4706 measured the exact close row on upstream/main and recorded that
the declaration and body closures both capture the iteration value
`"inside"`, while the outer `x` remains incorrectly bound to the iteration
value after the loop. Its direct simple control likewise captured `1` in the
body closure but left the outer `x` as `1`. The boundary control
`scope-body-lex-boundary.js` and non-lexical control
`scope-body-var-none.js` passed, showing that per-iteration capture and the
non-lexical path must remain unchanged.

The close-row shape is therefore a post-loop environment leak, not a body or
declaration closure-capture failure. The open row remains outside this slice:
its closure is created while evaluating a destructuring right-hand side and
requires the separate destructuring-head TDZ work owned by #4700/#4706.

Baseline to preserve before source edits:

```text
scope-body-lex-close.js:   fail — declaration/body see inside; outer x is inside
scope-body-lex-boundary.js: pass — first/second closures retain distinct values
scope-body-var-none.js:     pass — var body control remains correct
direct simple control:      fail — body closure sees 1; outer x remains 1
```

## Plan

1. Reproduce the exact close row and direct simple control on the current
   upstream/main baseline.
2. Trace the synchronous for-of lowering's lexical-environment setup and
   cleanup. Identify the narrowest saved environment/head-binding metadata
   that is overwritten for the loop and is not restored after completion.
3. Restore that metadata on every normal loop exit without changing
   per-iteration environment creation, closure capture, destructuring-head
   TDZ, or iterator-close behavior.
4. Add a focused regression test for the direct simple outer-binding control
   and run the exact row plus the two passing controls.

## Acceptance

- `scope-body-lex-close.js` passes through the original Test262 harness.
- The direct simple control observes the body iteration value but the outer
  lexical binding returns its pre-loop value after completion.
- `scope-body-lex-boundary.js` and `scope-body-var-none.js` remain passing.
- No excluded row is claimed as fixed, and changed compiler source stays at or
  below the 180-line budget.
- Record exact commands and before/after results in `## Test Results`.

## Test Results

Baseline (no source edits) was re-run on upstream/main
`d455e14cc37583221a682810123f7878f5185f8f` with the linked Test262 checkout at
`b363f29d3c43c626dc852744ad64a0b48a003693`:

```text
node --import tsx ... runTest262File(path, "language", 30000)

scope-body-lex-close.js:    fail — declaration/body closure sees inside;
                            post-loop outer x remains inside
scope-body-lex-boundary.js: pass — first/second closures retain distinct values
scope-body-var-none.js:     pass — non-lexical body control remains correct
direct simple control:      fail — body closure sees 1; outer x remains 1
```

The direct control source is:

```ts
export function test(): number {
  let x = 0;
  let probe = () => 0;
  for (let x of [1]) probe = () => x;
  return probe() * 10 + x;
}
```

Its baseline result is `11`; acceptance requires `10` (`probe() === 1` and
the outer `x === 0`).

Post-fix results on this worktree:

```text
node --import tsx ... runTest262File(path, "language", 30000)

scope-body-lex-close.js:    pass — wasm SHA a7917c32f131
scope-body-lex-boundary.js: pass — wasm SHA 4f6915c9591d
scope-body-var-none.js:     pass — wasm SHA 3d7b7ac1c4c3
decl-let.js:                pass
decl-const.js:              pass

vitest run tests/issue-4709.test.ts --pool=forks \
  --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
3/3 tests passed (exact row, direct simple control, and two controls).
```

The focused regression test's standalone direct control returns `10` after
the fix. `node_modules/.bin/tsc --noEmit --types node --pretty false` also
passes, and Prettier reports all three changed files formatted. Changed
compiler source is 59 added lines, below the 180-line limit.

After merging upstream/main at `21c94b707` (merge commit
`9dfe9b256`), the same focused Vitest file passed 3/3, the five-row Test262
set above passed 5/5, TypeScript type-checking passed, and targeted Biome
lint passed.
