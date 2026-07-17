---
id: 3361
title: "standalone Array.prototype.filter over an array-like $Object drops the thisArg argument (predicate reads this === undefined)"
status: ready
sprint: current
created: 2026-07-17
priority: low
horizon: s
feasibility: medium
model: opus
task_type: bug
area: codegen
language_feature: standalone-completeness, array-filter, this-binding
goal: standalone-parity
related: [2036, 3169, 3326]
origin: "found during #3326 (updating stale #2036 refuse-loudly expectations, 2026-07-17) — the filter cases graduated to a native standalone arm, but the 3rd-argument thisArg is not threaded into the predicate."
---

# #3361 — standalone `filter` over an array-like `$Object` drops `thisArg`

## Problem (measured, current main)

```ts
export function test(): number {
  const o: any = { 0: 5, 1: 15, length: 2 };
  const r: any = Array.prototype.filter.call(
    o,
    function (this: any, x: number) {
      return x > this.t;
    },
    { t: 10 }, // thisArg
  );
  return r.length; // JS: 1 (only 15 > 10); compiled standalone: 0
}
```

Compiles and runs host-free (the native `$ObjVec` filter arm from #2036 S6
step 2 / #3169), but the **3rd `thisArg` argument is not bound** into the
predicate — `this.t` reads `undefined`, so `x > undefined` is `false` for every
element and the result is empty (`length 0` instead of `1`).

The single-argument filter path is correct: length, element order/values, and
sparse-hole skipping over the same array-like `$Object` receiver all pass
(`tests/issue-2036.test.ts`). Only `thisArg` threading is missing.

## Scope

- Thread the `filter` call's 3rd argument as the callback receiver in the native
  array-like-`$Object` filter arm (`src/codegen/array-methods.ts`), matching the
  behaviour the callback methods (forEach/some/every) already have or should
  have for the borrowed-receiver path.
- Confirm the sibling result-builders that also accept a `thisArg`
  (`map`, and forEach/some/every/find/findIndex) thread it correctly over an
  array-like `$Object` receiver in standalone; extend if they share the gap.

## Test

`tests/issue-2036.test.ts` already contains the failing case, marked `it.fails`
with a `#3361` reference ("filter threads thisArg standalone"). When the fix
lands, remove the `.fails` so the test asserts `length === 1` normally.

## Acceptance

- `Array.prototype.filter.call({0:5,1:15,length:2}, fn, {t:10}).length === 1`
  in `--target standalone`, host-free.
- No regression in the other #2036 array-like `$Object` cases.
