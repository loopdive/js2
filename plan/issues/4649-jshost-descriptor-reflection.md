---
id: 4649
title: "js-host: property-descriptor/reflection harness self-tests — verifyProperty ×2, deepEqual-deep, isConstructor"
status: in-progress
assignee: ttraenkler/senior-dev
loc-budget-allow:
  - src/codegen/typeof-delete.ts
  - src/codegen/dyn-read.ts
  - src/codegen/object-runtime.ts
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
trap-growth-allow:
  count: 16
  reason: "Stale-baseline reclassification carried from merged PR #4794 (realm shim #4634): createRealm().global became a narrowed forwarding object, so 16 cross-realm tests that were ALREADY failing (all baseline fail) null-deref instead of failing an assertion. The js2wasm-baselines JSONL has not re-promoted since, so every queued PR sees the same +15/16 null_deref growth it did not cause. Named per #3596; failure-flavour reclassification only - no baseline-pass test traps. Inert once the baseline re-promotes."
  tests:
    - test/built-ins/AsyncFunction/proto-from-ctor-realm.js
    - test/built-ins/AsyncGeneratorFunction/proto-from-ctor-realm-prototype.js
    - test/built-ins/AsyncGeneratorFunction/proto-from-ctor-realm.js
    - test/built-ins/Function/internals/Call/class-ctor-realm.js
    - test/built-ins/Function/internals/Construct/derived-return-val-realm.js
    - test/built-ins/Function/internals/Construct/derived-this-uninitialized-realm.js
    - test/built-ins/GeneratorFunction/proto-from-ctor-realm-prototype.js
    - test/built-ins/GeneratorFunction/proto-from-ctor-realm.js
    - test/built-ins/Proxy/apply/arguments-realm.js
    - test/built-ins/Proxy/construct/arguments-realm.js
    - test/language/eval-code/indirect/realm.js
    - test/language/expressions/async-generator/eval-body-proto-realm.js
    - test/language/expressions/generators/eval-body-proto-realm.js
    - test/language/expressions/tagged-template/cache-realm.js
    - test/language/types/reference/get-value-prop-base-primitive-realm.js
    - test/language/types/reference/put-value-prop-base-primitive-realm.js
files:
  - src/codegen/typeof-delete.ts
  - src/codegen/context/create-context.ts
  - src/runtime.ts
---

# js-host: descriptor/reflection harness self-tests — 4 failures

Goal context: 100% of `test262/test/harness/` in BOTH lanes; js-host is at
102/116 (2026-08-23, branch `claude/harness-standalone-green`,
`.tmp/run-harness-all-host.mts`). This issue owns the
property-descriptor/reflection bucket:

| test | js-host error |
| --- | --- |
| `verifyProperty-value.js` | `prop descriptor should not be writable; … not be configurable` at L20 — `Object.getOwnPropertyDescriptor` reports wrong flags for a plain data property defined via `Object.defineProperty` |
| `verifyProperty-desc-is-not-object.js` | L12 `assert.throws(Test262Error, …)` did not throw — `verifyProperty(obj, "prop", <primitive desc>)` should reject a non-object descriptor |
| `deepEqual-deep.js` | L12 `assert.deepEqual({}, {a:{x:1},b:[true]})` did NOT throw — deepEqual judges an EMPTY object equal to a non-empty one (own-key enumeration of `{}` vs the compared object is broken somewhere in the harness's `Object.keys`/`getOwnPropertyNames` walk) |
| `isConstructor.js` | `SameValue(«false», «true»)` at source L194 via `__closure_39` — the failing assert maps to L14 `typeof isConstructor === "function"` but the booleans say a later `isConstructor(...)` verdict is wrong; source-map attribution needs re-deriving |

## Implementation Plan (initial — deepen before implementing)

1. **Minimal repros first**, in `.tmp/`, js-host mode:
   - verifyProperty-value — NARROWED (lead, 2026-08-23): the defineProperty
     PRIMITIVE is fine in js-host. Probes passed for BOTH a literal and a
     dynamic (variable, field-mutated) descriptor: writes blocked under
     `writable:false`, delete blocked under `configurable:false`, for-in
     empty under `enumerable:false`. So the failure lives in the harness
     composition: `reset(desc)` REASSIGNS the module-level `obj` from inside
     a function (closure-captured outer-var write), `desc.value = prop`
     mutates the param, and `verifyProperty` then reads `obj`. Suspect the
     closure write to `obj` not being visible to the later read, or
     verifyProperty's own restore/probe sequence. One SEPARATE latent finding
     while probing: a sloppy-mode write to a non-writable prop THROWS
     TypeError ("Cannot assign to read only property") instead of silently
     no-oping — propertyHelper catches, so it is probably not this test's
     cause, but it is a spec deviation worth its own note/issue if confirmed.
   - deepEqual-deep — NARROWED (lead, 2026-08-23): NOT an enumeration bug.
     `for-in` over `{}`/`{a,b}` is correct (probe passed), and the file's
     lines 10+12 alone pass — including the `assert.throws(Test262Error,
     function () { assert.deepEqual({}, {a:{x:1},b:[true]}); })` closure. The
     failure appears ONLY when line 13's third closure
     (`…deepEqual({a:{x:1},b:[true]}, {a:{x:1},b:[false]})`) is ALSO present:
     then the SECOND line's closure stops throwing (error attributes
     `__closure_92` via the L12 call site). Three-line repro kept at
     `test262/test/tmpprobe/deep4.js`-shape (recreate; tmpprobe is not
     committed). Suspect cross-closure/cross-literal type unification (the
     structurally-similar closures or the `[true]`/`[false]`/`{}` literals
     sharing an inferred shape) changing deepEqual's path — diagnose by
     diffing the compiled module with/without line 13.
   - isConstructor — the failing assert is one of the
     `assert.sameValue(isConstructor(function(){}), true)` /
     `…(Array), true)` lines (got false): the include's
     `Reflect.construct(function(){}, [], f)` THROWS for a legitimate
     constructor `f`, so `try/catch` answers false. js-host
     `Reflect.construct` with an explicit `newTarget` argument is the
     suspect — probe it directly first.
2. Fix the underlying builtin(s) in the js-host lane. These are almost
   certainly host-import/object-runtime issues, not parser issues — locate the
   js-host lowering for `defineProperty`/`getOwnPropertyDescriptor`
   (`src/codegen/object-runtime.ts` + host imports in `src/runtime.ts`) before
   assuming a compiled-JS bug.
3. **Watch cross-lane gating**: fixes must not disturb the standalone
   descriptor path (FLAG_* machinery) — standalone category must stay 113/116
   on the stacked base.

## Acceptance criteria

- The 4 tests pass js-host (`.tmp/run-harness-all-host.mts` shows them green).
- Standalone category unchanged (113/116 on the stacked base) and js-host
  sample 59/60 (`.tmp/run-host-list.mts`, `.tmp/host-sample.txt` —
  AsyncDisposableStack failure is pre-existing).

## Progress (2026-08-23) — 3 of 4 done, `isConstructor` remains

Status stays `in-progress`: `isConstructor.js` needs an IsConstructor bit the
compiler does not have (section 4 below), which is its own piece of work.

Three of the four flip. Each had a DIFFERENT root cause; none of the three was
where the initial triage pointed, so the diagnosis notes below are the
load-bearing part of this entry.

### Method that actually worked

Hand-written probe files kept disagreeing with the harness, because a test262
file is compiled as ONE unit (`assembleOriginalHarness` → prefix + body) and the
compiler's answers are order- and type-context-dependent. The technique that
settled every question: dump the assembled source
(`assembleOriginalHarness(...).primary.source`), edit tracing INTO the harness
copy, and re-run it as a `flags: [raw]` test. That is the only probe shape that
compiles the same module the failing test does.

### 1. `verifyProperty-desc-is-not-object.js` — JSDoc typeof fold

`propertyHelper.js` is a `// @ts-check` JS file; `verifyProperty` carries
`@param {PropertyDescriptor|undefined} desc`. The js-host lane const-folded
`typeof desc` to `"object"`, so the helper's own
`assert.sameValue(typeof desc, "object", …)` primitive rejection was
unreachable — `verifyProperty(o,"p",true)` returned normally. Traced: the
harness reported `[preCheck typeof=object]` for `true`, `42` AND
`"configurable"`.

The unsound-fold guard for annotation-free JS parameters already existed
(`typeofFoldUnsoundForJsParam`, #4394) but was gated `standalone || wasi`. JSDoc
is unenforced at runtime in every lane, so the gate is gone. Bonus flip:
`asyncHelpers-asyncTest-rejects-non-callable.js`.

### 2. `verifyProperty-value.js` — the host proxy's descriptor lied

`_wrapForHost`'s `getOwnPropertyDescriptor` trap hardcoded `writable: true` and
`configurable: true`; only `enumerable` had learned to read the sidecar flags
table (#2714/#3647). So a compiled object BEHAVED correctly under
`{writable:false, configurable:false}` (the write threw, the delete was
refused) while `[[GetOwnProperty]]` reported it fully mutable — precisely the
round-trip this test checks. Minimal repro:

```js
var g = Object.getOwnPropertyDescriptor;              // → the RAW host function
var o = Object.defineProperty({}, "p", { value: 1, writable: false, configurable: false, enumerable: false });
Object.getOwnPropertyDescriptor(o, "p");              // w=false c=false  (direct lowering)
g(o, "p");                                            // w=TRUE  c=TRUE   (via the proxy trap)
```

The alias reaches the trap because `var g = Object.getOwnPropertyDescriptor`
lowers to `__extern_get(__get_builtin("Object"), "getOwnPropertyDescriptor")` —
the real V8 function — which then runs against the `_wrapForHost` proxy. (A
value-read closure that routes to the runtime's own `__getOwnPropertyDescriptor`
exists in `builtin-value-read.ts`, but it is `ctx.standalone`-gated. Routing the
host lane through it too is a much broader change and was NOT taken.)

Accessor-flagged sidecar entries deliberately keep the old shape, and a refused
target mirror now serves the target's locked descriptor so the §10.5.5 proxy
invariant cannot be violated.

Gate note: `check:host-import-policy` pins `src/runtime.ts` at **exactly** 17949
lines — a hard no-growth ratchet, separate from and stricter than the LOC budget
(which an issue-file `loc-budget-allow` can waive). Any host-runtime fix has to
pay for its own lines; this one did, by compacting the trap's comment and the
adjacent #2714/#3647 blocks. Budget the edit for that up front.

### 3. `deepEqual-deep.js` — emission-time `ctx.vecTypeMap` snapshot

NOT a cross-closure/type-unification problem, and the failing line is the THIRD
one, not the second (the source map attributed it to L12). Minimal repro,
independent of any closure:

```js
assert.deepEqual._compare({ b: [true] },  { b: [false] });   // true  — WRONG
assert.deepEqual._compare({ b: [1] },     { b: [2] });       // false — right
assert.deepEqual._compare([true],         [false]);          // false — right
```

Traced inside a `raw` copy of the harness: for the inner `boolean[]` values
`isArrayLikeEquatable` answered **false** for BOTH, so `_compare` fell through
to `compareStructuralEquality`, whose `for (var key in a)` found **no own keys**
on either — two empty key sets compare EQUAL. The dynamic `.length` read
answered `0` for the same values.

Root cause: `Array.isArray`'s host-lane `ref.test` chain
(`emitArrayIsArrayExternrefPredicate`) and the dynamic `.length` vec arm
(`dyn-read.ts`) both bake `Array.from(ctx.vecTypeMap.values())` — an
**emission-time snapshot**. The harness prefix is compiled BEFORE the test body,
so a carrier first minted by the body is invisible to everything the prefix
baked. #2047 fixed exactly this for standalone by deferring `__extern_is_array`
to a finalize fill; the host lane was left on the snapshot.

`boolean[]` is the carrier this bites because it is the one common primitive
array element kind the harness itself never mints (`number[]` → `f64`,
`string[]` → `externref`, `[]` → `externref` are all pre-registered or
harness-used). Proof (A/B): prepending `var __warm = [true, false];` to the
assembled source flips `_compare` to `false` with `arrA=true`, `LEN 1/1`.

Fix taken — **late binding, the same discipline #2047 gave standalone**, applied
per predicate because the two ask different questions:

- **`Array.isArray` (host lane)**: the inline ladder becomes a CALL to a new
  module-local `__host_array_carrier` (`src/codegen/host-array-carrier.ts`),
  minted with a placeholder body on first use and filled at finalize from
  `collectStandaloneArrayCarrierTypeIdxs` — the same list `fillExternIsArray`
  uses, so the §7.2.2 byte-carrier exclusions come along for free. The fill is
  invoked from `fillExternIsArray`, which already runs at both finalize sites.
  Modules with no dynamic `Array.isArray` never mint it and are byte-identical.
- **the dynamic `.length` vec arm**: one `ref.test $__vec_base` replaces the
  per-type ladder. `$__vec_base` is the declared supertype of every concrete vec
  and carries `length` as field 0 (#2186), so this is a strict SUPERSET of the
  ladder — the byte vecs it also matches were already in `ctx.vecTypeMap` and
  therefore already in the ladder, and `.length` is a legitimate question for a
  byte vec anyway.

Three alternatives were tried and REJECTED; the reasons matter for anyone
extending this:

- **Pre-registering the `i32` carrier in `createCodegenContext`** (next to the
  existing `externref`/`f64`). It works — all three tests flipped — but it puts
  `__vec_i32` in the WAT of modules that never build an i32 array, and #1197's
  "promotion did NOT fire" assertions read exactly that string: **9 new
  equivalence regressions** in shard 1. This is why the gate exists; the
  harness numbers alone would have shipped it.
- **A dedicated `i32_bool` cache key** (so a plain-`i32` pre-registration could
  not steal the boolean element brand). It compiles to invalid Wasm: elem keys
  are matched as STRINGS in several places — `vec-access-exports.ts` boxes only
  `elemKey === "i32"` through `__box_number`, and the new key fell through to
  `extern.convert_any` on an i32, so `__vec_get` failed validation on every
  test. A new elem key is a multi-site change, not a one-line one.
- **`ref.test $__vec_base` for `Array.isArray`** (what the `.length` arm does).
  Wrong there: every byte vec, subview, TypedArray view and the regexp
  match-result struct also subtypes `$__vec_base` (#3562/#4443), so
  `Array.isArray(new Uint8Array(2))` would answer true.

Residual: `Array.isArray`'s host path still gates minting the predicate on
`ctx.vecTypeMap` being non-empty. That is currently unconditional (the
`externref`/`f64` pre-registrations), so it is inert — but it is the last
emission-time read left on this path.

### 4. `isConstructor.js` — NOT FIXED (residual, needs its own issue)

Root cause is established and is a real missing capability, not a patch:

```js
Reflect.construct(function(){}, [], f)   // f = a compiled closure
// → TypeError: [object Object] is not a constructor
```

`__reflect_construct_newtarget` wraps a wasm-struct `newTarget` with
`_wrapForHost`, which is NOT callable, so V8's IsConstructor(newTarget) check
(§26.1.2 step 3) rejects every compiled function. `Array` as newTarget passes;
the TARGET argument passes only because it is an inline function EXPRESSION and
therefore takes #4394's `__make_callback_ctor` constructible bridge.

The naive repair — route closure structs through `_wrapCallableForHost` the way
`__construct_closure` already does — is WRONG in the other direction: the
compiler has no runtime notion of constructibility at all. Measured:

```js
new arrow();   // succeeds — spec says TypeError
new gen();     // succeeds — spec says TypeError
```

so arrows and generators would start reporting `isConstructor === true` and the
test's three `false` assertions would fail instead. A correct fix needs an
IsConstructor bit reachable from an opaque closure value. Sketched options, both
too broad for this issue:

- a per-allocation constructible flag in the closure wrapper struct + a
  `__is_ctor_closure` export (mirrors `__is_closure`, `closure-exports.ts` bit
  17), consumed by `__reflect_construct*`, `__construct` and
  `__construct_closure`;
- distinct root wrapper types for non-constructible callables — rejected: two
  closures of the same signature would stop being assignable to one slot.

The compile-time predicate to reuse is `callableHasConstructBehavior`
(`callback-ctor-bridge.ts`); it already encodes §15.2.4 correctly.

### Measurements (this worktree, `.tmp/run-harness-all*.mts`)

| lane | before | after |
| --- | --- | --- |
| js-host `test/harness/` | 102 / 116 | 106 / 116 |
| standalone `test/harness/` | 112 / 116 (with the quickjs eval provider built) | 112 / 116 |
| js-host 60-file sample (`.tmp/host-sample.txt`) | 59 / 60 | 59 / 60 |
| `equivalence-gate.mjs` (3 local runs) | 24 known-failures in baseline | no new regressions |

CI on the PR (`loopdive/js2#4804`) is green on all six required checks plus all
eight `equivalence-shard` jobs, `issue-tests`, `linear-tests` and
`cross-backend-parity`; `mergeable_state: clean`.

The js-host base of 102 is the branch base measured in this worktree before any
edit. The standalone base of 112 was measured after building the quickjs eval
provider (`npx tsx scripts/build-quickjs-eval-provider.mjs`); without it the
same tree reads 110 because four files fail with "provider is not built", which
is a local-environment artifact, not a lane result.

The js-host `+4` is the three targets plus
`asyncHelpers-asyncTest-rejects-non-callable.js`, which the typeof-fold change
recovered for free. No previously-passing file in either lane regressed; the
remaining js-host failures are the same set as the base minus those four.

## Permanent repro

`test262/test/harness/verifyProperty-value.js` and
`test262/test/harness/deepEqual-deep.js` (js-host lane,
`tests/test262-runner.ts` `runTest262File(..., undefined)`).
