---
id: 4286
title: "codegen: Hono emits a closure result with the wrong concrete ref type"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: closures, classes
goal: dogfood
related: [1244, 3993]
assignee: "ttraenkler/npm-compat-goal"
loc-budget-allow:
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/literals.ts::compileArrayLiteral
---

# codegen: Hono emits a closure result with the wrong concrete ref type

## Problem

After #3993 removes the inherited-class callable abort, the pinned Hono 4.12.16
entry compiles in about 5.9 s to a 360,309-byte module but fails Wasm validation:

```text
WebAssembly.Module(): Compiling function #519:"__closure_156" failed:
type error in fallthru[0] (expected (ref null 2), got (ref 300))
```

The mismatch is a compiler-emitted closure result ABI defect, not a Hono source
diagnostic. Identify `__closure_156`'s exact source unit, compare the inferred
result contract with the body fallthrough value, and correct the generic
closure/result representation path without package-name special casing.

## Acceptance criteria

- [x] A reduced regression fails validation before the fix and runs with its
      native JavaScript result afterward.
- [x] `node --import tsx tests/dogfood/npm-compat-catalog-harness.mjs --package hono --json`
      emits a valid module or advances to a separately documented runtime blocker.
- [x] Existing closure-result and adjacent spread suites remain green.

## Result

The opaque function is Hono's callback at
`router/reg-exp-router/router.js:31`:

```js
(route) => [!/\*|\/:/.test(route[0]), ...route]
```

Published JavaScript leaves `route` as `any`. Array-literal carrier selection
ignored spread operands, selected `__vec_i32` from the leading boolean, and
then materialized every dynamic spread value into that numeric carrier. The
closure signature correctly promised `__vec_externref` for its inferred
`any[]` result, so the body both lost JS value tags and returned an unrelated
Wasm ref type.

Dynamic and callable spread operands now participate in the existing
array-literal dynamic-element proof. The literal therefore uses the universal
externref carrier and boxes each fixed or spread element according to its JS
type. A reduced JavaScript `Array.prototype.map` regression fails validation
before the change (`__closure_0`, expected ref 2, got ref 18) and returns `42`
afterward while checking the boolean, string, and number values independently.

The unchanged pinned Hono 4.12.16 entry now compiles in 3,504 ms to a
360,211-byte module and passes `WebAssembly.Module` validation. The focused
regression plus 20 adjacent array/spread tests pass, and repository typecheck is
green. Hono still needs a package runtime differential before correctness can
be claimed; the catalog truthfully reports that axis as unverified.
