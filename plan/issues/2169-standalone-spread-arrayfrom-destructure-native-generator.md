---
id: 2169
title: "standalone: spread / Array.from / array-destructure don't drive a native generator (treat the state struct as a __vec)"
status: in-progress
sprint: 63
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: iterators-generators
goal: standalone-mode
parent: 2157
depends_on: [2079]
---

# #2169 — native-generator consumers (SF-2 of #2157)

## Problem

A top-level `function*` lowers (since #2079) to a native state struct
(`$__gen_state_*`) consumed correctly by `for-of` via
`tryCompileNativeGeneratorForOf`. But three OTHER consumers don't recognize the
state struct as an iterator — they treat it as a `__vec`:

```ts
function* g(){ yield 1; yield 2; yield 3; }
[...g()]            // standalone: wrong-length array of NaN (exp [1,2,3])
Array.from(g())     // standalone: env-import leak + zero-import instantiate fail
const [a,b]=g();    // standalone: env-import leak (exp a=1,b=2)
```

## Root cause

The spread / `Array.from` / array-destructuring lowerings read
`struct.get <gen> 0` expecting a `$length` field, but field 0 of the generator
state struct is `state`. They build a garbage-length array of defaults and
never call `next()`.

## Fix direction

At each consumer, detect the native-generator subject
(`nativeGeneratorInfoForForOfSubject` / the `$__gen_state_*` type family) and
drive it with the same `next()`-until-`done` loop `tryCompileNativeGeneratorForOf`
already emits, collecting `value`s into the target array / binding list. Reuse,
don't duplicate, the driver.

## Acceptance criteria

- The three repros in `tests/issue-2157-*.test.ts` (SF-2 `it.todo`s) pass,
  zero host imports.
- `for-of` / array / string spread regression guards stay green.

## Source

Triage of #2157 (2026-06-15, sdev5), SF-2.

## Resolution (2026-06-15, sdev5) — array spread landed; Array.from/destructure carried forward

Landed the **array-spread** consumer (`[...g()]`). Added a reusable
`emitNativeGeneratorToVec(ctx, fctx, info, subjectType, vecTypeIdx, arrTypeIdx)`
in `generators-native.ts`: it drains the native generator via the same
`resume()`-until-`done` loop the for-of driver uses, accumulating yields into a
growable f64 backing array, and leaves a freshly-built `ref $vec_f64` on the
stack. The array-literal spread site (`literals.ts compileArrayLiteral`) now
detects a native-generator subject via `nativeGeneratorInfoForForOfSubject` and
materializes through that helper, then reuses the existing materialized-vec
spread machinery (same shape as the externref `buildVecFromExternref` path).

Verified standalone, zero host imports: `[...g()]` length/values, >4-yield grow
path, control-flow generators, mixed `[head, ...g()]`; array/string spread
regressions unchanged. Test: `tests/issue-2169-spread-native-generator.test.ts`
+ the SF-2 spread gate in `tests/issue-2157-*.test.ts` (un-todo'd).

**Carried forward (still on this issue):** `Array.from(g())` and
array-destructuring `[a,b]=g()` are separate consumer call sites
(`destructuring-params.ts` and the Array.from builtin) — the
`emitNativeGeneratorToVec` helper is ready to wire into both, but they're a
distinct, independently-testable change left as a follow-up to keep this PR
focused. Their `it.todo` gates in `tests/issue-2157-*.test.ts` stay todo.
Status kept `in-progress` until those two land.
