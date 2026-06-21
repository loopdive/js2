---
id: 1910d
title: "standalone loose-eq (==/!=) Object↔primitive ToPrimitive arm (§7.2.13 steps 11-12)"
status: done
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, type-coercion
language_feature: loose-equality, to-primitive, abstract-operations
goal: standalone-mode
sprint: 61
related: [1910, 1472, 1900, 1917, 1776, 2081, 1134]
assignee: ttraenkler/sdev-looseeq
test262_bucket: object-loose-equality
---
## Problem

The standalone / WASI (`noJsHost`) loose-equality cascade in
`src/codegen/binary-ops.ts` (the `noJsHost && (left|right === externref)`
block, ~L2002) implements ECMA-262 §7.2.13 IsLooselyEqual for
number / boolean / bigint / string / reference-identity — but had **no arm for
"exactly one operand is an Object and the other a primitive"** (§7.2.13
steps 11-12: `x is String/Number/BigInt/Symbol and y is Object ⇒ x ==
ToPrimitive(y)`, symmetric). So under `--target standalone`:

- `new Number(7) == 7` → `false` (should be `true`)
- `new Boolean(true) == 1`, `"1" == new Boolean(true)` → `false`
- `{ valueOf: () => 5 } == 5` → `false`

…all fell through to the reference-identity fallback and returned `false`.
(`new Number`/wrapper operands additionally went through a `__host_loose_eq`
host path that leaks an unsatisfiable import in standalone — but that path is
shadowed by the `noJsHost` block, so they reached the ref-identity arm and
returned a wrong `false` rather than failing to instantiate.)

## Fix

Add the §7.2.13 step 11-12 Object↔primitive arm **inside the `noJsHost` block**,
reusing the already-built native `__to_primitive` engine (#1900/#1917 — do NOT
fork it). After both operands are coerced into the `lTmp`/`rTmp` externref
temps, and gated on **loose `==`/`!=` only** (strict `===` never coerces,
§7.2.16):

1. Compute `__typeof_object(lTmp)` and `__typeof_object(rTmp)`.
2. If **exactly one** is an object (`i32.ne` ≡ XOR), reduce BOTH operands in
   place via `__to_primitive(operand, ref.null.extern /* default hint */)`.
   `__to_primitive` is the identity on a primitive (its `returnIfPrimitive`
   guard), so this only transforms the object side; the primitive side is
   untouched. The existing number/boolean/bigint/string cascade then runs on the
   reduced operands.

The XOR gate is load-bearing for two spec corners:
- **both objects** → §7.2.13 step 1 SameType ⇒ IsStrictlyEqual = reference
  identity, NEVER ToPrimitive → the gate is false, the eqref arm handles it
  (`{} == {}` stays `false`).
- **neither object** → gate false, primitives flow through unchanged.

`null`/`undefined` already short-circuit earlier (`looseNullish`), so they never
reach the reduction (`null == {}` stays `false`). A `Symbol` operand passes
through `__to_primitive` unchanged → compares unequal (correct).

### Critical hazard (the #1890 finalization-shift class)

`__to_primitive` is registered by `ensureObjectRuntime(ctx)`, which can add
**late imports that shift function indices**. It MUST be called *before* the
`addUnionImports` / `__typeof_*` funcIdx reads in the block — and **gated on
`isLoose`**. An earlier draft called `ensureObjectRuntime` unconditionally
(for strict `===` too) and that desynced the in-progress body, regressing
`#1776` `isSameValue` (a strict-`===` standalone test, ~1,436 dependents). With
the `isLoose` gate the strict path is byte-identical to before.

## Acceptance

- `new Number(7) == 7`, `"7" == new Number(7)`, `new Boolean(true) == 1`,
  `"1" == new Boolean(true)`, `{valueOf:()=>5} == 5` all `true` (standalone).
- `{valueOf:()=>5} == 6` → `false`; `new Number(7) === 7` → `false` (strict).
- `#1776` and the existing equality/coercion suites unchanged (0 regressions).
- Test: `tests/issue-1910d-loose-eq-object-primitive.test.ts`.

## Out of scope (follow-up needed)

Object→**String** reduction cases (`new String("x") == "x"`, `{toString}` vs a
string literal) still fail — but the block is correctly producing the reduced
string. They bottom out on a **separate pre-existing standalone defect**: an
`any`/object operand compared `==` against a *statically string-typed* literal
mis-coerces the string operand to `__box_number(__str_to_number(s))` = NaN, so
`NaN ≠ NaN` makes equal strings compare unequal. This reproduces with **no
objects involved** — `function eq(a:any){return a=="ab";} eq("ab")` returns
`false` in standalone while `a==="ab"` (strict) returns `true`. The mis-coercion
is in the operand-lowering / coercion-plan for `any`-vs-typed-string loose
equality, upstream of the loose-eq dispatch. Should be filed as its own issue.
