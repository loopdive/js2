---
id: 6680
title: "standalone: lodash `pullAt`/`remove` pass one value too many to `basePullAt` (`local.tee` + re-read in the number[] argument coercion)"
status: done
completed: 2026-09-26
sprint: Backlog
created: 2026-09-24
updated: 2026-09-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [6673, 6679]
---

# #6680 — extra stack value before a direct call to a capturing declaration

## Problem

Observed on lodash 4.18.1's standalone-dynamic compile once
[#6673](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6673-standalone-lodash-closure-capture-stack-balance)
and the (prototyped)
[#6679](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6679-return-call-arg-null-retype-across-global-set)
fix are applied. V8:

```
Compiling function #1542:"__closure_275" failed: call[0] expected type externref, found global.get of type f64
```

`wasm-opt --all-features` reports `call param types must match` on calls to
`$basePullAt` in `__closure_275`, `__closure_882` and `__closure_996`
(`pullAt`, `remove`, …). The 21 capture args are emitted correctly (checked
against `nestedFuncCaptures`), but the second user argument
(`arrayMap(indexes, …).sort(compareAscending)`, coerced to the callee's
`number[]` param `(ref null $vec_f64)`) is emitted as

```
… local.tee 34
local.get 34
ref.is_null
(if … throw)
local.get 34 ref.as_non_null … struct.new $vec_f64
call $basePullAt
```

— the `local.tee` leaves one extra value, so every argument shifts by one.
Not yet reduced; start from `pullAt`'s
`basePullAt(array, arrayMap(indexes, fn).sort(compareAscending))` with a
capturing `basePullAt(array, indexes)` whose `indexes` is inferred `number[]`.

## Acceptance criteria

- A reduced fixture compiles to valid Wasm in both lanes and runs like Node.
- lodash's standalone-dynamic lane moves past the `basePullAt` call mismatch.

## Implementation Plan

Executed 2026-09-26 under [#6703](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6703-lodash-standalone-optimization-error-invalid-raw-module).

Root cause is not the `number[]` argument coercion: `arrayMap(…)` returns an
externref-element vec, the comparator `compareAscending` is not a compilable
closure there, and native strings make the default ToString sort bail — so
`compileArraySort` takes its #2502 no-op arm, which `local.tee`d the receiver
into `__arr_sort_noop_N`, ran the null guard, then `local.get`s it again.
Nothing consumed the tee'd copy (the Timsort arm tees into its helper call).
Fix: `local.set` in the no-op arm (`src/codegen/array-methods.ts`).

## Resolution

- `tests/issue-6703-lodash-raw-module-validity.test.ts`
  (`pick(1, xs.map(x => x).sort(cmp))`, `pick` not inlined): invalid on
  parent (`call[0] expected type f64, found local.tee of type (ref null 2)`),
  valid with the fix.
- The 18 `call param types must match` errors on `$basePullAt`
  (`__closure_268/875/989`) are gone; lodash's raw module validates.
- Residual (unchanged behaviour): the no-op arm does not sort; a comparator
  over externref elements that is not a compilable closure is still ignored
  in standalone.
