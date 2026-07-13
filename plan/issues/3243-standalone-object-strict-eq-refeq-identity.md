---
id: 3243
title: "standalone: native object === identity — extend #2734 ref.eq fast path to inline strict-eq (retire tag-5 string-content fold for objects)"
status: done
completed: 2026-07-13
sprint: current
priority: high
feasibility: hard
reasoning_effort: max
task_type: substrate
area: codegen
language_feature: strict-equality, object-identity, tag-5-classifier, standalone
goal: host-independence
umbrella: 1781
assignee: ttraenkler/opus-genproto3
related: [2734, 2583, 2040, 2580, 3236]
origin: "2026-07-13 #3236 Slice 2 root-cause: native object `===` folds to tag-5 string-content compare, layout-fragile; discovered while wiring generator instance prototype identity."
---

# #3243 — native object `===` identity in standalone (ref.eq fast path for inline strict-eq)

## Problem

In standalone/WASI, `===`/`!==` between two native `$Object` externrefs is
UNRELIABLE. `emitAnyEqOperands` (coercion-engine.ts) marshals each externref
operand through `__any_from_extern`, whose non-honest default folds an object
externref into the **tag-5 (string) fallback**. `__any_strict_eq` then compares
the two objects by string CONTENT — a layout-dependent result.

Demonstrated (standalone, compile+instantiate+run):

```
function* g() {}
function f() {}
// same comparison, two module layouts:
rel():          getPrototypeOf(getPrototypeOf(g)) === getPrototypeOf(f)   // → 1
relWithNoise(): const x = getPrototypeOf(g());                            //
                getPrototypeOf(getPrototypeOf(g)) === getPrototypeOf(f)   // → 0  (!!)
```

The SAME comparison flips 1→0 merely because an unrelated `getPrototypeOf(g())`
precedes it. Consequence: #3236 Slice 1's `host_free_pass` flips
(prototype-relation-to-function.js, the GeneratorPrototype descriptor/this-val
tests) pass only **coincidentally** by code shape and are latently fragile;
#3236 Slice 2 (default-proto.js) cannot pass at all.

## Root cause

`__extern_strict_eq` (#2734, used by Array indexOf/includes) already prepends a
`ref.eq` reference-identity fast path (internalize both externrefs; identical
`eq` ref → 1) before the `__any_from_extern` + `__any_strict_eq` fallback. But
the **inline** `emitStrictEq` path (`===`/`!==` in source) routes through
`emitAnyEqOperands` → `__any_strict_eq` DIRECTLY and never gets that fast path,
so object identity is lost to the tag-5 fold.

This is the tag-5 field-4 object-identity family: #2734 (native ref.eq
identity), #2583 (any-strict-eq tag-5 host-only), #2040/#2580 (tag-5 3-way
classifier).

## Fix

Extend #2734's `ref.eq` identity fast path to inline `emitStrictEq`, **scoped to
object/`any` operands only** via `isReferenceLikeEqOperand`:

- When `helperName === "__any_strict_eq"`, `ctx.standalone || ctx.wasi`, and BOTH
  operand static types are reference-like (`Any`/`Unknown`/`Object`, or a union
  whose every constituent is) — compile both operands to `externref` and call
  `__extern_strict_eq` (the ref.eq-guarded helper).
- number/boolean/bigint/symbol/**string** operands are excluded → they keep
  their exact existing tag-3/tag-4/tag-5 path (byte-identical, verified).
- Host lane emits nothing new (gated) → #1917 both-lane neutrality preserved.

`__extern_strict_eq` never false-positives a primitive: distinct number/string
boxes are distinct refs (ref.eq fails → value comparison); only a genuinely
identical reference short-circuits.

## Acceptance

- Object `===` returns identity-correct results REGARDLESS of module layout
  (default-proto.js + prototype-relation-to-function.js stable).
- Primitive `===` (number/float/NaN/string/bool/null/undefined/mixed/±0) emit
  **byte-identical** wasm vs. baseline (verified: SHA `602540fb…`, both lanes).
- JS-host lane byte-identical.
- NET ≥ 0 on the merge_group standalone floor.

## Implementation Notes (opus-genproto3)

Landed together with #3236 Slice 2 (the generator-instance `getPrototypeOf`
branch): Slice 2's instance wiring is necessary but banks no flip without this;
this substrate fix is the enabler and additionally hardens the whole #3236
Slice-1 cluster against layout drift.

Files:
- `src/codegen/coercion-engine.ts` — `isReferenceLikeEqOperand` gate +
  `__extern_strict_eq` reroute in `emitAnyEquality` (strict-eq only).
- `src/codegen/expressions/calls.ts` — `Object.getPrototypeOf(<Generator
  instance>)` → `%GeneratorPrototype%` singleton (#3236 Slice 2).

Local validation: 16/16 `===` semantic cases preserved; primitive-eq program
byte-identical to baseline; rel/relWithNoise/defProto all reliably `1`.
Authoritative gate is the merge_group standalone floor (this touches every
object/any `===` in standalone).
