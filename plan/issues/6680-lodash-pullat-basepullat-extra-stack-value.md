---
id: 6680
title: "standalone: lodash `pullAt`/`remove` pass one value too many to `basePullAt` (`local.tee` + re-read in the number[] argument coercion)"
status: ready
sprint: Backlog
created: 2026-09-24
updated: 2026-09-24
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
