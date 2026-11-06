---
id: 7258
title: "IR move-only scan: return a boolean-holding `var x;` carrier into a boolean result (#7250 rule c)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7250
related: [2949, 7106, 7190]
assignee: "ttraenkler/c-r7"
loc-budget-allow:
  # 2026-11-06: +~33 select.ts (one helper `concreteResultRecoversDynamic`
  # that also absorbs the #7106 S1c string arm, which used module state only
  # select.ts owns), +5 from-ast.ts (one `coerceReturnValue` arm next to its
  # string/number siblings). Neither can move out without moving the state.
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# IR move-only scan: return a boolean-holding `var x;` carrier into a boolean result

## Problem

[#7250](7250-ir-property-helper-dynamic-carrier-locals.md) found three move-only
scan rules that keep propertyHelper.js's `isWritable` legacy. Rule (c):
`if (writeSucceeded)` / `return writeSucceeded`, where `var writeSucceeded;` is
the dynamic carrier's undefined (#7106 Stage 4) and the function's inferred
result is `boolean`.

## Measurements (step 1, before code)

Probe on main `92305e40` (standalone, `trackIrOutcomes`, `JS2WASM_IR_SHAPE_DIAG=1`):

| shape (in a dynamic-carrier function) | main |
| --- | --- |
| `if (d)`, `while (d)`, `!d`, `d ? x : y` | already IR-emitted (`dyn.truthy`) |
| `if (d && e)` value-free condition | refused `expr-logical-value-family` (logical-value rule, not move-only) |
| `return d` into a dynamic result | already IR-emitted |
| `var ws; ws = a === b; return ws;` (inferred `boolean` result) | **refused** `move-only[concrete]` on `ws` in `return ws` |
| same with `ws = 3` (inferred `number`) | refused, same row |

So the only (c) gap is the RETURN of a `var x;` carrier into an inferred
boolean result. Truthiness tests already lower through `dyn.truthy`.

Wrapped ledger A/B: see "Results".

## Implementation Plan

- `src/ir/select.ts`
  - `currentFnReturnsString: boolean` → `currentFnReturnKind: ResolvedKind`
    (one state variable instead of one flag per kind).
  - New `concreteResultRecoversDynamic(fn, returned, dynamicUndefinedVars)`:
    one switch over the result kind that says whether `return <dynamic>` can
    land in a concrete result. The existing #7106 S1c string arm moves into
    it (dedup); the new `bool` arm admits only an identifier that is a
    `var x;` dynamic-undefined local, in a function with no `: T` and no JSDoc
    `@returns`. TypeScript's evolving type for `x` is then boolean, because one
    `any` write would make the result `any`. So the carrier holds a boolean or
    its initial undefined.
  - `dynamicUsesAreMoveOnly` records the Stage 4 names in
    `dynamicUndefinedVars` and calls the helper once in its return arm.
- `src/ir/from-ast.ts` `coerceReturnValue`: a dynamic value into a boolean
  result lowers via the existing `dyn.truthy` (`emitDynTruthy`). It sits next
  to the string (`dyn.string_carrier`) and number (`js.number.unbox`) arms. No
  new instruction, import or provider.
- Contract: unchanged. The value is read through the canonical ToBoolean
  provider, and only where ToBoolean is the identity on the values the carrier
  can hold.

Code-quality acceptance: no new function over budget (`dynamicUsesAreMoveOnly`
does not grow, net); the string arm is folded rather than duplicated; no new
host import.

## Acceptance criteria

- `tests/issue-7258-ir-move-only-truthiness-return.test.ts`: the boolean
  returns are IR-emitted and return legacy's values; a `number` result and a
  JSDoc-annotated boolean result stay refused.
- Typed corpus byte-identical on gc/standalone/wasi.
- Wrapped ledger: 0 invariants, compileOk not lower.
- Standalone test262 A/B on every file whose route changed: no pass→fail, no
  new trap.

## Results (2026-11-06, base `92305e40` vs head `f6c1d280`)

- **Wrapped ledger** (`--wrapped --stride 40 --target standalone --jobs 2`,
  `JS2WASM_IR_SHAPE_DIAG=1`): head equals base apart from timing and the
  commit field. 1296 files, 14448 units; ir 1137, both 8531, legacy 4780;
  compileOk 1118 → 1118; invariants 0 → 0. All 807 `unsupportedDetails` rows
  are identical, so the slice moves no unit in the stride corpus.
- **Why 0:** propertyHelper's `isWritable` is the motivating shape, but its
  first refusal is still rule (a), `obj[name] = newValue`, then (b), so (c)
  alone frees nothing there. No stride test body has the
  `var x; x = <bool>; return x;` shape with no earlier refusal.
- **Per-file route diff** (wrapped compile, IR-emitted unit names): stride-40
  plus a 300-file seeded random sample, kept where `return X;` names a
  `var X;` local. That leaves 175 files, including every propertyHelper
  includer. 0 route changes; compile ok 164, fail 11, the same on both sides.
- **Typed corpus:** 88 files (playground, `examples/`, the first 60 of
  `tests/equivalence/`) × gc/standalone/wasi = 264 compiles, byte-identical.
- **Unit test:** `tests/issue-7258-ir-move-only-truthiness-return.test.ts`
  passes.

This slice is groundwork: it lands the (c) admission so that isWritable
(and so verifyWritable, verifyNotWritable and verifyProperty) can reach its
tail once (a) and (b) are admitted.
