---
id: 5145
title: "ES2015 standalone: array conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/array-methods.ts
  - src/codegen/array-concat-spec.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/iterator-native.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/vec-props.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/array-prototype-borrow.ts
  - src/codegen/array-holes.ts
  - src/codegen/context/types.ts
coercion-sites-allow:
  # `! ToString(k)` is a literal step of CreateDataPropertyOrThrow's caller
  # (§23.1.3.x "CreateDataPropertyOrThrow(A, ! ToString(k), …)"), not a
  # hand-rolled coercion matrix: the STRING spelling of the index is the key
  # both the $vec index lane and the $Object prop table agree on. Measured
  # 2026-08-28: a number-boxed key lands in a slot the vec's own indexed read
  # never consults, so the pre-existing entry kept winning.
  - src/codegen/array-species.ts
func-budget-allow:
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/array-methods.ts::compileArraySpliceCore
  - src/codegen/array-methods.ts::compileArrayFill
  - src/codegen/array-methods.ts::compileArrayCopyWithin
  - src/codegen/array-methods.ts::compileArrayFilter
  - src/codegen/array-methods.ts::compileArrayMap
  - src/codegen/array-methods.ts::compileArraySlice
  - src/codegen/array-methods.ts::compileArraySliceFromVecLocal
  - src/codegen/array-methods.ts::compileArraySplice
  - src/codegen/array-methods.ts::compileArrayConcat
  - src/codegen/array-concat-spec.ts::compileArrayConcatNativeSpecFromExprs
  - src/codegen/array-concat-spec.ts::compileArrayConcatNativeSpecFromReceiverAndArgsVec
  - src/codegen/array-prototype-borrow.ts::compileArrayPrototypeCall
  - src/codegen/array-holes.ts::scanForArrayHoles
---

# #5145 — ES2015 standalone: array conformance wave 1

The loc-budget-allow grant above is deliberate: this change-set adds an
ArraySpeciesCreate/CreateDataPropertyOrThrow protocol lane, concat protocol
fixes, and Array.from/of completion in the listed files — measured growth,
rationale dated 2026-08-28 (this issue). A NEW file
`src/codegen/array-species.ts` for the species helper is also fine (and
preferred over growing array-methods.ts further).

## Problem

125 ES2015-bucket `built-ins/Array/**` test262 tests fail in STANDALONE mode
(pure Wasm, zero host imports; re-verified against head 2026-08-28 — all 125
from the day-old baseline still fail: 119 FAIL, 6 COMPILE_ERROR). The dominant
gap is the observable-constructor protocol: no native method consults
`constructor`/`@@species` when creating its result, and result writes use raw
stores instead of CreateDataPropertyOrThrow. Second and third are
`Array.prototype.concat` protocol residuals (incl. a 6-test invalid-Wasm
codegen bug) and the unfinished `Array.from`/`Array.of`. This package is ~1/8
of the remaining ES2015 standalone gap (#2860 umbrella).

Target list (exact, re-verified): `.tmp/es2015/wp-array-current-fails.txt`
(125 paths). Probe: `npx tsx .tmp/run-standalone.mts --list <file>` (split >150
lines; some tests take 20 s).

## Current failure clusters

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| 1 | ArraySpeciesCreate + CreateDataPropertyOrThrow | 61 | `src/codegen/array-methods.ts:compileArraySliceFromVecLocal` (+ splice/map/filter cores) mint `struct.new $vec` directly, documented as deliberate at array-methods.ts:4716-4721; `src/codegen/array-concat-spec.ts:319` hardcodes `__objvec_new` for ArraySpeciesCreate (documented under-approximation, :78-81). No species read, no Construct, raw stores instead of define semantics. | `prototype/map/create-species.js`, `prototype/splice/create-species-poisoned.js`, `prototype/filter/target-array-with-non-writable-property.js` |
| 2 | concat protocol residuals | 21 | (a) 6× COMPILE_ERROR: reflective `.call/.apply` lowering (`src/codegen/expressions/calls.ts` ~L7655) emits `call_ref` "need 3, got 2" against the variadic concat proto-closure ABI (`array-object-proto.ts:813-815` → `compileArrayConcatNativeSpecFromReceiverAndArgsVec(ctx,fctx,1,2)`); (b) IsConcatSpreadable in `array-concat-spec.ts` lacks the §23.1.3.1.1 step-1 "Type(E) is Object" gate (primitives spread when `Boolean.prototype[@@isConcatSpreadable]=true`); (c) symbol/indexed props on wrapper/function/RegExp/TypedArray carriers invisible to `__extern_get`; (d) arguments-object elements read back `null` not `undefined`; (e) `$Hole` marker leaks as uncaught GC exception (sparse). | `prototype/concat/Array.prototype.concat_array-like.js` (CE), `prototype/concat/Array.prototype.concat_spreadable-boolean-wrapper.js`, `prototype/concat/Array.prototype.concat_sloppy-arguments.js` |
| 3 | Array.from / Array.of incomplete | 20 | `src/codegen/expressions/call-builtin-static.ts` ~L1140-1200: direct-call arms cover only string/generator/mapFn-vec shapes — no array-like (non-iterable) source arm ("value is not iterable"), mapfn invoked with 3 args via `__hof_map` instead of (value, index); reflective/value form hits the generic refusal `src/codegen/builtin-value-read.ts:1570`; no this-constructor protocol (`Array.from.call(C, …)`), no IteratorClose on abrupt, `__array_from_mapped` (`iterator-native.ts` ~L690) traps "requested new array is too large" on iterables; `of` writes via Set not CreateDataPropertyOrThrow. | `from/source-object-length.js`, `from/iter-cstm-ctor-err.js`, `of/does-not-use-prototype-properties.js` |
| 4 | ToIntegerOrInfinity(Symbol) silently truncates | 5 | fill/copyWithin arg lowering (`array-methods.ts:compileArrayFill` :8817, copyWithin case :2298) compiles index args in `{kind:"f64"}` context — a Symbol coerces silently instead of TypeError. Verified by probe: `[1,2,3].fill(0, Symbol())` does not throw. | `prototype/fill/return-abrupt-from-start-as-symbol.js`, `prototype/copyWithin/return-abrupt-from-target-as-symbol.js` |
| 5 | keys/values/entries not callable as values | 3 | `src/codegen/array-object-proto.ts:871` — `emitArrayProtoMemberBody` refusal arm; no dynamic array-like iterator core for the reflective form. | `prototype/values/returns-iterator-from-object.js` |
| 6 | ArraySetLength define semantics | 3 | `Object.defineProperty(arr, "length", …)` misses the §10.4.2.4 double-ToNumber coercion order and non-writable/redefine TypeErrors; `vec-props.ts:461` notes the named-expando lane is NOT ArraySetLength. | `length/define-own-prop-length-coercion-order.js` |
| 7 | Proxy-trap-dependent (defer) | 4 | has/deleteProperty traps + revoked-proxy IsArray TypeErrors — belongs to the proxy work package, not this wave. (The two concat `is-concat-spreadable-*-proxy-revoked` tests are counted in cluster 2; defer them too if they need real traps.) | `prototype/copyWithin/return-abrupt-from-has-start.js`, `isArray/proxy-revoked.js`, `prototype/splice/property-traps-order-with-species.js` |
| 8 | Realm NewTarget carrier (defer) | 3 | `Codegen error: standalone Reflect.construct distinct NewTarget is not implemented for this target carrier (#3371)` — #3371 residual. | `proto-from-ctor-realm-zero.js` |
| 9 | Misc singles (stretch) | 5 | `@@unscopables` object (2), `toLocaleString` must call element `.toLocaleString()` (2), `Array[@@species]` accessor prop-desc (1). | `prototype/Symbol.unscopables/value.js`, `prototype/toLocaleString/primitive_this_value.js` |

Cluster counts include overlap-free assignment; 1+2+3 = 102/125 (82%).
Within cluster 1, three `flat/target-array-*` tests additionally require the
native flat arm (`array-methods.ts:9996` `tryCompileArrayFlatNativeDepth1`,
#3363) to accept heterogeneous receivers — they only reach species semantics
after that refusal is passed; treat them as the tail of cluster 1.

## Implementation Plan

Do clusters in this order (count-descending — partial completion maximizes
yield). No new host imports without a standalone fallback (this whole issue is
standalone-lane: everything below is Wasm-native). Never edit
`tests/test262-runner.ts`, skip lists, or `scripts/*baseline*.json`. New
codegen needing type info goes through `ctx.oracle` (`src/checker/oracle.ts`),
never raw `ctx.checker` (oracle-ratchet gate).

### Step 1 — `__array_species_create` runtime helper (cluster 1, 61 tests)

New file `src/codegen/array-species.ts` (or a section of
`object-runtime-descriptors.ts` if the deps make that easier). Register a
native helper `__array_species_create(recv: externref, len: f64) -> externref`
following the `registerNative` reserve-then-fill pattern of
`object-runtime-descriptors.ts:buildObjectDescriptorHelpers` (see also
`vec-props.ts` "Reserve-then-fill" for the funcIdx-ordering discipline).
Body implements §9.4.2.3 (ES2015 numbering; §10.4.2.3 in current text):

1. `C = Get(recv, "constructor")` via `__extern_get` — for `$Vec` receivers
   this already consults the #3537 expando bag, which is where
   `a.constructor = {}` lands, so the read works today.
2. `C === undefined` → return a **default sentinel** (`ref.null extern` works:
   `undefined` is a non-null singleton under the #undefined-singleton regime,
   so null is unambiguous) — the caller keeps its existing fast path.
3. `C` is an object → `C = Get(C, @@species)` — symbol-keyed `__extern_get`
   with the boxed well-known symbol; copy the @@isConcatSpreadable read
   pattern already in `array-concat-spec.ts` (it boxes the symbol and calls
   `__extern_get`). `C` null/undefined → default sentinel.
4. `C` not a constructor → throw TypeError (use `ensureExnTag` +
   the emitThrowTypeError-style throw used across `array-object-proto.ts`).
   Abrupt completions from the two Gets propagate naturally through the
   exception tags — do NOT catch them.
5. Else `Construct(C, «len»)` through the existing dynamic construct channel
   `__construct_closure` (`closure-exports.ts`; call pattern:
   `src/codegen/expressions/new-non-constructable-value.ts:110` — it already
   handles prototype installation and the non-constructable TypeError).
   Return the constructed object (externref).

Default-sentinel edge cases the caller handles: `len` is passed as f64 with
`-0` normalized to `+0` (slice/splice `create-species-neg-zero.js` asserts
`args.length===1 && args[0]===0` — pass exactly one argument); default lane
`ArrayCreate(len)` with `len ≥ 2^32` → RangeError
(`create-species-undef-invalid-len.js`).

**Wire-up (one method at a time, each independently landable):** in the native
cores — `compileArraySliceFromVecLocal`, the splice core, the map/filter HOF
cores (all `array-methods.ts`), and the concat spec loop
(`array-concat-spec.ts:319`) — call `__array_species_create(this, len)` first.
Null sentinel → existing `struct.new $vec` / `__objvec_new` path, byte-for-byte
unchanged (perf + all currently-passing tests preserved). Non-null → run a
**generic extern-target loop**: same element sequence, but writes go through a
new `__create_data_prop_or_throw(target, idx, value)` helper (Step 2) and the
final result is the constructed object, not a vec. concat's loop is already
extern-shaped ($ObjVec) so it only needs the target swap + write-helper swap;
slice/map/filter/splice need the extern arm added beside the vec arm.

### Step 2 — `__create_data_prop_or_throw` (cluster 1's target-array-* tail)

Build on the existing descriptor machinery in
`object-runtime-descriptors.ts` (`__defineProperty_value`,
`__object_isExtensible`, the `$PropEntry.$flags` bits): define
`{value, writable:true, enumerable:true, configurable:true}`; if the target is
non-extensible and the key absent, or the existing property is
non-configurable, → TypeError. NOTE `map/target-array-with-non-writable-property.js`:
a *configurable* non-writable existing property is REDEFINED successfully
(result is writable:true value:2) — this is define semantics, not Set; a plain
`__extern_set` fails that test, which is why the write helper is load-bearing.
splice/map also `Set(A, "length", n)` at the end per spec — plain
`__extern_set` there, NOT the define helper.

### Step 3 — concat protocol residuals (cluster 2, 21 tests)

3a. **The call_ref CE (6 tests) — fix first, it's a codegen invalid-Wasm bug.**
Minimal repro (compiles in ~10 s):
```js
var obj = { "length": 6, "1": "A" };
var actual = Array.prototype.concat.call(obj, [1]);
```
`npx tsx src/cli.ts <file> --target standalone -o /tmp/x.wasm` →
`Compiling function "__module_init" failed: not enough arguments on the stack
for call_ref (need 3, got 2)`. The reflective `.call/.apply` lowering
(`calls.ts` ~L7655) invokes the `Array.prototype.concat` closure, whose body
is the VARIADIC (this, argsVec) ABI (`array-object-proto.ts:813-815`), through
an arity-style `call_ref` that pushes one operand too few. Either marshal
`.call` args into the argsVec ABI for this member, or route
`Array.prototype.concat.call(recv, …)` to `compileArrayConcatNativeSpec` the
way `call-receiver-method.ts:722` already does for the
`x.concat = Array.prototype.concat` install shape. Verify with the repro
before running the test list.

3b. **Primitive gate in IsConcatSpreadable** (`array-concat-spec.ts` spreadable
check): per §23.1.3.1.1 step 1, if E is not an Object the answer is `false`
*without* reading `@@isConcatSpreadable` — currently
`Boolean.prototype[Symbol.isConcatSpreadable] = true` makes the primitive
`true` spread (`concat_spreadable-boolean-wrapper.js` L38, verified by probe:
per-instance wrapper spreading already works, the primitive arm is the bug).
Gate on the value-carrier brand tests (there are existing "is object"
predicates in the object runtime — reuse, don't invent).

3c. **Carrier property visibility**: `@@isConcatSpreadable`/indexed/`length`
expando reads on Boolean/String wrapper, function, and RegExp receivers must
reach the same bags that `$Object`/`$Vec` have (#3537 / #3468 family;
`closure-props.ts` is the function-carrier lane — compose, don't edit, per the
#3468 ownership note in `vec-props.ts`). String-wrapper spreading yields code
units (`concat_spreadable-string-wrapper.js`).

3d. **arguments-object element mapping**: spreading an arguments object gives
`null` where `undefined` is expected (`concat_sloppy-arguments.js`,
`_strict-arguments.js`) — map absent/undefined slots through the undefined
singleton in the arguments carrier's indexed read, mirroring what
`__extern_get_idx` does for `$ObjVec`.

3e. **Hole marker leak**: `concat_spreadable-sparse-object.js` dies with
"uncaught Wasm-GC exception (non-stringifiable payload)" — a `$Hole` sentinel
escapes to a reader that doesn't translate it. Audit the output readers listed
in the `array-concat-spec.ts` header ("output readers map the marker back to
undefined") for the path this test takes.

3f. `arg-length-exceeding-integer-limit.js` (n+len > 2^53-1 TypeError) —
investigate why the documented step 5.c.iii check doesn't fire; likely the
proxy-backed `length` read answers 0. If it needs proxy get traps, move the
test to cluster 7 (defer) and say so in the PR.

### Step 4 — Array.from / Array.of completion (cluster 3, 20 tests)

Existing native pieces to build on, not duplicate: `__array_from_iter_n`
(#2904) and `__array_from_mapped` (#3206) in `iterator-native.ts`; the
string/generator/mapFn direct-call arms in `call-builtin-static.ts`
~L970-1200.

4a. **Array-like (non-iterable) source arm** (§23.1.2.1 step 4 onward): when
`GetMethod(items, @@iterator)` is undefined, loop `len = ToLength(Get(items,
"length"))`, `Get(items, k)` — kills the "value is not iterable" family
(`from/source-object-length.js`, `-without.js`, `-missing.js`). Reads via
`__extern_length`/`__extern_get_idx` exactly like the #4394 HOF loop.

4b. **mapfn call shape**: from's mapper is called with exactly `(value, k)` —
`from/iter-map-fn-args.js` measures `args[0].length === 2`; routing through
`__hof_map` passes 3. Add a 2-arg mapper variant or a flag on the loop.

4c. **this-constructor protocol** for both `from` and `of`: if
`IsConstructor(this)` → `Construct(this)` / `Construct(this, «len»)` via
`__construct_closure`, else plain array. This unlocks
`from/iter-cstm-ctor*.js`, `of/construct-this-with-the-number-of-arguments.js`.
Element writes via `__create_data_prop_or_throw` (Step 2) — that is what
`of/does-not-use-prototype-properties.js` and the return-abrupt-from-data-
property tests check (abrupt define → propagate the ORIGINAL error, today it
surfaces as TypeError). Then `Set(A, "length", n)`.

4d. **IteratorClose on abrupt** (`from/iter-set-elem-prop-err.js` measures
`closeCount === 1`): on an abrupt define/mapper completion, call the
iterator's `return` before rethrowing. `iterator-native.ts` /
`iter-lazy-native.ts` carry the existing IteratorClose emission for for-of —
reuse that pattern.

4e. **Reflective/value form** (`Array.from` read as a value, `.call` forms):
the generic refusal at `builtin-value-read.ts:1570` needs a real closure for
`from`/`of` that runs the same core as 4a-4d (mirror how
`emitArrayProtoMemberBody` gives Array.prototype members reflective bodies).

4f. Fix `__array_from_mapped`'s "requested new array is too large" trap on
iterable sources (`from/iter-map-fn-err.js`) — it sizes the result from a
garbage length; grow-on-push instead.

### Step 5 — Symbol → TypeError in fill/copyWithin index args (cluster 4, 5 tests)

In `compileArrayFill` (`array-methods.ts:8817`) and the copyWithin arm
(:2298), before the `{kind:"f64"}` arg compile: statically-known symbol args
(`ctx.oracle.staticJsTypeOf(arg) === "symbol"` — same oracle call the
Array.from mapper rejection uses, `call-builtin-static.ts:1162`) emit the
"Cannot convert a Symbol value to a number" TypeError; the exact emitter
pattern lives in `src/codegen/expressions/unary.ts:57-69`. Evaluate preceding
args first so side-effect order is preserved. (Dynamic externref args are the
rarer shape; if the f64 coercion path has a shared ToNumber funnel, add the
`$Symbol` brand test there — otherwise static coverage alone flips all 5
tests, which all pass Symbol() literally.)

### Step 6 — keys/values/entries reflective cores (cluster 5, 3 tests)

Replace the refusal at `array-object-proto.ts:871` for these three members
with a dynamic array-like iterator: ToObject(this) guard (copy the #4394 HOF
receiver guard in the same function), then produce the native array iterator
over `__extern_length`/`__extern_get_idx` reads. The native iterator
state-struct machinery is in `iterator-native.ts`; the direct `a.values()`
lowering already emits one — factor its core so the reflective closure can
drive it from an externref receiver.

### Step 7 (stretch) — ArraySetLength (cluster 6, 3 tests)

§10.4.2.4 in the vec `length` define path (`vec-props.ts` — the :461 comment
marks where ArraySetLength is NOT yet implemented): ToNumber(value) twice
(coercion-order tests observe both hints), RangeError on mismatch, TypeError
on redefining non-writable length. Small but fiddly; do only after 1-6 are
green.

### What NOT to do

- No new `env::*` host imports — this is the standalone lane; the runner
  fails any module that emits one (`standaloneHostImportError`).
- Do not edit `tests/test262-runner.ts`, any skip list, or
  `scripts/*-baseline.json` (main is the baselines' sole writer).
- Do not touch `closure-props.ts` (#3468-owned — compose via the
  buildVecOrClosure* layering, see `vec-props.ts` header).
- Do not regress the fast paths: the species read must cost one helper call
  with a null-sentinel early-out; the vec arms stay byte-equivalent when no
  custom constructor is present.
- Clusters 7 (proxy traps) and 8 (realm NewTarget, #3371) are explicitly OUT
  of scope — do not chase those 9 tests here.
- Raw `ctx.checker.getTypeAtLocation` is ratcheted — `ctx.oracle` only.

## Acceptance criteria

- All tests in `.tmp/es2015/wp-array-current-fails.txt` pass via
  `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-array-current-fails.txt`
  — except the 9 explicitly-deferred cluster 7/8 tests (list them in the PR if
  still failing) and cluster 9 stretch singles.
- Every test in `.tmp/es2015/wp-array-passing-spotcheck.txt` (40 paths) still
  passes via the same probe.
- Ratchet gates pass: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports` (run bare,
  never piped).
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## References

- #2860 — standalone-vs-js-host gap umbrella (this wave's parent goal).
- #3575 — the DEFAULT-lane (js-host gc) ArraySpeciesCreate/@@isConcatSpreadable
  issue (ready, backlog, XL). Same protocol, different lane; the
  `__array_species_create` helper built here on the native substrate is the
  standalone half. Cross-link in the PR; do not duplicate its default-lane
  analysis.
- #1359 (done) — introduced the vec fast paths; @@species deliberately left as
  the "Slice B follow-up" (array-methods.ts:4716). This issue IS that follow-up
  for standalone.
- #4446 (done) — native concat spec loop; its two documented
  under-approximations (ArraySpeciesCreate, hole marker) are clusters 1/2 here.
- #3537 (done) — vec expando bag: why `a.constructor = {}` on an array is
  readable at all; pattern for the cluster-2c carrier bags.
- #3206 / #2904 (done) — existing Array.from native pieces to extend.
- #2717 / #3363 (done) — flat native depth-1 arm; the 3 flat tests need its
  heterogeneous-receiver extension plus species.
- #3371 (done, residual) — standalone Reflect.construct distinct NewTarget:
  cluster 8's refusal message cites it.
- #3468 — own-property carrier family; ownership boundary for cluster 2c.

## Results (wave 1, 2026-08-28)

Probe: `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-array-current-fails.txt`
(125 paths), run before and after on the same worktree.

| | before | after |
|---|---|---|
| pass | 0 | **44** |
| fail | 119 | 73 |
| compile_error | 6 | 8 |

Regression guard `.tmp/es2015/wp-array-passing-spotcheck.txt`: **40/40 PASS**
before and after. Gates green: loc / func / coercion-sites / oracle-ratchet /
dead-exports. `tests/equivalence/array*` — 99/100, the one failure
(`array-inline-return.test.ts > find does not hijack return`, a TypeScript
`number | undefined` assignability error in the fixture) reproduces on a clean
HEAD checkout of the same worktree, so it is pre-existing.

Per-method after-counts: concat 13, slice 7, splice 7, filter 6, map 6,
copyWithin 3, fill 2.

### Landed

- **Cluster 1 — ArraySpeciesCreate + CreateDataPropertyOrThrow.** New
  `src/codegen/array-species.ts`: a §10.4.2.3 prologue (`Get(O,"constructor")` →
  `Get(C, @@species)` → IsConstructor refusal → `__native_construct_1`) emitted
  BEFORE each producer's element loop, plus a result swap that re-publishes the
  vec's elements onto the constructed object through `__defineProperty_value`
  and `Set`s `length`. Wired into `slice` (incl. the reflective proto-member
  body), `map`, `filter`, `splice` (both the general and the 0-arg arms) and
  `concat` (both entries).
- **Cluster 3a — the concat `call_ref` invalid-module bug (6 tests).**
  `Array.prototype.concat.call(recv, …)` now routes to a new
  `compileArrayConcatNativeSpecFromExprs` instead of the reflective `.call`
  lowering, whose arity-shaped `call_ref` pushed one operand too few against
  concat's variadic `(this, argsVec)` proto closure.
- **Cluster 4 — Symbol index args (5 tests).** `fill`/`copyWithin` now throw
  "Cannot convert a Symbol value to a number" for a statically-known Symbol in
  an index position, after evaluating receiver + all args for side effects.

### Escape gate (why this is byte-neutral for ordinary programs)

`ctx.arraySpeciesDirty`, set by the `scanForArrayHoles` pre-scan when the module
mentions `Symbol.species` or assigns a `.constructor` property. Clear ⇒ the
producers keep their raw `struct.new $vec` result AND their static
`(ref null $vec)` result type. This matters beyond size: the species arm widens
the result to `externref`, which would otherwise push unrelated typed code onto
the dynamic lane. The JS-host lane is excluded outright
(`arraySpeciesActive` requires `standalone || wasi`).

Also load-bearing: the prologue treats `C === %Array%` as the default lane. In
standalone there is one set of intrinsics, so another realm's `Array` IS this
carrier — which is §10.4.2.3 step 6 for the only realm shape this target has,
and it is what keeps `slice/create-proto-from-ctor-realm-array.js` (asserts the
species getter is NOT invoked) passing.

### Deliberately NOT done — with the blocking reason

- **Symbol-keyed properties on FUNCTION / wrapper carriers (~14 tests).**
  `Holder[Symbol.species] = C` where `Holder` is a function does not read back
  through `__extern_get`, so the species chain resolves to `undefined` and falls
  to the default lane. Same substrate hole spreads
  `concat_spreadable-function` / `-boolean-wrapper` / `-reg-exp` /
  `-string-wrapper`. This is the plan's cluster 2c (#3468 own-property carrier
  family) and is the single largest remaining item in this package. Affected:
  `{map,filter,slice,splice}/create-proxy.js`, `-create-revoked-proxy.js`,
  `create-proto-from-ctor-realm-non-array.js`, `concat/create-proxy.js`,
  `concat/create-proto-from-ctor-realm-non-array.js`.
- **`target-array-with-non-writable-property` (5 tests) — NOT a species bug.**
  Reduced to a species-free repro: `Object.defineProperty(q, 0, …)` on a `$vec`
  followed by `verifyProperty(q, 0, …)` already fails on clean HEAD — the
  descriptor read answers the defined value while the harness's dynamic
  `obj[name]` read answers the stale dense slot. `Reflect.get(arr, 0)` is
  likewise `undefined` for a plain `[7]`. A separate vec-index/overlay-read
  issue; the species transfer writes both lanes (define + `Set`) and is not what
  is wrong.
- **`create-species-undef-invalid-len` (2 tests).** Needs `ArrayCreate(len)`'s
  RangeError for `len ≥ 2^32`, but the receiver length reaches the prologue
  through an **i32** vec field, where `2^32` has already truncated to 0. Needs a
  wider length carrier, not a species change.
- **`concat_sloppy-arguments` / `_strict-arguments` / `-with-dupes` (3).** The
  arguments carrier answers `__extern_has_idx` true for indices past the
  supplied argument count and then yields `ref.null`, so absent slots surface as
  `null` instead of `undefined`. Cluster 3d; a fix belongs in the carrier's
  indexed read, not in concat.
- **`concat_spreadable-sparse-object` (1).** `$Hole` still escapes to a reader
  that does not translate it ("uncaught Wasm-GC exception"). Cluster 3e.
- **Clusters 3 (Array.from/of, 20), 5 (keys/values/entries reflective, 3),
  6 (ArraySetLength, 3), 9 (misc singles, 5)** — not started; unchanged from the
  plan.
- **Clusters 7 (proxy traps) and 8 (realm NewTarget, #3371)** — explicitly out
  of scope per the plan; the 3 `proto-from-ctor-realm-*` compile errors and the
  proxy-trap tests are those.
