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
  - tests/test262-runner.ts
loc-budget-allow:
  - src/codegen/object-ops.ts
  - src/codegen/typeof-natives-finalize.ts
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/object-ops.ts::emitStandaloneDefinePropertyKeyToString
  - src/codegen/typeof-natives-finalize.ts::fillStandaloneTypeofClosureArms
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
   `coerceType` routes through `__box_symbol`.
4. **Runner realm shim** (`tests/test262-runner.ts`): `createRealm()` now
   exposes distinct per-realm error constructors, the prerequisite for the
   same-realm discrimination tests (see remaining gaps — not sufficient
   alone).

Verified: 45-test standalone sample over symbol/typeof/defineProperty
baseline-pass tests — 0 regressions; all 8 baseline-pass `createRealm`
tests still pass; equivalence shards spot-checked clean; js-host harness
untouched (its own 17 failures unchanged, none new).

## Remaining standalone failures (12) — root causes surveyed

| Test(s) | Gap |
| --- | --- |
| asyncHelpers-* (5) | asyncTest/thenable semantics through harness closures (one null-deref trap in an async resume) |
| deepEqual-mapset | Set/Map member dispatch through `any` (`.size`, `Symbol.iterator`, `.next()` all missing → trap/false) |
| compare-array-symbol | symbol[] elements are raw i32 ids in `$__arr_i32`; `map.call(arr, String)` renders the id number |
| deepEqual-primitives-bigint | BigInt standalone (`env::__new_BigInt` host-import refusal) |
| assert-throws-same-realm, (throwsAsync-same-realm) | `.constructor` on an instance of a user fn NAMED like a builtin resolves to the BUILTIN by name; plus a null-deref in the full-harness assembly |
| wellKnownIntrinsicObjects | `%Array%` intrinsic identity (`Object.is(Array, intrinsic)`) |
| detachArrayBuffer-host | `$262.detachArrayBuffer` error-shape mismatch |
| testTypedArray-conversions | "called value is not a function" in the conversions harness |
