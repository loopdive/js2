---
id: 7490
title: "`var x = 2; x *= undefined` is claimed, then withdrawn: compound assign RHS has no numeric carrier"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7375, 7144, 7183]
---

# #7490 — `x *= undefined` claims, then withdraws

## Problem

The selector claims `var x = 2; x *= undefined;` and from-ast then refuses it at build time:

```
ir/from-ast: compound assign RHS has no numeric carrier (got dynamic<tag:1>) in <module-init>
```

The unit falls back to legacy through `irPostClaimErrors`. That is the "claim, then withdraw" the IR rules forbid
(refuse at select, never claim and withdraw).

## Measured

Exact repro: the ordinary pipeline (`compile` from `src/index.ts`, not the Prepared entry), a top-level **script**,
not a closure:

```ts
compile("var x = 2; x *= undefined;", {
  target: "standalone", // and target "gc": same result
  trackIrOutcomes: true,
  allowJs: true,
  fileName: "t.js",
  skipSemanticDiagnostics: true,
});
// result.success === true; result.irPostClaimErrors ===
// [{ kind: "build", func: "<module-init>",
//    message: "ir/from-ast: compound assign RHS has no numeric carrier (got dynamic<tag:1>) in <module-init>" }]
```

| tree | standalone | gc |
| --- | --- | --- |
| main `41f0654e8` | post-claim error above | same |
| #7375 head `c2bd96e00` | same | same |

It needs a non-module script, or a function body: `export function f() { var x = 2; x *= undefined; return x; }`
claims and withdraws too (RV7442, standalone and gc). In an ES module's `<module-init>` (`export {}` beside the
statement) and in the #7144 sweep's closure (`subject.f = function (m, k) { … }`) it is refused at select
(`operand-coercion-unsupported`).
Found by RV7427 while reviewing #7375. That PR did not change this case.

## To decide

`undefined` reaches the compound arm boxed (`dynamic<tag:1>`), not as the f64 NaN sentinel that a value `void x`
supplies. One of these should give:

- the selector's `compoundWriteAdmissible` (via the shared admissibility table) refuses an `undefined` right-hand
  side; or
- from-ast reads it as ToNumber(undefined) = NaN, as `relOperandToF64` does for the sentinel.

The second is the behaviour the binary form already has (`n * undefined`). Whichever is chosen, the #7144 sweep should
gain an `undefined` producer so the selector and from-ast are checked to agree.
