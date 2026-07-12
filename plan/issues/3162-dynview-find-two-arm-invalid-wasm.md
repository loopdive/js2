---
id: 3162
title: "[SOUNDNESS] dyn-view find/findIndex through the #3058 two-arm emits INVALID wasm (fallthru type i32 vs ref) on a mutating predicate"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-find-wasm
sprint: current
created: 2026-07-12
priority: high
task_type: bug
feasibility: medium
area: codegen
goal: standalone
language_feature: typed-arrays, array-methods
test262_category: built-ins/TypedArray/prototype/find
related: [2872, 3058]
parent: 2872
# (#3162) The soundness fix extends `emitDynViewMethodTwoArm` in place (the
# Implementation Plan mandates "extend in place; do not fork a per-method
# two-arm"), so the two-arm's home file grows by the find/findIndex THEN-arm
# routing. Intended, sanctioned growth of the god-file for this change-set.
loc-budget-allow:
  - src/codegen/array-methods.ts
---

# #3162 — dyn-view `find`/`findIndex` two-arm emits INVALID wasm

## Severity: codegen soundness (higher than a CE or a feature gap)

This is **not** a missing-feature gap and **not** a leaked-host-import CE — it is
the compiler emitting a **structurally invalid wasm module** (fails
`WebAssembly.compile`/`instantiate` validation), i.e. a codegen-soundness bug.
Whoever picks it up should treat it as an emitter type-unification fix, not a
feature addition.

## Currently LATENT (why it isn't biting main today)

The bug only manifests when `find`/`findIndex` are members of
`DYN_VIEW_READ_METHODS` (`src/codegen/array-methods.ts`) — i.e. routed through
the #3058 dyn-view two-arm (`emitDynViewMethodTwoArm`). #2872 slice 4
deliberately **excluded** `find`/`findIndex` from that set for exactly this
reason, so main is unaffected. This issue tracks the soundness fix that must
land **before** `find`/`findIndex` (a measured **+13 fail→pass**) can be
lit up.

## Repro

Add `"find"` (and/or `"findIndex"`) to `DYN_VIEW_READ_METHODS`, then compile the
harness shape standalone:

```ts
export function test(): number {
  function run(TA: any): number {
    const a: any = new TA([1, 2, 3]);
    // a mutating predicate is the trigger (test262 predicate-call-changes-value)
    return a.find(function (v: any, i: any, arr: any) { arr[0] = 9; return v === 2; }) === 2 ? 1 : 0;
  }
  return run(Int8Array);
}
```

test262 file: `built-ins/TypedArray/prototype/find/predicate-call-changes-value.js`
(+ the `findIndex` twin, + the `BigInt/` variants).

**Observed** (real runner, `--target standalone`):

```
compile_error: WebAssembly.instantiate(): Compiling function #218:"__closure_5"
failed: type error in fallthru[0] (expected (ref null 4), got i32) @+67789
```

Measured impact when the set includes find+findIndex: **+13 fail→pass but +4
fail→compile_error** — the CEs are these invalid-wasm modules.

## Root-cause hypothesis

The two-arm (`emitDynViewMethodTwoArm`, array-methods.ts) unifies its THEN arm
(the dyn-view-materialized-to-`$__vec_f64` `find` result) and ELSE arm to a
single `externref` branch result via `coerceArmToExternref`. On the
`predicate-call-changes-value` shape the materialized `find` impl over the
f64-vec leaves an **i32** on the stack where the branch fallthrough expects a
`(ref null …)` — the arm result ValType is not being coerced before the
`if`-block's fallthrough. The "expected (ref null 4)" (not `externref`) in the
error suggests the mismatch is between the materialized-vec element ref type and
the branch type, i.e. `find`'s returned ValType for this shape is not the
`externref` `coerceArmToExternref` assumes. Likely the mutating-predicate path
takes a different `find` codegen branch (a closure-capture / re-entrancy arm)
whose result ValType the two-arm doesn't coerce.

Investigate: what ValType does `compileArrayMethodCall(... "find" ..., skipDynViewWrap=true)`
return over an `$__vec_f64` for the mutating-predicate shape, and why
`coerceArmToExternref` leaves it as i32. The fix is almost certainly in the
arm-result coercion / the `find` impl's returned ValType, NOT per-method.

## Acceptance

- With `find`/`findIndex` in `DYN_VIEW_READ_METHODS`, the repro + the four
  `find`/`findIndex` `predicate-call-changes-value{,BigInt}` test262 files
  compile to VALID wasm (no fallthru type error).
- Net for `find`+`findIndex` dyn-view lane: the +13 fail→pass lands with **zero
  fail→CE**.
- `prove-emit-identity` IDENTICAL (gc/wasi/standalone corpus byte-inert — the
  change is dyn-view-two-arm-only).
- No regressions in the broader standalone stride.

## Not in scope (separate #2872 cluster-tracker notes, lower severity)

- `findLast`/`findLastIndex`: missing `__call_1_f64` registration on this path
  (a CE, not invalid wasm) — likely a shared dispatch-arm addition.
- `every`/`some`/`forEach`: detached-buffer regressions (materialization
  snapshots before a mid-callback detach) — a semantics gap, not soundness.
- `map`/`filter`/`sort`/`with`: need a TA-result builder.

## Implementation Plan

(arch, 2026-07-12. Anchors verified on main: `DYN_VIEW_READ_METHODS`
array-methods.ts:3023, `coerceArmToExternref` :3088, `emitDynViewMethodTwoArm`
:3157, the two-arm gate in `compileArrayMethodCall` :3267-3285,
`compileArrayFind` :7747, `setupArrayCallback` :6501,
`compileArrowAsClosure` closures.ts:1853, `computeClosureWrapperSig`
closures.ts:1616, `__hof_find` / `NATIVE_HOF_METHODS` hof-native.ts:57-72.)

### The double-compile mechanism (what "compiled twice" concretely means)

The two-arm compiles the SAME callback `ts.FunctionExpression` node twice:

1. **THEN arm** (`emitDynViewMethodTwoArm` :3201): re-enters
   `compileArrayMethodCall(..., skipDynViewWrap=true)` over the materialized
   `$__vec_f64` → `compileArrayFind` (:7747) → `setupArrayCallback` (:6501)
   → `compileArrowAsClosure(ctx, fctx, cbArg)` (closures.ts:1853) — mints
   `__closure_N` with a wrapper sig from `computeClosureWrapperSig`.
2. **ELSE arm** (:3212): re-dispatches the WHOLE call via
   `compileExpression` — the ordinary externref/standalone path compiles the
   same node AGAIN (a second `__closure_M` mint, via `compileArrowAsClosure`
   or the #3098 closed-method-dispatch HOF arm).

Note `reduce`/`reduceRight` are ALREADY in the set (:3044) and double-compile
their callbacks WITHOUT emitting invalid wasm — so double-mint per se is
tolerated (bloat, not soundness). The find-specific breakage is state that
leaks between the two compiles (or between an arm compile and a late
registration) for the mutating-predicate shape.

### Step 1 — reproduce and pin the broken mint (half a day, do this first)

1. Add `"find"` to `DYN_VIEW_READ_METHODS` (:3023) in a scratch branch.
2. Compile the issue's repro standalone; dump WAT (`.tmp/` probe). Locate
   `__closure_5`: read its DECLARED func type (the `(ref null 4)` result)
   vs its BODY's fallthru (i32), and identify what type index 4 actually is
   (likely `$__vec_f64` or a closure struct).
3. Diff the two mints for the same predicate node (`__closure_4` vs
   `__closure_5` or similar): param types, result type, capture struct.
4. Decide between the two candidate root causes:
   - **H1 — per-node state contamination**: the second
     `computeClosureWrapperSig`/capture analysis run sees memoized per-node
     state from the first (e.g. `addFunctionOwnLocals` memo #2103, contextual
     widen flags like `ctx.forceExternrefCallbackParams`, or the #2939
     dynamic-dispatch pre-scan wrapper-type registration) and mints a body
     whose emitted result no longer matches its registered type.
   - **H2 — late-registration index mismatch**: a helper/type registration
     fired between mint and push INSIDE an arm buffer, so the closure body
     was attached against a stale funcIdx/typeIdx (the #1839-class hazard;
     the two-arm's `savedBodies` patches funcIdx immediates in bodies, but
     a closure minted inside an arm adds a whole defined function). Compare
     against the working `reduce` arm to see what `find` registers extra
     (`compileArrayFind`'s hole-map `holeToUndefinedInstrs` :7818 and the
     `emitCallbackTypeCheck` :7757 are find-specific registrations).

### Step 2 — the fix (two acceptable shapes, prefer A)

**Fix A (class-wide, preferred) — hoist the callback compile out of the
two-arm.** In `emitDynViewMethodTwoArm` (:3157), when `callExpr.arguments[0]`
is an arrow/function expression: compile it ONCE in the OUTER body (before
the `ref.test` split) via `compileArrowAsClosure`, store the closure value in
an outer local, and record it in a per-compile
`WeakMap<ts.Expression, {localIdx, valType}>` (module-scoped beside
`dynViewTwoArmActive` :3064). Teach `setupArrayCallback` (:6501) and the
else-arm's ordinary path to consult that map FIRST and `local.get` the
precompiled closure instead of recompiling the node. This removes the
double-mint for every method in the set (also shrinks reduce/reduceRight
bloat) and makes the arm result types deterministic.

**Fix B (narrower) — route the THEN arm for find/findIndex through the #3098
substrate.** `__hof_find`/`__hof_findIndex` (hof-native.ts, emitted at
reserve time, standalone-only) already run the spec loop over
`__extern_length`/`__extern_get_idx`, which explicitly accept "real
`$__vec_*` arrays" (hof-native.ts:27). THEN arm becomes: validate +
materialize (unchanged, :3195-3198) → `extern.convert_any` the mat vec →
`call __hof_find(matExt, cbExt, undefined)` — result is already externref,
so `coerceArmToExternref` is a no-op and the fragile re-entry into
`compileArrayFind` disappears. The callback is compiled once per arm as an
externref closure via the proven `__apply_closure` bridge. Caveats: (a)
standalone/wasi-only (`ensureNativeArrayHof` returns undefined otherwise —
gate the set membership or keep the re-entry for gc/host); (b) verify
`__hof_find`'s result boxing matches the TA `find` element semantics
(f64 elements → `__box_number`); (c) the mutating predicate mutates the
materialized copy — same semantics the measured +13 already had.

If Step 1 lands on H2 (late-registration), Fix A still applies (the hoist
moves the mint out of the arm-buffer window); additionally pre-ensure the
find-specific registrations (`ensureGetUndefined`/hole map, callback
type-check error machinery) BEFORE the arm split, mirroring the existing
pre-flush pattern in `setupArrayLoop` (:6586-6589).

### Reuse

- `emitDynViewMethodTwoArm` / `coerceArmToExternref` (array-methods.ts:3157/
  :3088) — extend in place; do not fork a per-method two-arm.
- `__hof_find`/`__hof_findIndex` + `reserveApplyClosure`
  (src/codegen/hof-native.ts:57-110, the #3098 callback substrate) — the
  Fix-B loop; already reserve-time/append-only (no funcIdx shift).
- `compileArrowAsClosure` (closures.ts:1853) — the single mint entry; the
  hoist calls it once, nothing new.
- The `savedBodies` late-import-shift discipline already documented in the
  two-arm's doc block (:3152-3156) — any new outer-local emission must stay
  inside that registration.

### Edge cases

- Predicate is an identifier (already-compiled closure value) — the hoist
  map only intercepts inline arrow/function-expression args; identifiers
  keep the existing path.
- 0-arg `find()` — stays excluded by the existing `arguments.length >= 1`
  gate (:3278).
- `findIndex` twin + `BigInt/` variants (the issue's 4 test262 files).
- thisArg 2nd argument (`find(pred, thisArg)`) — `setupArrayCallback`'s
  `compileThisArg` (:6543) must still run per-arm even when the closure is
  hoisted (spec arg-order evaluation happens once — hoist BOTH callback and
  thisArg evaluation to the outer body to keep single-evaluation semantics).
- Do not disturb `reduce`/`reduceRight` byte-behavior beyond removing the
  double-mint (A/B-test the existing dyn-view suites).

### Acceptance / tests

Per the issue's Acceptance section, plus:
- New equivalence test `tests/issue-3162.test.ts`: the repro shape for
  find + findIndex, mutating and non-mutating predicates, thisArg form,
  identifier-callback form.
- `prove-emit-identity` IDENTICAL for the gc/host lanes (set membership +
  two-arm changes are standalone-reachable only if Fix B; Fix A touches the
  shared two-arm — verify the hoist emits byte-identical modules for
  programs without dyn views, which it does by construction since the
  two-arm gate requires `ctx.moduleUsesDynTaView`).

## Resolution (2026-07-12, dev-find-wasm)

Implemented per the Implementation Plan (Fix B, THEN arm through the #3098
substrate). Root cause on current main was NOT only the fallthru type error but
the ELSE arm's `any.find(cb)` re-dispatch binding to a host `env.<TA>_find` +
`env.__make_callback` (invalid standalone module). Two changes:

1. **`src/codegen/expressions/calls-closures.ts`** — added `find`/`findIndex`
   to the #3014/#3139 extern-class dispatch refusal list. `any`-receiver
   `find`/`findIndex` no longer first-match-bind to a host %TypedArray% method;
   they fall to the generic dynamic dispatch → the native `__hof_find`/
   `__hof_findIndex` loop (standalone-clean). This fixes the ELSE arm (and any
   dynamic-receiver find, matching the forEach/some/every precedent).
2. **`src/codegen/array-methods.ts`** — added `find`/`findIndex` to
   `DYN_VIEW_READ_METHODS` (standalone-gated), and the THEN arm now routes the
   materialized `$__vec_f64` through `__hof_<name>(recv, cb, thisArg)` instead
   of re-entering `compileArrayFind`. `__hof_find` returns an externref result
   with the spec `undefined` (`ref.null.extern`) not-found sentinel and threads
   `thisArg` — fixing the legacy re-entry's NaN-boxed miss (`__box_number`,
   which failed `assert.sameValue(result, undefined)`) and dropped thisArg. The
   HOF is pre-ensured before the arm split (funcIdx space settled up front).
   `reduce`/`reduceRight` keep their existing re-entry (byte-identical).

Mutating-predicate semantics: the two-arm materializes a snapshot copy, so a
predicate that mutates the view mid-iteration sees the copy (the plan's Fix-B
caveat (c) — "same semantics the measured +13 already had"). This is soundness-
correct (valid wasm, host-import-free) which is the acceptance target.

## Test Results

- `tests/issue-3162.test.ts` — 9/9 pass (mutating predicate, matched element,
  not-found → undefined, findIndex found/-1, arrow, identifier callback,
  thisArg accepted, reduce undisturbed). Each asserts the module is VALID +
  host-import-free.
- Comprehensive `.tmp` probes: find/findIndex over genuine ArrayBuffer-backed
  dyn views compile to valid, `env`-import-free standalone wasm and return
  correct values.
- `prove-emit-identity` — IDENTICAL (39/39 gc/wasi/standalone corpus emits
  byte-inert; the two-arm change is dyn-view-gated, the refusal change touches
  no corpus file).
- Regression sweep: dyn-view (#3058/#3057), #2872, #3098, #3139/#3014,
  functional-array-methods, findlast, flatmap — all green. The 3 pre-existing
  failures in closed-imports/#1119 (incremental-compiler manifest) also fail on
  base — not introduced here.
- `tsc --noEmit` clean.
