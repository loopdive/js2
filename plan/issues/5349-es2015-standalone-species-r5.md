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
  # 2026-09-06 round 2: the round-1 grants for source-scan-predicates.ts,
  # context/types.ts, context/create-context.ts and index.ts are REMOVED, not
  # renewed. Round 1 gated the undecidable step-16 case behind a whole-program
  # pre-scan (`sourceHasPackedByteTaConstruct` + a context flag); round 2 makes
  # the case decidable by branding the packed-byte carrier with `final`, so all
  # of that scaffolding is deleted. Measured against origin/main efa9e76f07:
  # 15 changed src files, net +1 LOC for the whole branch, and no function
  # needs a growth allowance at all.
  # 2026-09-06 round 3: the brand made several emitters that RELIED on the two
  # byte vecs canonicalizing to one runtime type trap or misdispatch. The
  # `.length` of a `$__ta_view` receiver is one of them — `new Uint8Array(b)`
  # emits the shared-backing view whose field 1 is `buf`, so the existing
  # struct-shape probe in `tryLengthAndNameReads` misses it and the
  # `ref.test <vec>` ladder answers 0 where node answers 4 (probes pb/r1,
  # pb/r3). The read has to happen inside that dispatcher, next to the
  # `$__subview_<elem>` case it mirrors.
  - src/codegen/property-access-dispatch.ts
  - src/codegen/node-fs-api.ts
  # 2026-09-06 round 4 (R1): §25.1.5.3's species ladder must be able to ask
  # "is this C the intrinsic %ArrayBuffer%?". On the WASI lane the bare
  # `ArrayBuffer` identifier read produced `ref.null.extern`, so
  # `ab.constructor = ArrayBuffer` stored a value indistinguishable from a
  # genuine `ab.constructor = null` and the ladder threw the spec's
  # "constructor is not an object" TypeError where node (and pre-species main)
  # answered 4. The one-name widening of the reified-carrier arm belongs in the
  # identifier resolver that owns every other builtin bare-value read; +15
  # lines, of which 14 are the safety argument for the widening.
  - src/codegen/expressions/identifiers.ts
  # 2026-09-06 round 4 (integration): the round-2/3 brand-by-finality gate in
  # `finalizeLeafStructTypes` (+16 lines — the `keepOpenTypeIdxs` set that keeps
  # the ArrayBuffer byte vec `$__vec_i32_byte` an open root on the host-free
  # lanes, plus its safety argument) passed this gate on the lanes' own base
  # 50c81e5487. main's post-merge baseline refresh has since lowered the
  # index.ts ceiling to 14,995, so the same lines now read as growth against
  # origin/main; restated here so the grant travels with this PR. The lines
  # belong in index.ts: `finalizeLeafStructTypes` is the one place the module's
  # leaf struct types are marked final.
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-06 round 3: +18 lines in the `$__ta_view` length arm described
  # above, in the function that already owns every other `.length` receiver
  # shape.
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
  # 2026-09-06 round 3: +17 in the `$__ta_ctor` source dispatcher — the
  # `i8_byte` carrier joins the plain-vec copy arms (it is a typed-array SOURCE,
  # not a byte buffer) plus the mechanism note explaining why the ArrayBuffer
  # arm used to swallow it. The arms are one generated loop; splitting the
  # dispatcher would separate a chain that must be built inside-out in one
  # `liveBodies` scope.
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructFromLocals
  # 2026-09-06 round 3 audit: +8 for the comment on the `byteLength` probe's new
  # packed-byte `else` arm (the arm itself is a separate helper function).
  - src/codegen/property-access-dispatch.ts::tryBufferViewAttributeReads
  # 2026-09-06 round 4 (R1): the same +15 as the identifiers.ts LOC grant above,
  # inside the one function that resolves every builtin bare-value identifier
  # read. The arm is a single `if` in an ordered ladder whose position is the
  # semantics (after local/module/declared-global shadowing, before the
  # null-externref fallback); lifting it out would move it out of that order.
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
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

### Review round 1 (2026-09-06)

One confirmed finding, reproduced base/lane/node and fixed as far as the
representation allows.

**Finding.** `emitArrayBufferSliceSpecies` implements §25.1.5.3 step 16 ("if
`new` does not have an `[[ArrayBufferData]]` slot, throw a TypeError") as
`any.convert_extern; ref.test $__vec_i32_byte`. A species returning a
`Uint8Array` PASSED that test: the copy loop then wrote through the caller's
typed array and slice returned it by identity.

**Root cause — a canonicalization, not a missing arm.** Since #2835 the
ArrayBuffer byte buffer is `$__vec_i32_byte { length: i32, data: (ref null
$__arr_i32_byte) }` with `$__arr_i32_byte = (array (mut i8))`, and the
packed-byte view carrier is `$__vec_i8_byte { length: i32, data: (ref null
$__arr_i8_byte) }` with `$__arr_i8_byte = (array (mut i8))`. Both structs
declare the same two fields and the same `sub final $__vec_base` clause, so
they are STRUCTURALLY IDENTICAL and Wasm GC canonicalizes them to ONE runtime
type. Read off the emitted WAT of the b15 probe: the species closure's
numeric-length arm emits `array.new_default $__arr_i8_byte; struct.new
$__vec_i8_byte`, and `$run`'s step-16 `ref.test` names `$__vec_i32_byte` —
different type indices, same canonical rtt. No `ref.test`, brand read or
property query can separate them; this is the same canonicalization the
`ArrayBuffer.isView` chain documents as its "KNOWN IMPRECISION". Only the three
i8-backed names are affected — `i16_byte` is `(array (mut i16))`, `i32_elem`
`(array (mut i32))`, the float views `(array (mut f64))`, and `$__ta_view_*` /
`$__ta_dyn_view` / `$__dv_window` carry extra fields.

**Fix (SUPERSEDED by round 2 below — read the correction with it).** A new
module pre-scan `sourceHasPackedByteTaConstruct` (source-scan-predicates.ts)
set `ctx.moduleUsesPackedByteTaCarrier` when the source could build an
`Int8Array` / `Uint8Array` / `Uint8ClampedArray`, and
`emitArrayBufferSliceSpecies` returned its null sentinel in that case — the
module kept main's pre-#5349 emission byte-for-byte rather than answering step
16 with a test that cannot decide. Pre-scan, not emit-order state, because the
`Uint8Array` construction may compile after the `slice` site.

> **CORRECTION (2026-09-06, round 2).** The sentence that stood here —
> *"Deliberately over-approximating …: the only cost is a declined emission,
> never a wrong runtime answer"* — **is false**, and the round-2 lane measured
> it. Declining the arm is not a refusal; it silently reverts the module to
> main's "species never consulted" answer, which is a WRONG answer wherever the
> species was legitimate. In a module that merely mentions one of the three
> names: a legitimate ArrayBuffer species answered 704 instead of 716 (node
> 716); the species-called observation, a buffer-derived species and all seven
> must-throw shapes (plain object, `Int32Array`, string, same-object step 18,
> too-small step 20, `new Uint8Array(new ArrayBuffer(n))`,
> `new Uint8Array(receiver)`) all reverted — on standalone and on wasi. Round 2
> removes the pre-scan entirely and brands the carrier instead, so step 16
> decides the case with the `ref.test` it already had.

**Outcomes** (`--target standalone`, `imports: []` asserted on every row;
node 22 oracle in brackets):

| probe | base | lane | fix | node |
| --- | --- | --- | --- | --- |
| b15 / `new Uint8Array(n)` species | 601 | **611** (aliases + mutates `made`) | 601 | 1 (TypeError) |
| `new Uint8Array(new ArrayBuffer(n))` species | 501 | 501 | 501 | 1 |
| `new Uint8Array(receiver)` species | 500 | 501 | 500 | 1 |
| instrumented b15 (species-called bit) | — | 1111 | 1001 | 101 |
| `new Int32Array(n)` species | 501 | 1 | **1** | 1 |
| b16 / `new DataView(...)` species | — | 1 | **1** | 1 |
| `{}` species (`species-returns-not-arraybuffer`) | — | 1 | **1** | 1 |
| `class MyAB extends ArrayBuffer` species | 501 | 1 | 1 | 511 |

The last row is NOT a lost working program: `new MyAB(4).byteLength` already
answers wrongly on base (probe returns 1, node 11), so ArrayBuffer subclassing
is unsupported in this lane independently of species — and a subclass instance
is an `$Object`, indistinguishable from the `{}` that
`species-returns-not-arraybuffer.js` requires the TypeError for. Recorded as a
pre-existing gap, not adopted.

**Corpus.** All 33 rows of `built-ins/ArrayBuffer/prototype/slice` (which
includes the 12 `species*` rows), run three ways in one harness: **fix is
row-for-row identical to lane on all 33**, and 0 rows are lost against base.
None of the 33 files, nor `assert.js` / `sta.js` / `compareArray.js` /
`propertyHelper.js` / `detachArrayBuffer.js`, mentions any of the three
packed-byte names, so the gate never fires on that directory.

**Byte identity.** The four `speciesctor-get-species-custom-ctor-returns-
another-instance.js` shapes (slice / subarray, plain and BigInt) hash
identically lane vs fix: `d3c4d649…`, `2cec2e21…`, `1e007e7f…`, `aea948e5…`.
An unarmed `Uint8Array` module (no `.constructor` write) is also byte-identical
lane vs fix — the gate sits after the `arraySpeciesDirty` guard, so nothing
unarmed reaches it.

**Residual, with its owner (CLOSED by round 2 below).** In a module that
constructs a packed-byte TypedArray, `ArrayBuffer.prototype.slice` does not
observe `@@species` at all.
Repro: `var made; var ab=new ArrayBuffer(8); var C={};
C[Symbol.species]=function(n){ made=new Uint8Array(n); return made };
ab.constructor=C; ab.slice(0,4)` — 601 here, TypeError in node. Closing it needs
the packed-byte view carrier to be distinguishable from the buffer's — which
round 2 does at the **declaration site** (`final` on the `i8_byte` vec, the
`i32_byte` vec kept open), not in the typed-array construction path this
paragraph guessed at (`emitDynamicUint8ArrayBufferAlias` /
`TYPED_ARRAY_PACKED_STORAGE`), and without touching a field or an instruction. The same canonicalization also mis-answers
`Object.prototype.toString.call` and `ArrayBuffer.isView` for that carrier.

Pins: five cases in `tests/issue-5349-species-r5.test.ts` (Int32Array result,
DataView result, plain-object result, the residual, and a Float64Array module
that keeps the full ladder). 22/22 green on node 22 and node 25.

### Status

Left at `status: in-progress`, not `done`: steps 6 and 7 (26 TypedArray rows)
are diagnosed but unimplemented, and steps 3 and 4 are recorded as declined
with their measurements. The three landed steps are complete and self-contained;
review round 1 added the step-16 gate above.
## Implementation Plan — round 2 (2026-09-06, Fable lane; Opus-medium implements)

**What round 1 got wrong, measured.** The round-1 fix (`186c63d811`) closed the
b15 wrong answer (a species returning `new Uint8Array(4)` was accepted as an
ArrayBuffer, the copy loop wrote through the caller's typed array and slice
returned it by identity) by declining the WHOLE `ArrayBuffer.prototype.slice`
species arm in any module that mentions `Int8Array`/`Uint8Array`/
`Uint8ClampedArray`. The single-reviewer pass showed that is a wrong-answer
regression against the pre-fix lane, not a refusal: in such a module a
legitimate ArrayBuffer species (r5 `→` 704, node 716), the species-called
observation (r6), a buffer-derived species (s2) and all seven must-throw shapes
(plain object, `Int32Array`, string, same-object step 18, too-small step 20,
buffer-backed `new Uint8Array(new ArrayBuffer(n))`, `new Uint8Array(receiver)`)
silently revert to base's "species never consulted" answer — on standalone AND
wasi. The sentence "the only cost is a declined emission, never a wrong runtime
answer" is false and must be corrected in the round-1 record, the
`sourceHasPackedByteTaConstruct` doc comment goes with the function.

**Root cause, one level deeper than round 1 stated.** `$__vec_i8_byte` and
`$__vec_i32_byte` are registered as `sub $__vec_base (struct (mut i32) (mut (ref
$arr)))` with structurally identical `(array (mut i8))` data arrays. They stay
distinct *declarations* but `markLeafStructsFinal` (`src/codegen/fixups.ts`,
called from `finalizeLeafStructTypes` in `src/codegen/index.ts` ~L4907) marks
every leaf struct `final`, so in a module without `$__resizable_ab` both become
`sub final $__vec_base (…)` and Wasm GC canonicalizes them to ONE runtime type.
On wasi the pass is skipped entirely (`skipFinal = ctx.wasi`), so both are open
there — identical again. A `ref.test` between them can never discriminate.

**The fix — brand by finality, no representation change (measured 2026-09-06 on
a scratch tree `.tmp/w5/i8brand/tree` = git archive of `186c63d811` + the two
edits below + the round-1 gate removed):**

1. `src/codegen/registry/types.ts::getOrRegisterVecType` — register the
   `i8_byte` vec with `final: true` from the start (spread
   `...(cacheKey === "i8_byte" ? { final: true } : {})` into the struct def).
   The packed-byte TypedArray carrier has no subtype anywhere (verify:
   `grep -rn "superTypeIdx:" src/codegen` — every parent is `$__vec_base`, the
   externref vec, `$__vec_i32_byte` (for `$__resizable_ab`) or a class/brand
   struct; none is the `i8_byte` vec). Explicit `final` at registration is not a
   post-seal mutation, so `programAbiSession.recordLeafTypeFinalization` is not
   involved.
2. `src/codegen/index.ts::finalizeLeafStructTypes` — keep the `i32_byte` vec
   OPEN: add `ctx.vecTypeMap.get("i32_byte")` (when registered) to
   `keepOpenTypeIdxs` next to the callable root. It is the root of the buffer
   hierarchy (`$__resizable_ab` subtypes it), so open is the principled state,
   not a hack. Result: `sub $__vec_base` (buffer) vs `sub final $__vec_base`
   (packed-byte view) are distinct canonical types on standalone; on wasi the
   explicit `final` from step 1 does the same job.
3. `src/codegen/dataview-native.ts::emitArrayBufferSliceSpecies` — DELETE the
   `if (ctx.moduleUsesPackedByteTaCarrier) return null;` gate and its comment;
   replace with a short comment naming the brand. The existing step-16
   `ref.test <vecTypeIdx>` (the `i32_byte` vec) now answers false for every
   packed-byte TypedArray, buffer-backed or length-constructed.
4. Remove the round-1 scaffolding so `check:dead-exports` stays green:
   `sourceHasPackedByteTaConstruct` + `PACKED_BYTE_TA_NAMES`
   (`source-scan-predicates.ts`), the `moduleUsesPackedByteTaCarrier` field
   (`context/types.ts`, `context/create-context.ts`) and its two assignments in
   `index.ts` (~L5213, ~L10411), the re-export at `index.ts` ~L349.

Measured on the scratch tree, standalone, node 22 oracle (probes
`.tmp/w5/i8brand/p/*.js`, harness `.tmp/w5/i8brand/run.mts <treeA> <treeB>`):

| probe | pre-fix lane | round 1 | scratch (this plan) | node |
| --- | --- | --- | --- | --- |
| b15 species → `new Uint8Array(4)` | 600 (accepted) | 600 (arm declined) | **1 (TypeError)** | 1 |
| b16 species → `new Uint8Array(new ArrayBuffer(n))` | 1 | 600 | 1 | 1 |
| r5 ArrayBuffer species with `new Uint8Array(2)` in module | 716 | 704 | 716 | 716 |
| r8 `Int32Array` species with `new Uint8Array(2)` in module | 1 | 501 | 1 | 1 |
| t1–t19 (u8 over buffer, DataView over `u.buffer`, `new Int16Array(u8)`, `isView`, slice/subarray, toString, copy-construct, from/of, set, clamped/int8, instanceof, for-of, subarray writes, sort/map/filter, JSON/keys) | — | — | **identical to the pre-fix lane on all 19** | — |

So the brand admits exactly the b15 shape as a TypeError and moves nothing else
in those 19 programs. The alias arm in `emitDynamicUint8ArrayBufferAlias`
(`new Uint8Array(buffer)`) shares the `data` ARRAY, not the struct, so it is
unaffected: array types still canonicalize, only the two vec structs split.

**Pre-existing, NOT this round's (record in the round-2 section, do not fix):**
`u.buffer` of a length-constructed `Uint8Array` is a snapshot copy, not an
alias (t1 40/node 47, t2 90/99, t11 200/242, t17 320/329); `u.sort()` in place
is a no-op and `indexOf`/`join` follow (t18 342/11162); `Object.keys(u)` is
empty (t19); `for (var j in u)` + `[...u]` in one function emits INVALID wasm
(t16 instantiate fails "Compiling function …") — that last one needs its own
issue (allocate an id with `claim-issue.mjs --allocate --no-pr-scan
--allow-unscanned --by ttraenkler/opus`), title "standalone for-in/spread over a
TypedArray emits invalid wasm", with t16 as the repro.

**Order / steps for the lane.** Start from a fresh worktree of the session
branch, `git merge --no-edit worktree-wf_f3919b81-91f-2` (round-1 fix branch;
the issue-file conflict is two sections appended at the end — keep BOTH, theirs
then this section). Commit 1: steps 1+2 (the brand) with a pin that proves
`ref.test` now discriminates (`ArrayBuffer.prototype.slice` species b15 →
TypeError) and the t7/t8/t14/t17 sharing pins unchanged. Commit 2: steps 3+4
(gate removal + scaffolding deletion) + the record correction. Do NOT combine
them — if the corpus control blames one, the other survives.

**Controls (set-diff of non-pass paths, never totals).** Because the brand
changes the type section of every standalone/wasi module that builds a
packed-byte view, the control is the whole TypedArray/ArrayBuffer/DataView
family, not the 33 slice rows: `built-ins/ArrayBuffer` (221),
`built-ins/DataView` (~470), `built-ins/TypedArray` (~1,100),
`built-ins/TypedArrayConstructors` (~730), plus every row outside those
directories whose source mentions `Uint8Array|Int8Array|Uint8ClampedArray`
(grep the corpus; ~150). Protocol that fits the box: run the FIX tree on each
list in ≤150-row chunks at `COMPILER_POOL_SIZE=2`, `--standalone`; diff each
chunk's non-pass set against the fresh standalone baseline
(`node scripts/fetch-baseline-jsonl.mjs --standalone --force`, main
`efa9e76f07`); re-run ONLY the differing rows on a base tree (git archive of
the session branch head — its `src/` equals main's for these files) to
separate baseline drift from this change. Zero rows lost. Then the same lists
under `--target wasi` for compiled-ness only (row runner) — the wasi packed map
is the same code path. Rebuild the compiler bundle AND
`node scripts/build-quickjs-eval-provider.mjs` after the last src edit, on both
trees, before any row run (the adapter is keyed on the bundle hash; a stale
adapter reads as a phantom compile_error, seen in round 1's review).

**Byte identity.** Host: identical on every program (packed storage is gated
on `wasi || standalone`). Standalone/wasi: identical on every program that
registers no `i8_byte` vec (plain arrays, objects, strings, Int32Array-only,
ArrayBuffer-only); a module WITH a packed-byte view differs only in the type
section (`sub` → `sub final` on one type) — assert that with a WAT diff on two
programs, not just a hash.

**Pins** (`tests/issue-5349-species-r5.test.ts`, standalone, `result.imports`
asserted `[]`, node 22 and 25): b15 → TypeError, b16 → TypeError, r5 = 716, r8
= TypeError, s3/s4 (same-object / too-small) → TypeError with a `new
Uint8Array(2)` present in the module, t7 = 415, t14 = 303, t17 = 320 (the
pre-existing value, pinned as "unchanged by the brand", with the node value in
the test name), plus one wasi compile-only pin that the b15 program compiles
and its WAT carries `sub final` on `__vec_i8_byte` and `sub` on
`__vec_i32_byte`. Existing 22 pins stay green.

**Acceptance.** All of: the table above reproduces on the lane tree; zero rows
lost across the five control lists; host byte-identical; the round-1 record
corrected (the false "never a wrong runtime answer" sentence replaced by the
measurement); `sourceHasPackedByteTaConstruct` gone; gates green bare and with
`LOC_GATE_BASE=origin/main`; TS7 typecheck; lint; `Model: Claude Opus 5
Medium`; nothing pushed.

### Round 2 (2026-09-06)

Two commits, both on this branch, measured on the box that carried three other
lanes at 1-minute load 15-18 throughout:

- `3e02bb9d7c` — **the brand.** `getOrRegisterVecType` declares the `i8_byte`
  vec `final: true`; `finalizeLeafStructTypes` keeps the `i32_byte` vec OPEN
  (it is the root `$__resizable_ab` subtypes). Two structurally identical
  structs become two distinct canonical Wasm GC types, on standalone (where the
  open `i32_byte` does the work) and on wasi (where `markLeafStructsFinal`
  returns early and the declared `final` does it). No field, no instruction,
  no byte-count change.
- `52ac986120` — **the gate removal.** `emitArrayBufferSliceSpecies` decides
  §25.1.5.3 step 16 with the `ref.test $__vec_i32_byte` it already had. Deleted
  with it: `sourceHasPackedByteTaConstruct` + `PACKED_BYTE_TA_NAMES`, the
  `moduleUsesPackedByteTaCarrier` context field and its two pre-scan
  assignments, the `index.ts` re-export. `grep -rn` over `src/` and `tests/`
  finds none of the three names.

**Probes, `--target standalone`, `result.imports` asserted `[]`, node 22
oracle** (harness `.tmp/r2/run.mts`, probes `/home/user/js2/.tmp/w5/i8brand/p`,
output `.tmp/r2/probetable3.txt`; trees: this worktree HEAD, `.tmp/r2/r1` =
round-1 state, `.tmp/r2/base` = `origin/main` `efa9e76f07`):

| probe | main | round 1 | **lane (HEAD)** | node 22 |
| --- | --- | --- | --- | --- |
| b15 species → `new Uint8Array(4)` | 600 | 600 | **1 (TypeError)** | 1 |
| b16 species → `new Uint8Array(new ArrayBuffer(n))` | 600 | 600 | **1** | 1 |
| r5 ArrayBuffer species, `new Uint8Array(2)` in module | 704 | 704 | **716** | 716 |
| r8 `Int32Array` species, `new Uint8Array(2)` in module | 501 | 501 | **1** | 1 |
| t1–t19 (19 packed-byte programs) | — | — | **identical on all three trees** | — |

So the brand admits exactly the b15/b16 shape as a TypeError, restores the
legitimate-species answer round 1 had reverted, and moves nothing else in those
19 programs. Round 1's column is flat against main on all four species probes —
i.e. round 1 bought its wrong-answer fix by giving the whole arm back.

**Round-1 correction (also applied in place above).** The round-1 sentence
"the only cost is a declined emission, never a wrong runtime answer" is false;
the replacement quotes this table.

**Controls — five lists, 3,147 rows, every row run, set-diff against the
standalone baseline** (`/home/user/js2/.test262-cache/test262-standalone-current.jsonl`,
fetched 08:12 UTC today from main `efa9e76f07`, which is this branch's
merge-base). Driver `.tmp/r2/drive2.sh` (21 chunks of ≤150 rows,
`COMPILER_POOL_SIZE=2`), diff `.tmp/r2/perlist.mjs`:

| list | scope | rows | non-pass | LOST | GAINED |
| --- | --- | --- | --- | --- | --- |
| L1 | `built-ins/ArrayBuffer` | 221 | 63 | **0** | 9 |
| L2 | `built-ins/DataView` | 561 | 99 | **0** | 0 |
| L3 | `built-ins/TypedArray` | 1,446 | 543 | **0** | 1 (flake, below) |
| L4 | `built-ins/TypedArrayConstructors` | 738 | 226 | **0** | 0 |
| L5 | rows elsewhere naming a packed-byte view | 181 | 107 | **0** | 0 |

**Zero rows lost, on every list.** No row changed non-pass KIND either.

Both classes of difference were re-run on the base tree (`origin/main` `efa9e76f07`, bundles
and QuickJS provider rebuilt there first — the adapter is keyed on the bundle
hash and a stale one reads as a phantom compile_error):

- **The 9 `ArrayBuffer/prototype/slice/species*` gains are real and are r5 step
  5's**, preserved by round 2: 9 fail on main, 9 pass on the round-1 tree, 9
  pass on the lane (`.tmp/r2/base-gained10.txt`, `.tmp/r2/r1-gained9b.out`,
  `.tmp/r2/lane-gained9.out`). None of the nine mentions a packed-byte name, so
  round 1's pre-scan never fired on them.
- **`TypedArray/prototype/subarray/coerced-begin-end-shrink.js` is NOT a gain —
  it is a flaky V8 heap exhaustion, and it is excluded.** The baseline recorded
  it `compile_timeout`; it passed inside its chunk on the lane; run alone at
  `COMPILER_POOL_SIZE=1` it **OOMs the compiler on the lane AND on main**
  (exit 134, `Runtime_AllocateInOldGeneration`). Its neighbour
  `coerced-begin-end-grow.js` OOM-killed a whole 150-row chunk once and then
  answered `fail: illegal cast` — identically on lane and main — when re-run
  alone. Two chunks (12, 14) were lost to this and were re-run split into
  50-row and 10-row pieces (`.tmp/r2/rp2.sh`, `rp3.sh`, `rp4.sh`); every row in
  the table above has a verdict from a run that reached `=== counts ===`.

**49 of L5's 181 rows carry no baseline entry at all** (mostly `staging/sm` and
newer `built-ins/Uint8Array` base64/hex rows). They ran, but they cannot be
scored against a baseline that does not list them; they are counted in "rows"
and excluded from LOST/GAINED.

**WAT evidence** (`.tmp/r2/b15.*.wat`). Standalone, round 1 → lane, the whole
diff is two lines — one type:

```
-  (type $__vec_i32_byte (sub final $type0 (struct (field $length (mut i32)) …)))
+  (type $__vec_i32_byte (sub       $type0 (struct (field $length (mut i32)) …)))
   (type $__vec_i8_byte  (sub final $type0 (struct (field $length (mut i32)) …)))   ← both trees
```

Under `--target wasi` it is the mirror: `$__vec_i8_byte` carries the declared
`final`, `$__vec_i32_byte` stays open. Two distinct canonical types on both
targets, which is what lets step 16's `ref.test` answer.

**Host byte identity — the plan's "identical on every program" is WRONG, and
the correction is one byte.** `finalizeLeafStructTypes` is not target-gated, so
a host module that registers an `i32_byte` vec also loses that type's `final`:
`sub final` → `sub`, `@105 0x4f → 0x50` on b15 (`.tmp/r2/b15.m0.host.wat` vs
`b15.fix.host.wat`, one line of diff). Measured over the 22 probes: 14 modules
differ by exactly that byte, 8 are byte-identical, and t16/t19 were excluded
because an identical-tree control shows those two are non-deterministic
independently of this change. Nothing else moves on host: `$__vec_i8_byte` is
never registered there (packed storage is `wasi || standalone`), so there is no
second type for the canonicalization to collapse against, and dropping `final`
only widens what MAY subtype — it changes no `ref.test` answer.

**wasi — 60-row compile-only sample, not the full lists, deliberately.** The
standalone pass alone took ~5 h wall-clock at this load; a full wasi pass over
the same 3,147 rows would have been comparable, far past the 90-minute
allowance the plan set for it. Sample: every 4th row of the 233 control rows
whose source constructs a packed-byte view (`.tmp/r2/wasi60.txt`). Result
`{ pass: 32, fail: 21, skip: 7 }` — **zero compile_error, zero invalid, zero
crash**; all 21 failures are runtime/semantic (`transfer is not a function`,
`setFromBase64 is not a function`, …), i.e. the wasi packed map still compiles
everywhere the brand reaches it. What this leaves unmeasured: a wasi row
outside those 233 that the brand changes behaviourally.

**Pins.** `tests/issue-5349-species-r5.test.ts` — **34/34 green on node 22
(v22.22.2) and node 25 (v25.9.0)** at `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096
--pool=forks --poolOptions.forks.singleFork=true`, including the round-2 six:
the standalone and wasi WAT shape, buffer/view sharing (415), copy-construction
(13), slice over an aliased view (303), and the pre-existing `u.buffer`
snapshot gap (320 here, 329 in node 22) pinned as unchanged.

Related suites, in ≤3-file batches (`.tmp/r2/pins3.txt`, `pins4.txt`,
`pins5.txt`). Green: `issue-5195*` (4 files), `issue-5309`, `issue-5312`,
`issue-3054-{b1,b2,b3,c,de}`, `issue-1787`, `issue-2199`, `issue-2199b`,
`issue-2593`, `issue-2639`, `issue-2648`, `issue-2861`, `issue-2934`,
`issue-3062`, `issue-3239`, `issue-38`, `issue-4383`, `issue-4778`,
`issue-5117`, `issue-5137`, `issue-5194-{r2,r3,set-r2}`, `issue-1670`.
Four files fail — **every one shown identical on the base tree, so
pre-existing**:

| file | failures | base tree (`origin/main`) |
| --- | --- | --- |
| `arraybuffer-dataview.test.ts` | 6 (`Import #0 module="string_constants"`) | same 6 |
| `typed-array-basic.test.ts` | 11 (same import) | same 11 |
| `issue-1654-wasi-dataview-arraybuffer.test.ts` + `issue-1655-…` | 4 | same 4 |
| `issue-5193-init-marshal-host-typedarray.test.ts` | 1 (module-scope sibling-view aliasing) | same 1 |

**Pre-existing gaps re-confirmed on all three trees** (probe table above, and
so NOT this round's): `u.buffer` of a length-constructed `Uint8Array` is a
snapshot copy, not an alias (t1 40 / node 47, t2 90 / 99, t11 200 / 242,
t17 320 / 329); `u.sort()` in place is a no-op and `indexOf`/`join` follow
(t18 342 / 11162); `Object.keys(u)` is empty (t19 30205 / 30213); and
`[...u]` over a packed-byte view emits INVALID wasm (t16) — filed as
**#5359** with a narrowed repro that shows **spread alone is the trigger and
`for-in` is not implicated**, correcting the round-2 plan's "for-in + spread"
attribution.

**Gates**, run from inside the worktree, bare, statuses read directly
(`.tmp/r2/gates2.txt`): the chained ratchet (`check-loc-budget` →
`check-func-budget` → `check-coercion-sites` → `check:oracle-ratchet` →
`check:dead-exports`) **RC 0**, `check:speculative-rollback` 0,
`check:stack-balance` 0 (no bucket increase), `check:codegen-fallbacks` 0,
`check:any-box-sites` 0, TS7 `--noEmit -p tsconfig.ts7.json` 0, `lint` 0.
LOC across the 15 changed src files vs the merge-base is **net +1**, and no
function needs a growth allowance.

- **`LOC_GATE_BASE=$(git rev-parse origin/main)` FAILS, and it is not this
  branch's growth.** It names `type-coercion.ts` (5278 > 5148),
  `expressions/calls-closures.ts` (2726 > 2699) and
  `property-access-dispatch.ts` (5206 > 5198) — three files this branch does
  not touch (`git diff --name-only efa9e76f07..HEAD` lists none of them). Main
  **shrank** all three after `efa9e76f07`; this branch still carries the older,
  larger copies, so simulating against a base it has not merged reads that as
  growth. `LOC_GATE_BASE=efa9e76f07` (the real merge-base, and the revision the
  baseline JSON was written at) is **RC 0**. The real merge preview takes main's
  shrunken files, so this clears on the catch-up merge — which this lane was
  instructed not to perform.

**Status.** The round-2 objective is met: step 16 decides the packed-byte case
on its own brand, the module-wide arm decline is gone with all its scaffolding,
zero rows lost across 3,147 controls, and the false round-1 sentence is
corrected in place. Steps 6 and 7 (26 TypedArray rows) remain diagnosed and
unimplemented, so the issue stays `in-progress`.

### Round 3 (2026-09-06)

Round 2 branded the packed-byte TypedArray carrier `$__vec_i8_byte` `final` and
kept the ArrayBuffer byte vec `$__vec_i32_byte` open, so the two structurally
identical structs stopped canonicalizing to ONE Wasm GC runtime type. The brand
is right — it is what lets `ArrayBuffer.prototype.slice` step 16 discriminate —
but **several emitters had been written against that identity**, and round 2 did
not look for them. A `ref.cast $__vec_i32_byte` applied to a `Uint8Array` used to
succeed (silently aliasing the view's bytes as a buffer); with the brand it
TRAPS. A `ref.test $__vec_i32_byte` used to answer TRUE for one; with the brand
it answers false and control falls into a numeric fallback.

Five commits on this branch, in the order the defects were found. The brand
itself is kept in full; nothing here reinstates the module-wide arm decline.

#### The site audit

Every `ref.cast` / `ref.test` / `ref.cast_null` in `src/` whose typeIdx comes
from `i32ByteVec(ctx)` or `getOrRegisterVecType(ctx, "i8_byte"|"i32_byte", …)`
— 41 sites, enumerated mechanically (`.tmp/r3/audit.mjs`), plus every static
provenance helper that feeds one (`nativeBufferBuiltinOf`, `isArrayBufferArg`,
`argSymName === "Uint8Array"`). Classes: **(i)** the value can only ever be one
carrier, or the site is already brand-guarded — keep; **(ii)** it can be either —
dispatch on both; **(iii)** it relied on the identity to ALIAS — copy or alias
per spec.

| site | class | what changed |
| --- | --- | --- |
| `emitTaViewConstruct` (dataview-native) | ii + iii | The recover cast is guarded: `$__vec_i32_byte` → the buffer (unchanged fast path), `$__vec_i8_byte` → §23.2.5.1.2 element-wise COPY into a fresh byte buffer, anything else → a zero-length buffer. Emitted only where a cast would have been emitted anyway. |
| `emitTaViewConstructWindowed` | ii | Same guard. `byteOffset`/`length` then validate against the copy — a deviation from §23.2.5.1.2 (which IGNORES them for a TypedArray source), recorded, not a trap. |
| `emitDynamicTaViewConstruct` | ii | Same guard at `bytes: 1` (raw byte copy) — the destination kind is a RUNTIME value here, so there is no static element width to re-encode into. |
| `emitArrayBufferSlice` (receiver) | ii | Same guard at `bytes: 1`. Found by the audit, not by the review. |
| `tryLengthAndNameReads` (property-access-dispatch) | ii | `.length` of a `$__ta_view` receiver: that carrier's field 1 is `buf`, not `data`, so the struct-shape probe missed it and the `ref.test <vec>` ladder answered 0. |
| `tryBufferViewAttributeReads` `.byteLength` | ii | Consults `$__vec_i8_byte` before answering 0. Found by the audit; it was a wrong ANSWER, not a trap, because the probe already had a `ref.test`. |
| `tryCompileNodeProcessApi` (node-fs-api) | ii | The write carrier is picked from the raw checker symbol and the call boundary casts to it. Now an externref argument tests the brand and calls the matching helper (`__wasi_write_uint8array_i8` / `__wasi_write_arraybuffer`), neither → write nothing. |
| `emitDynamicUint8ArrayBufferAlias` | iii | New `$__vec_i8_byte` arm: fresh array + `array.copy` + fresh carrier. The `$__vec_i32_byte` arm keeps its buffer-ALIAS semantics. The #5194 doc block's premise ("build the carrier over the SAME array") is corrected in place. |
| `emitTaDynCtorConstructFromLocals` | iii | `i8_byte` joins the PLAIN-VEC copy arms — a typed-array source read element-wise through `array.get_u`, not a byte buffer. §23.2.5.1.2 step 5 comes with it: a BigInt destination from this source is a TypeError. |
| `emitTaPlainVecElementToF64` | ii | Packed source elements read with `array.get_u` (plain `array.get` does not validate on a packed array). |
| `finalizeLeafStructTypes` (index.ts) | — | The keep-open is gated on `ctx.wasi \|\| ctx.standalone`. `$__vec_i8_byte` is never registered on the JS-host lane, so there was no second type to separate from and the dropped `final` bit only moved bytes. |
| `ensureArrayBufferTransferHelper` | i | The cast sits under a `ref.test` that already decides; a non-buffer is simply not transferred. |
| `tryCompileStandaloneDetachedWrite` | i | Same shape — `ref.test` then cast. |
| `emitTaViewDynamicByteLength` | i | The value is a `$__ta_view`'s `buf` field, typed `$__vec_i32_byte` by construction. |
| `emitArrayBufferSliceSpecies` (step 16) | i | This IS round 2's brand test. Unchanged, and now decided by two genuinely distinct types. |
| `emitDataViewByteExports` (vec-access-exports) | i | `ref.test` then cast, per export. |
| `tryCompileIndexedBuiltinNew` (new-indexed) | i | Casts a value the same expression just built. |
| `emitObjectProtoToStringClassifier` | i | A brand TEST with no cast; the brand makes it MORE accurate (a Uint8Array no longer answers `[object ArrayBuffer]`). |
| `emitArrayBufferSlice` (species result) | i | Guarded by step 16's `ref.test` in `emitArrayBufferSliceSpecies`, which throws otherwise. |

#### Probes — 102 files, `--target standalone`, `result.imports` asserted `[]`

Trees: **node** = node 22 oracle · **base** = `.tmp/rev5349/base` (`4324022bd5`) ·
**lane** = `wf_2c593ff3-433-2` (`42cf719b19`, pre-fix r5) ·
**r2** = the merge state `53022bc096` (round 2) · **fix** = HEAD.
Harness `.tmp/r3/allprobe.mts`; every row of the 102 that any tree disagrees on:

| probe | node | base | lane | r2 | fix |
| --- | --- | --- | --- | --- | --- |
| `pb/r1` reassigned binding | 4 | 0 | 0 | **TRAP** | **4** |
| `pb/r3` rewritten array element | 4 | 0 | 0 | **TRAP** | **4** |
| `p5/g01` reassign + element write | 49 | 49 | 49 | **TRAP** | **49** |
| `p5/g10` array-element ctor arg | 4 | 4 | 4 | **TRAP** | **4** |
| `p4b/s01` (wasi) `process.stdout.write` | ABC/1 | ABC/1 | ABC/1 | **TRAP** | **ABC/1** |
| `p6/h01` helper, both shapes | 442 | 442 | 442 | 400 | **442** |
| `p6/h02` helper, view source | 33 | 33 | 33 | 0 | **33** |
| `pb/r2` `mk(new Uint8Array(3)).length` | 3 | 3 | 3 | 0 | **3** |
| `p8/m01` testWithTypedArrayConstructors | 333 | 331 | 331 | 0 | **333** |
| `p5/g02` copy-not-alias observation | 313 | 393 | 393 | 110 | **313** |
| `p5/g04` `new Int32Array(u8)` | 8 | 2 | 2 | 0 | **8** |
| `p6/h04` `new Int32Array` via a param | 28 | 22 | 22 | 20 | **28** |

Six of the twelve now beat **base** as well as round 2, because base's answers
came from the aliasing the brand exposed. Every other probe of the 102 is
**identical on r2 and fix**; the ones where base differs are round-2's own gains
(`c12`, `c13`, `e12`, `g05`, `h05`, `q03`) and they are preserved.

Audit probes (`.tmp/r3/paud`, same protocol), the four the 102 did not cover:

| probe | node | base/main | r2 | fix |
| --- | --- | --- | --- | --- |
| `ab.slice` on a reassigned binding | 4 | 4 | **TRAP** | **4** |
| `.byteLength` on the same | 8 | 8 | **0** | **8** |
| `new DataView` over the same | TypeError | 8 | TypeError | TypeError |
| `new BigInt64Array(erased u8)` | TypeError | 0 | 0 | **TypeError** |

The `DataView` row is a round-2 GAIN, kept. `.buffer` (−1 vs node 8),
`ArrayBuffer.isView` and `Object.prototype.toString` on a reassigned binding
(0 vs node 1), `ab.slice` on an erased ArrayBuffer (−1 vs 4) and `.set` on a
reassigned binding (0 vs 12) are IDENTICAL on all three trees — pre-existing,
not this round's, not fixed.

#### Residuals this round creates or leaves, stated plainly

- **An erased `Int8Array` source widening into a >1-byte destination reads
  UNSIGNED.** `Int8Array`, `Uint8Array` and `Uint8ClampedArray` share one
  `$__vec_i8_byte` carrier and signedness is a static property of the TS name,
  so `new Int16Array(erasedInt8Array)` stores 255 where node stores −1. A
  byte-width destination is unaffected (the stored byte is identical either
  way). Closing it needs the carrier to record its element signedness.
- **`emitTaViewConstructWindowed` validates `byteOffset`/`length` against the
  COPY.** §23.2.5.1.2 ignores both for a TypedArray source; this returns a
  windowed view of the copy instead. A bounded wrong answer where round 2 had a
  trap.
- **`emitDynamicTaViewConstruct` recovers at `bytes: 1`.** Right for the
  byte-width ctor kinds, a wrong element count for the wider ones.
- **`ab.slice` on a packed-byte receiver returns a byte buffer**, not the
  Uint8Array node returns. The length matches; the type does not. Pre-existing
  in kind (main was equally wrong), non-trapping now.

#### wasi

**Compile-only over ALL 233 packed-byte-view rows**, not a sample. The row
runner has no wasi target (`runTest262File` accepts only `"standalone"`), so
`.tmp/r3/wasicompile.mts` assembles what the runner would — `assert.js` +
`sta.js` + every `includes:` harness file + the test body — compiles it at
`--target wasi` and calls `WebAssembly.validate`:

| tree | ok | compile_error | invalid | crash |
| --- | --- | --- | --- | --- |
| round 2 (`53022bc096`) | 222 | 9 | 2 | 0 |
| **this tree** | **222** | **9** | **2** | **0** |

The 11 non-ok rows are the SAME 11 on both trees (set-diff empty). None is a
packed-byte-map failure: nine are host-import refusals in `staging/sm`
(`env.isNaN`, `env.SharedArrayBuffer_new`, `env.__proto_method_call` under
`--no-host-imports`) and two are pre-existing `WebAssembly.validate false`
(`staging/sm/TypedArray/set-negative-offset.js`,
`staging/sm/generators/iterator-next-non-object.js`). Round 3 introduces zero
wasi compile regressions.

The 102-probe set was also RUN under `--target wasi` against a minimal
`wasi_snapshot_preview1` shim (`.tmp/r3/allwasi.mts`), on base / round 2 / this
tree: every standalone row above reproduces, including `p4b/s01` writing
`[65,66,67]` and returning 1.

#### Host byte identity

`.tmp/r3/allprobe.mts <tree> host`, sha256 of the emitted binary, 102 probes,
against `git archive 50c81e5487` (this branch's main merge-base):

| tree | modules differing from main |
| --- | --- |
| round 2 | **70 of 102** |
| this tree | **0 of 102** |

Round 2's host delta was one byte per module (`sub final` → `sub` on
`$__vec_i32_byte`) and bought nothing: `$__vec_i8_byte` is registered only under
`wasi || standalone`, so on the host lane there is no second type to separate
from. Gating the keep-open on `ctx.wasi || ctx.standalone` removes it entirely.
`emitRecoverBufferVecGuarded` is gated the same way for the same reason — without
that, its `getOrRegisterVecType("i8_byte", …)` added a type to the six host
`ab.slice` modules.

#### Pins

`tests/issue-5349-species-r5.test.ts` — **60/60 green on node 22 (v22.22.2) and
node 25 (v25.9.0)** at `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 --pool=forks
--poolOptions.forks.singleFork=true --dangerouslyIgnoreUnhandledErrors`. Round 3
adds 26: the four X1 shapes, the six X3 shapes, a copy-not-alias minimum
(`new Uint8Array(u); c[0]=9; u[0]` → 1), a buffer-ALIAS pin that the i32_byte arm
did NOT become a copy, all nine numeric TA kinds from a Uint8Array source through
an erased binding, the BigInt refusal, the wasi `process.stdout.write` case
(executed against an inline fd_write shim), the two audit shapes, and a host
`sub final` shape pin.

Related suites, 48 files in 16 three-file batches (`.tmp/r3/suites/`).
**11 batches fully green**, including `issue-5194-{r2,r3,set-r2}`,
`issue-3054-{b1,b2,b3}`, `issue-5195-{r2,r3-heritage,r3-restricted,r3-review}`,
`issue-5309`, `issue-5312`, `issue-2631`/`issue-2633`/`issue-2655` (node-fs),
`wasi`/`wasi-target`/`wasi-stdin`, `real-world-wasi`. Five batches red — **every
failure reproduced identically on the round-2 tree**, and the wasi four also on
`main`:

| file(s) | failures | round-2 tree | main |
| --- | --- | --- | --- |
| `arraybuffer-dataview` + `typed-array-basic` + `issue-5193` | 18 (6 + 11 + 1) | same 18 | — |
| `issue-1654-wasi-dataview-arraybuffer` + `issue-1655-…` | 4 (`illegal cast`) | same 4 | same 4 |
| `wasi-environ` | 3 | same 3 | — |

#### Gates

Run from inside the worktree, bare, statuses read directly: the chained ratchet
(`check-loc-budget` → `check-func-budget` → `check-coercion-sites` →
`check:oracle-ratchet` → `check:dead-exports`) **RC 0**;
`check:speculative-rollback` 0, `check:stack-balance` 0,
`check:codegen-fallbacks` 0, `check:any-box-sites` 0, TS7
`--noEmit -p tsconfig.ts7.json` 0, `lint` 0.

**`LOC_GATE_BASE=$(git rev-parse origin/main)` is RC 0 for BOTH budget gates** —
unlike round 2, which failed it on `type-coercion.ts` /
`expressions/calls-closures.ts` / `property-access-dispatch.ts`. Those were
main's post-merge shrink showing up as growth against a base the branch had not
merged; this branch merged main `50c81e5487`, so the simulation now matches CI.

Growth allowances, all in this issue's frontmatter with dated rationales:
`property-access-dispatch.ts` and `node-fs-api.ts` (LOC), and the functions
`tryLengthAndNameReads`, `emitTaDynCtorConstructFromLocals`,
`tryBufferViewAttributeReads`.

#### Controls — the same five lists, 3,147 rows, every row run

Driver `.tmp/r3/drive2.sh` (21 chunks of ≤150 rows, `COMPILER_POOL_SIZE=2`,
`--standalone`), started only AFTER the last src edit and with the compiler
bundle + `runtime-bundle.mjs` + the QuickJS eval provider rebuilt (the adapter is
keyed on the bundle hash; a stale one reads as a phantom compile_error). An
earlier start was discarded and rerun from scratch when a later fix landed
mid-run — a control from two different trees is not a control.

**Set-diff against the standalone baseline** (`test262-standalone-current.jsonl`,
main `efa9e76f07`), `.tmp/r3/perlist.mjs`:

| list | scope | rows | non-pass | LOST | GAINED |
| --- | --- | --- | --- | --- | --- |
| L1 | `built-ins/ArrayBuffer` | 221 | 63 | **0** | 9 |
| L2 | `built-ins/DataView` | 561 | 99 | **0** | 0 |
| L3 | `built-ins/TypedArray` | 1,446 | 543 | **0** | 0 |
| L4 | `built-ins/TypedArrayConstructors` | 738 | 223 | **0** | 1 |
| L5 | rows elsewhere naming a packed-byte view | 181 | 107 | **0** | 0 |

**Zero rows lost, on every list. No row changed non-pass KIND either.** The nine
L1 gains are r5 step 5's `ArrayBuffer/prototype/slice/species*` rows, unchanged
from round 2. The one L4 gain is **round 3's own**:
`TypedArrayConstructors/ctors/typedarray-arg/returns-new-instance.js`, which is
literally §23.2.5.1.2 — on the round-2 tree it fails
`Expected SameValue(«0», «10»)` (the erased typed-array source produced an empty
view), and the baseline records it `fail`.

**Set-diff against ROUND 2's own chunk outputs** (`wf_76a5e57d-8c2-1/.tmp/r2/fixrun`),
`.tmp/r3/runsdiff.mjs`: `compared=3146 LOST=0 GAINED=3 changedNonPassKind=0`.
Two of the three (`TypedArrayConstructors/internals/Get{,/BigInt}/infinity-detached-buffer.js`)
are **not** round-3 gains — the baseline records both `pass` and this tree passes
them; they are non-pass only in round 2's chunk output, i.e. an artifact of that
run.

**3,146 of 3,147 rows carry a verdict from a run that reached `=== counts ===`.**
Chunk 14 OOM-killed at 150 rows; it was re-run split to 25 rows, then 5, then 1
(`.tmp/r3/rerun14{,a,b}`), which gives 149 of its 150 a clean verdict. The
remaining row is `TypedArray/prototype/subarray/coerced-begin-end-shrink.js`,
which **OOM-kills the compiler run alone at `COMPILER_POOL_SIZE=1` on THIS tree
AND on main** (`git archive 50c81e5487`, exit 134,
`Runtime_AllocateInOldGeneration`) — measured here, not inherited; the baseline
records it `compile_timeout`. Recorded, not counted.

**49 of L5's 181 rows carry no baseline entry** (mostly `staging/sm` and newer
`built-ins/Uint8Array` base64/hex rows). They ran; they cannot be scored against
a baseline that does not list them, so they are counted in "rows" and excluded
from LOST/GAINED.

#### Status

The three defects the review reproduced are closed, two more the audit found are
closed, and the brand is intact and now host-free-lane-only. Zero rows lost over
3,147 controls, one real conformance gain, host emission byte-identical to main.
Steps 6 and 7 (26 TypedArray rows) remain diagnosed and unimplemented, so the
issue stays `in-progress`.
