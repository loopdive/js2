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
