---
id: 5357
title: "`x === false` answers TRUE when `x` is a nullish reference — the operands are collapsed to f64 and `Number(null) === Number(false)`"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-06
completed: 2026-09-06
assignee: ttraenkler/sendev-5357
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
# 2026-09-06: runtime.ts sits exactly at its ceiling (19149). The change is a
# one-token gate on the existing `__defineProperties` #2837 branch plus a
# three-line comment; it cannot live in a subsystem module because it is the
# branch itself that mis-targets a WasmGC object.
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
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

## Resolution

Base `50c81e5487` (upstream/main, 2026-09-06). Measured with a 60-row
standalone probe through `compileAndRunUpstreamModule` (untyped `.js`
two-file project, host lane) and the same rows single-file under
`--target standalone` and `semanticProviders: "native-first"`; a
deliberately failing control and two must-pass controls sanity-check the
harness (an earlier probe shape — a `function` nested in the test arrow —
answered `"true"` for every row including a string-returning one, and was
thrown away).

### What was actually wrong — three mechanisms, not one

| rows | base (host) | base (standalone / native-first) | mechanism |
| --- | --- | --- | --- |
| `const n = null; n === false`, `pick(true) === false`, `pick(true) !== false`, `anyOne(true) === true`, `onEnter?.(x) === false` with `() => {}` / `() => 0` / `undefined`, prettier's `guarded` | wrong | right | the `__unbox_number` + `f64.eq` collapse (this issue) |
| `null == false`, `null == 0`, `null != 0`, `pick(true) == 0` | wrong | right | the same collapse, loose form — the plan listed these as "unchanged" controls; measured wrong on the parent |
| `const u = undefined; u === false / === 0 / == false / != 0 / !== false` | wrong | **wrong** | not the collapse: `void`/`undefined` maps to `{kind:"i32"}` (type-mapper "void → no result"), so `u` is an `i32` slot holding 0 and `u === 0` is `0 === 0` |

The native lanes were already correct for every collapse row because the
#1776 tag-dispatch block returns for every externref pair before the tail
is reached, so the collapse is host-lane-only in practice. The plan's
"box the scalar and send it to the reference arm, in both lanes" is still
what landed: the helper carries the native branch so the semantics stay in
one place if that gate ever moves.

`__unbox_number` in the host lane is `Number(v)` (ToNumber), so the
numeric fast path is unsound for ANY reference that is not statically
numeric (`"0" === 0`, `true === 1`, `[0] === 0` would all collapse to
`true`). Those number-scalar pairs were already routed to `__host_eq` by
the #1986 arm; the tail only ever saw pairs with a statically-Boolean
side, and the collapse is kept exactly for the number-typed references
the fast path exists for.

### Design

- **`src/codegen/strict-eq-reference-arm.ts`** (new) —
  `emitReferenceEqualityFromStack`: brands an `i32` scalar by its static
  type (`boolean` → `__box_boolean`, symbol → `__box_symbol`) so the box
  keeps the JS tag, then host lane → `emitHostEqualityFromStack`
  (coercion-engine.ts stays the one `__host_eq` emitter), native-first →
  `__extern_strict_eq` / `__any_eq`. `emitLooseScalarVsReferenceEquality`:
  `ref.is_null` decides the nullish case (§7.2.15 steps 2-3) in front of
  the ToNumber comparison, which IS steps 5-10 for a non-nullish reference.
- **`binary-ops-typed-dispatch.ts`** — the wrapper arm and the #1986 arm
  call the helper (two of the four inline `__host_eq` emissions gone:
  coercion-sites net `__host_eq -4`, `__host_loose_eq -1`); the tail
  reroutes every strict pair with a statically-Boolean side (the only
  strict pairs that can reach it) and guards loose scalar-vs-reference
  pairs. File shrinks 1610 → 1593 lines; the function stays under its
  ceiling.
- **`src/runtime.ts`** — `__defineProperties`' #2837 branch (a host
  descriptor object carrying wasm-closure accessors) is gated to HOST
  targets; a WasmGC target takes the existing opaque-object sidecar path.
  Found by the A/B: axios's `utils.freezeMethods` runs `reduceDescriptors`
  at module init and keeps every descriptor whose reducer result is
  `!== false` — the exact #5357 shape. On the parent the reducer's
  `undefined` collapsed to `0 !== 0`, every descriptor was dropped and the
  freeze was a silent no-op; with a correct `!==` the throwing-setter
  descriptors reached that branch, which called the raw
  `Object.defineProperty` on the compiled `utils` object — "WebAssembly
  objects are opaque", 12 of 34 axios unit files dead at module init
  (200/231 → 73/231 before the gate).
- **`strict-eq-type-disjoint.ts`** (#4208's scalar module) — an
  `"undefined"` class for an `i32` whose static type is `void`/`undefined`,
  decidable against Number and Boolean for `===` and, because nullish equals
  nothing but nullish, for `==` too. Refused for anything but a plain
  variable binding: a parameter typed `undefined` from its default alone
  (`function g(v = undefined) { return v === 0 }`, nested so #5221's
  widening does not apply) carries whatever the caller passed — with the
  class applied to it `g(0)` answered `false`; refusing it restores the
  parent's answers for that shape (`g(0)` right, `g()` wrong — #5221's).

### Measurements

- Probe, 60 rows: host 41/60 → 58/60; standalone 53/60 → 58/60;
  native-first 53/60 → 58/60. The two residuals in every lane are the
  deliberately failing control and the nested defaulted-parameter row
  above (unchanged from the parent).
- Regression test `tests/issue-5357-nullish-reference-strict-equals-false.test.ts`
  (22 rows × 3 lanes + the axios `freezeMethods` shape): parent 18 failed /
  50 passed of 68 (the matrix rows 16; both `freezeMethods` probes, whose
  module init threw in the #2837 branch on the parent); fix 68/68.
- Scoped test262 (`strict-equals`, `strict-does-not-equals`, `equals`,
  `does-not-equals`; 149 tests): gc 139/149 → 139/149, standalone
  136/149 → 136/149, identical residual sets in both lanes (ToPrimitive /
  `Symbol.toPrimitive` / IsHTMLDDA / BigInt-width cases).
- Existing suites #1986, #4208, #1776, #2081, #1065, #2605/#2606, #4397,
  #5346, #4656, #2508: 149 passed, 2 failed — both fail identically on the
  parent (`#4397 escape()` under native-first returns null; `#4656`'s
  opaque-receiver `it.fails` residual), unrelated.
- Dogfood A/B, 17 suites at one head: see the table below.

### Dogfood A/B (base → fix at `50c81e5487`, 17 suites, one at a time)

| package | base | fix | per-file change |
| --- | --- | --- | --- |
| lodash | 58/62 | 59/62 | `test.js` 58 → 59 |
| axios | 200/231 | 200/231 | none (73/231 before the runtime gate) |
| prettier | 105/151 | 105/151 | none — `is-empty-doc` 10/16 both, `print-doc-to-string` 0/3 both (#5356) |
| jest | 335/356 | 335/356 | none |
| hono | 229/324 | 229/324 | none |
| redux | 66/82 | 66/82 | none |
| marked | 9/30 | 9/30 | none |
| three | 17/18 | 17/18 | none |
| webpack, clsx, cookie, stylelint, tailwindcss, jsdom, styled-components, uuid, moment | 16/16, 32/32, 63740/63740, 108/108, 13/13, 6/6, 9/9, 75/75, 10/10 | identical | none |

All 17 suites exited 0 with an `admitted` headline in both runs; no file
regressed. (The jest `queueRunner.test.ts` and hono `cookie.test.ts`
compile failures are on both sides.)

### Prettier: what this fix does and does not move

The plan expected `is-empty-doc` 7/16 → ≥ 15/16 with #5346 + this fix.
Measured: 10/16 before (that is #5346's 7 → 10) and 10/16 after, prettier
105/151 → 105/151. The six remaining rows all expect `false`, and
`isEmptyDoc` produces `false` only by writing `isEmpty = false` from inside
the `traverseDoc` callback and reading it after the call. A minimal probe
(`.tmp/probe-5357/capture.mjs` shape) answers the question directly:

| shape | Node | Wasm (this branch) |
| --- | --- | --- |
| `let flag = true; const cb = () => { flag = false }; cb(); flag` | false | false |
| `let isEmpty = true; traverse(["a"], (d) => { isEmpty = false; return false; }); isEmpty` | false | **true** |

A `let` written inside a callback that is passed through another function
is not visible to the enclosing function afterwards — #5356's eager
capture box, exactly as the dispatch note said for `print-doc-to-string`
(0/3 before and after; it needs #5356 as well). `traverseDoc`'s
`onEnter?.(doc) === false` gate itself IS fixed here: `guarded(() => {})`
now visits.

### Left out, deliberately

- `u === undefined` where `u` is the `i32`-lowered `const u = undefined`
  and the right side materialises via #4656 still answers `false`
  (`__host_eq(__box_number(0), undefined)`); same on the parent. Fixing it
  means materialising the `i32` as the canonical `undefined` externref
  rather than folding, which changes representation for every equality on
  such a binding — a separate slice.
- A nested function's `v = undefined` parameter is still an `i32` slot
  (#5221 applies only where the widening runs); `g()` answers `true` for
  `v === 0` on the parent and after this fix alike.
- A statically-number externref against an `any` reference
  (`numRef === anyRef`) keeps the collapse, as the plan asked; it is wrong
  when `anyRef` holds `"1"` or `true`, and was not in the matrix.
