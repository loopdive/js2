---
id: 4606
title: "Boxed boolean returned from a mixed-return function prints as 1 in template interpolation"
status: done
completed: 2026-08-21
sprint: current
created: 2026-08-21
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: template-literals
goal: core-semantics
related: [4121]
# The mixed-kernel elimination is a THIRD fixpoint over the same cached
# `fnInfo` / `numeric` / `boolean` state the two existing fixpoints in this
# function already share, and it has to run after both (it consults the
# purely-boolean verdict and re-validates with `isNumericExpr`). Hoisting it out
# would mean re-threading four closures and two sets for 25 lines; the function
# crosses 300 at 325.
func-budget-allow:
  - src/codegen/declarations/param-return-inference.ts::inferNumericReturnTypes
origin: "#4121 slice 2 (PR #4720) negative-test writing; reproduces at the branch base and with every JS2WASM_NUMERIC_* kill switch off — pre-existing, unrelated to that slice"
# id 4606 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: the only open PR was 4720, which introduces
# no new issue files.
---

# #4606 — boxed boolean from a call prints `1` under template interpolation

## Problem

A function whose return sites mix `boolean` and `number` returns a boxed
(dynamic-carrier) value. Interpolating that value in a template literal
stringifies it as its numeric payload, not its boolean identity:

```js
function m(x) {
  if (x > 5) return true;
  return x + 1;
}
var v = m(9);
console.log(`${v}`.length);
```

| engine | `${v}` | `.length` |
| --- | --- | ---: |
| node | `"true"` | 4 |
| js2 | `"1"` | **1** |

This is NOT the usual f64-carrier trap: `v` is boxed (the mixed return
forces the dynamic carrier), and a direct `var v = true; \`${v}\`` prints
`true` correctly. The loss happens when the boxed value flows from a call
result into template stringification — the boolean tag is dropped and the
payload is stringified as a number.

Found while writing negative tests for #4121 slice 2 (PR #4720). Reproduces
identically at that branch's base commit and with `JS2WASM_NUMERIC_RETURNS=0`
and `JS2WASM_NUMERIC_ADMISSION=0` — so it is pre-existing and independent of
the numeric-return inference work.

## Root cause

**Not** the template-literal ToString lowering, and not a box/unbox path: the
value is never boxed at all. `m` is compiled as `(func $m (param f64) (result f64))`,
and `return true` emits `i32.const 1; f64.convert_i32_s`. The boolean tag is gone
at the function boundary, before any consumer sees it — which is why the direct
`console.log(m(9))` and `String(m(9))` print `1` just as the interpolation does,
and why `typeof m(9)` is `"number"`.

The carrier is chosen by `inferNumericReturnTypes` — the #1121 numeric-kernel
analysis in `src/codegen/declarations/param-return-inference.ts:819`. Its
`isNumericExpr` counts every **boolean-valued** expression as numeric, because
they all lower to i32:

- `src/codegen/declarations/param-return-inference.ts:872` — the `true` / `false` keywords
- `:879` — `!x`
- `:916` — every comparison operator

`m`'s TS return type is implicit `any` (`x` is untyped, so `x + 1` is `any`),
which makes it a candidate; both return sites then pass `isNumericExpr`, so the
whole function is promoted to an f64 result carrier.

#2795 had already found half of this: a **purely**-boolean kernel gets a
boolean-branded i32 (`{kind:"i32", boolean:true}`) so it boxes as a JS boolean.
The gap was the **mixed** kernel — some boolean returns, some numeric — which
has no single scalar carrier that preserves both tags.

### Fix

A third fixpoint after the numeric and boolean ones: a kernel that is not purely
boolean but has at least one boolean-valued return is removed from the promoted
set entirely, so it keeps its boxed (`externref`) carrier and the tag survives.
Removal must iterate — `isNumericExpr` admits a call to any member of the
numeric set, so dropping `m` withdraws the proof from a caller like
`function g(y) { return m(y); }`, which the re-validation pass then drops too.

Purely-boolean kernels (#2795) and purely-arithmetic kernels are untouched.

### Kill switches

Independent of `JS2WASM_NUMERIC_RETURNS` / `JS2WASM_NUMERIC_ADMISSION`, as the
issue reported: those gate `inferBindingAwareNumericReturnTypes` (#4121), a
different, standalone-only analysis. `inferNumericReturnTypes` (#1121) is
unflagged, which is why turning them off changed nothing.

### Adjacent defect, NOT fixed here

The same tag loss happens with **no function involved**, through a conditional
expression:

```js
var x = 9; var v = x > 5 ? true : x + 1; console.log(`${v}`);   // node "true", js2 "1"
```

The ternary's arms are unified to `f64` at the lowering site (`(if (result f64) …
i32.const 1 … f64.convert_i32_s …)`), a different mechanism from the return
carrier. Left out deliberately: `cond ? <numeric> : <numeric>` is a very common
shape, and widening it to a boxed carrier is a value-representation decision with
a far larger blast radius than this issue's scope. Worth its own issue.

## Acceptance criteria

- [x] The repro above prints `4` (matching node) in JS-host mode.
- [x] A regression test pins the repro plus the near-miss cases that already
      work (`var v = true` interpolated directly; a boolean-only-return
      function's result interpolated). —
      `tests/issue-4606-mixed-boolean-return-carrier.test.ts` (12 tests; also
      pins the numeric arm, the caller-withdrawal fixpoint, #2795's
      purely-boolean mutual-recursion kernel, and a purely-arithmetic kernel
      staying on f64).
- [x] Root cause recorded here: where the boolean tag is dropped
      (box/unbox path vs the template-literal ToString lowering).
- [x] No equivalence regressions.
