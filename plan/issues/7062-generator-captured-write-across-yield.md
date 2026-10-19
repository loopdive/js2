---
id: 7062
title: "codegen: a closure whose captured variable is moved into its ref cell AFTER a `yield` (native generators) reads a stale value or emits invalid Wasm (`struct.set expected (ref null N), found f64`) — generator spill planning fixes the saved slots before the lazy capture boxing runs (#6991/#6993 generator variants)"
status: ready
sprint: current
created: 2026-10-18
updated: 2026-10-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: generators, closures, capture-boxing
goal: standalone-gap
related: [6991, 6993, 6960, 3050]
---
# Boxed capture across `yield` in native generators

Left out of PRs #6697 (#6991) and #6696 (#6993) because it is a separate root cause from the loop/try pre-box fixes.

## Repro (node → wasm, standalone and gc)

```js
function* g(){ var k = 7; var f = function(){ return k; }; yield 1; k = 8; console.log(f()); }   // node 8, wasm 7
function* gen(){ for (let i = 0; i < 3; i++) yield () => i; }   // compile failure: __gen_resume_gen: struct.set[1] expected (ref null N), found local.get f64
```

## Root cause (traced, not yet fixed)

`src/codegen/generators-native.ts` spill planning (~:3033) decides which locals are saved across a suspension before the lazy capture boxing in `src/codegen/closures.ts:1012-1025` promotes the captured local to a ref cell. The closure holds the pre-spill cell (or raw copy) while the resume frame restores the raw slot; with per-iteration `let` the resumed slot has a different Wasm type than the cell's field.

## Implementation Plan

1. Pre-box captured bindings for the whole generator body BEFORE spill planning, the same way #6696/#6697 pre-box for `try` and loops (`collectNamesCapturedByClosures` + the shared write predicate in `src/shared/binding-writes.ts`): any binding captured by a closure constructed anywhere in a generator body and written anywhere in it gets its cell at function entry; the spill plan then saves the cell reference (a single ref slot) instead of the raw value.
2. The #1453 per-iteration `let` re-aim in `statements/loops.ts` must see the generator frame's slot representation; add a test that the `for (let i…) yield () => i` shape produces valid Wasm and yields closures returning 0, 1, 2.
3. Tests: both repros on both lanes in `tests/equivalence/issue-7062-generator-captured-write.test.ts`, plus `yield` inside `try/finally` with a closure built before the yield and the variable written after.

## Acceptance
- Both repros match node; no invalid-Wasm emission for the `let` shape; existing `*generator*` equivalence files pass.


> Filed from the 2026-10-15 compiler audit follow-ups (surfaced by the #6991–#7001 implementation PRs). Under `plan/method/ir-only-development-freeze.md` a direct-AST semantic fix needs a specific user disposition; IR/shared-runtime work does not.
