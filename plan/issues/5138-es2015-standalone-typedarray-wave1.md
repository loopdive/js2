---
id: 5138
title: "ES2015 standalone: typedarray conformance wave 1"
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
  - src/codegen/dataview-native.ts
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/iterator-native.ts
  - src/codegen/ta-hof-map-filter.ts
  - src/codegen/ta-ctor-meta.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/registry/types.ts
func-budget-allow:
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructFromLocals
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
---

# ES2015 standalone: typedarray conformance wave 1

LOC-growth allowance rationale (2026-08-28): the clusters below add new
codegen arms (iterable-protocol construct arm, dyn-view length-sentinel
resolution, ValidateTypedArray guards, descriptor arms) to the files listed
in `loc-budget-allow` — measured growth is expected and granted for this
change-set.

## Problem

540 ES2015-bucket test262 tests under `built-ins/TypedArray/**` and
`built-ins/TypedArrayConstructors/**` fail on the standalone target
(re-verified 2026-08-28 against head on branch
`claude/es2015-test262-standalone-9vij99`: all 540 from the day-old baseline
still fail — 528 FAIL + 12 COMPILE_ERROR, 0 already fixed). The failures are
NOT 540 independent bugs: six root causes cover all of them, and the top one
(dynamic-constructor argument protocols) alone accounts for ~41%. This is one
of the largest single work packages standing between current standalone
conformance and the 100% ES2015 goal.

**Target list**: `.tmp/es2015/wp-typedarray-current-fails.txt` (540 paths,
regenerated 2026-08-28). Per-cluster path lists:
`.tmp/es2015/ta-cl-{A-arg-protocols-and-misc,B-proto-model,C-detach,C-validate,D-coercion-abrupt,E-descriptors,F-CE-reflect-construct,F-CE-reflect-set}.txt`.
Probe: `cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>`
(split lists >150 lines; some tests take up to 20 s). Minimal repro probes
from the analysis are saved under `.tmp/probes/ta-*.js` (runnable via
`npx tsx .tmp/run-standalone.mts "../../.tmp/probes/<name>.js"`).

**Two measurement traps, established during this analysis:**

1. **The harness's "(Testing with X and makeArray.)" suffix is unreliable.**
   `Function.name` on the test262 harness factory functions is broken in
   standalone — ALL 8 `typedArrayCtorArgFactories` report `.name ===
   "makeArray"` (probe `.tmp/probes/ta-names.js`). A failure attributed to
   "makeArray" is usually actually the `makeIterable` or
   `makeResizableArrayBuffer` iteration. Do not cluster by suffix.
2. **The 48 detach tests need the QuickJS eval artifact locally.** They use
   `$262.detachArrayBuffer`, which routes through the `js2wasm:runtime-eval`
   seam; without `.test262-cache/quickjs-artifact-*/libquickjs.wasm` the probe
   reports a bogus `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is
   not built` error. Build it via `scripts/quickjs-artifact/build.sh` (see
   `scripts/quickjs-eval-provider.mjs`, #4238) or read the true failures from
   the CI standalone baseline
   (`.test262-cache/test262-standalone-current.jsonl`) — e.g.
   `some/detached-buffer.js` really fails with "Expected a TypeError to be
   thrown but no exception was thrown at all".

## Current failure clusters

Ordered by count descending — partial completion maximizes yield.

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| A | Dynamic-ctor argument protocols | 224 | `src/codegen/dataview-native.ts:emitTaDynCtorConstructFromLocals` (L4418): (A1) no iterable-protocol arm — `new TA(objWithSymbolIterator)` falls to the ToIndex count arm → 0-length view; (A2) auto-length sentinel `-1` leaks from `.length` reads on `$__ta_dyn_view` over resizable buffers (`registry/types.ts:getOrRegisterTaDynViewType` L556 — subtypes `$__vec_base`, so generic length reads return raw field0); (A3) plain-vec copy arm admits only `f64`/`i32`/`externref` carriers (L4663) — string-element array literals (`new TA(["0","0","0"])`) fall to count arm → 0 | `TypedArray/prototype/forEach/callbackfn-arguments-without-thisarg.js`, `TypedArray/prototype/reduceRight/callbackfn-returns-abrupt.js`, `TypedArray/prototype/fill/fill-values.js` |
| B | Missing %TypedArray% intrinsic + shared prototype model + species | 145 | No two-level prototype chain: `TA.prototype.hasOwnProperty("forEach")` is `true` (should be false — methods must live on %TypedArray%.prototype); `Object.getPrototypeOf(Int8Array)` is null → harness `var TypedArray = ...` line makes every later `TypedArray.*` read throw "Cannot access property on null or undefined". `src/codegen/ta-dyn-mop.ts` (MOP arms), `src/codegen/ta-ctor-meta.ts:fillTaCtorGetMetaArm`, `src/codegen/builtin-prototype-brand.ts` | `TypedArrayConstructors/prototype/forEach/inherited.js` (+32 more `inherited.js`), `TypedArrayConstructors/Uint8Array/prototype.js`, `TypedArray/Symbol.species/result.js`, `TypedArray/prototype/map/speciesctor-get-ctor.js` |
| C | ValidateTypedArray entry guards (detach + brand + callable) | 73 | Method entry never runs §23.2.4.3 ValidateTypedArray: (C1, 48 tests) detached view (backing byte-vec length forced to −1, `ta-dyn-mop.ts` L26/L1916) reads as effective length 0 → silent no-op instead of TypeError (`slice` already guards via `emitArrayBufferDetachedCheck`, `dataview-native.ts:171` — the pattern to copy); (C2, 25) non-TA receiver (`TA.prototype.indexOf.call({}, 0)`) and non-callable callbackfn (`sample.forEach(42)`) silently no-op — probe `.tmp/probes/ta-symbol.js`. Dispatch: `src/codegen/expressions/call-receiver-method.ts`, HOF loop entries in `ta-dyn-mop.ts`/`ta-hof-map-filter.ts` | `TypedArray/prototype/some/detached-buffer.js`, `TypedArray/prototype/sort/invoked-as-method.js`, `TypedArray/prototype/every/callbackfn-not-callable-throws.js` |
| D | Symbol/abrupt coercion of method arguments | 49 | `ToNumber(Symbol)` does not throw TypeError, and abrupt completions from `valueOf`/`toString` of index/offset args are swallowed, in the externref→f64 coercion path (`src/codegen/type-coercion.ts` / `__to_primitive`/`__unbox_number` natives). Probe: `sample.fill(Symbol())` returns normally | `TypedArray/prototype/fill/fill-values-symbol-throws.js`, `TypedArray/prototype/set/array-arg-return-abrupt-from-tointeger-offset.js`, `TypedArrayConstructors/ctors/object-arg/throws-setting-obj-valueof.js` |
| E | Ctor/proto data properties + descriptors | 37 | `Float64Array.prototype.BYTES_PER_ELEMENT` → NaN, `Uint16Array.BYTES_PER_ELEMENT` static read throws; `name`/`length` descriptors report `configurable: false` (ES2015 wants true); `from`/`of` not own props. `src/codegen/ta-ctor-meta.ts:fillTaCtorGetMetaArm` (L36) + the #2896 `fillBuiltinFnMeta` descriptor arms; #4490 owns own-property coherence | `TypedArrayConstructors/Float64Array/prototype/BYTES_PER_ELEMENT.js`, `TypedArrayConstructors/Float64Array/name.js`, `TypedArray/from/prop-desc.js` |
| F | Compile errors: Reflect residuals | 12 | (F1, 6) `Reflect.set` with explicit receiver refused in standalone (#2046, in-progress); (F2, 6) `Reflect.construct` NewTarget whose `.prototype` GETTER throws — the `custom-proto-access-throws.js` family still refused post-#3371. `src/codegen/expressions/new-super.ts` §#3371 arm | `TypedArrayConstructors/internals/Set/key-is-valid-index-reflect-set.js`, `TypedArrayConstructors/ctors/length-arg/custom-proto-access-throws.js` |

Cluster evidence (all re-measured 2026-08-28 on head with the probes named
above): `new TA(makeIterable(TA,3))` → length 0; `new TA(<resizable ab>)` →
`.length === -1`; `new TA(["0","0","0"])` → length 0; while
`new TA([1,2,3])`, `new TA(makeArray(TA,3))` (an `Array.from` result),
`new TA(makeArrayLike(TA,3))` and fixed-buffer `new TA(buf)` all work. The
harness runs every test body through 8 arg factories in order
`[makePassthrough, makeArray, makeArrayLike, makeIterable, makeArrayBuffer,
makeResizable*, makeGrown*, makeShrunk*]`, so nearly every cluster-A test
passes its early iterations and dies at `makeIterable` (A1) or the resizable
factories (A2) — fixing A1 without A2 moves almost nothing to green.

## Implementation Plan

Work the clusters in order (A → F). Each step ends with a re-run of that
cluster's path list through the probe; expected yield is stated per step.
General constraints: **no new host imports without a standalone fallback**
(this issue is standalone-only — every fix must be a Wasm-native arm; the
runner fails any test whose module emits host imports). New codegen needing
type info goes through `ctx.oracle` (`src/checker/oracle.ts`), never the raw
TS checker (oracle-ratchet gate).

### Step 0 — setup (30 min)

Build the QuickJS eval artifact (`scripts/quickjs-artifact/build.sh`) so the
48 detach tests are measurable locally; if the toolchain is unavailable,
validate cluster C1 against the CI baseline jsonl instead and say so in the
PR. Re-run `.tmp/es2015/wp-typedarray-current-fails.txt` through the probe to
confirm the starting point.

### Step 1 — cluster A: dyn-ctor argument protocols (224 tests)

All in `emitTaDynCtorConstructFromLocals`
(`src/codegen/dataview-native.ts:4418`) and the length-read path.

1. **A1 — iterable-protocol arm.** §23.2.5.1: usingIterator is checked
   BEFORE the array-like path. In the `$Object` arm (~L4560), first probe the
   arg for a callable `Symbol.iterator` property; if present (and not
   null/undefined), materialize it with `ensureNativeArrayFromIterN`
   (`src/codegen/iterator-native.ts:632`) — the exact pattern of
   `emitStandaloneIterableMaterialize` (`iterator-native.ts:972`, #3100 S5) —
   then reuse the existing `$ObjVec` copy arm on the materialized result.
   Edge cases: `iterator-is-null-as-array-like.js` (a null `@@iterator` must
   take the array-like path — do not throw); `iterator-not-callable-throws.js`
   (non-callable non-null `@@iterator` → TypeError);
   `iterating-throws.js` (abrupt from `next()` must propagate as-is, not be
   wrapped — today the wrap turns Test262Error into TypeError, the
   "Expected a Test262Error but got a TypeError" signature).
2. **A2 — length-sentinel resolution.** `$__ta_dyn_view` deliberately
   subtypes `$__vec_base` so generic `.length` reads hit field 0 — which
   stores `-1` for auto-length (length-tracking) views over resizable
   buffers. Add a `$__ta_dyn_view` arm AHEAD of the `$__vec_base` arm in
   `__extern_length` (its emitter lives in the object-runtime natives; grep
   `__extern_length` in `src/codegen/`) and in any `.length` fast path in
   `ta-dyn-mop.ts`, computing the live length exactly as
   `pushTaDynViewInBoundsLen` (`dataview-native.ts:3221`) /
   `pushTaDynViewEffectiveLen` (`:3921`) do: stored >= 0 → stored (with the
   shrunk-window OOB→0 rule), else `max(0, buf.length − byteOffset) /
   elemSize`.
3. **A3 — ref-element vec copy arm.** The plain-vec copy loop (~L4663)
   skips every carrier key except `f64`/`i32`/`externref`, so a
   string-element array literal's `ref_<n>` vec falls to the count arm. Admit
   ref-struct-element carriers: `array.get` the element, box to externref
   (`extern.convert_any`), then the same `coerceType externref→f64`
   (ToNumber) the `$ObjVec` arm uses. Strings like `"0"` must convert via
   ToNumber (the harness's `makeArray` fills with `"0"` strings).

Do NOT try to make the count arm smarter (ToIndex of an object is correct
spec behavior once real array-likes/iterables are peeled off first). Do NOT
add a JS-host import for iteration. Expected yield: the majority of the 224
(tests whose only failing iterations are makeIterable/resizable); the
remainder of cluster A are per-method value/coercion details that fall to
steps 3–4.

### Step 2 — cluster B: %TypedArray% intrinsic + prototype model (145 tests)

The architectural step. Required semantics: `Object.getPrototypeOf(Int8Array)`
= %TypedArray% (a function-like value, `length` 0 in ES2015+, own
`Symbol.species` getter returning `this`); `Object.getPrototypeOf(TA.prototype)`
= %TypedArray%.prototype; the ~20 prototype methods are OWN on
%TypedArray%.prototype ONLY (`TA.prototype.hasOwnProperty("forEach")` must be
false); per-kind prototypes own only `constructor` and `BYTES_PER_ELEMENT`;
calling %TypedArray% throws TypeError (`TypedArray/invoked.js`).

Approach — extend the synthetic-meta/MOP layer, do not build a full object
graph: follow #4490's D7 direction (Int8Array's ctor is already a real
mutable `$Object` carrier — see the `k === 0` skip in
`ta-ctor-meta.ts:57`). Mint two intrinsic singletons (a %TypedArray% carrier
and a %TypedArray%.prototype carrier, real `$Object`s so gOPD/defineProperty
compose), then: (i) answer `getPrototypeOf` on `$__ta_ctor` values / per-kind
prototype brands with them (the MOP arms in `ta-dyn-mop.ts` and the
`__object_getPrototypeOf` native); (ii) route `hasOwnProperty` /
`getOwnPropertyDescriptor` on per-kind prototype brands so the method names
report NOT-own but reachable (the lookup falls through to the
%TypedArray%.prototype carrier); (iii) put the `Symbol.species` accessor
(returns `this`) and `BYTES_PER_ELEMENT` statics on the right owners.
Coordinate with `src/codegen/builtin-prototype-brand.ts` (existing per-proto
brand machinery) and `builtin-value-read.ts`. The `speciesctor-get-*` family
additionally needs SpeciesConstructor (§7.3.20) in `map`/`filter`/`slice`/
`subarray` to read `this.constructor` then `@@species` through the new chain
— implement after (i)–(iii); treat the custom-ctor-invocation subset as
stretch for this wave.

While in this area, fix the `Function.name` collision that makes all 8
harness factories report `"makeArray"` (probe `.tmp/probes/ta-names.js`) —
the name lookup for user function declarations read as values collides on
shape (see `function-instance-meta-methods.ts` / `__builtinfn_get_meta`
consumers). It costs little here and un-poisons every future TypedArray
triage.

### Step 3 — cluster C: ValidateTypedArray guards (73 tests)

1. **C1 — detach guards (48).** The detach marker already exists (backing
   byte-vec `length` = −1; `$DETACHBUFFER` sets it — `ta-dyn-mop.ts:1986`).
   `ArrayBuffer.prototype.slice`/`resize` already throw via
   `emitArrayBufferDetachedCheck` (`dataview-native.ts:140-171`) and CI
   proves the pattern (slice/detached-buffer PASSES today). Emit the same
   check → `throw TypeError` at the entry of every %TypedArray%.prototype
   method on the dyn-view path: the generic `__hof_*` loop entries, the
   `map`/`filter` helpers (`ta-hof-map-filter.ts`), and the scalar methods
   (`set`, `copyWithin`, `fill`, `subarray`*, `slice`, `sort`, `indexOf`
   family, iterators, `Symbol.toStringTag` is exempt — returns undefined).
   Watch the tests where detach happens DURING iteration
   (`callbackfn-detachbuffer.js`): the guard must re-check per §23.2.3.x
   (mostly: subsequent reads yield undefined, no throw — read each test).
   *`subarray` does NOT throw on detached (§23.2.3.27) — check per-method
   spec text before adding a guard blindly.
2. **C2 — brand + callable checks (25).** At method dispatch
   (`call-receiver-method.ts` and the ta-dyn arms): non-TA receiver →
   TypeError (covers `invoked-as-method`/`invoked-as-accessor` — these need
   step 2's %TypedArray%.prototype to exist so the method VALUE is reachable
   to `.call` in the first place); non-callable callbackfn/comparefn/predicate
   → TypeError before the loop (probe: `sample.forEach(42)` silently
   no-ops); `from`/`of` invoked as plain functions (this not a constructor) →
   TypeError.

### Step 4 — cluster D: Symbol/abrupt coercion (49 tests)

One mechanism: the standalone externref→f64 ToNumber path (`coerceType` in
`src/codegen/type-coercion.ts` routing to the `__to_primitive` /
`__unbox_number` natives in `src/runtime.ts`) must (a) throw TypeError on a
Symbol operand, (b) propagate abrupt completions from `valueOf`/`toString`
un-swallowed. This same family is being worked area-by-area in
#5102/#5117/#5118/#5120/#5123 — check `git log origin/main` and the claim
ref for a landed shared fix BEFORE implementing; if a shared symbol-brand
throw already exists, this step is wiring it into the TA method argument
sites (`fill`, `copyWithin`, `set` offset, `indexOf`/`lastIndexOf`/`includes`
fromIndex, `slice`/`subarray` begin/end, `join` separator, `sort` comparefn
results, ctor object-arg ToPrimitive). The `join` illegal-cast crashes
(`join/return-abrupt-from-separator.js`) are the same site: a Symbol
separator reaches `__str_flatten` uncast.

### Step 5 — cluster E: descriptors + statics (37 tests)

In `fillTaCtorGetMetaArm` (`ta-ctor-meta.ts:36`) + the #2896
`fillBuiltinFnMeta` descriptor arms: report `name`/`length` as
`configurable: true` (ES2015 changed these from ES5); add
`BYTES_PER_ELEMENT` to both the ctor meta arm (static) and the per-kind
prototype brand (value 1/2/4/8, writable:false enumerable:false
configurable:false); make `from`/`of`/`name`/`length` answer hasOwnProperty
as own props of the ctor. #4490 (in-progress) owns ctor own-property
coherence — coordinate with its owner; if #4490's D7 migration lands first,
these become plain `$Object` property definitions instead of meta arms.

### Step 6 — cluster F: Reflect residuals (12 CEs)

F1 (`Reflect.set` receiver) belongs to #2046 (in-progress) — check the claim
ref; if active, leave it and note the dependency; if stale, implement per
#2046's plan. F2: the #3371 arm refuses when NewTarget's `prototype` cannot
be statically resolved; the 6 remaining tests only need the GETTER-THROWS
path (access `newTarget.prototype`, propagate the abrupt completion) — they
never construct successfully, so no distinct-proto plumbing is needed:
evaluate the `prototype` get through the MOP (which throws the test's
Test262Error) before reaching the refusal.

### What NOT to do (any cluster)

- No new host imports without a standalone fallback (the runner's
  `standaloneHostImportError` fails the test regardless of behavior).
- Never edit `tests/test262-runner.ts`, its skip lists, or
  `scripts/*baseline*.json` (main is the baselines' sole writer).
- Do not "fix" by special-casing harness function names or test paths.
- Do not rebuild helper bodies at finalize — splice arms per the
  `fillBuiltinFnMeta` discipline (`ta-ctor-meta.ts` header).
- Run the ratchet gates before every commit (chained, never piped):
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs &&
  node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet &&
  npm run -s check:dead-exports`.

## Acceptance criteria

- All tests in `.tmp/es2015/wp-typedarray-current-fails.txt` (540 paths,
  2026-08-28) pass via
  `npx tsx .tmp/run-standalone.mts --list <chunk>` (split into ≤150-line
  chunks). Partial completion is acceptable per-cluster in count-descending
  order; state the per-cluster residual in the PR.
- Every test in `.tmp/es2015/wp-typedarray-passing-spotcheck.txt` still
  passes (measured 2026-08-28: 37/40 pass locally; the 3 "failures" —
  `slice/detached-buffer.js`, `Symbol.toStringTag/detached-buffer.js`,
  `ctors/buffer-arg/length-to-number-detachbuffer.js` — are the local
  quickjs-artifact gap, not regressions; they pass in CI. With the artifact
  built locally, all 40 must pass.)
- All source-ratchet gates pass (loc-budget with this issue's
  `loc-budget-allow` grant, func-budget, coercion-sites, oracle-ratchet,
  dead-exports).
- Equivalence tests pass (`npm test -- tests/equivalence.test.ts`).

## Results (wave 1, 2026-08-28)

**Counts** (`npx tsx .tmp/run-standalone.mts --list`, standalone target, this
worktree):

| List | Before | After |
|---|---|---|
| `.tmp/es2015/wp-typedarray-current-fails.txt` (540) | 540 failing (528 FAIL + 12 CE) | **538 failing** (526 FAIL + 12 CE), 2 pass |
| `.tmp/es2015/wp-typedarray-passing-spotcheck.txt` (40) | 37 pass | **37 pass** (no regression) |

The 3 spotcheck non-passes are the documented local quickjs-artifact gap
(`slice/detached-buffer.js`, `Symbol.toStringTag/detached-buffer.js`,
`ctors/buffer-arg/length-to-number-detachbuffer.js`), not regressions.
Newly green: `TypedArray/prototype/every/returns-true-if-every-cb-returns-true.js`,
`TypedArray/prototype/filter/result-full-callbackfn-returns-true.js`.

**Landed**

- **A1 — iterable-protocol construct arm** (`dataview-native.ts:
  emitTaDynCtorConstructFromLocals`). §23.2.5.1 step 6 now probes
  `GetMethod(O, @@iterator)` BEFORE the array-like path; a callable one
  materializes through `__array_from_iter_n` (no host import), a non-callable
  non-nullish one throws TypeError, a null/undefined one keeps the array-like
  arm. Probe-verified: `new TA(objWithSymbolIterator)` went length 0 → 3 with
  correct element values.
- **A1b — detached-arm live-body tracking** (same function). Every dispatch arm
  is built detached and spliced at the end, so a late import minted by a later
  arm shifted funcIdxs already baked into earlier arms. Each chain link is now
  registered in `ctx.liveBodies` while detached. Latent-correctness fix; found
  while debugging A3.
- **A2 — auto-length sentinel resolution in `__extern_length`**
  (`ta-dyn-mop.ts: fillTaDynViewMopArms`). A `.length` read on an externref
  lowers to `__extern_length`, not to `__extern_get`'s string-key ladder, and
  its `$__vec_base` arm returned the stored field 0 verbatim — the `-1`
  length-tracking sentinel for a view over a resizable buffer. A
  `$__ta_dyn_view` arm ahead of it now computes the live in-bounds count via
  the same `pushTaDynViewInBoundsLen` the MOP and the element engine use.
  Probe-verified: `new TA(resizableAb).length` −1 → 3.

**Not landed / findings for wave 2** — each is a measured blocker, in the order
that would unlock the most:

1. **The @@iterator delegation shape is broken UPSTREAM of the ctor, and it is
   what pins cluster A at ~0 flips.** The harness `makeIterable` returns
   `obj[Symbol.iterator] = function () { return src[Symbol.iterator](); }`, and
   even `Array.from(that)` yields length 0 in standalone — so A1's arm is
   correct but starved. In standalone `arr[Symbol.iterator]()` evaluates to an
   externref-wrapped `$IterRec`, which `__iterator`'s tail then classifies as
   an OBJ/USER iterator and looks for a `next` PROPERTY it does not have. An
   "adopt the record" arm in `buildIteratorBody`'s two tails
   (`iterator-native.ts`) was written and did NOT fix it, so the real break is
   elsewhere in that path — diagnose `Array.from(makeIterable(TA,3))` first,
   before any further TypedArray-ctor work. **Every cluster-A test needs all 8
   factories to pass, so nothing in the list can go green until this does.**
2. **A3 — ref-element vec copy arm.** Admitting `ref_<n>` carriers in the
   plain-vec copy loop (so `new TA(["0","0","0"])` copies instead of falling to
   the ToIndex count arm) made `s.length` wrong in a way the live-body fix
   above did not explain; reverted rather than shipped half-diagnosed. Note the
   STATIC path has its own bug here: `new Float64Array(["0","5","0"])` is a
   hard CompileError (`f64.convert_i32_u expected i32, found array.get of
   (ref null N)`).
3. **Cluster E is already served.** `TA.BYTES_PER_ELEMENT` and `TA.length` read
   correctly today through the dyn-view/MOP path — a `fillTaCtorGetMetaArm`
   BYTES_PER_ELEMENT arm was written, measured as a no-op against base, and
   dropped. Re-measure before spending on E again.
4. Clusters B (%TypedArray% intrinsic), C (ValidateTypedArray guards), D
   (Symbol/abrupt coercion) and F (Reflect residuals) were not started.

**Measurement note.** The harness's own failure formatting is unreliable in
standalone: `String(value)` throws for several value shapes and
`assert._toString` then falls back to the unimplemented
`Object.prototype.toString`, so an assertion failure can surface as
`TypeError: Object.prototype.toString is not yet implemented` and the rendered
«…» values can be garbage (`function () { [native code] }` for a boolean).
Write probes with boolean asserts (`assert.sameValue(x === 3, true, "…")`) and
read WHICH assert failed, never the printed values.

## References

- **#2872** (ready, unclaimed) — the prior `built-ins/TypedArray/prototype/**`
  standalone cluster issue (294 tests, #2870-era measurement). This issue
  supersedes its stale numbers; adopt its file, don't re-derive.
- **#3177** (ready, unclaimed) — `TypedArrayConstructors/**` internals/ctors
  (356 tests, 2026-07-12 measurement); its slice-4 expando work landed (the
  `$__ta_dyn_view.expando` field). Same territory as clusters A/E/F here.
- **#2046** (in-progress) — Reflect.set receiver (cluster F1). Coordinate.
- **#3371** (done) — Reflect.construct NewTarget; cluster F2 is its residual
  getter-throws path.
- **#4490** (in-progress) — builtin ctor own-property coherence / D7
  ctor-as-real-$Object (clusters B/E). Coordinate; Int8Array already migrated.
- **#2896** (done) — builtin function name/length meta natives (clusters B/E
  build on its fill/splice discipline).
- **#3054** (done) — resizable AB + dynamic `new ctor(rab)`; cluster A2 is a
  gap in its auto-length sentinel story.
- **#1645 / #1350** (ready / blocked-dup) — the original detached-buffer
  guards issue (cluster C1).
- **#1567** — TypedArray length-descriptor splice side effects (cluster E
  adjacency).
- **#2593** (done) — element-width wrapping; reuse its conversions in A3.
- **#1907** — standalone builtin static-method value reads (cluster E
  from/of adjacency).
- **#5102 #5117 #5118 #5120 #5123** — the in-flight ES2015 symbol-coercion
  family (cluster D shares the mechanism).
- **#1523 / #4238** — $262 host object / QuickJS eval seam (why detach tests
  need the artifact locally).
- **#5139** — sibling wave-1 issue (class work package), same program.
