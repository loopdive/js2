---
id: 4626
title: "Standalone test262 harness/ self-test gaps — symbol keys, typeof symbol, realm shim"
status: in-progress
sprint: current
created: 2026-08-22
updated: 2026-08-22
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
lane: B
assignee: ttraenkler/claude-remote
files:
  - src/codegen/object-ops.ts
  - src/codegen/typeof-natives-finalize.ts
  - src/codegen/literals.ts
  - src/codegen/expressions/new-super.ts
loc-budget-allow:
  - src/codegen/object-ops.ts
  - src/codegen/typeof-natives-finalize.ts
  - src/codegen/literals.ts
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  - src/codegen/object-ops.ts::emitStandaloneDefinePropertyKeyToString
  - src/codegen/typeof-natives-finalize.ts::fillStandaloneTypeofClosureArms
  - src/codegen/expressions/new-super.ts::tryCompileNativeConstructFromValue
---

# #4626 — Standalone test262 `harness/` self-test gaps

## Problem

The merged-state run at PR #4740's merge_group counted the `test/harness/`
self-test category at **100 pass / 16 fail** standalone (99/17 js-host). The
16 standalone failures decompose into fixable primitive gaps and deep feature
gaps.

## Fixed in the first slice (4 tests)

- `propertyhelper-verifyenumerable-enumerable-symbol.js`
- `propertyhelper-verifynotenumerable-enumerable-symbol.js`
- `verifyProperty-desc-is-not-object.js`
- `deepEqual-primitives.js`

Root causes fixed:

1. **`Object.defineProperty` dropped symbol keys** (`object-ops.ts`): the
   standalone ToPropertyKey helper ToString-ed EVERY key, aliasing
   `Symbol("x")` to the string `"Symbol(x)"` — the id-keyed `$Object` runtime
   then never found the property from `o[sym]` /
   `getOwnPropertyDescriptor(o, sym)`. Now a `ref.test $Symbol` passes the
   carrier through unchanged.
2. **`typeof` answered "object" for `$Symbol` carriers**
   (`typeof-natives-finalize.ts`): the `__typeof` /  `__typeof_object`
   natives had no symbol arm, so `assert.sameValue(typeof desc, "object")`
   in propertyHelper ACCEPTED a Symbol desc. Spliced "symbol" / exclusion
   arms at the same finalize pass as the closure arms.
3. **`Symbol()` result was an unbranded i32** (`literals.ts`): any-channel
   coercions boxed it via `__box_number`. Now carries `symbol: true` so
   `coerceType` routes through `__box_symbol` — gated to the native-symbol
   lanes (`usesNativeSymbolProvider`) after the 2026-08-23 park: branding it
   in the js-host lane routed mid-emission coercions through
   `ensureLateImport(__box_symbol)`, a late host-import insertion that shifts
   baked function indices (#608/#794 hazard).
4. ~~Runner realm shim~~ **REVERTED after a merge_group park (2026-08-23,
   run 32620945052)**: giving `createRealm()` named function-expression error
   constructors (`function TypeError(msg) {…}`) put builtin-shadowing fnctor
   NAMES into the `$262` preamble compiled into EVERY `needs262` test module.
   The name-keyed fnctor machinery then resolved `new TypeError(...)` in test
   code to the shim's fnctor — 367 js-host regressions with wasm-hash change
   (216 "invalid Wasm binary", `e instanceof TypeError` false, Temporal
   buckets >50). Any future realm shim must use NON-shadowing spellings
   (e.g. `realm.TypeError = makeRealmCtor("TypeError")`).

Verified: 45-test standalone sample over symbol/typeof/defineProperty
baseline-pass tests — 0 regressions; all 8 baseline-pass `createRealm`
tests still pass; equivalence shards spot-checked clean; js-host harness
untouched (its own 17 failures unchanged, none new).

## Fixed in the second slice

- `testTypedArray-conversions.js` — the #3981 ordinary-[[Construct]] arm
  (`tryCompileNativeConstructFromValue`, `new-super.ts`) claimed
  `new TA(...)` for an any-typed callee BEFORE the #2872 dynamic-TA arm ever
  ran, constructing a plain native object (`.length` 0, `.fill` "called value
  is not a function"). Fixed with a runtime `ref.test $__ta_ctor` two-arm
  inside that arm (gated on `noJsHost && moduleUsesDynTaView`): a TA-ctor
  callee routes through `emitTaDynCtorConstructFromLocals`; every other value
  keeps the ordinary-construct driver byte-for-byte.

Residual found while reducing (NOT one of the 16): the DECLARED alias form
`var TA = Int8Array; new TA([5])` misreads the array argument as a length
(`.length` 5) — filed as **#4635**.

## Remaining standalone failures (10) — root causes surveyed

| Test(s) | Gap |
| --- | --- |
| asyncHelpers-* (5) | → **#4630** (asyncTest/thenable semantics; one null-deref trap) |
| deepEqual-mapset | → **#4629** (Set/Map member dispatch through `any`: `.size`, `Symbol.iterator`, `.next()` all missing) |
| compare-array-symbol | → **#4632** (symbol[] elements are raw i32 ids; `String` renders the id number) |
| deepEqual-primitives-bigint | → **#4631** (standalone BigInt carrier) |
| assert-throws-same-realm, (throwsAsync-same-realm) | → **#4634** (non-shadowing realm-shim error ctors) + #4630 for the async trap |
| wellKnownIntrinsicObjects | → **#4633** (intrinsic identity across the runtime-eval boundary) |
| detachArrayBuffer-host | FIXED (third slice): the runtime shim's `var $262` collided with the test's own `var $262` override (no last-assignment-wins for duplicate top-level vars); `assembleVariant` now renames the shim part's `$262` occurrences when the body declares one. Fixes BOTH lanes. |
| testTypedArray-conversions | FIXED (second slice, above) |
