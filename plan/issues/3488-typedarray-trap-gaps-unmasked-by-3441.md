---
id: 3488
title: "TypedArray compiler trap-gaps (.set / bit-precision / invoked-as-func) — unmasked by #3441, tighten the #3189 ratchet back"
status: ready
created: 2026-07-20
priority: medium
task_type: bug
area: test262-conformance
goal: test262-conformance
sprint: current
horizon: m
related: [3441, 3189, 3202, 3335]
loc-budget-allow:
  - src/codegen/expressions/calls.ts
---

# #3488 — TypedArray trap-gaps unmasked by #3441

## Summary

#3441 (worker-lane test262 sandbox parity — the TypedArray cluster + Atomics
were missing from `scripts/test262-worker.mjs`) let the TypedArray harness
corpus run PAST `__module_init` for the first time. That is a large net win
(+647 host, ~656 tests improve). But it also **unmasked pre-existing compiler
trap-gaps**: 28 TypedArray tests that used to die early at `__module_init`
(catchable "Cannot convert null to object") now execute their body and hit an
**uncatchable Wasm trap** (`null_deref` / `oob`), tripping the #3189
uncatchable-trap ratchet in the merge_group.

To land #3441 the ratchet was widened with a **temporary** per-category valve
(`TRAP_RATCHET_TOLERANCE` / `BASELINE_TRAP_GROWTH_ALLOW` repo variables, reset to
0 after #3430 landed). This issue tracks IMPLEMENTING the underlying gaps so the
ratchet floor tightens back — mirrors #3487 (illegal_cast fix-forward).

**These are NOT new miscompiles from #3441.** The traps are latent compiler gaps
in TypedArray semantics that were previously hidden behind the module-init
failure. #3441 only made them observable.

## Newly-trapping tests (from #3430 merge_group, run 29711072322)

### `null_deref` (+19; 166 → 185)

- `TypedArray/prototype/Symbol.toStringTag/BigInt/invoked-as-func.js`
- `TypedArray/prototype/Symbol.toStringTag/invoked-as-func.js`
- `TypedArray/prototype/buffer/invoked-as-func.js`
- `TypedArray/prototype/byteLength/invoked-as-func.js`
- `TypedArray/prototype/byteOffset/invoked-as-func.js`
- `TypedArray/prototype/length/invoked-as-func.js`
- `TypedArray/prototype/copyWithin/bit-precision.js`
- `TypedArray/prototype/set/bit-precision.js`
- `TypedArray/prototype/slice/bit-precision.js`
- `TypedArray/prototype/map/return-new-typedarray-conversion-operation-consistent-nan.js`
- (+9 more — pull the full list from the run's `test262-regressions-report` artifact)

Two sub-families:
1. **`*/invoked-as-func.js`** — calling a `%TypedArray%.prototype` accessor/method
   as a bare function (no TypedArray receiver) must throw a catchable `TypeError`
   ("called on a non-object / incompatible receiver"), but the codegen null-derefs
   the missing receiver instead. This is the reflective-accessor null-receiver
   guard gap (cf. #3441's sibling finding at `property-access.ts:1015`, routed to
   dev-3422 as #728).
2. **`*/bit-precision.js`** — bit-level round-trip checks that hit a null-deref in
   the element codec path.

### `oob` (+9; 48 → 57)

- `Promise/allSettled/resolve-element-function-length.js`
- `TypedArray/prototype/set/BigInt/boolean-tobigint.js`
- `TypedArray/prototype/set/BigInt/string-tobigint.js`
- `TypedArray/prototype/set/array-arg-offset-tointeger.js`
- `TypedArray/prototype/set/array-arg-primitive-toobject.js`
- `TypedArray/prototype/set/array-arg-set-values.js`
- `TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-same-type-sab.js`
- `TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-same-type.js`
- `TypedArray/prototype/with/index-validated-against-current-length.js`

Dominated by `TypedArray.prototype.set` argument-coercion paths (`ToInteger`
offset, `ToObject` primitive arg, cross-buffer copy) that index out of bounds
instead of doing the spec-ordered bounds check → catchable `RangeError`. Related
to the earlier `.set` bounds work in #3202 / #3335.

## Acceptance

- The listed tests no longer hit an uncatchable trap (they pass, or fail with a
  CATCHABLE error the harness can assert on).
- Reset `TRAP_RATCHET_TOLERANCE` / `BASELINE_TRAP_GROWTH_ALLOW` to 0 (already done
  post-#3430) and confirm the ratchet holds at the tightened floor (null_deref
  ≤ 166, oob ≤ 48, or the new post-fix counts).

## Notes

Filed as the #3441 fix-forward so the temporary trap-tolerance valve is provably
transitional, not a permanent floor raise. Suggest splitting into two slices:
(a) `invoked-as-func` reflective null-receiver TypeError (overlaps #728), and
(b) `TypedArray.prototype.set` OOB → catchable RangeError.

## Slice (a) — LANDED (reflective accessor `invoked-as-func`)

**Corrected root cause (verify-first, NOT the filed "getter null-receiver guard"
framing).** The getter body is already correct: `getter.call(undefined)` from JS
throws a catchable `TypeError` ("Method get TypedArray.prototype.length called on
incompatible receiver"), and both `prop-desc.js` and `invoked-as-accessor.js`
already pass. The trap was in the **compiled call path**, not the getter and not
the descriptor:

- `var getter = Object.getOwnPropertyDescriptor(proto, "length").get; getter();`
  resolves `.get` to a **HOST-function-valued externref** (a host callable, NOT a
  wasm closure struct). The bare-identifier call dispatch (`call-identifier.ts`)
  tests it against the closure-struct type, the `ref.test` fails → a null closure
  cast, and because the raw callee is non-null the guarded null-check does **not**
  throw — it falls through to `struct.get <closure> 0` on the null and
  `null_deref`-traps.
- The `__call_function` host-callable fallback arm already exists
  (`call-identifier.ts:1625`, #1712/#3335) but is gated by
  `calleeMayBeHostCallable` (`calls.ts`), which only recognised
  `var f = Object.hasOwn`-style host-builtin-member inits — NOT the reflective
  `gOPD(o, k).get`/`.set` accessor extraction. So the host arm was never emitted
  and the trapping path ran.

**Fix**: `calleeMayBeHostCallable` now recognises the syntactic
`Object.getOwnPropertyDescriptor(o, k).get`/`.set` extraction shape (no checker
query → oracle-ratchet-safe; narrow → `#1941` dual-mode host-import-free guarantee
for pure local-closure programs preserved). The `__call_function` arm is then
emitted, the reflective getter dispatches through the host, and `getter()` with an
undefined `this` throws the CATCHABLE `TypeError` the harness asserts.

**Measured (host lane, verify-first, pre vs post over all 51 `*/invoked-as-func.js`):**

- `28 pass / 5 fail / 18 fail(TRAP)` → `44 pass / 5 fail / 2 fail(TRAP)`.
- **+16 host flips**, 16 `null_deref` traps eliminated, **0 regressions**.
- Remaining 2 traps are `intl402/NumberFormat/*` (Intl — unrelated skip-feature
  territory); remaining fails are `TypedArrayConstructors/{from,of}` statics + an
  Intl PluralRules test (different shapes, out of scope).
- Broad regression sweep (62 tests: TypedArray `prop-desc` + `invoked-as-accessor`
  + `Object.getOwnPropertyDescriptor` + RegExp `invoked-as-func`) is byte-identical
  pre/post — zero conformance regressions.

Covered by `tests/issue-3488.test.ts`.

## Remaining slices (NOT in this PR — re-scope / re-file)

- **(b) `TypedArray.prototype.set` OOB (+9).** Verify-first correction: this is
  **NOT** an offset-coercion bug — offset `ToInteger` works in a statically-typed
  `compileTypedArraySet` context (confirmed: `sample.set([42], "")` / `1.9` on a
  real `Float64Array` passes). The listed tests fail because `sample = new TA(
  makeCtorArg([...]))` (an `any`-typed receiver) constructs a **length-0 host view**
  via the source-array→host-`%TypedArray%`-ctor **marshaling** gap — this is
  **#3335 value-rep territory**, already partly guarded to a *catchable* TypeError.
  Making these PASS needs real marshaling work (produce a correct-length view), not
  a `.set` bounds change. Warrants its own value-rep issue.
- **(c) `*/bit-precision.js` (null_deref).** These trap **inside the test262
  harness catch block** (`testTypedArray.js`: `e.message += " (Testing with …)";
  throw e`), i.e. a separate error-object/`.name`/string-concat root cause in the
  harness rethrow path — NOT the element codec the filing guessed. Warrants its own
  scoped issue.

The `TRAP_RATCHET_TOLERANCE` / `BASELINE_TRAP_GROWTH_ALLOW` reset + full ratchet
tightening stays blocked on (b)+(c); this PR removes the 16 `invoked-as-func`
`null_deref` traps.
