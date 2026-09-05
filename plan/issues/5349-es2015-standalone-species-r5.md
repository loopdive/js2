---
id: 5349
title: "ES2015 standalone species — r5: ArrayBuffer.slice SpeciesConstructor, Array constructor-null and defineProperty arming, TypedArray species this/validation/inherited ctor"
status: in-progress
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: l
feasibility: medium
model: opus
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: species
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5145, 1359, 3575, 4449, 5317, 4444]
loc-budget-allow:
  # 2026-09-05 r5 step 5: ArrayBuffer.prototype.slice had no SpeciesConstructor
  # step at all (§25.1.5.3 steps 13-20). The emitter plus the shared
  # constructor-value ladder extracted out of `emitTaDynSpeciesCreate` live in
  # dataview-native.ts; array-species.ts grows by the §10.4.2.3 step-9 null arm
  # and array-holes.ts by the third pre-scan trigger.
  - src/codegen/dataview-native.ts
  - src/codegen/array-species.ts
  - src/codegen/array-holes.ts
---

## Problem

The ES2015 standalone census (2026-09-05, 10,188 / 11,704) carries 69 non-pass
rows under `built-ins/Array/prototype/{concat,splice,slice,map,filter,flat}`,
`built-ins/TypedArray/prototype/{slice,subarray,map,filter}`,
`built-ins/TypedArrayConstructors/internals` and
`built-ins/ArrayBuffer/prototype/slice` whose spec step is species-constructor
validation. A read-only investigation (2026-09-05, scratch `.tmp/w5/species/`,
probes `p3`-`p9.mts`, oracle `oracle.mjs`) found species implemented in three
unrelated places at three depths, and the rows sort by which one is wrong:

- **Array** (`src/codegen/array-species.ts`, #5145) runs a real
  ArraySpeciesCreate behind the `arraySpeciesActive` pre-scan gate; two holes:
  an explicit `constructor = null` is taken as the default lane (L336), and
  `Object.defineProperty(a,'constructor',{get})` never arms the pre-scan
  (`array-holes.ts:627`); plus the default lane skips ArrayCreate's
  `len > 2^32-1` RangeError; plus `map`/`filter` wrongly `Set(A,"length")`
  (`array-species.ts:461-467`, zero rows, measured 110 vs node 111).
- **TypedArray** (`emitTaDynSpeciesCreate`, `dataview-native.ts:6003`, #4449)
  gets the constructor-value ladder right; its failures are downstream: the
  construct driver's `this` is not `Object.create(species.prototype)`
  (`native-construct.ts:441-462` reads a `.prototype` that differs from the
  user-visible one), `ValidateTypedArray` is a representation test
  (`ref.test $__ta_dyn_view`, L6205-6220) that rejects a legitimately returned
  static-lane TypedArray, and a dyn view's `.constructor` read never consults a
  user-mutated `TA.prototype` (`ta-dyn-mop.ts:845-911` — an accessor is never
  invoked, a plain data write is ignored; the row error points at L883-898
  but the defect may be upstream: see step 7).
- **ArrayBuffer.prototype.slice** (`emitArrayBufferSlice`,
  `dataview-native.ts:431-593`) has NO SpeciesConstructor step at all — it goes
  from the byte copy straight to `struct.new $vec_i32_byte` at L597-601.

Row buckets, with the mechanism each needs, are in the plan below; 18 rows in
these paths are NOT species defects and are excluded (resizable-buffer
re-validation TA4 ×6, `illegal cast` during module init TA5 ×3, TA6 ×1, the
`$ObjVec` hole representation H1 ×4 `[1,2,3,null,…]`, revoked-Proxy `illegal
cast` in concat X1 ×3, proxy trap order A5 ×1).

## Implementation Plan — r5 (2026-09-05, Fable lane; Opus-medium implements)

Independent steps, ascending risk, each separately committed with its
measurement. Do NOT build one shared runtime SpeciesConstructor for all three
families — Array's works and TypedArray's failures are not validation failures.

1. **Array: `constructor === null` is a TypeError, not the default lane (5 rows).**
   `array-species.ts:336` tests the raw constructor value with
   `defaultLaneTest` (`nullish || Object.is(C, %Array%)`). `__extern_get`
   already distinguishes absent (the `undefined` singleton) from an explicit
   `null` (`ref.null.extern`) — probe `p9`. Hoist a one-time `cIsNull` i32 local
   right after L296 and steer: null → the `constructArm`'s existing
   `IsConstructor` refusal (L324-326) throws; undefined / `%Array%` → default
   lane as today. **L343's `defaultLaneTest` on the post-`@@species` value MUST
   keep its `ref.is_null` disjunct** (§10.4.2.3 step 6 maps a null `@@species`
   to undefined; `create-species-null.js` passes today and must keep passing).
   Guard the discrimination on `ctx.undefinedSingleton` — with the
   `JS2WASM_UNDEF_SINGLETON=0` kill switch the two collapse; fall back to today's
   behaviour there. Rows: `{concat,map,filter,slice,splice}/create-ctor-non-object.js`.
2. **Array pre-scan arms on `defineProperty` with a `'constructor'` key (5 rows).**
   `array-holes.ts:627` `isArraySpeciesObservable`: third trigger — an
   `Object.defineProperty` / `Object.defineProperties` / `Reflect.defineProperty`
   call whose second argument is the string literal `'constructor'` or an
   object literal with a `constructor` property (copy the namespace matcher from
   `isOwnKeysOrDescriptorDefineUse` at L645). Over-approximate deliberately (a
   false positive costs the runtime-null prologue, never a wrong answer).
   Byte-identity check: a corpus sample using `Object.defineProperty` on keys
   other than `constructor` must not move. Rows:
   `{concat,map,filter,slice,splice}/create-ctor-poisoned.js`.
3. **Array default lane: ArrayCreate length RangeError (3 rows).** In the default
   arm of `emitArraySpeciesCreate`, `len > 2^32-1` ⇒ RangeError (§10.4.2.2).
   Rows: `map/create-species-undef-invalid-len.js`,
   `splice/create-species-undef-invalid-len.js`,
   `splice/create-species-length-exceeding-integer-limit.js`.
4. **`map`/`filter` epilogue: no `Set(A,"length")` (0 rows, measured).** Add
   `setLength: boolean` to `emitArraySpeciesResultSwap` (L378) and pass `false`
   from `array-methods.ts:7409` (filter) and `:7585` (map); `concat`/`slice`/
   `splice` keep it. Land with a pin (`r.length === undefined` for a
   plain-object species result under `map`; `501` under `slice`).
5. **ArrayBuffer.prototype.slice: the species step (12 rows, largest bucket).**
   Lift the constructor-value ladder out of `emitTaDynSpeciesCreate`
   (`dataview-native.ts:6098-6167`) into an exported
   `emitSpeciesConstructorLadder(ctx, fctx, { receiverLocal, defaultCtorInstrs })`
   and have the TypedArray path CALL it — its emission must stay byte-identical
   (hash a `testWithTypedArrayConstructors`-shaped module before/after). Then in
   `emitArrayBufferSlice`, after the detach check (L443) and before the byte
   copy (L580), behind a gate modelled on `arraySpeciesActive` (a module that
   never mentions `.species`/`Symbol.species`/`constructor` writes emits today's
   bytes exactly): `C = ? Get(O,"constructor")` (absent ⇒ `%ArrayBuffer%`; null
   or non-Object ⇒ TypeError); `S = ? Get(C, @@species)` (null/undefined ⇒
   `%ArrayBuffer%`); `IsConstructor(S)` false ⇒ TypeError; non-default ⇒
   `new = ? Construct(S, «newLen»)` via `reserveNativeConstructDriver(ctx, 1,
   "prototype")`; validate §25.1.5.3 steps 15-18: not an ArrayBuffer
   (`ref.test $vec_i32_byte` or the resizable type) ⇒ TypeError; same object as
   the receiver ⇒ TypeError; `byteLength < newLen` ⇒ TypeError; larger is legal
   and returned as-is; copy into the constructed buffer. Emit the species arm as
   a BRANCH whose default side still leaves the `$vec_i32_byte` struct (callers
   consume it without coercion, header comment L425-430). Rows: `ArrayBuffer/
   prototype/slice/species{,-is-not-object,-is-not-constructor,-constructor-is-
   not-object,-returns-not-arraybuffer,-returns-same-arraybuffer,-returns-
   smaller-arraybuffer,-returns-immutable-arraybuffer,-returns-larger-arraybuffer}.js`;
   the three default-lane rows `species-is-undefined`, `species-is-null`,
   `species-constructor-is-undefined` assert `getPrototypeOf(result) ===
   ArrayBuffer.prototype` and need the default result to be a prototyped
   ArrayBuffer — measure; do not promise them.
6. **TypedArray `ValidateTypedArray` is a brand test, not a representation
   test (10 rows).** `dataview-native.ts:6205-6220`: accept the static
   typed-array representations too (the disjunction `ArrayBuffer.isView` /
   `instanceof %TypedArray%` already spells), and on a static-lane hit either
   return it directly (slice/subarray hand the object back; `…-returns-another-
   instance.js` asserts `result === other` by identity) or box it into a dyn
   view before the producer's write loop (map/filter). Widening the accept set
   without that boxing moves the `illegal cast` into the producer's first
   `struct.get` — worse than today's TypeError. Rows: the 10
   `speciesctor-get-species-custom-ctor{,-returns-another-instance}.js` under
   slice/subarray/map/filter incl. `BigInt/` twins.
7. **TypedArray species `this` and inherited constructor (16 rows) — diagnose
   first.** (a) `this` inside the species constructor is not
   `Object.create(S.prototype)` (probe `p6`: proto mismatch while `typeof this
   === "object"`): `native-construct.ts:441-462` reads `.prototype` through a
   path that disagrees with the user-visible `S.prototype` — fix the RESOLUTION
   (route the driver's proto read through the accessor ordinary user code
   uses), not the driver's shape. Rows: the 8 `speciesctor-get-species-custom-
   ctor-invocation.js`. (b) `TA.prototype.constructor` mutation invisible to a
   dyn view's `.constructor` read (probe `p8`: accessor never invoked, data
   write ignored, yet `getPrototypeOf(result) === TA.prototype`). BEFORE editing
   `ta-dyn-mop.ts:883-898`, dump the WAT for the `proto-ctor-marker` probe and
   check whether `constructorLookup`'s `getProtoIdx`/`protoGetWithReceiver` arms
   are present or whether `hasOwnIdx`/`getProtoIdx`/`selfIdx` resolved
   `undefined` and the bare fallback (L906-908) was taken; fix where the
   evidence points. Rows: the 8 `speciesctor-get-ctor-inherited.js`.

Measurement protocol: base = `git archive origin/main` tree (linked
node_modules/test262, rebuilt bundle + quickjs eval provider, again after the
last src edit); node 22 oracle; reuse `.tmp/w5/species/p*.mts` and
`oracle.mjs`; rows via `npx tsx scripts/run-test262-paths.mts --isolate <list>
--standalone` with timeouts re-run alone at `COMPILER_POOL_SIZE=1`. Controls
(zero rows lost by set-diff): every ES2015 row under `built-ins/Array/prototype`
(~560), `built-ins/TypedArray` + `built-ins/TypedArrayConstructors` (~1,100 — run
once at the end), `built-ins/ArrayBuffer` (~130).

## Acceptance criteria

- The 51 rows in steps 1-3 and 5-7 pass, minus any the step's own measurement
  shows blocked by a named mechanism (record each with its repro).
- Zero rows lost across the three controls.
- Byte-identical to base: any module that neither mentions `Symbol.species` /
  `.species` nor writes a `constructor` property (the #5145 escape gate,
  measured 53,710 B vs 170,396 B armed); `ab.slice()` in such a module;
  `emitTaDynSpeciesCreate`'s emission after the step-5 extraction; every
  program on host and wasi.
- Behaviour-identical: `create-species-null.js`,
  `create-proto-from-ctor-realm-array.js` (the `Object.is(C, %Array%)` disjunct
  stays on both call sites), the abrupt-completion rows (`callCount === 0`),
  `IsArray` before `Get(O,"constructor")` (L348-362 block).
- Pins for every step in `tests/issue-5349-species-r5.test.ts` (standalone,
  `result.imports` `[]`), including the step-4 zero-row measurement.
- Gates green bare and with `LOC_GATE_BASE=origin/main`; grants here.

## Lane protocol

As in #5316/#5318: fresh worktree of the session branch, commit per step with
the measurement in the body, `Model: Claude Opus 5 Medium`, never push/PR/
enqueue; append `## 2026-09-05 r5 implementation (Opus)` with rows base→lane by
path, control set-diffs, gates, residuals with mechanisms.

## 2026-09-05 r5 implementation (Opus)

Three of the seven planned steps landed (1, 2, 5); two were DECLINED after their
own measurement showed the plan's premise did not hold (3, 4); two were
DIAGNOSED to a sharper mechanism than the plan carried and left unimplemented
(6, 7). Every number below is a run in this worktree, base = a
`git archive origin/main` tree at `.tmp/base` with its own compiler bundle and
quickjs eval provider, rebuilt on both sides after the last src edit. Oracle =
node 22; the pins also run green on node 25.9.0. Scratch: `.tmp/w5x/`.

### Rows, base → lane (`npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone`, `COMPILER_POOL_SIZE=2`)

The 57-row target set was measured on base first: **6 pass / 51 fail**.

| bucket | rows | base | lane |
| --- | --- | --- | --- |
| `Array/prototype/{concat,map,filter,slice,splice}/create-ctor-non-object.js` | 5 | 0 pass | **5 pass** |
| `Array/prototype/{concat,map,filter,slice,splice}/create-ctor-poisoned.js` | 5 | 0 pass | **5 pass** |
| `Array/prototype/{map,splice}/create-species-undef-invalid-len.js`, `splice/create-species-length-exceeding-integer-limit.js` | 3 | 0 pass | 0 pass (step 3 declined — see below) |
| `ArrayBuffer/prototype/slice/species*.js` | 12 | 0 pass | **9 pass** |
| `TypedArray/prototype/{slice,subarray,map,filter}[/BigInt]/speciesctor-*` | 32 | 6 pass | 6 pass (steps 6-7 diagnosed, not implemented) |

Lane totals over the same 57 rows: **25 pass** (base 6). The six rows that
passed on base are all in the TypedArray family the step-5 ladder extraction
touched, so they were re-run explicitly on the lane build and all six still
pass (`.tmp/w5x/rows-ta-pass.txt`, `{ pass: 6 }`); the other 26 TypedArray rows
were already non-pass on base, so no pass can have been lost there.

**+19 rows, 0 lost.** Each step was measured in isolation before its commit
(step 1 with `array-holes.ts` reverted to base by one `cp`: 5/5; step 2 alone:
5/5; step 5 alone: 9/12).

### Step 1 — `constructor === null` is a TypeError (landed, 5 rows)

`array-species.ts`. §10.4.2.3 maps null to undefined only for the *@@species*
read (step 7b); a null `C` from step 5 is neither an Object nor undefined and
falls through to step 9's `IsConstructor` refusal. `defaultLaneTest`'s `nullish`
disjunct was swallowing it into the ArrayCreate default lane.

Absent and explicit-null are distinguishable only under the #2106 undefined
singleton, so the arm is gated on `undefinedSingletonActive(ctx)`; with
`JS2WASM_UNDEF_SINGLETON=0` behaviour is unchanged. Measured that this does NOT
fire for an array with no own `constructor` in an armed module
(`armed-plain-{map,slice,filter,splice,concat}` all 111/211/311/411/511, same as
base and node) — that was the one way this step could have made a working
program throw.

Probes base → lane (node 22 in brackets): `ctor-null` 0 → **1** [1] ·
`ctor-number` 1 → 1 [1] · `ctor-undefined-default` 111 → 111 [111] ·
`species-null-default` (the `create-species-null.js` shape) 111 → 111 [111].
Under `--target wasi` too: `wasi-ctor-null` 0 → **1**.

### Step 2 — the pre-scan arms on `defineProperty(_, 'constructor', …)` (landed, 5 rows)

`array-holes.ts`. `isArraySpeciesObservable` matched only an ASSIGNMENT to
`.constructor`, so `Object.defineProperty(a, 'constructor', {get})` left
`ctx.arraySpeciesDirty` clear and the entire prologue unemitted — the throwing
getter was never read and the callback ran. Third trigger added for
`Object|Reflect.defineProperty` with a string-literal `'constructor'` key and
`Object.defineProperties` with a `constructor` key in an object literal. A
computed key is deliberately NOT matched.

Attribution A/B (one `cp` between `.tmp/w5x/array-holes.base.ts` and
`.step2.ts`): `ctor-poisoned` **0, 141,709 B** without the step (prologue
unarmed) → **2, 152,490 B** with it; node 22 says 2.

### Step 3 — ArrayCreate length RangeError: DECLINED, the plan's mechanism is not the blocker

Implemented as specified (a `len > 2^32-1` RangeError on the default lane of
`emitArraySpeciesCreate`, before the first element write so `setCount === 0` /
`cbCount === 0` still hold), rebuilt, and re-measured: **all three rows still
fail, with the identical error text**. Reverted.

The reason is upstream of the check. `map/create-species-undef-invalid-len.js`
and `splice/create-species-undef-invalid-len.js` mention `Symbol.species` and
`constructor` **only inside their `info:` comment block** — the executable code
uses `new Proxy(array, {get(){…}})` and `Array.prototype.map.call(proxy, cb)`.
So `isArraySpeciesObservable` never fires, `ctx.arraySpeciesDirty` stays clear,
and the whole ArraySpeciesCreate prologue — including any RangeError added to it
— is not emitted at all. With the prologue absent the guard is dead emission in
every module that DOES arm (a plain `$vec` cannot reach a length above 2^32-1),
which is why it was reverted rather than kept.

Closing these needs the pre-scan to arm on `new Proxy(…)`, which widens every
Proxy-using module's producer result types — precisely what the #5145 escape
gate exists to avoid, and a change whose blast radius needs its own control run.

The third row, `splice/create-species-length-exceeding-integer-limit.js`, is not
this mechanism at all: it fails with `Expected a StopSplice` from a Proxy
`defineProperty` trap, i.e. MOP trap ordering on a species target, not
ArrayCreate.

### Step 4 — `map`/`filter` epilogue `Set(A,"length")`: DECLINED, it regresses behaviour

Implemented as specified (`setLength: boolean` on
`emitArraySpeciesResultSwap`, `false` from the `filter` and `map` call sites)
and measured. The plan predicted zero rows and a `r.length === undefined`
improvement. What actually happened, with a plain-object species under `map`:

| probe | node 22 | base | with step 4 |
| --- | --- | --- | --- |
| `r[0] === 2` | 701 | 701 | **700** |
| `r.length` | 801 (undefined) | 802 (2) | **800** (neither) |
| `r[1] === 4` | 901 | 901 | **900** |

Dropping the `Set` breaks the ELEMENT reads as well: the `$Object` carrier's
indexed read lane keys off a present `length`, so without it the
`__defineProperty_value` + `__extern_set` writes the epilogue already made stop
resolving through `r[k]`. Base is wrong on one assertion; the change is wrong on
three. Zero rows either way, so it was reverted, and the pin
`#5349 step 4 — DECLINED` records the state it was declined to.

### Step 5 — `ArrayBuffer.prototype.slice` SpeciesConstructor (landed, 9 of 12 rows)

`dataview-native.ts`. Two pieces:

* `emitSpeciesConstructorLadder` — §7.3.22's constructor-VALUE ladder, extracted
  verbatim out of `emitTaDynSpeciesCreate` and now called by both. Byte-identity
  verified: `ta-slice-species` 178,552 `3799664d072b743a`, `ta-map-species`
  181,227 `e622867814f2cd50`, `ta-filter-species` 180,375 `83e2d2bc4c590025`,
  `ta-subarray-species` 167,788 `a55a079c88b8a9d7`, `ta-slice-plain` 50,452
  `be548229c0733b45` — **all identical** before and after the extraction; only
  `ab-slice-species` moves (160,177 → 162,149).
* `emitArrayBufferSliceSpecies` — Construct(ctor, «newLen») through the
  reserve/fill native construct driver, then steps 16-20 (not an ArrayBuffer /
  detached / SameValue(new, O) / byteLength < newLen; a LARGER buffer is legal
  and returned as-is). The copy loop then fills the CONSTRUCTED buffer's own
  data array and the constructed object is returned by identity (step 26). The
  default lane is #5145's null sentinel, so an unarmed module emits today's
  bytes exactly.

Probes base → lane (node 22 in brackets): `ab-species-identity` 302 → **303**
[303] · `ab-species-larger` 400 → **401** [401] · `ab-species-{smaller,notab,
same,notctor,notobj}` and `ab-ctor-notobj` all 0 → **1** [1] ·
`ab-ctor-roundtrip` 101 → 101 [101] · `ab-slice-plain` 201 → 201 [201], 51,253 B
both sides. 10 of 13 probes now agree with node 22; base agreed on 2.

### Controls

* **Byte-identity, 10 unarmed programs** (`defineProperty` /
  `defineProperties` / `Reflect.defineProperty` on non-`constructor` keys, a
  computed key, plain `map` / `slice` / `ab.slice` / `ta.slice`), sha256 of the
  standalone binary: **identical on all 10**, base vs lane.
* **Same 10 under `--target host`: identical.** Under `--target wasi`:
  identical. The armed shapes under host are identical too (the feature is
  `noJsHost`-gated); under wasi they move, and the wasi behaviour was executed:
  `wasi-armed-abslice` 701, `wasi-armed-map` 111, `wasi-ctor-null` 0 → 1.
* **Behavioural, 7 armed programs** (a module armed by an unrelated
  `.constructor` write, then ordinary `map`/`slice`/`filter`/`splice`/`concat`/
  `ab.slice`): all match node 22 on base and on lane.
* **`built-ins/ArrayBuffer/prototype/slice` set-diff — EVERY row in the directory `emitArrayBufferSlice` owns, not only the species ones (33 rows): base { fail: 14, pass: 18, compile_error: 1 } → lane { fail: 5, pass: 27, compile_error: 1 }. Rows LOST (pass → non-pass): 0. Rows GAINED: 9.**
  Gained:
    + built-ins/ArrayBuffer/prototype/slice/species-constructor-is-not-object.js
    + built-ins/ArrayBuffer/prototype/slice/species-is-not-constructor.js
    + built-ins/ArrayBuffer/prototype/slice/species-is-not-object.js
    + built-ins/ArrayBuffer/prototype/slice/species-returns-immutable-arraybuffer.js
    + built-ins/ArrayBuffer/prototype/slice/species-returns-larger-arraybuffer.js
    + built-ins/ArrayBuffer/prototype/slice/species-returns-not-arraybuffer.js
    + built-ins/ArrayBuffer/prototype/slice/species-returns-same-arraybuffer.js
    + built-ins/ArrayBuffer/prototype/slice/species-returns-smaller-arraybuffer.js
    + built-ins/ArrayBuffer/prototype/slice/species.js
* **57-row TARGET-SET set-diff, base vs lane, complete:** base
  `{ fail: 51, pass: 6 }` → lane `{ pass: 25, fail: 32 }`. **Rows lost
  (pass → non-pass): 0. Rows gained: 19.**
* **`built-ins/Array/prototype/{concat,map,filter,slice,splice}` directory
  set-diff (679 rows) and `built-ins/ArrayBuffer` (221 rows): NOT COMPLETED.**
  Both were started and abandoned: the box was carrying six other lanes'
  test262 sweeps at a 1-minute load average of 24-26, which put a single
  221-row `--isolate` sweep past an hour and the four-sweep set past eight.
  They were replaced by the tighter, directly-affected controls above — the
  whole `ArrayBuffer/prototype/slice` directory (the one `emitArrayBufferSlice`
  owns), the full 57-row target set, and the byte-identity sets. Lists are kept
  at `.tmp/w5x/ctl-ab.txt` and `.tmp/w5x/ctl-array5.txt` for whoever runs them
  on a quiet box. What this leaves unmeasured: an `Array.prototype`
  `concat`/`map`/`filter`/`slice`/`splice` row, in a module armed by
  `Symbol.species` or a `constructor` write, that the step-1 null arm or the
  step-2 pre-scan trigger changes without one of the probes noticing.
* **The `equivalence-gate` was NOT run to completion locally** — it was started
  and killed to give the control sweeps CPU. It is a required CI check and runs
  there; it is not in this lane's gate list.

### Gates

Green, run bare with the exit status read directly, both bare and with
`LOC_GATE_BASE=$(git rev-parse origin/main)`: `check-loc-budget`,
`check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`,
`check:dead-exports`, `check:speculative-rollback`, `check:stack-balance`,
`check:codegen-fallbacks`, `check:any-box-sites`, TS7 `--noEmit -p
tsconfig.ts7.json`, `pnpm lint`. Growth for `dataview-native.ts`,
`array-species.ts` and `array-holes.ts` is granted in this issue's frontmatter
with a dated rationale; no `scripts/*-baseline.json` was touched. No new
`checker.*` query (the change adds no type query at all). No raw
`fctx.body.length` rollback. Every emitter that splices `Instr[]` into a runtime
body builds a FRESH array — `notObjectArm` and `typeErrorArm` are factories
called once per arm for exactly that reason.

Pins: `tests/issue-5349-species-r5.test.ts`, 17 tests, standalone with
`result.imports` asserted `[]`, green on node 22 and node 25.9.0 at
`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 --pool=forks
--poolOptions.forks.singleFork=true`.

### Residuals, each with its mechanism

1. **The 3 default-lane `ArrayBuffer/prototype/slice` rows**
   (`species-is-undefined`, `species-is-null`,
   `species-constructor-is-undefined`) now reach their LAST assertion and fail
   only on `Object.getPrototypeOf(result) === ArrayBuffer.prototype`. The
   default lane's `$vec_i32_byte` carries no prototype link, so
   `getPrototypeOf` cannot answer `ArrayBuffer.prototype`. This is the #5325
   getPrototypeOf-on-WasmGC-carriers family, not a species defect. Repro:
   `var ab=new ArrayBuffer(8); var C={}; C[Symbol.species]=undefined;
   ab.constructor=C; var r=ab.slice();` → `r.byteLength` is 8 (correct), the
   proto check is false.
2. **Step 7(a), the species constructor's `this` (7 rows,
   `speciesctor-get-species-custom-ctor-invocation.js`).** The plan suspected
   `native-construct.ts:441-462` reads a `.prototype` that "differs from the
   user-visible one". Measured, it is worse and simpler than that: the driver's
   `Object.create(proto)` misses the closure's `.prototype` **entirely**, even
   when the program assigns one explicitly.
   * `Object.getPrototypeOf(this) === S.prototype` inside the species fn: 0
     (node: 1) — and the proto is NOT null, so the driver did create with
     *something*.
   * With an explicit `S.prototype = P`: still 0 (node: 1).
   * `this.tag` where `S.prototype.tag = 7` was set: undefined (node: 7) — so it
     is a DIFFERENT object, not a lost identity comparison.
   * `S.prototype === S.prototype` in ordinary user code: true. An ordinary
     `new S(3)` gets the right prototype (301). Only the
     `reserveNativeConstructDriver` path is wrong.
   * **The same defect is on the ARRAY side**: an `a.map` species constructor's
     `this` has the same wrong prototype (500, node 501). So this is one
     mechanism in `__native_construct_N`'s `__extern_get(callee, "prototype")`
     against the closure own-property side table (#3468), not a TypedArray
     matter, and fixing it is a change to closure `.prototype` identity — well
     outside this issue's blast radius. Repro:
     `var P={}; function S(n){ return [] } S.prototype=P; var C={};
     C[Symbol.species]=S; var a=[1,2]; a.constructor=C; a.map(f);` and read
     `Object.getPrototypeOf(this)` inside `S`.
3. **Step 7(b), `TA.prototype.constructor` invisible to a dyn view (8 rows,
   `speciesctor-get-ctor-inherited.js`).** Confirmed both halves the plan
   suspected: a plain data write `Float64Array.prototype.constructor = marker`
   is not seen by `t2.constructor` (300, node 301), and an accessor installed
   with `Object.defineProperty(Float64Array.prototype, 'constructor', {get})`
   is never invoked (400, node 401) — while `Object.getPrototypeOf(t) ===
   Float64Array.prototype` is correct (501). Not attempted.
4. **Step 6, `ValidateTypedArray` as a representation test.** Its real reach is
   **4 rows**, not 10: only the four
   `speciesctor-get-species-custom-ctor-returns-another-instance.js`
   (slice/subarray, plain and BigInt) fail with `TypedArray species constructor
   returned a non-TypedArray`. The other 28 rows in that family split into 8
   step-7(b), 7 step-7(a), 1 `returned too short`, and 5 BigInt-lowering
   failures unrelated to species (e.g. `map/BigInt/…custom-ctor.js` fails with
   `Cannot mix BigInt and other types, use explicit conversions`). Not
   attempted: `-returns-another-instance.js` asserts `result === other` by
   identity, so widening the accept set without also giving the producer a way
   to write into a static-lane view moves the `illegal cast` into the first
   `struct.get` — strictly worse than today's TypeError, as the plan warned.
5. **`ArrayBuffer` species under `--target wasi` is emitted but not
   exercisable** by the obvious shapes: `C[Symbol.species] = fn` needs a
   computed-key write, and that refuses on base and lane alike with `Host import
   "env.__to_property_key" requested under --no-host-imports / WASI strict
   mode`. Pre-existing, unrelated to this change; recorded so the wasi lane's
   silence is not read as coverage.

### Status

Left at `status: in-progress`, not `done`: steps 6 and 7 (26 TypedArray rows)
are diagnosed but unimplemented, and steps 3 and 4 are recorded as declined
with their measurements. The three landed steps are complete and self-contained.
