---
id: 1966
title: "arr.unshift(...) is a silent no-op returning 0 — missing from ARRAY_METHODS, falls into garbage generic fallback"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-methods
goal: builtin-methods
related: [1377, 1234, 1461, 1608]
origin: "2026-06-10 deep-audit sweep (objects agent): verified miscompile on main, WAT-proofed"
---

# #1966 — `unshift` was never implemented for WasmGC arrays

## Problem

`a.unshift(0)` compiles cleanly, mutates nothing, and returns `0`. The string
`"unshift"` appears nowhere in `src/` — the call falls into the generic
method-call fallthrough that drops the receiver and args and unboxes null.

## Repro (verified on main)

```ts
export function test(): string {
  const a=[1,2]; const r=a.unshift(0); return r + "|" + a.join(",");
}
```

wasm: `0|1,2` — node: `3|0,1,2`.

WAT: property-get of `"unshift"` → `drop`; evaluate arg → `drop`;
`ref.null extern` → unbox-call → `0`.

## Root cause

`src/codegen/array-methods.ts:2372-2413` — `ARRAY_METHODS` contains every
other mutator (`push/pop/shift/splice/fill/copyWithin/with/toSpliced...`) but
not `"unshift"`. `compileArrayMethodCall` returns `undefined` (line 2434) and
the generic fallthrough in `src/codegen/expressions/calls.ts` (after 6702)
emits get-prop/drop/unbox(null) instead of failing loudly.

## Fix direction

Add `"unshift"` + `compileArrayUnshift` (mirror of `compileArrayPush` with an
`array.copy` shift, return new length). **Independently: make the
unknown-array-method fallthrough a compile error** or route it through the
working `__extern_method_call` bridge — that converts this whole silent-garbage
class (see also #1967) into diagnostics.

## Acceptance criteria

- Repro matches Node (`3|0,1,2`)
- Multi-arg `unshift(x, y)` order correct; growth/realloc path covered
- Unknown array methods produce a compile-time diagnostic

## Dupe check

#1377/#1234/#1461 (done) cover `Array.prototype.unshift.call(arrayLike)`
generic-receiver semantics, not direct `arr.unshift`; #1608 is a `set` typeidx
crash. Unfiled.

## Addendum (2026-06-11 standalone audit, fable agent) — root cause located

Verified standalone too, with array corruption: `a=[2,3]; a.unshift(1);
a.shift()` leaves the array as `[3,3]`. Root cause:
`src/codegen/array-methods.ts:2539` — the `MUTATING` write-back set
(`push,pop,shift,reverse,splice,fill,copyWithin,sort,set`) is missing
`"unshift"`, so the mutated vec is never written back to the receiver.
One-line fix candidate + write-back audit for other missing members.
