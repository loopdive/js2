---
id: 5147
title: "ES2015 standalone: iterators conformance wave 1"
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
  - src/codegen/iterator-native.ts
  - src/codegen/iter-lazy-native.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/map-runtime.ts
  # 2026-08-28 wave-1 implementation: the chunks/windows lazy kinds and the
  # §7.4.11 result-object / native-`.next()` routing add new emitted-code paths
  # (new struct field + steppers, two new reserve-then-fill helpers, one new
  # dispatcher arm), plus their reserve-then-fill flags on the context type and
  # their two finalize calls in the driver.
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/expressions/call-tail-dispatch.ts
func-budget-allow:
  # 2026-08-28: `ensureLazyStepper` gains two more kind arms (chunks/windows,
  # each a full buffered stepping loop) in the same one-function kind-dispatch
  # shape every existing lazy kind lives in; the four other growths are the
  # single new dispatcher arm / routing branch each site needed.
  - src/codegen/iter-lazy-native.ts::ensureLazyStepper
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/index.ts::generateModule
---

# #5147 — ES2015 standalone: iterators conformance wave 1

## Problem

95 of the 96 "iterators" work-package tests still fail on the standalone
target (re-verified per-test on head `86739f05`, 2026-08-28: 95 FAIL, 1 —
`SetIteratorPrototype/next/does-not-have-mapiterator-internal-slots-set.js` —
already passes since the day-old baseline). The failures split cleanly:
46 are the missing `Iterator.prototype.chunks`/`windows` methods (the
iterator-chunking family, counted in this bucket by the runner — it is NOT
in `PROPOSAL_FEATURES`, so it scores against conformance), and 49 are
holes in the native iterator-protocol reification that #1320/#2038/#3013
built: source-level `.next()` on a native iterator carrier returns null,
the Array/Map/Set iterator-prototype singletons have no own `next`, and the
`@@iterator` call arm only routes arrays. All are pure-Wasm work — no new
host imports. Growth allowance for the files above granted 2026-08-28 for
this change-set (rationale: new lazy-helper kinds, new GetIterator arms,
and result-object materialization are new emitted-code paths, not
refactors).

Target list (regenerated today, authoritative):
`.tmp/es2015/wp-iterators-current-fails.txt` (95 paths).
Minimal repro probes used below are in `.tmp/probes5147/*.js`
(run via `npx tsx .tmp/probe-one.mts <abs-path>`).

## Current failure clusters

Counts verified by classifying all 95 paths; sums to 95. Sample paths are
relative to `test262/test/built-ins/`.

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| A | `Iterator.prototype.chunks`/`windows` missing | 46 | `src/codegen/iter-lazy-native.ts:60` `LAZY_ITER_METHODS` has no chunks/windows kinds, so the standalone lazy-helper dispatch (`closed-method-dispatch.ts:399`, `call-receiver-method.ts:3972`) never routes them → TypeError "called value is not a function" before any iteration. 42/46 call the method directly on a generator (`g().windows(2)`); 4 go through the runner's `Iterator.prototype` shim reflectively. | `Iterator/prototype/chunks/chunks-evenly-divisible.js`, `Iterator/prototype/windows/windows-basic.js`, `Iterator/prototype/chunks/callable.js` |
| D | proto `next` not an own property + no brand check | 17 | `src/codegen/array-object-proto.ts:3156` `emitIteratorPrototypeSingleton` seeds only `@@toStringTag` for kinds Array/Map/Set; the own `next` closure exists only for String (#5099, same function, `kind === "String"` branch). `proto.next` → undefined → `verifyProperty` throws "Cannot convert undefined or null to object", `.call(...)` throws "reading 'call'". | `MapIteratorPrototype/next/name.js`, `SetIteratorPrototype/next/this-not-object-throw-values.js`, `ArrayIteratorPrototype/next/property-descriptor.js` |
| B | `.next()` on a native iterator carrier returns null | 15 | `src/codegen/expressions/call-receiver-method.ts` ~L3585 (any/externref generic arm): `methodName === "next"` routes to `tryEmitAsyncGenNextDispatch`/`__gen_next`, neither of which recognizes the `$__IterRec` VEC carrier (`iterator-native.ts`, #1320/#2038) or the Map/Set carriers (`map-runtime.ts:1113` `__map_iter_next`) → nullish result; the subsequent `.value`/`.done` read (`property-access-dispatch.ts:3645`) throws "Cannot access property on null or undefined". Probe `s-nullish.js` proves `([1,2][Symbol.iterator]()).next() == null` is `true`. The `iteration-mutable` rows additionally need LIVE stepping (the VEC carrier snapshots eagerly at creation — probe test creates the iterator on an empty array, pushes, then nexts). | `ArrayIteratorPrototype/next/iteration.js`, `MapIteratorPrototype/next/iteration.js`, `ArrayIteratorPrototype/next/Float32Array.js` (9 TypedArray rows) |
| C | `arguments[Symbol.iterator]` not routed | 8 | `src/codegen/expressions/call-tail-dispatch.ts:738-796` (@@iterator arm): only checker-proven arrays get the native `.values()` route (`:749`, #3013); an arguments-object receiver falls into the native `__iterator` GetIterator ladder (`iterator-native.ts` `buildIteratorBody`), which has no arguments-carrier arm → TypeError "called value is not a function". | `ArrayIteratorPrototype/next/args-mapped-iteration.js`, `ArrayIteratorPrototype/next/args-unmapped-expansion-before-exhaustion.js` |
| E | `%IteratorPrototype%` not modeled | 6 | The kind singletons' `$Object.$proto` (field 0) is never set, so `Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))` is null → member access on null throws. `%IteratorPrototype%[@@iterator]` (a self-returning function, §25.1.2.1) does not exist anywhere. `join/not-a-constructor.js` needs `Iterator.prototype.join` to at least exist as a non-constructor function. | `Iterator/prototype/Symbol.iterator/prop-desc.js`, `Iterator/prototype/Symbol.iterator/return-val.js`, `Iterator/prototype/join/not-a-constructor.js` |
| G | `"str"[Symbol.iterator]()` throws | 2 | Same @@iterator arm as C: no string arm, and the GetIterator ladder rejects `$AnyString` (#3388 non-iterable TypeError). String for-of works via a different lowering (`ensureStrToCharVecHelper`, #1470) — the computed-symbol call never reaches it. | `StringIteratorPrototype/next/next-iteration.js`, `StringIteratorPrototype/next/next-iteration-surrogate-pairs.js` |
| F | detach-during-iteration unobservable | 1 | Eager VEC snapshot at iterator creation: the TypedArray iterator never re-reads its source, so `$DETACHBUFFER` mid-loop (runner sidecar `__detached__`, #1515) cannot throw the §23.2.3 TypeError. Needs a live TypedArray stepping arm + IsDetachedBuffer check. | `ArrayIteratorPrototype/next/detach-typedarray-in-progress.js` |

**Dependency note (load-bearing for cluster A):** every chunks/windows test
drives a generator source. Head carries the #5060 regression that makes every
native-generator first resume trap `unreachable` (documented and owned by
**#5141** cluster R0 — probe `r-genforof.js`: even `for (x of g())` traps on
head). The cluster-A dispatch/implementation work is independent and can land
first, but its test yield only realizes once #5141-R0 has landed. Clusters
B/C/D/E/G/F use arrays/Map/Set/strings — not blocked.

## Implementation Plan

Ordered by cluster count descending (A → D → B → C → E → G → F), with one
shared step first because D and B both consume it. Each step is
independently landable; partial completion maximizes yield.

**Step 0 — shared: native CreateIterResultObject (§7.4.11).**
Add `ensureNativeIterResultObject(ctx)` in `src/codegen/iterator-native.ts`:
a defined func `__iter_result_obj(done i32, value externref) -> externref`
that builds a real `$Object` via `__new_plain_object` + two `__extern_set`
(or `__defineProperty_value` with writable/enumerable/configurable = true —
these are CreateDataPropertyOrThrow data properties) for keys "value"/"done";
`value` when done must be the undefined singleton (`undefinedExternInstrs`,
`src/codegen/any-helpers.ts`, #2106), never null. String keys via
`nativeStringLiteralInstrs` (#3119 pattern, already imported in this file).
Follow the reserve-then-fill funcIdx discipline of #1719 if any dependency is
finalize-time; here all deps (`ensureObjectRuntime`) are eager, so a plain
idempotent ensure-helper works. Then make the two IteratorResult read fast
paths accept a `$Object` result: `property-access-dispatch.ts:3645` routes
IteratorResult-typed `.value`/`.done` to `__gen_result_value`/`__gen_result_done`
when those exist in funcMap — verify what fills them in standalone
(`generators-native-consumer.ts:877-936`) and add a `ref.test $Object` →
`__extern_get` arm to their bodies (or decline the fast path when the funcs
are absent so the generic `__extern_get` dispatch reads the `$Object`
naturally). Do NOT reuse `$MapIterResult`/`$NativeGeneratorResult` closed
structs as the source-visible result — tests read properties dynamically and
closed structs are invisible to `__extern_get` (the exact #25/#2038 trap).

**Step A — `Iterator.prototype.chunks` / `windows` (46 tests).**
Mimic the #2903 R3 lazy-helper pattern in `src/codegen/iter-lazy-native.ts`
end-to-end — it is the existing analogous implementation (`map/filter/take/
drop/flatMap` over one `$LazyIterHelper` closed struct + a single
kind-dispatched `__lazy_iter_step`):
1. Add kinds `chunks: 5`, `windows: 6` to `KIND` (`:63`) and both names to
   `LAZY_ITER_METHODS` (`:60`); extend `isLazyIterForm` — chunks arity 1,
   windows arity 1-2, and the arg is a NUMBER, not a callable (adjust any
   callable-arg assumption in the wrapper allocation: store chunkSize/
   windowSize in the `state` f64 field; the `fn` field stays null; the
   `inner` externref field carries the accumulating buffer vec for chunks /
   the rolling window vec for windows; windows' `undersized` mode
   ("only-full" default vs "allow-partial") needs one more bit — pack it
   into `state`'s sign/fraction or add one i32 field to the struct, all
   kinds share the layout so a new field is mechanical).
2. Validation at CALL time per the proposal (before the wrapper is
   returned): ToIntegerOrInfinity, then RangeError unless in [1, 2^32-1]
   (`windowSize-out-of-range.js` checks 0, -0, -1, 2^32, Infinity, NaN…),
   with IteratorClose(underlying) before the throw. Throw pattern:
   `emitWasiErrorConstructor` (`src/codegen/registry/error-types.ts`), same
   as the #3388 TypeError in `iterator-native.ts` — check it supports
   RangeError; the second windows arg validates `undersized` against
   {"only-full","allow-partial"} → TypeError otherwise. CAUTION:
   `chunks/chunkSize-not-a-number.js` currently PASSES (it is in the
   spotcheck file) — keep its expected TypeError-on-non-number behavior.
3. Stepping in `__lazy_iter_step`: chunks — pull from src via
   `__iter_hof_next` into the buffer; when buffer length == chunkSize, emit
   a REAL array (fresh vec each time — `yields-distinct-arrays.js` checks
   `chunks[0] !== chunks[1]`); on src done, flush a non-empty partial
   buffer (`chunks-last-chunk-partial.js`) and do NOT call src.return
   (`exhaustion-does-not-call-return.js`). windows — same, but after the
   first full window shift-by-one (copy, don't alias); "only-full" yields
   nothing when src is shorter than windowSize (`undersized-default.js`),
   "allow-partial" yields the one short window (`windows-allow-partial.js`).
4. Reflective seeds: register both (plus a minimal non-constructor `join` —
   eager string-concat over the source with "," default separator is enough
   for `join/not-a-constructor.js`, which only checks it is a non-constructor
   function) as own function properties of the %IteratorPrototype% singleton
   from Step E, via `ensureStandaloneNativeMethodClosure`
   (`src/codegen/native-proto.ts:780`) so `Iterator.prototype.chunks.call(...)`
   and `isConstructor(...)` checks resolve (`callable.js`,
   `non-constructible.js` — the closure must not be constructable, which
   the native-method closure ABI already satisfies).
5. Protocol-fidelity tail (get-next-method-only-once, next-method-throws,
   *-throwing-done/value, underlying-iterator-advanced/closed-in-parallel,
   return-is-forwarded*): these ride on the USER/OBJ carrier arms of
   `__iter_hof_open`/`__iter_hof_next` (GetIteratorDirect must read `next`
   ONCE at wrapper creation and cache it; abrupt `next` results must
   propagate; `.return` on the wrapper forwards to the underlying iterator
   exactly once, and not after exhaustion). Fix in `iter-hof-native.ts`'s
   open/step helpers, not per-kind. Several of these also use
   `class X extends Iterator` with accessor `next` — expect this sub-tail
   to be bounded by class/accessor fidelity; land the rest first.

**Step D — own `next` on the Array/Map/Set iterator-prototype singletons (17).**
Extend `emitIteratorPrototypeSingleton` (`src/codegen/array-object-proto.ts:3156`):
replicate the `kind === "String"` #5099 branch for Array/Map/Set. Each needs
a per-kind brand glue à la `ensureStringNativeProtoGlue` (`:2187`) +
`ensureStandaloneNativeMethodClosure(ctx, brand, "next", "method")`, seeded
with descriptor bits writable:true/enumerable:false/configurable:true
(`0x01|0x04`, exactly as the String branch). That alone fixes the metadata
rows (`name.js`, `length.js`, `property-descriptor.js` — the #5099 machinery
already emits correct `name`/`length` rows; proof: `StringIteratorPrototype/
next/name.js+length.js` pass today). The closure BODY must be behavioral,
not a stub: brand-check `this` via `ref.test` against the kind's carrier
struct (`$__IterRec` for Array; the Map/Set iterator structs in
`map-runtime.ts` — see `__map_iter_next` `:1113`), step it (Step B's
routing), wrap via `__iter_result_obj`; any other receiver — primitives,
plain objects, cross-kind iterators (`this-not-object-throw-*.js`,
`does-not-have-*iterator-internal-slots*.js` do BOTH directions) — throws a
native TypeError (#3388 pattern). Coordinate with in-flight **#4777**
(Map/Set @@toStringTag on the same singletons — same function, additive
branches) to avoid a textual conflict.

**Step B — make `.next()` on native iterator carriers actually step (15).**
Two routing layers:
1. Static: in `call-receiver-method.ts`, BEFORE the generator/`__gen_next`
   arms, add an arm keyed the same way #3013/#4747/#4777 key their
   getPrototypeOf routing (`call-builtin-static.ts:2148-2200`): receiver
   checker symbol `ArrayIterator`/`MapIterator`/`SetIterator`/`StringIterator`
   (use `ctx.oracle` for any NEW type queries — raw `ctx.checker.*` additions
   trip the oracle-ratchet gate) with methodName `next` (0-arg) → compile
   receiver to externref, call `__iterator_next` (multivalue `i32 done,
   externref value` — `iterator-native.ts:2393` `buildIteratorNextBody`), wrap
   via `__iter_result_obj`. Also `return` (§23.1.5.2.2 has none for array
   iterators, skip) — only `next` is needed for this list.
2. Dynamic: the same tests often hold the iterator in an untyped var; in the
   any/externref generic arm (~L3585) prepend a runtime `ref.test $__IterRec`
   dispatch (pattern: the #2865 `tryEmitAsyncGenNextDispatch` runtime
   dispatch in the same file) that steps via `__iterator_next` on hit and
   falls through to the existing `__gen_next` behavior on miss.
3. Live stepping for the `iteration-mutable` rows (3 of the 15): the VEC
   snapshot is taken at iterator creation, so mutations are invisible. Add a
   live arm to the carrier — hold the SOURCE array struct + cursor and
   re-read `vec.length` each step — following the #4708 pattern (it replaced
   the standalone Set-values snapshot with a live `$Map`-entry cursor for
   for-of; reuse its carrier if reachable). The 9 TypedArray rows work with
   the plain snapshot fix (their arrays aren't mutated) — do not block them
   on this.
4. Map/Set: `new Map(...).keys().next()` must route through the Map runtime's
   own stepping (`__map_iter_next`, `map-runtime.ts:1113`, returns
   `$MapIterResult {value anyref, done i32}`) — unwrap into
   `__iter_result_obj`, entries yield the `[k,v]` pair array exactly as the
   for-of lowering already builds it.

**Step C — arguments-object `@@iterator` (8).**
In the @@iterator arm (`call-tail-dispatch.ts:749`), the #3013 array route
keys on `resolveArrayInfo(ctx, receiverType)`. An `arguments` receiver
compiles to whatever carrier the arguments-object lowering uses — find it
(grep `arguments` in `src/codegen/expressions/identifiers.ts` /
`func-space`), and route it like an array: §22.1.3.40 — the arguments
iterator IS `Array.prototype.values` semantics over the captured elements.
If arguments already lowers to a vec-backed carrier, `compileArrayMethodCall
(..., "values")` may work as-is once the receiver is admitted; the
mapped-vs-unmapped distinction (`args-mapped-*` vs `args-unmapped-*`) only
matters through the parameter-alias writes the tests do BEFORE/AFTER
grabbing the iterator — snapshot semantics of the existing carrier decide
how many of the 8 land; take the iteration ones first
(`args-*-iteration.js`), the expansion/truncation ones need the live arm
from Step B-3.

**Step E — `%IteratorPrototype%` singleton (6).**
Add kind `"Iterator"` (the root) to `emitIteratorPrototypeSingleton`: mint
one more `$Object` global. Wire the four kind singletons' `$proto`
(`$Object` field 0 — the #1472 Phase C prototype-chain slot that
`Object.getPrototypeOf`'s dynamic `$Object` path already reads; verify via
`object-runtime.ts:11987`) to it at their init. Seed it with own property
`[Symbol.iterator]` (boxed well-known symbol id 0 — reuse the `__box_symbol`
+ `__defineProperty_value` recipe already in this function for
@@toStringTag; descriptor writable:true/enumerable:false/configurable:true
per `prop-desc.js`): a native closure that RETURNS ITS RECEIVER
(`return-val.js` does `getIterator.call(thisValue) === thisValue`), with
function metadata name `"[Symbol.iterator]"` and length 0 (`name.js`,
`length.js`). This also makes the runner's `Iterator` shim
(`Iterator.prototype = getProtoOf(getProtoOf([][Symbol.iterator]()))`)
resolve to this object — which is what Step A-4's reflective seeds and
cluster A's 4 reflective tests stand on.

**Step G — string `@@iterator` (2).**
Same arm as Step C: admit checker-proven string receivers (and
`$AnyString`-carrier dynamics) and produce the string code-point iterator
the existing machinery already knows how to build — `ensureStrToCharVecHelper`
(#1470, `native-strings.ts`; it is what `__extern_slice`'s $AnyString rest
arm uses) → per-code-point char vec → VEC `$__IterRec`. Surrogate pairs
must stay paired (`next-iteration-surrogate-pairs.js`) — the #1470 helper is
already code-point-correct. The static result type will be
`StringIterator`, which keeps #4747's getPrototypeOf routing coherent.

**Step F — detach-during-iteration (1, stretch).**
Requires a live TypedArray arm in the IterRec (Step B-3's shape, holding the
TA view) + an IsDetachedBuffer check per step consulting the runner's
`__detached__` sidecar the DataView dispatch already checks (#1515 — grep
`__detached__` in `src/codegen/`). Defer if the live arm doesn't land;
1 test.

**What NOT to do:**
- No new host imports without a standalone fallback (the runner FAILS any
  standalone module that emits host imports — `standaloneHostImportError`).
  Everything above is defined-Wasm-function work.
- Never edit `tests/test262-runner.ts`, skip lists, or
  `scripts/*baseline*.json` (main is the baselines' sole writer). The
  runner's `Iterator` shim stays as-is — make the compiled code satisfy it.
- New type-info queries go through `ctx.oracle` (`src/checker/oracle.ts`),
  not raw `ctx.checker.*` — the oracle-ratchet gate blocks raw additions
  (grant `oracle-ratchet-allow:` only for genuine ValType-level questions).
- Don't return closed structs (`$MapIterResult`, `$NativeGeneratorResult`,
  `$LazyIterHelper`) as source-visible iterator RESULTS — dynamic property
  reads can't see them (`__extern_get` gates on `$Object`); wrap through
  `__iter_result_obj`.
- Don't re-fix the generator-resume `unreachable` regression here — #5141
  owns it (its R0). If it hasn't landed when cluster A is done, report the
  A-cluster tests as blocked-on-#5141 rather than chasing the trap.
- Late imports: use `ensureLateImport` + `flushLateImportShifts` and the
  reserve-then-fill discipline (#1719/#2043) — no bare funcIdx caching
  across late additions.

## Acceptance criteria

- All 95 tests in `.tmp/es2015/wp-iterators-current-fails.txt` pass via the
  probe (`npx tsx .tmp/run-standalone.mts --list
  .tmp/es2015/wp-iterators-current-fails.txt` → SUMMARY all pass), with the
  cluster-A generator-sourced rows evaluated on a head that includes the
  #5141-R0 regression fix (report them separately if that has not landed).
- Every test in `.tmp/es2015/wp-iterators-passing-spotcheck.txt` (19 paths,
  includes `chunks/chunkSize-not-a-number.js` and the #5099 String rows)
  still passes.
- Source-ratchet gates pass, chained before commit: `node
  scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node
  scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm
  run -s check:dead-exports`.
- Equivalence tests pass (`npm test -- tests/equivalence.test.ts`).

## Results (wave 1, 2026-08-28)

Measured with `npx tsx .tmp/run-standalone.mts --list …` on this branch.

| List | Before | After |
|---|---|---|
| `.tmp/es2015/wp-iterators-current-fails.txt` (95) | 0 pass / 95 fail | **16 pass / 79 fail** |
| `.tmp/es2015/wp-iterators-passing-spotcheck.txt` (19) | 19 pass | **19 pass** (no regression) |
| whole `Iterator/prototype/{chunks,windows}` dir (78) | 9 pass | **26 pass** |

**Landed**

- **Cluster A (partial, +16).** `Iterator.prototype.chunks` / `.windows` are
  implemented as two new `$LazyIterHelper` kinds in
  `src/codegen/iter-lazy-native.ts`: a `$Vec` buffer in the wrapper's `inner`
  field (four new primitives `__lazy_buf_{new,push,copy,shift}`), a new
  mutable `flags` field (bit 0 = source exhausted, bit 1 = windows
  `allow-partial`), and full call-time argument validation — TypeError for a
  non-Number / non-integral / non-finite size, RangeError outside
  `[1, 2^32-1]`, TypeError for an `undersized` other than `undefined` /
  `"only-full"` / `"allow-partial"`. All the yield-shape rows pass
  (evenly-divisible, partial last chunk, size-1, size-larger-than-iterator,
  distinct arrays, sliding windows 1/2/3, allow-partial, undersized-default,
  already-exhausted, out-of-range, callable).
  - The dispatcher (`closed-method-dispatch.ts`) passes the second source-level
    argument plus an i32 "was it supplied" flag: a null externref cannot
    distinguish an absent argument from a source-level `null`, and
    `windows(1, null)` must throw while `windows(1)` must not.
- **Shared step 0.** `__iter_result_obj(done, value)` builds a real `$Object`
  (§7.4.11) with `value` / `done` data properties — never a closed struct, which
  `__extern_get` cannot see. `__iter_next_result(recv)` packages one ladder step
  as a single-result call.
- **`.next()` on a native carrier.** `__call_m_next_0` gains a
  `ref.test __IterRec ∨ $LazyIterHelper` arm ahead of the
  `__extern_method_call` fallback, and the two `.next()` call sites in
  `call-receiver-method.ts` route through `__any_iter_next` (whose miss arm is
  the pre-existing `__gen_next`). `__iterator` also gained the §7.4.1 identity
  arm for an `$__IterRec` subject.

**Skipped / follow-ups**

- **Clusters B, C, D, E, F, G are NOT done** (79 remaining). The blocker is one
  shared fact: `<array>[Symbol.iterator]()` still lowers to
  `Array.prototype.values`' SNAPSHOT vec (`call-tail-dispatch.ts`), and a vec
  has no cursor, so `.next()` on it cannot step. Switching that arm to
  `__iterator(recv)` (a real `$__IterRec`) was implemented and measured on this
  branch: it fixed `Array.from(it)` and simple `it.next()` shapes but left the
  95-list at the same 16 and broke `array[Symbol.iterator]().next()` for a
  variable receiver, so it was reverted (the note is left in the code). The
  carrier migration must move `%ArrayIteratorPrototype%` (#3013/#4747) with it —
  that is the next wave's first task, and clusters B and D fall out of it.
- Cluster A's remaining rows split into (i) the reflective/metadata set
  (`is-function`, `prop-desc`, `name`, `length`, `non-constructible`,
  `result-is-iterator`), which needs the Step E `%IteratorPrototype%` singleton
  plus the Step A-4 seeds, and (ii) the protocol-fidelity tail
  (`get-next-method-only-once`, `next-method-*`, `return-is-*`,
  `underlying-iterator-*`), which drives `class X extends Iterator` receivers
  through `__iter_hof_open`/`__iter_hof_next` and needs the GetIteratorDirect
  read-`next`-once + abrupt-completion work in `iter-hof-native.ts`.
- **Latent bug found and worked around, worth its own issue:** feeding a
  MULTI-RESULT call straight into a two-parameter call
  (`call __iterator_next` → `call __iter_result_obj`) is mis-read by
  `stack-balance.ts`'s call-argument repair once that sequence is cloned into
  another body — it models one pushed result, under-flows, and "repairs" the
  receiver by unboxing it to i32, producing a module that fails validation.
  `__iter_next_result` spills to locals to avoid it.

**Validation**: all five source-ratchet gates green (loc/func allowances
granted in this file's frontmatter). Equivalence: the 50 iterator/generator/
array/map/set/destructuring/spread files run clean except
`tests/equivalence/array-inline-return.test.ts`, which fails identically on an
unmodified `src/` (pre-existing). The full 219-file equivalence directory OOMs
in this container, so it was run as that subset.

## References

- **#5141** — generators wave 1: owns the head `unreachable`-on-first-resume
  regression (PR #5060) that gates cluster A's yield; shares
  `iterator-native.ts`.
- **#5139 / #5146** — sibling ES2015-standalone wave-1 issues (class /
  assignment), same head, same probe tooling.
- **#3013** — `%ArrayIteratorPrototype%` singleton + array `@@iterator` →
  `.values()` routing (the pattern Steps C/G extend).
- **#5099** (done) — String iterator-prototype `next` metadata closure (the
  pattern Step D replicates per kind).
- **#4747** — `%StringIteratorPrototype%` getPrototypeOf routing.
- **#4777** (in-progress) — Map/Set iterator-prototype @@toStringTag; same
  `emitIteratorPrototypeSingleton` function as Step D — coordinate.
- **#4731** (in-progress) — Set iterator non-constructor semantics
  (`Set/prototype/*` rows — disjoint test set, adjacent machinery).
- **#4708** (done) — live `$Map`-entry cursor replacing the Set-values
  snapshot (the live-stepping pattern for Step B-3).
- **#4742** (done) — `Array.prototype[Symbol.iterator]` exposure.
- **#1320 / #2038 / #3388** — the native `$__IterRec` GetIterator ladder
  this issue extends (design notes at the top of
  `src/codegen/iterator-native.ts`).
- **#2903 R3** — lazy iterator helpers (`iter-lazy-native.ts`), the direct
  template for chunks/windows.
- **#1718** (done) — js-host iterator sequencing helpers (prior art for the
  helper semantics, host mode).
- **#681 / #2860** — standalone iterator-protocol / standalone-gap
  umbrellas.
