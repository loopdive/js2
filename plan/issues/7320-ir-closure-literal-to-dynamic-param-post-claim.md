---
id: 7320
title: "IR: a closure literal passed to a dynamic parameter of a direct call is claimed, then rejected by from-ast"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7305, 7130, 7195, 7198]
assignee: "ttraenkler/c-lane-opus"
func-budget-allow:
  # 2026-11-07 (#7166 review M1): lowerCall +5. The closure arm of the
  # direct-call argument coercion (`functionObjectDynamicValue`) sits beside
  # `boxConcreteToDynamic` in the one per-argument loop it fixes.
  - src/ir/from-ast.ts::lowerCall
---

# #7320 — closure literal → dynamic parameter: claim-then-refuse

## Problem

Under the member-closure plan regime, a closure literal passed as an argument
to a same-source top-level function is minted a plan. That is #7130's
argument-position site, and it needs standalone/wasi, native-first and the
externref carrier. The selector then claims the caller. from-ast's
direct-call argument check boxes a concrete argument into a dynamic
parameter only through `boxConcreteToDynamic`, which has no arm for a
`closure` value, so the claimed unit is rejected after the claim:

```
ir/from-ast: arg 0 of call to u is closure()->void, expected dynamic in <module-init>
```

This is a post-claim build error (`irPostClaimErrors`): the selector and
from-ast disagree. The unit falls back to legacy at run time, so results
were correct, but the IR invariant is broken.

## Repro

The bug is pre-existing on main. RV7164 confirmed it on dc52abf7, b631a4bc,
63018c49 and 67d7f221. A bare `compile()` shows nothing, because no plan is
minted without the harness options.

```js
/*---
description: x
---*/
var seen; function u(g) { return typeof g; } u(function () { seen = 1; });
```

Compiled the way the test262 runner does on standalone:

```ts
const meta = parseMeta(source);
const variant = assembleOriginalHarness(source, meta).primary;
compile(variant.source, { ...originalHarnessCompileOptions(meta, "standalone"), trackIrOutcomes: true });
```

Result: `u` emitted IR; `irPostClaimErrors` = `[<module-init>: "ir/from-ast: arg 0 of call to u is closure()->void, expected dynamic"]`.

## Fix (on #7166)

In from-ast's direct-call argument coercion, a `closure` argument to a
`dynamic` parameter boxes as a function value through
`functionObjectDynamicValue`, the box `__apply_closure`'s own arguments
already use: a callable pack, then `IR_DYN_CALL_BOX_FN`. Every other argument
kind keeps `boxConcreteToDynamic`.

#7305's widening claims more callees with dynamic parameters, so it would
expose this more often. That is why the fix rides #7166.

## Validation

On the repro and its `'use strict'` / `this`-reading variants, with the fix:

- `irPostClaimErrors` is empty;
- `<module-init>` is IR;
- runtime results match base on standalone and gc, and wasi stdout matches.

#7166's ledger, playground and 652-file test262 A/B include the fix.
