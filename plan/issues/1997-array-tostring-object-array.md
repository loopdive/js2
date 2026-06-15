---
id: 1997
title: "Array.prototype.toString() returns '[object Array]' instead of join() (method call only; String(a) works)"
status: done
completed: 2026-06-15
sprint: 62
created: 2026-06-10
updated: 2026-06-15
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: array-methods
goal: core-semantics
related: [1215]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #1997 — array .toString() falls to generic object-toString dispatch

## Problem

```ts
const a: any[] = [[1,2],[3]];
a.toString()   // wasm: "[object Array]"   node: "1,2,3"
```

Also flat `[1,2,3].toString()`. `String(a)` works; only the method call is
broken. Spec §23.1.3.36: Array toString = join.

## Root cause

`src/codegen/array-methods.ts:2372` — the `ARRAY_METHODS` set has `"join"`
but no `"toString"`, so the call falls to the generic object-toString
dispatch (`src/codegen/index.ts:3770`
`emitDispatchForMethod("toString", "__call_toString")`). Regression /
residual of #1215 (done).

## Fix direction

Add `"toString"` to ARRAY_METHODS, lowering to the join path with the
default separator.

## Acceptance criteria

- Both repros match Node; nested arrays stringify via join recursively

## Dupe check

#1215 (done) registered `number_toString` for array `.toString()`; current
behavior is a residual. New.

---

## Resolution (2026-06-15, dev3)

**Done.** Verified on `origin/main` @ `516feec44`: `"toString"` is already in
`ARRAY_METHODS` (`src/codegen/array-methods.ts`), so `[1,2,3].toString()` →
`"1,2,3"` and the nested `[[1,2],[3]].toString()` → `"1,2,3"` (the host
`__extern_join_str` recurses into nested vecs via `__vec_len`/`__vec_get`) —
**provided the host instantiation calls
`result.importObject.__setExports(instance.exports)`** so the recursion can
reach the exported vec accessors. Without `__setExports` the recursion can't
find the vec accessors and falls back to `"[object Object]"`; that is a
harness requirement, not a compiler bug.

Closed alongside #1998 (same `tests/issue-1997.test.ts` regression gate, which
covers both flat and nested `toString`). The only residual array-stringify bug
found was the `Array(n)` sparse-hole rendering, fixed in #1998.
