---
id: 6617
title: "`Object.getPrototypeOf(<instance of a compiled class>)` answered null through every dynamic path, and had no hop across the standalone link"
status: in-progress
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/senior-dev-s30
loc-budget-allow:
  # 2026-09-15 — inherited from #6612–#6616 (the S25–S29 stack this branch is
  # based on), restated here because the LOC gate reads the allowance from a
  # file the PR touches and those issue files are not in this slice's diff.
  # `src/runtime.ts` sits at 19,822 against a 19,601 ceiling on the stack tip;
  # this slice adds nothing to it.
  - src/runtime.ts
func-budget-allow:
  # 2026-09-15 — same inheritance: `buildImports` is 308 against a 300 ceiling
  # on the stack tip. Untouched by this slice.
  - buildImports
---

# #6617 — the prototype link of a compiled class instance, dynamically and across the link

## Problem

Under `--target standalone`, `Object.getPrototypeOf(x)` answers the right object
only when the CHECKER can name `x`'s class. Every other path answered `null`:

```js
class C { constructor(y) { this.y = y; } }
const NS = { C };
Object.getPrototypeOf(new C(1)) === C.prototype;   // true  — the static fold
Object.getPrototypeOf(NS.C ? new C(1) : null);     // null  ← the gap, ONE module
```

and across the #2527 linked-provider seam, where by construction no value has a
checker type:

```js
Object.getPrototypeOf(new NS.PD(1));                    // null
Object.getPrototypeOf(new NS.PD(1)) === NS.PD.prototype // false
```

The generic native `__getPrototypeOf` walks `$Object.$proto`. A compiled class
instance is a closed `$ClassName` struct with no `$proto` field at all, so every
arm missed. The host lane answers the same question through
`__class_instance_proto` (#5347), which explicitly declines the standalone lane.

Behind it: test262's 45 `built-ins/Temporal/**/subclassing-ignored.js` files,
whose helper asserts
`assert.sameValue(Object.getPrototypeOf(result), construct.prototype)`.

## Fix

1. `src/codegen/standalone-class-instance-proto.ts` (new) —
   `__std_class_instance_proto`, a `ref.test` + `__tag` + `ref.eq` cascade over
   the module's own classes, most-derived first, declining the class-OBJECT
   singleton and materialising the prototype through `__class_proto_build_<C>`.
   Prepended as an arm of `__getPrototypeOf`; disjoint from #802's marked-root
   arm by construction.
2. `standalone-link-boundary.ts` — a new terminal
   `__js2wasm_link_get_prototype_of`, wrapping that dispatcher (NOT
   `__getPrototypeOf`: see the code comment — the wider wrapper would publish
   the provider's `%Object.prototype%`, a foreign intrinsic).
3. `object-runtime.ts` / `object-runtime-prototype.ts` — the consumer's
   `__getPrototypeOf` miss arm calls the peer terminal, through the same
   one-arm-serves-both-lanes shape `__extern_has` already uses.
4. `expressions/call-builtin-static.ts` — the generic `Object.getPrototypeOf`
   site raises the per-class prototype demand, the arming twin of #6457's.

## Acceptance criteria

- `Object.getPrototypeOf(<instance>)` through a dynamic value answers the
  class's prototype singleton, by `ref.eq` identity with `C.prototype`, in one
  module and across the link.
- A class OBJECT and a prototype singleton are still declined (no
  `getPrototypeOf(p) === p` chain hang).
- 0 legitimate pass→fail on the four Temporal families and the must-not-move
  corpus.
