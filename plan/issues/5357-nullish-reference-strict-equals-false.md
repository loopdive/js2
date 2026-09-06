---
id: 5357
title: "`x === false` answers TRUE when `x` is a nullish reference — the operands are collapsed to f64 and `Number(null) === Number(false)`"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
---

## Problem

Strict equality between a **reference-represented** operand that is `null`/
`undefined` at runtime and a statically-Boolean operand answers `true`.

```js
function pick(flag) {
  return flag ? null : "x";
}
export function probe() {
  const r = pick(true);         // null
  return String(r === false);   // Node: "false".  Wasm on 01ce47aba7: "true"
}
```

The emitted body shows the collapse — the Boolean is widened to f64, the
reference is put through `Number()`, and `f64.eq` compares `0` with `0`:

```wat
local.tee 0            ;; $r : externref = null
i32.const 0            ;; false
f64.convert_i32_s      ;; 0.0        <-- Type(y) erased
local.set 1
call 0                 ;; __unbox_number($r) -> Number(null) = 0
local.get 1
f64.eq                 ;; 0 == 0  -> TRUE
```

This is the same shape #4208 fixed for `1 === true` in the SCALAR regime, one
representation over. `strict-eq-type-disjoint.ts`'s own header states that the
reference case "already answer[s] correctly … handled by the `#296` cross-type
arm further down". Measured on `01ce47aba7`, it does not: the numeric collapse
runs first, so the `#296` arm is never reached for this pair.

### Measured matrix (all on `01ce47aba7`)

| expression | Wasm | correct |
| --- | --- | --- |
| `const n = null; n === false` | **true** | false |
| `const u = undefined; u === false` | **true** | false |
| `const u = undefined; u === 0` | **true** | false |
| `const u = undefined; u === null` | false | false |
| `undefined === false` (both literals) | false | false |
| `pick(true) === false` where `pick` returns `null \| string` | **true** | false |
| `let v = "s"; v = null; v === false` | false | false |
| `function f(v){ return v === false } f(undefined)` | false | false |
| `function nothing(){}; nothing() === false` | false | false |

So it fires when the nullish value reaches the comparison **as a reference the
compiler chose a numeric collapse for** — a `const` initialised to a nullish
literal, or a call whose return type is a nullish union. A parameter, a
re-assigned `let`, and a `void` function's result all take a different arm and
are already correct.

### Why it matters

It is one of the two defects behind prettier's `tests/unit/is-empty-doc.js`
(7/16, #5346). `traverseDoc` gates its recursion on

```js
if (onEnter?.(doc) === false) {
  continue;
}
```

A callback that returns nothing yields a nullish reference, `=== false` is
therefore true for every node, and the traversal `continue`s at the root —
visiting exactly one doc. `isEmptyDoc` then answers `true` for every input.
(The other defect, the optional call never invoking a value callee, is fixed
separately; with only that fix `traverseDoc` visits 1 node instead of 3.)

## Where it is emitted

`src/codegen/binary-ops-typed-dispatch.ts`, the tail of the externref-equality
block — the `addUnionImports(ctx); const unboxIdx = …__unbox_number…` fallback
immediately before `fctx.body.push({ op: isEqOp ? "f64.eq" : "f64.ne" })`
(~L1545-1566 on `01ce47aba7`, confirmed by instrumenting every statement-position
`f64.eq`/`f64.ne` push in `binary-ops.ts` and `binary-ops-typed-dispatch.ts` and
running the repro: exactly one marker fires, and it is that one).

It is NOT `compileNumericBinaryOp` — a trace on its entry does not fire for this
expression — and it is NOT the `isNumericOp` externref arm at ~L637, which
`===` never satisfies.

The correct arm exists directly above it: the reference-identity /
`__host_eq` block at ~L1330. Our expression cannot reach it because that block
requires

```ts
leftType.kind === "externref" && rightType.kind === "externref" &&
!leftIsString && !rightIsString && !leftIsNumber && !rightIsNumber &&
!leftIsBool && !rightIsBool
```

and `false` is statically Boolean, lowered to `i32`. So it is excluded twice —
once for not being an externref, once for being statically Boolean — and falls
into the ToNumber collapse.

## Why the obvious narrow fix is not enough

Folding §7.2.16 step 1 statically (drop both operands, push `0`/`1` when one
side is statically Boolean and the other's static type cannot be Boolean) is
sound and fixes the `pick(true) === false` repro — but it does NOT fix
prettier. `traverseDoc`'s left operand is a call on an untyped parameter, so
its static type is `any`, and a fold from `any` would be unsound.

The fix therefore has to be dynamic: box the scalar side to `externref` and
route the comparison into the block above, which already has both lanes
covered — `__host_eq` (JS `===`) in the host lane and the #1776 native tag
dispatch under `semanticProviders === "native-first"`. That means relaxing that
block's `!leftIsBool && !rightIsBool` gate as well as its both-externref gate,
which is why this is `feasibility: hard`: PR #272 dropped a nearby fallback
outright and cost −12 net test262. A per-lane half-fix (host lane only) is
explicitly NOT wanted.

## Acceptance criteria

1. Every row of the matrix above answers as Node does, with a regression test
   covering the `const`-nullish, the nullish-union call and the already-correct
   parameter/`let` rows — untyped `.js`, failing on the parent commit with
   exact counts both ways, and an anti-vacuity control.
2. `1 === true` (#4208) and the loose-equality behaviour (`null == false` is
   `false`, `undefined == false` is `false`, `0 == false` is `true`) are
   unchanged.
3. A/B at one head over the 17 dogfood suites.
