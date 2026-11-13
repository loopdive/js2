---
id: 7064
title: "codegen: `for` loops still do not pre-box a captured NON-NULL `ref` slot (objects on both lanes, strings on standalone), so a closure built in a `for` body that captures an object/string variable written in the loop keeps a stale copy — measured: dropping the `ref` exclusion in `preBoxLoopCapturedBindings` fixes the remaining object/standalone-string post-loop cases (#6991 leftover)"
status: ready
sprint: current
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: closures, loops, capture-boxing
goal: standalone-gap
related: [6991, 6960]
---
# `for` pre-box excludes non-null `ref` slots

Left out of PR #6697 (#6991) on purpose (the plan said not to widen the type filter); the implementer measured that dropping the exclusion fixes the remaining cases.

## Repro (node → wasm)

```ts
export function test(): string { let s = "a"; const fs: (() => string)[] = []; for (let i = 0; i < 2; i++) fs.push(() => s); s = "z"; return fs[0](); }   // node "z", standalone "a"
export function test2(): number { let o = { v: 1 }; const fs: (() => number)[] = []; for (let i = 0; i < 2; i++) fs.push(() => o.v); o = { v: 9 }; return fs[0](); }   // node 9, wasm 1 (both lanes)
```

## Implementation Plan

1. `src/codegen/statements/loops.ts` `preBoxLoopCapturedBindings` type filter (~:350-358): admit `ref` the same way the #6960 `writeGated` paths already do (`getOrRegisterRefCellType(ctx, type)` works for any ValType). Keep the write-gating: only bindings written in the loop or after it by a closure get a cell.
2. Verify the generator variant (#7062) is not made worse: run `*generator*` equivalence files.
3. Tests: both repros, both lanes, in `tests/equivalence/issue-7064-for-prebox-ref-slot.test.ts`; also the `for (a of …)` head-capture case from #6697's notes (`node 33, wasm 13`) — if it falls out of the same change, pin it; otherwise record it here as still open.


> Filed from the 2026-10-15 compiler audit follow-ups (surfaced by the #6991–#7001 implementation PRs). Under `plan/method/ir-only-development-freeze.md` a direct-AST semantic fix needs a specific user disposition; IR/shared-runtime work does not.
