---
id: 2742
title: "String.prototype methods: ToString(this) generic-receiver coercion, RequireObjectCoercible, and function `.length` own property"
status: in-progress
assignee: ttraenkler/opus-loop-d
sprint: current
created: 2026-06-27
updated: 2026-07-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen, runtime
es_edition: ES5
language_feature: string-methods
goal: es5
related: [2670]
depends_on: []
# (#3102 ratchet) Accessor-return marshalling belongs beside its sibling
# host-value bridges and closure caches in runtime.ts. The merge-group
# regression repair also needs source rest-parameter metadata and one narrow
# emitted classifier: the generic host dispatcher cannot materialize a rest vec,
# so the runtime must classify that source shape before exposing the closure.
# PR #3753 keeps lastIndexOf's method-specific NaN fallback beside the shared
# native-string integer-argument lowering.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/closure-exports.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/string-ops.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
---
# #2742 — String.prototype generic-receiver `ToString(this)` coercion

Every `String.prototype` method begins with `RequireObjectCoercible(this)` then
`ToString(this)` — it must work when `this` is **not** a primitive string
(a `Number`/`Boolean`/`Array`/plain-`Object` wrapper, or `null`/`undefined`).
Our implementations assume a string receiver, so the large
`built-ins/String/prototype/*` cluster fails on the generic-receiver path. This
mirrors #2670 (Array generic array-like receiver) but for String, and is a
single clean root cause spanning ~50 tests.

## Failing patterns / test262 files (current main)

**(a) Non-string `this` must be `ToString`-coerced** (e.g.
`__instance = new Object(42); __instance.charAt = String.prototype.charAt;
__instance.charAt(0)`):
- `test/built-ins/String/prototype/charAt/S15.5.4.4_A1_T1.js`
- `test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A1_T1.js`
- `test/built-ins/String/prototype/indexOf/S15.5.4.7_A1_T1.js`
- `test/built-ins/String/prototype/lastIndexOf/S15.5.4.8_A1_T1.js`
- `test/built-ins/String/prototype/slice/S15.5.4.13_A1_T1.js`
- `test/built-ins/String/prototype/substring/S15.5.4.15_A3_T1.js`,
  `…/S15.5.4.15_A3_T2.js`, `…/S15.5.4.15_A3_T4.js`
- `test/built-ins/String/prototype/concat/S15.5.4.6_A1_T10.js`

**(b) `null`/`undefined` `this` must throw a real `TypeError`
(`RequireObjectCoercible`), not an internal null-deref:**
- `test/built-ins/String/prototype/charAt/S15.5.4.4_A2.js`,
  `…/charAt/S15.5.4.4_A1.1.js`, `…/charAt/S15.5.4.4_A5.js`
- `test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A2.js`,
  `…/charCodeAt/S15.5.4.5_A4.js`
- `test/built-ins/String/prototype/slice/S15.5.4.13_A3_T4.js`,
  `…/slice/S15.5.4.13_A1_T5.js`
- `test/built-ins/String/prototype/substring/S15.5.4.15_A3_T7.js`,
  `…/substring/S15.5.4.15_A3_T10.js`

**(c) `this` whose `valueOf`/`toString` must run through `ToPrimitive`/`ToString`
ordering (trim family):**
- `test/built-ins/String/prototype/trimStart/this-value-object-tostring-meth-priority.js`
- `test/built-ins/String/prototype/trimEnd/this-value-object-toprimitive-meth-priority.js`
- `test/built-ins/String/prototype/trimStart/this-value-object-valueof-meth-priority.js`
  (currently `Cannot convert object to primitive value` runtime traps)

**(d) Each `String.prototype.X` must expose a `length` own data property
(function arity):**
- `test/built-ins/String/prototype/charAt/S15.5.4.4_A8.js`
- `test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A8.js`
- `test/built-ins/String/prototype/indexOf/S15.5.4.7_A8.js`
- `test/built-ins/String/prototype/substring/S15.5.4.15_A8.js`

## Acceptance criteria

- Group (a): a `String.prototype` method invoked with a non-string `this`
  (`new Number(n)`, `new Boolean(b)`, `new Array(...)`, plain object) coerces via
  `ToString(this)` and returns the spec result. ≥8 of the listed (a) files pass.
- Group (b): `null`/`undefined` `this` throws `TypeError`; ≥7 of the listed (b)
  files pass (no `dereferencing a null pointer` / `Cannot access property` trap).
- Group (c): the trim-family `this`-ToPrimitive ordering tests stop trapping;
  ≥2 of 3 pass.
- Group (d): `String.prototype.{charAt,charCodeAt,indexOf,substring}.hasOwnProperty('length')`
  is `true`; all 4 listed (d) files pass.
- **Target: ≥40 of the ~66 ES3-core `String.prototype` generic-receiver tests
  fixed.** No regression in currently-green String tests.

## Implementation notes

**Group (d) fixed** (PR #2742-d carve-out, 2026-06-27): The test runner was
incorrectly transforming `obj.propertyIsEnumerable(key)` → `obj.hasOwnProperty(key)`
globally, which masked the non-enumerable nature of builtin function `.length`.
The codegen (`compilePropertyIntrospection`) already correctly emits
`__propertyIsEnumerable` for `externref` receivers (native functions), which
delegates to `Object.prototype.propertyIsEnumerable.call(obj, key)` in the
runtime — returning `false` for the non-enumerable `.length` own property. Fix:
removed the two blanket `propertyIsEnumerable→hasOwnProperty` transforms from
`wrapTest()` in `tests/test262-runner.ts`. All 4 group-(d) test262 files now pass;
no regressions in currently-passing tests.

**Groups (a)/(b)/(c) remain open** — substrate-gated (generic-receiver
`ToString(this)` coercion). Tracked in this issue; assigned separately.

## Scope / out of scope
- IN: charAt, charCodeAt, indexOf, lastIndexOf, slice, substring, concat,
  trim/trimStart/trimEnd generic-receiver + `ToString(this)` + `.length`.
- OUT: regex-driven methods (`match`/`matchAll`/`replace`/`replaceAll`/`split`/
  `search`) — those depend on the RegExp engine residual (#2161); `localeCompare`
  / `normalize` / Unicode case-folding (toLowerCase/toUpperCase locale) — separate
  Unicode-substrate slice; BigInt-argument coercion tests (blocked).
- Spec: ES2023 §22.1.3 String.prototype methods; `RequireObjectCoercible` §7.2.1,
  `ToString` §7.1.17.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — group carve-out. Group (d) (builtin function .length non-enumerable + a test-runner fix) landed. The headline ToString(this) generic-receiver coercion for String.prototype methods (charAt/charCodeAt/indexOf/slice/substring/concat...) + remaining groups remain. Stays in-progress.

## Measurement re-grounding (2026-07-26, opus-loop-d) — the group framing above is WRONG

Before writing code I re-ran the **exact 22 files this issue lists** through
`runTest262File` on `main` @ `e16edd48a`, with a positive control (a String test
expected to pass) and a negative control (a deliberately-wrong expectation) to
prove the harness can report both outcomes. **Baseline: 10 pass / 12 fail.**
Three of this issue's claims do not survive contact with the measurement.

**1. Group (a) is essentially ALREADY FIXED — 8 of its 9 listed files pass on
`main` today.** `charAt`/`charCodeAt`/`indexOf`/`lastIndexOf`/`slice` +
3× `substring` with a non-string `this` all pass. Only `concat/S15.5.4.6_A1_T10`
fails, and for an unrelated reason (an *argument*'s `toString`, not the
receiver's). The issue's headline — "our implementations assume a string
receiver" — is stale.

**2. Group (b) is MISLABELLED.** It is described as `RequireObjectCoercible`
(null/undefined `this`). It is not: genuine `String.prototype.charAt.call(undefined)`
already throws a proper `TypeError` on `main` (probed directly). The 8 failing
(b) files are two *different* mechanisms:

- **6 files — "X is not a function".** Shape is
  `__FACTORY.prototype.charAt = String.prototype.charAt; new __FACTORY().charAt(…)`.
  **This is NOT String-specific.** The decisive control: assigning a *plain user
  function* to a user constructor's prototype (`F.prototype.m = function(){…}`)
  and calling it fails **identically** (`m is not a function`). The real defect is
  **dynamic `F.prototype.X = …` augmentation followed by an instance call** — a
  separate, broader issue that should not be filed under String.
  Note `charAt/S15.5.4.4_A1.1` additionally uses `eval("1")`, so it is
  `runtime-eval`-gated regardless.
- **2 files — `charAt/S15.5.4.4_A5`, `charCodeAt/S15.5.4.5_A4`** ("dereferencing
  a null pointer"). These belong with group (c): the receiver's own
  `toString`/`valueOf` must run and propagate a user throw.

⚠️ **This also corrects the #3626 census's C1 `missing_builtin` classification.**
The census reads the "`X` is not a function" signature (58 corpus-wide) as
*"genuinely missing methods — add/repair the method"*. Measured here, the methods
are **present and correct**; the failure is prototype-chain augmentation. Sizing
any work off "add the missing method" would be sizing off a mislabel.

**3. Group (c) is the one real in-scope defect — root-caused and fixed below.**

## What landed in this slice (group (c) root cause)

Traced through the host-marshalling boundary with the argument actually handed to
V8's native `String.prototype.trim`:

```
arg0: rawIsWasmStruct=false  toStringType=undefined  valueOfType=object
      descs=toString:getter,valueOf:getter   valueOfIsWasmStruct=true
```

`get valueOf() { return function () { … }; }` lowers the inner function to a
**WasmGC closure struct**. The getter itself was already bridged (V8 can invoke
it), but its **return value crossed back raw**, so V8 saw
`typeof o.valueOf === "object"` — not callable. In `OrdinaryToPrimitive`
(§7.1.1.1 step 5.b `IsCallable(method)`) a non-callable method is silently
**skipped**; with `toString` also non-callable the algorithm reaches step 6 and
throws `"Cannot convert object to primitive value"`.

**Fix** (`src/runtime.ts`): `_wrapAccessorGetterReturn` marshals an accessor
getter's return through `_maybeWrapCallableUnknownArity`, which converts only
values `__is_closure` positively identifies and passes everything else through.
Deliberately confined to the **accessor** path — marshalling *generic* call exits
was tried and reverted for regressing ~85 dstr files (#3123/#2835), which is also
why `wasmClosureDynamicBridge` carves out the `new`-path only.

Post-fix, the receiver now matches V8 exactly on the encoded probe
(`toStringAccessed=1, valueOfAccessed=1`, `trim` → `"xy"`; V8 = 111).

## Honest result — gross fixed and regressions, separately

- **Regressions: 0** (22-file set re-run; equivalence suite green).
- **test262 files flipped by this slice: 0 of 22.** The pass count is 10 → 10.
  The 3 group-(c) files move *past* the spurious `TypeError` to a deeper
  assertion, but do not flip.
- **New coverage: 3 tests red on the merge base**, green with the fix
  (`tests/issue-2742.test.ts`, group (c) block), plus 2 narrowness/no-regression
  guards green on both.

This slice removes a real spec violation and a whole spurious-`TypeError` class;
it does **not** claim conformance flips it cannot demonstrate.

## Remaining blockers (measured, not guessed)

1. **`@@toPrimitive` on the receiver is never consulted.** With a
   `get [Symbol.toPrimitive]()` present, the encoded probe returns `0` accesses
   where V8 gives `1` (`toString`/`valueOf` are now correct at 1/1). This is what
   still blocks all 3 group-(c) test262 files — they assert the *access counters*,
   not just the value. Symbol-keyed accessors are not reaching the host
   ToPrimitive path.
2. **Dynamic `F.prototype.X = …` then instance call** (the 6 "not a function"
   files) — broader than String; needs its own issue.
3. **`concat/S15.5.4.6_A1_T10`** — argument-side `toString`, unrelated to the
   receiver.

Stays `in-progress`: this closes the group-(c) root cause, not the issue.

## Merge-group regression remediation (PR #3660, 2026-07-26)

The bot-held merge-group run `30187000346` tested immutable merge commit
`ff373100552e1d6c4f9c792a8eecf6e01fadbd23`. Recomputing the gate from its
downloaded candidate artifact against exact selected baseline
`100c90d3b71426b6ec2cf6a6e920878325ac1a02` found 33 stable regressions after
flakiness/quarantine filtering, 42 fine-gate improvements, and signature
`fc7292a8a6f761c1`. The trap ratchet also isolated one new
`illegal_cast`: `test/built-ins/Object/keys/proxy-keys.js`.

There were two causal defects:

1. The first implementation wrapped the already-cached getter bridge in a
   second JavaScript function. Accessor getter identity is observable, so
   `Object.getOwnPropertyDescriptor(o, "x").get === getter` became false and a
   SameValue redefinition of a non-configurable accessor incorrectly threw.
   The repair marks bridge-owned getter functions and marshals the return inside
   that same bridge. No new function replaces the descriptor getter.
2. `proxy-keys.js` returns a source rest closure from an accessor. Rest lowering
   gives that closure one concrete Wasm vec formal, but a native `Proxy` call
   supplies positional host arguments. Sending the first host argument through
   the generic dynamic dispatcher therefore trapped in a concrete `ref.cast`.
   `ClosureInfo` now records the source rest shape and the module emits a narrow
   `__closure_has_rest` discriminator. The accessor bridge leaves such closures
   raw, preserving current-main's accepted `missing_builtin` limitation instead
   of worsening it to an uncatchable Wasm trap. Ordinary zero- and nonzero-arity
   returned functions are still bridged.

No-capture closures reuse a signature-keyed wrapper type. A non-rest closure
with the exact same concrete vec signature is therefore conservatively left raw
too; captured closures retain distinct subtypes. This bounded tradeoff avoids an
ABI change to closure structs in a regression-only repair.

This deliberately does not catch and retry a trapped dynamic call, alter any
Test262 baseline, or broaden generic call-exit marshalling (the latter already
regressed ~85 dstr files in #3123/#2835).

Validation after merging current `main` (`f7d1187fa2c79e0153731308200ebb2c6cac274b`):

- `tests/issue-2742.test.ts`: 15/15 pass, including getter identity,
  non-configurable SameValue redefinition, an arity-1 returned setter, and the
  rest-closure trap guard.
- Exact immutable affected set: 75/75 Vitest cases pass — all 33 stable
  regressions and all 42 fine-gate improvements.
- Exact controls: the three dominant identity regressions pass;
  `proxy-keys.js` reports `missing_builtin` (“not a function”), with no
  `illegal_cast`.

## `lastIndexOf` NaN-position residual (PR #3753, 2026-07-28)

Standalone lowering now preserves `lastIndexOf`'s from-end sentinel when a
position expression coerces to `NaN` or `undefined`. Other integer-indexed
String methods retain their ordinary NaN-to-zero behavior.

Exact local-vs-local Test262 A/B on base `c5bd4631724afa`:

- JS-host directory: 19/25 → 19/25; ES5 subset: 15/21 → 15/21.
- Standalone directory: 15/25 → 17/25; ES5 subset: 11/21 → 13/21.
- Fail→pass: `S15.5.4.8_A1_T10.js` and `S15.5.4.8_A4_T3.js`.
- Pass→fail: none. Every remaining failure kept the same normalized signature.
