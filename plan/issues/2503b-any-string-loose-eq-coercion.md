---
id: 2503b
title: "standalone any-vs-typed-string == mis-coerces string operand to NaN (operand-order asymmetry)"
status: done
created: 2026-06-19
updated: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, type-coercion
language_feature: loose-equality, string-coercion, abstract-operations
goal: standalone-mode
sprint: 61
related: [1910, 1910d, 1472, 2073, 2081, 1134, 1914]
assignee: ttraenkler/dev2
---
## Problem

In `src/codegen/binary-ops.ts`, equality where one operand is `any`/object and
the other is a **statically string-typed** operand was handled
**asymmetrically** by operand order:

- `"ab" == a` (a: any) → routed through `compileStringBinaryOp` (correct
  §7.2.15 string-aware comparison) via the existing left-string arm → **true**.
- `a == "ab"` (a: any) → fell through to the equality / standalone `noJsHost`
  dispatch, which **ToNumber-coerced the string literal** to
  `__box_number(__str_to_number("ab"))` = NaN. So equal strings compared
  unequal: `function eq(a: any) { return a == "ab"; } eq("ab")` returned
  **false** standalone (while `a === "ab"` and the reversed `"ab" == a` both
  returned true).

Found by sdev-looseeq while implementing #1910d (the loose-eq Object↔primitive
ToPrimitive arm): the object→String reduction cases (`new String("x") == "x"`,
`{toString}` vs a string literal) bottomed out on this defect even though the
ToPrimitive arm correctly produced the reduced string — it then compared the
reduced string against a string-typed literal in `a == "lit"` order and got the
NaN mis-coercion. Reproduces with **zero objects involved**.

## Root cause

The coercion plan had a left-string equality arm (string `==` non-numeric →
`compileStringBinaryOp`) but **no symmetric right-string equality arm** — the
right-string arm was gated to `+` (`PlusToken`) only. So a string-typed RIGHT
operand against a non-numeric LEFT (`any`/object) skipped the string dispatch
and fell into the numeric coercion path.

## Fix (revised — the first attempt caused a −3 test262 regression)

The first attempt mirrored the left-string arm: route a string-typed RIGHT
operand against a non-numeric LEFT through `compileStringBinaryOp`. That forces
a **pure string-content** compare, which is wrong whenever the `any` LEFT holds
a NON-string at runtime, so it regressed 3 test262 tests:
- `5 == "5.0"` must be `true` (ToNumber("5.0")=5), not `false` (String(5)="5");
- `null == "ab"` / `undefined == "ab"` are always `false` (never coerce);
- an object LEFT must ToPrimitive then recurse.
The static-type routing collapsed all of these to a string compare.

**True root cause**: in the struct-ref coercion block of
`compileBinaryExpression` (`src/codegen/binary-ops.ts`), **loose** equality
(`==`/`!=`) where one operand is a native-string ref and the other is externref
(`any`) fell into the ToNumber path (`coerceType(ref → f64, "number")`),
scanning the string to NaN. The **strict** (`===`/`!==`) counterpart was already
fixed (#1914 mixed externref+native-string arm); loose equality had no such arm.

**Revised fix**: a loose-equality guard in that block — when one operand is a
native-string ref and the other is externref (and it is **not** a wrapper
object, which keeps its dedicated arm, #1910d) — boxes the string ref to
externref and lets BOTH operands fall through to the standalone
abstract-equality cascade (~line 1990). That cascade dispatches on the
**runtime** tag per §7.2.15: string⇄string content compare, string⇄number
ToNumber, nullish guard, Object→ToPrimitive. This restores operand-order
independence WITHOUT static string routing, so number/null/undefined/object
`any` values are compared per spec. The over-broad arm from the first attempt
was removed.

JS-host (`gc`) mode is unaffected (those comparisons route through
`__host_loose_eq`/`__host_eq` = correct JS `==`/`===`); the guard is gated on
`ctx.nativeStrings`, so the rerouting only changes the standalone/WASI path that
previously mis-coerced.

## Acceptance

- `a == "ab"` (a: any, a==="ab") → `true` standalone; `a != "ab"` → `false`;
  mismatch (`a` is `"xy"`) → `false`; strict `a === "ab"` → `true`; reversed
  `"ab" == a` unchanged → `true`.
- JS-host mode compiles & validates (no codegen regression).
- 0 regressions across #1776 / #1134 / #1986 / native-string equality suites.
- Test: `tests/issue-2503b-any-string-loose-eq.test.ts` (standalone runtime +
  JS-host compile/validate).
