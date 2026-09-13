---
id: 6415
title: "`ArrayBuffer.isView` read as a FIRST-CLASS VALUE answers false for every carrier on the JS-host lane"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-12
completed: 2026-09-12
loc-budget-allow:
  # 2026-09-12 (#6415): +24 lines in the funcref-ladder return bridge — one
  # externref -> boolean-i32 arm (4 lines) plus the comment recording why the
  # arm is brand-restricted and why widening to plain i32 is wrong. The arm
  # must live beside the other `scalarBridgePlan` rows: they are one ordered
  # ladder whose pre-pass decides late-import reservation from their combined
  # answer, so extracting one row to a new module would split that decision.
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  # 2026-09-12 (#6415): same +24 lines, same rationale — `scalarBridgePlan` is
  # a closure inside `compileIdentifierCall` because it reads that call's
  # `sigParamWasmTypes`/`expectedReturn`/`ctx` frame.
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
coercion-sites-allow:
  # 2026-09-12 (#6415): `__is_truthy` 1 -> 2 in this file. This is NOT a
  # hand-rolled ToBoolean matrix — `__is_truthy` IS the coercion engine's
  # canonical host-lane ToBoolean primitive (src/ir/builder.ts L563,
  # src/ir/core/dialect/js.ts L125), and the new site is a single `call` to it.
  # Routing the bridge anywhere else is what the gate is asking for and what
  # this already does.
  - src/codegen/expressions/call-identifier.ts
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Measured while closing [#5370](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5370-typed-array-carrier-host-boundary-fidelity)
(same probe, both before and after that fix — this is pre-existing and
untouched by it):

```js
// untyped .js half
export function isViewViaHostFn(value) {
  const f = ArrayBuffer.isView; // first-class VALUE read
  return f(value);
}
```

`isViewViaHostFn(new Uint8Array(3))` and `isViewViaHostFn(<host Uint8Array>)`
both answer **false** in compiled code on the JS-host lane. Node answers `true`
for both. The DIRECT call form — `ArrayBuffer.isView(value)` in the same
untyped module, same values — answers `true` after #5370.

So the two spellings of the same predicate disagree, which is exactly the
divergence #5150 removed on the standalone lane and left open here.

## Why

`src/codegen/builtin-value-read.ts` has a first-class `ArrayBuffer.isView`
closure, but it opens with:

```ts
case "ArrayBuffer.isView": {
  if (!noJsHost(ctx)) return null;
```

so on the host lane the value read falls through to the generic host-property
route. Whatever that produces does not reach the `__arraybuffer_isView` import
that #5370 corrected (that import now re-asks through `_wrapForHost`, so a
branded carrier reads as a real view). Two arms are worth measuring before
choosing:

* the host-lane value read resolves `ArrayBuffer` then `.isView` through
  `__extern_get`, and the resulting dynamic call hands the callee the RAW
  WasmGC carrier rather than its `_wrapForHost` mirror; or
* the closure is built but with the standalone `isViewRefTestInstrs` body,
  which cannot see a host externref at all.

The standalone `isViewRefTestInstrs` chain is NOT the fix for the host lane on
its own: it shares the `$Vec` carrier between `number[]` and TypedArrays, so a
plain array literal would start reading as a view. The host lane has an exact
answer available (the import) and should use it.

## Acceptance criteria

1. `const f = ArrayBuffer.isView; f(x)` answers identically to
   `ArrayBuffer.isView(x)` on the JS-host lane for: a compiled carrier, a
   host-built typed array, and — anti-vacuity — a plain array literal (`false`)
   and a `DataView`.
2. Regression test under `tests/`, untyped `.js` two-file fixture, failing on
   the parent and passing with the fix, exact counts both ways.
3. A/B over the 17 dogfood suites at one HEAD; nothing regresses.
4. Standalone lane byte-identical (this is a host-lane arm).

## Dispatch

Model: **opus**. One located arm; the design point is whether the host-lane
closure should call the import or whether the generic dynamic-call path should
marshal its arguments, and the second answer would be much larger in blast
radius.

## Implementation Plan

**Measured on 23a0ddaa26 (probe: `.tmp/6415/probe{1..4}.mts`, two-file untyped fixture through `compileProject`+`buildCompiledImports`, the #5370 harness):** the defect reproduces (`f(x)` → not-view for a compiled `Uint8Array(3)` and for a host `TextEncoder` array; direct call → view). But **neither arm in "Why" is responsible**, and the defect is not isView-specific:

* Host lane never reaches the `builtin-value-read.ts` closure (the caller at `property-access-dispatch.ts` ~L1958 is gated `ctx.standalone || isHostDescriptor`); the value read is `__get_builtin("ArrayBuffer")` → `__extern_get("isView")` — a real host function — and the call is `__call_function`, whose runtime (`src/runtime/host-call-abi.ts` `invoke`) already `_wrapForHost`s every WasmGC arg. The untyped callee answers correctly: `return f(value)` read back as `unknown` from the typed half gives `true`, and `f(value) ? "view" : "not-view"` inside the .js half gives `"view"`.
* The value is lost at the **typed caller**. `viaValue as unknown as (v) => boolean` calls through the callable-struct funcref ladder in `src/codegen/expressions/call-identifier.ts` (~L3182–3330). The untyped callee's Wasm signature returns **externref** (it boxes via `__box_boolean`), the call site expects `{i32, boolean}`; the return-bridge chain `declaredRefSubtypeOf` → `canProjectImplementationReturn` → `dispatchBridgePlan`/`scalarBridgePlan` (~L2335–2427) has **no externref→boolean-i32 arm**, so the live arm hits the "dead-arm placeholder" `drop; i32.const 0` (~L3322). WAT confirms `call_ref N; drop; i32.const 0`. Same failure for `const f = Array.isArray; return f(v)` and `const f = Object.is; return f(v, v)` (both answer false); `return f(v) ? true : false` (i32 return) passes — that is the control.

**Fix (arm A, chosen):** in `scalarBridgePlan` add, before the final `return null`: `if (isHostExtern(from) && to.kind === "i32" && to.boolean === true) return helpers.isTruthyIdx === null ? null : [{ op: "call", funcIdx: helpers.isTruthyIdx }];` — `__is_truthy` is ToBoolean of the boxed host result (exact for a real boolean; spec-correct if the callee returns a non-boolean). Plumb `isTruthyIdx` through the `helpers` type, `dispatchBridgePlan` (`ctx.funcMap.get("__is_truthy") ?? null`) and `theoreticalHelpers` (`isTruthyIdx: 0`). Do NOT widen to plain `i32` (native ints / symbol ids) and do NOT touch `scalarAbiTypesMatch`.

**Order-preservation constraints:** the ladder's arms must not pull a late import (the #2174 `ref.func` desync — see the comment block at ~L3290). `__is_truthy` is a union import (`registry/imports.ts` L934, L1017), and the `needsScalarBridge` pre-pass (~L2440–2472) runs `addUnionImports`+`flushLateImportShifts` BEFORE the ladder is baked — but only if it sees a non-null plan, so the new arm must be in place for that pre-pass call too (it uses `theoreticalHelpers`, so adding the field is what makes it fire). Standalone/WASI return `null` at the top of `scalarBridgePlan` → byte-identical (AC4). Alternative arm B — giving the untyped callee an i32 return when TS infers `boolean` for a host-value call — changes every JS module's export ABI; not chosen.

**Reduction first:** re-run `.tmp/6415/probe4.mts` (isViewB/isArrayB/objectIsB "n", ternaryB "y", hostPredB "y") — after the fix all "y".

**Regression test** `tests/issue-6415-host-value-predicate-boolean-return.test.ts`, #5370 harness shape (untyped `mod.js` + typed `entry.ts`, `target: "gc"`, `platform: "web"`, `deferTopLevelInit`, results as strings). `mod.js`: `viaIsView`, `viaIsArray`, `viaObjectIs` (`return f(...)`), `viaTernary` (control), `hostBytes`. Cases: isView of compiled `Uint8Array` → view; isView of host bytes → view; isArray of `[1,2,3]` → yes; Object.is(1,1) → yes; **anti-vacuity**: isView of `[1,2,3]` → not-view, isArray of `new Uint8Array(3)` → no; **control**: `viaTernary` compiled carrier → view (passes on parent). DataView: assert `f(dv)` equals the direct call only — the direct host-lane `ArrayBuffer.isView(new DataView(...))` itself answers **false** on this HEAD (separate defect, file a follow-up; do not fold into this PR). Expected counts: parent 4 fail / 4 pass; fix 8 / 8.

**Dogfood:** no anchor is expected to move (the shape needs a typed caller casting an untyped module's function to `=> boolean`; the 17 suites are untyped-to-untyped). Run the A/B anyway per AC3 (webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono 259/324) and report exact counts; any typed-caller lane (tests/dogfood typescript-binder fixtures) is the only plausible mover, upward. Standalone lane: byte-identical; spot-check with `tests/issue-5150-es2015-buffers.test.ts` (cluster G) still green. Gates: LOC/func budget (small growth in call-identifier.ts — grant in this issue file if needed), oracle-ratchet untouched.

## Dispatch

Model: **opus**. A ~15-line bridge arm in a ladder with a known late-import ordering hazard plus a dead-arm invariant; the diagnosis is done, but the pre-pass plumbing and the anti-vacuity test need care beyond mechanical.

## Resolution

Fixed on branch `issue-6415`. **The plan's diagnosis held in full; nothing in
it needed contradicting.** One change in
`src/codegen/expressions/call-identifier.ts`, arm A as planned.

**Reduction (probe `.tmp/6415/probe.mts`, measured on `e8a778638f`):** the
defect is not `ArrayBuffer.isView`-specific and not a property-read defect. The
untyped callee is correct — the same `f(value)` computed INSIDE `mod.js`
answers `"view"` on the parent. The value is lost at the **typed caller**: the
untyped callee's Wasm signature returns externref (it boxes via
`__box_boolean`), the `as unknown as (v) => boolean` call site expects the
boolean-branded i32 this lane lowers `boolean` to, and the funcref-ladder
return bridge had no externref → boolean-i32 arm — so the **live** arm fell
into the dead-arm placeholder `drop; i32.const 0`. Parent probe:

| probe | parent | fixed |
| --- | --- | --- |
| `isView` of compiled `Uint8Array(3)` | `not-view` | `view` |
| `isView` of host `TextEncoder` bytes | `not-view` | `view` |
| `Array.isArray([1,2,3])` | `no` | `yes` |
| `Object.is(1, 1)` | `no` | `yes` |
| `isView([1,2,3])` (anti-vacuity) | `not-view` | `not-view` |
| `Array.isArray(new Uint8Array(3))` (anti-vacuity) | `no` | `no` |
| `Object.is(1, 2)` (anti-vacuity) | `no` | `no` |
| `f(v) ? true : false` (i32-return control) | `view` | `view` |
| same predicate computed inside `mod.js` | `view` | `view` |

**Fix:** one arm at the end of `scalarBridgePlan`, before its final
`return null` —

```ts
if (isHostExtern(from) && to.kind === "i32" && to.boolean === true) {
  return helpers.isTruthyIdx === null ? null : [{ op: "call", funcIdx: helpers.isTruthyIdx }];
}
```

plus `isTruthyIdx` plumbed through the `helpers` type, `dispatchBridgePlan`
(`ctx.funcMap.get("__is_truthy") ?? null`) and `theoreticalHelpers`
(`isTruthyIdx: 0`). The `theoreticalHelpers` field is what makes the
`needsScalarBridge` pre-pass see a non-null plan and run
`addUnionImports` + `flushLateImportShifts` BEFORE the ladder is baked, so no
late import can shift an already-emitted `ref.func` (#2174). Brand-restricted
to `boolean === true` on purpose: plain `i32` also spells native ints and
symbol ids. `scalarAbiTypesMatch` untouched.

**Regression test:** `tests/issue-6415-host-value-predicate-boolean-return.test.ts`
— untyped `mod.js` + typed `entry.ts`, results as strings, `target: "gc"`,
`platform: "web"`, `deferTopLevelInit`. **Parent 4 failed / 5 passed; with the
fix 9 / 9.** Three anti-vacuity cases and the i32-return control are among the
5 that already passed.

**Acceptance criteria:**

1. ✅ Met for a compiled carrier, a host-built typed array, a plain array
   literal (`false`) and a `DataView`. The `DataView` case is asserted as
   AGREEMENT between the two spellings only — the DIRECT
   `ArrayBuffer.isView(new DataView(new ArrayBuffer(8)))` also answers `false`
   on this HEAD (measured, `.tmp/6415/probe-dv.mts`), a separate pre-existing
   defect filed as #6433 and deliberately not folded in here.
2. ✅ Exact counts above.
3. ✅ A/B over the 17 dogfood suites at one HEAD — see the PR body; no suite
   moved, as predicted (the shape needs a typed caller casting an untyped
   module's function to `=> boolean`; the suites are untyped-to-untyped).
4. ✅ Standalone byte-identical — `scalarBridgePlan` returns `null` for
   `ctx.standalone || ctx.wasi` two lines in, above every arm.
   `tests/issue-5150-es2015-buffers.test.ts` has the SAME 8 failed / 10 passed
   on the parent and with the fix (identical failure set, pre-existing on
   `upstream/main`).

**Growth:** +24 lines in `call-identifier.ts` /
`compileIdentifierCall`, and `__is_truthy` 1 → 2 in that file. All three
granted in this file's frontmatter with dated rationale.
