---
id: 1136
title: "Array.prototype.flat() and flatMap() not implemented"
status: done
created: 2026-04-20
updated: 2026-04-28
completed: 2026-04-28
priority: medium
feasibility: medium
reasoning_effort: medium
goal: platform
sprint: 42
---
## Problem

`Array.prototype.flat()` (ES2019) and `flatMap()` are not implemented. Programs using lodash or standard array operations that rely on these methods fail at runtime.

## Acceptance Criteria

- [x] `Array.prototype.flat(depth?)` flattens nested arrays up to `depth` levels
- [x] `Array.prototype.flatMap(fn)` maps then flattens one level
- [x] test262 tests pass for both methods

## Implementation

Implemented via host imports (`__array_flat`, `__array_flatMap`) in runtime.ts with a `_toJsArray` helper to convert WasmGC vec structs to plain JS arrays.

Merged via PR #190 (branch `issue-1136-array-flat`).

## Addendum (dev-iter, 2026-06-05) — findLast/findLastIndex were the real gap

Cluster-5 re-recon: `flat`/`flatMap` ARE wired (host imports `__array_flat`/
`__array_flatMap` in runtime.ts) and pass in the real test262 host harness — an
isolated probe that under-provisions those imports falsely shows "flat is not a
function", but the production runtime provides them. So `flat`/`flatMap` are NOT
broken.

What WAS missing: `Array.prototype.findLast` / `findLastIndex` — entirely absent
from the array-method dispatch in `array-methods.ts` (not in `ARRAY_METHODS`,
no compile case), even though the runtime callback-arity table at
`runtime.ts:1570-1571` already listed them. `arr.findLast(cb)` therefore fell
through to a non-native path and produced wrong results.

Fixed in PR #1239: native `compileArrayFindLast`/`compileArrayFindLastIndex`
(reverse-iteration mirrors of find/findIndex, §23.1.3.12/.13) + dispatch wiring.
Tests in `tests/issue-1136-findlast.test.ts`.

Note: `tests/functional-array-methods.test.ts` is broken on main (stale env
harness — missing `string_constants` import + no `skipSemanticDiagnostics`;
23/24 fail independent of this change). Separate follow-up: default
`[10,2,1].sort()` sorts numerically, not lexicographically — #1816 fixed the
comparator path but the default-ToString-compare residual remains.
