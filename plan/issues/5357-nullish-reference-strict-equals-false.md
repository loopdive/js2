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

## Implementation Plan

The previous agent located the emitter exactly and argued, correctly, that a
static fold cannot fix prettier (`onEnter?.(doc) === false` has an `any`
left operand). The fix is to stop the ToNumber collapse from ever seeing a
pair it cannot decide, and route those pairs into the reference-equality arm
that already implements JS `===` in both lanes.

1. **Capture the parent** (`.tmp/binary-ops-typed-dispatch.orig.ts`) and
   reproduce the whole nine-row matrix in one standalone probe
   (`compileAndRunUpstreamModule`, untyped `.js`), plus `1 === true` (#4208)
   and the three loose-equality rows, so every later run answers all of
   them at once.
2. **Read the two arms** in `src/codegen/binary-ops-typed-dispatch.ts`:
   the reference-identity / `__host_eq` block (~L1330 on `01ce47aba7`; host
   lane emits the `__host_eq` import, `semanticProviders === "native-first"`
   emits the #1776 native tag dispatch) and the `__unbox_number` + `f64.eq`
   tail (~L1545–1566). Also `strict-eq-type-disjoint.ts` (#4208) for how the
   scalar regime folds disjoint types, and how a Boolean is boxed to
   `externref` today (grep `type-coercion.ts` for the i32→externref boolean
   arm used when a `true`/`false` is passed to a host function — reuse it,
   do not invent a box).
3. **Factor the reference arm's emission** into a helper
   (`emitReferenceStrictEquality(ctx, fctx, isEqOp)` or similar, in a small
   new module — `binary-ops-typed-dispatch.ts` is near its ceiling) that both
   the existing ~L1330 site and the new call site use, so the host/native
   lane split stays in one place. **A host-lane-only fix is explicitly not
   wanted.**
4. **Reroute the collapse.** In the tail, before `__unbox_number`:
   - if the scalar side is **statically Boolean** → box it to `externref`
     and call the helper. §7.2.16 step 1: `Type(x) ≠ Type(y)` is `false`,
     and `__host_eq` / the native tag dispatch implement that. This also
     fixes `x === true` for a reference holding `1` (the collapse answers
     `true` there too — add that row to the matrix).
   - if the scalar side is **statically Number** and the reference side is
     not statically numeric → emit a `ref.is_null` guard first (nullish
     reference ⇒ `false` for `===`, `true` for `!==`), then keep the
     numeric fast path **only if** the unboxed value is genuinely a number;
     otherwise route to the helper. Check what `__unbox_number` does with a
     non-number (it is `Number()` semantics — a string `"0"` would compare
     equal to `0`, also wrong for `===`; if the existing tests already pin
     that, the fast path is unsound and the whole pair goes to the helper).
   - leave the collapse untouched when the reference side is statically
     numeric (`number`-typed externref, the case the fast path exists for).
5. **test262 before pushing**: PR #272 cost −12 on a nearby fallback. Run
   the scoped corpus locally — `test/language/expressions/strict-equals`,
   `strict-does-not-equals`, `equals`, `does-not-equals` (find the path
   filter in `tests/test262-runner.ts` / the vitest runner's env, e.g.
   `TEST262_FILTER`) — on parent and fix; the numbers must not go down in
   either lane. Note in the PR body what you ran.
6. **Regression test** per the acceptance criteria, both lanes (find how
   an existing test drives `semanticProviders: "native-first"` /
   `--target wasi` and reuse it). Loose equality rows and #4208 rows as
   no-change controls.
7. **A/B at one HEAD**, 17 suites, per file. Expected: prettier
   `is-empty-doc` 7/16 → ≥ 15/16 (with #5665's optional-call fix on your
   base), and `=== false` / `=== 0` against `any`-typed values are common
   library idioms — hono, jest, axios, redux may all move; report per file,
   improvements welcome, no regressions. `print-doc-to-string` also needs
   #5356; report its state without claiming it.

Independent of #5356 (disjoint files); both needed for prettier's
`print-doc-to-string`.

## Dispatch

Model: **fable** (`feasibility: hard`, `reasoning_effort: max`). Two
lanes, a fast path whose soundness boundary has to be established by
measurement, and a test262 history (#272) of a nearby change costing net
conformance. Dispatch after PR #5665 lands (it carries this file).
