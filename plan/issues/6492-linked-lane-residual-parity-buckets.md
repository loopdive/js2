---
id: 6492
title: "Linked lane P3c residual: 705 pass→fail rows in ~12 provider-side buckets (BigInt convert, __module_init null, extern class stubs, illegal-cast trap)"
status: in-progress
sprint: current
created: 2026-09-16
updated: 2026-09-18
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: test262-harness
goal: test262-conformance
depends_on: [6490]
related: [3451, 6486, 6489, 6490, 6491, 6482]
# 2026-09-16 — bucket 2 (`__cb_<id>` erases `await`): the whole change is one
# early bail at the TOP of `compileArrowAsCallback`, +30 lines of which 24 are
# the comment recording WHY a suspending async callback must not reach the
# host-callback bridge. The decision belongs where the bridge is entered — the
# alternative (a predicate module) would put the condition one indirection away
# from the `return compileArrowAsClosure(...)` escape it shares with the
# standalone arm 400 lines below, which is the thing a reader has to see next to
# it. `compileArrowAsCallback` is the god-function that owns callback lowering;
# splitting it is #3399's job, not this bug's.
# 2026-09-17 — bucket `Cannot convert 0 to a BigInt`: +6 lines in `src/runtime.ts`.
# The mechanism (a second, buffer-shaped owner probe for the #5225 registry) is
# 60 lines and ALL of it went into the subsystem module
# `src/runtime/cross-module-struct-owners.ts`, which is where the god-file gate
# wants it. What stays in the barrel is the single line that consults it plus
# the comment saying which module the three byte-reader exports must agree on —
# and that has to sit AT `_compiledAbToHostBuffer`, because the bug was exactly
# that its `__dv_byte_len`/`__dv_byte_get`/`__ab_max_len` reads silently came
# from three-ways-unrelated modules. Moving the call out would move the
# decision away from the reads it constrains.
# 2026-09-17 (round 3) — `_classChainRead` cross-module owner re-ask: +27 lines
# in `src/runtime.ts`, of which 22 are the comment. The CODE is 5 lines and it
# has to live exactly here: the thing being corrected is the meaning of the
# `_classObjectOwnedBy` guard on the line above it, and the comment records the
# one fact a reader cannot recover from the diff — that the identity `===`
# depends on the re-ask returning the SAME cached `_wrapForHost` mirror the
# consumer's own crossing produced, not merely "the right class object". Moving
# either out of `_classChainRead` puts the correction one indirection away from
# the guard it corrects. The function is 6 lines of dispatch; splitting it is
# not a thing that exists to do.
# 2026-09-17 (round 5) — `__instanceof` asks the sandbox realm: +27 lines in
# `resolveImport`, of which 22 are the comment. The CODE is 2 lines and it has
# to sit on the line after the `globalThis[ctorName]` lookup it corrects: the
# thing a reader cannot recover from the diff is WHY a second realm exists at
# all here — that the construction site (`globalSandbox?.Promise ?? Promise`)
# already prefers the sandbox while this lookup did not, so the two disagreed
# about the same value. Moving it out of the import factory would separate the
# correction from `globalSandbox`, the parameter that makes it meaningful.
# `resolveImport` is the import-name dispatch table; splitting it is #3399's
# job, not this bug's.
# 2026-09-17 (round 6) — `LIB_GLOBALS` gains the lib.es5 `declare function`
# names: +24 lines in `src/codegen/extern-declarations.ts`, of which 9 are the
# nine names and 15 are the comment. The set IS the gate, so the names have to
# live in it, and the comment has to sit with them because the failure it
# records is invisible from the diff: a name missing here means
# `collectDeclaredGlobals` never RUNS, which silently suppresses the
# `__call_function` host arm three modules away and turns an indirect `eval`
# into an uncatchable trap. The neighbouring `EvalError` note already records
# the same failure for the ambient constructors; this is its `declare function`
# half, and separating the two would hide that they are one rule.
# 2026-09-17 (round 6) — the UNDEF-SENTINEL producer re-ask: +19 lines in
# `src/codegen/type-coercion.ts`, of which 18 are the comment. The CODE is one
# line, and it has to sit exactly between `addUnionImports` and the
# `__box_number` lookup, because the ORDER is the correctness argument:
# registering an import shifts func indices, and `flushLateImportShifts` remaps
# already-EMITTED instructions but not an index already captured in a local. A
# reader who moves the line two lines down reintroduces a stale-index bug that
# no test names. The rest of the comment records the one fact the diff cannot
# show — that `canonicalUndefinedExternInstrs` is read-only BY DESIGN and its
# `ref.null.extern` fallback is not a fallback but a different VALUE.
# 2026-09-17 (round 4c) — `Iterator.prototype.chunks` / `.windows`: +13 lines in
# `src/runtime/iterator-polyfills.ts` (which crosses the 1500-line god-file
# threshold) and +160 inside `_installIteratorHelperPolyfills`, plus +10 in
# `src/runtime.ts` for two names and their comment in `_ITER_HELPER_NAMES`.
# The two helpers cannot live anywhere else: they are written against four
# bindings that are LOCAL to `_installIteratorHelperPolyfills` and exist only
# once the host's `%Iterator%` has been resolved — `Iproto`,
# `compilerIteratorProto`, `_makeHelperIterator` and `_closeIterator`. Every
# one of the ten existing helpers (`map`/`filter`/`take`/`drop`/…) is written
# there for exactly that reason, and hoisting two of the twelve out would put
# them on the far side of the host/compiled prototype split whose handling is
# the whole point of this change. The `_ITER_HELPER_NAMES` line is likewise
# fixed: it is the #3049 list that decides whether a COMPILED receiver gets the
# iterator-record bridge, and a helper absent from it is unreachable from a
# generator however it is implemented. Splitting the god-function is #3399's
# job; this is +2 entries in a 12-entry table.
# 2026-09-18 (round 28) — the two added `ctx.checker` reads FORWARD an already
# threaded checker to an EXISTING raw-checker consumer; they add no new query.
# `replaySafeNestedCallAwait` (src/codegen/async-cps.ts) has always called
# `getResolvedSignature` / `getTypeOfSymbolAtLocation` / `getSymbolAtLocation`
# directly — it asks for `ts.Signature` and declaration IDENTITY (is this callee
# bound by exactly one `const` declaration?), which `ctx.oracle` does not
# express. Round 28 only makes the try/catch analysis pass the checker its
# caller already holds, so the same predicate can run on that path at all.
# Migrating that predicate to the oracle is a separate change with its own
# measurement.
oracle-ratchet-allow:
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
loc-budget-allow:
  - src/codegen/closures.ts
  - src/runtime.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/type-coercion.ts
  # 2026-09-17 (round 9) — the free-global-call MECHANISM is a new subsystem
  # module, `src/codegen/expressions/linked-free-global-call.ts` (170 lines,
  # 60 of them the rationale). What lands in the god-file is +13 lines: the
  # import plus one guarded dispatch. It has to sit in `call-identifier.ts`
  # and nowhere else, because the thing being corrected is the REACHABILITY of
  # `tryEmitUndeclaredCalleeReferenceError` on the next line — the arm is
  # meaningful only as "before that unconditional throw", and the declared/
  # implicit-callee/runtime-eval conditions it must not shadow are local
  # variables of that dispatch chain. Splitting the chain is #3399's job.
  - src/codegen/expressions/call-identifier.ts
  - src/runtime/iterator-polyfills.ts
  # 2026-09-18 (round 29) — a further +76 in `src/codegen/async-cps.ts` for the
  # #6504 spill continuation's PLANNER half: the `spilledCall` segment field,
  # the shape arm in `lowerLinearStatements`, and the two hook attachments in
  # `linearPlanToCfg`. The mechanism (shape predicate + both emit halves) lives
  # in the new `src/codegen/async-spilled-call.ts`; what lands here is only what
  # must sit inside the private lowering walk and the CFG builder it feeds.
  # 2026-09-18 (round 28) — +26 lines in `src/codegen/async-cps.ts`, all of them
  # one threading gap across the THREE `LowerState` builders: `lowerChunk` /
  # `lowerRegionBody` / `analyzeTryCatchAsync` (try/catch) and
  # `analyzeWhileAsync` (while-with-await), plus the four exported entry points
  # that reach them (`planTryCatchCfg` + `tryCatchAsyncSpillInfo`,
  # `planWhileLoopCfg` + `loopAsyncSpillInfo` — each planner paired with its
  # spill-info twin, which must make the same shape decision). About half the
  # lines are the three rationale comments; the rest are parameter declarations
  # and their forwarding at the recursive call sites. It cannot move to a
  # subsystem module: the parameter must travel through these exact private
  # recursive functions, which is the whole of the change.
  - src/codegen/async-cps.ts
func-budget-allow:
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/runtime.ts::resolveImport
  - src/codegen/type-coercion.ts::coerceType
  # 2026-09-17 (round 9) — same +12 lines as the LOC grant above, counted
  # against the enclosing dispatcher. The guard cannot move out of
  # `compileIdentifierCall` without carrying `declaration`, `implicitCallee`
  # and `isRuntimeEvalGlobal` with it; the emission it guards already lives in
  # its own module.
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/runtime/iterator-polyfills.ts::_installIteratorHelperPolyfills
  # 2026-09-18 (round 28) — +1 line: `planTryCatchCfg` gains the optional
  # `checker` parameter it must forward to `analyzeTryCatchAsync`. The function
  # is a 375-line CFG builder that #3399 will split; this change adds a
  # parameter declaration to its signature and nothing to its body.
  - src/codegen/async-cps.ts::planTryCatchCfg
  # 2026-09-18 (round 16) — RESTATED STRANDED GRANT, not this round's growth.
  # `223ed4474a fix(#5406)` on this shared branch grew the classifier by +15
  # (392 > 377) and its own issue file carries no allowance, so the func gate
  # fails only against CI's base (`LOC_GATE_BASE=origin/main`) and would block
  # every later commit on the branch. Restated here per the stranded-grant rule
  # so the PR can go green; the growth belongs to #5406, not to #6492.
  - src/codegen/object-proto-tostring.ts::emitObjectProtoToStringClassifier
---

# #6492 — linked lane residual after P3c

## Problem (2026-09-16, run 35152748683, main @ 52b8143a39)

After #6489/#6490/#5950 the linked-harness lane agrees with the honest lane on
97.6 % of the corpus; 705 rows are honest-pass / linked-not-pass. The #3451
slice-6 flip needs (a) zero uncatchable-trap buckets (the #3189 trap ratchet
is never excused by a re-baseline) and (b) a residual small enough to declare
honestly. Buckets, from the `merge linked evidence` parity report of that run
(`Difference buckets`, first 80 chars):

| rows | bucket | first hypothesis |
| ---: | --- | --- |
| 128 | `TypeError: Cannot convert 0 to a BigInt (Testing with BigInt64Array and makePass…` | `testWithBigIntTypedArrayConstructors` in the provider now dispatches the consumer callback through the host (#6490); the BigInt constructors' argument coercion inside the provider converts a consumer `0` number where the honest assembly saw a BigInt literal — check the provider-side `BigInt64Array` ctor path and the `__call_function` argument boxing for bigint |
| 61 | `Test262:AsyncTestFailure:TypeError: Cannot read properties of null (reading 'the…` | async rows: a provider `asyncTest`/`$DONE` closure returning a consumer promise whose `.then` is read on a null — likely the same cross-module closure-root miss as #6490 in `compileReceiverMethodCall` (the sibling the #6490 issue records as untouched) |
| 24 + 9 + 9 | `Cannot read properties of null/undefined (reading 'catch' / 'next') [in __module_init()]` | same family: consumer promise / iterator handed to a provider helper (`asyncTest`, `checkSequence`, `testWithTypedArrayConstructors` iterables) |
| 49 + 26 | `Expected a undefined to be thrown but no exception was thrown at all` / `Expected a undefined but got a TypeError` | `assert.throws(SomeCtor, fn)` where the provider reads `SomeCtor` (a consumer class or realm ctor) as `undefined` — the constructor value crosses the boundary as a closure the provider cannot see; compare with #6482 |
| 22 | `illegal cast [in __cb_2() ← __closure_62]` | uncatchable trap in a provider callback — MUST be fixed or excluded before the flip; locate `__closure_62` in the provider WAT (`scripts/test262-linked-harness-smoke.mts` can dump it) |
| 23 + 12 | `No dependency provided for extern class "badArrayType" / "OProxy"` | the consumer body declares a class with the same name as a harness extern stub; linker dependency resolution fails — a body-side name collision the honest assembly never sees |
| 22 | `Thrown value was not an object!` | provider `assert.throws` receiving a consumer-thrown primitive/`Test262Error` that crossed as a non-object |
| 18 + 15 + 14 + 12 | `Expected a TypeError …`, `async completion marker not observed`, `Expected a SyntaxError …`, `AsyncTestFailure: Expected true but got false` | sample 3 rows each after the classes above are fixed |

Not in scope here: #6491 (36 early-error rows), #6482 (descriptor-shape
residual, ~130 rows), the 16 `import.defer` proposal rows (honest CE vs linked
fail — a verdict-shape difference, not a lane bug).

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

Order by rows × certainty; each step is one measured commit.

1. **Repro harness first.** For each bucket pick one row from the parity
   report's `pass → fail` table (the JSON artifact of run 35152748683 has all
   705; if artifact download is blocked, take the rows printed in the job log
   of `merge linked evidence`, job 104989517829). Run it through the real
   runner in linked mode — this is the ground truth, not the smoke script:
   `RUN_TIMESTAMP=p TEST262_CHUNK_INDEX=0 TEST262_CHUNK_TOTAL=1 TEST262_ORACLE_MODE=linked TEST262_RESULT_PREFIX=test262-linked TEST262_INCLUDE_PROPOSALS=1 JS2WASM_TEMPORAL_CACHE=.test262-cache/temporal TEST262_PATH_FILTER="<path1>|<path2>" VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 npx vitest run tests/test262-chunk-dynamic.test.ts`
   (rebuild `scripts/compiler-bundle.mjs` + `scripts/runtime-bundle.mjs` after
   every compiler change; delete `.tmp/linked-smoke` — the provider cache key
   is not keyed on the compiler build, #6488). Capture the base verdicts in
   `.tmp/p6492/` before the first edit.
2. **`illegal cast` (22, trap)** — find the cast site in the provider
   (`__closure_62`), determine which consumer value it casts, and route it
   through the host arm the way #6490 did (`calleeIsLinkedProviderParam` is
   the template; the sibling site is `compileReceiverMethodCall` in
   `src/codegen/expressions/calls.ts`). Acceptance: the bucket is 0 and no new
   trap category appears.
3. **`__module_init` null `.catch`/`.next` (42) + AsyncTestFailure null (61)**
   — same closure-root family for promises/iterators reaching provider
   helpers; fix at the same dispatch site or in `src/linked-provider-runtime.ts`
   if the value crosses as an externref that needs the #5225 decoder registry
   (`_crossModuleStructs.decoderFor`).
4. **BigInt convert (128)** — reproduce with one
   `TypedArray/prototype/*/BigInt/*` row; the fix is either bigint boxing in
   `__call_function` argument marshalling or the provider's BigInt typed-array
   constructor path; measure both hypotheses before changing either.
5. **`Expected a undefined …` (75)** — likely #6482-adjacent; if the fix lands
   in the same descriptor/identity substrate, cite #6482 and leave that issue's
   own residual table updated.
6. **extern class stubs (35)** — a linker-side rule: a consumer-declared name
   that shadows a provider extern must win (or the provider stub must be
   unreferenced when the body declares it). Fix in `src/package-linker.ts` or
   the harness provider builder (`src/test262-harness-provider.ts`).
7. **`Thrown value was not an object!` (22)** and the four small buckets —
   sample after 2–6 and fix what remains in the same substrate.
8. Every commit: gates (`check-loc-budget`/`func-budget` with
   `LOC_GATE_BASE=$(git rev-parse origin/main)`, coercion, oracle-ratchet,
   dead-exports, host-import-policy, `check-compiler-boundaries.mjs --mode
   inventory --base origin/main`, typecheck, lint, `pnpm run build`); the
   equivalence gate once at the end; ONE `Model: Claude Opus 5 Max` trailer per
   commit. Budget allowances go in this file's frontmatter with a dated
   rationale.

## Implementation notes (2026-09-16, Opus lane)

Branch `issue-6492-linked-residual-buckets`, based on `0f69af09cb`.

### Measurement setup (plan step 1)

The CI artifact of run 35152748683 is not reachable from this container
(`*.blob.core.windows.net` blocked) and `gh` is not installed here, so the
sampled rows were derived locally instead of read off the report: the real
runner (`tests/test262-chunk-dynamic.test.ts`) was run over **chunk 0 of 57 of
the whole corpus in BOTH lanes** (850 rows, honest and `TEST262_ORACLE_MODE=linked`),
and the pass→fail set diffed per row. That reproduces the parity report's method
on a 1/57 sample and gave a live row for the `illegal cast` bucket; the buckets
too small to appear in 850 rows were then hunted by their error string over a
6,317-row linked run of the async/Promise/Iterator families, with the honest
verdict fetched only for the matching rows.

**Local hazard worth recording for the flip plan (#6488):** the provider cache
(`/tmp/js2wasm-test262-harness-cache`, `JS2WASM_TEST262_HARNESS_CACHE`) is keyed
on the harness prefix + ABI versions, **not on the compiler build**. The first
survey here reported 4 `dereferencing a null pointer [in testWith…]` rows — the
#6490 bucket, already fixed — purely because the cache still held day-old
provider artifacts. Every measurement below uses a fresh cache dir. CI is not
exposed (a runner's tmpdir is empty and the workflow does not restore that
cache), but any local re-measurement is.

### Bucket `illegal cast` (22 rows, the trap bucket) — FIXED

Root cause: **the canonical method-closure trampoline is minted from a
pre-final signature and its wrapper ABI is never repaired.**
`ensureMethodClosureSingleton` mints `__obj_meth_tramp_<m>_cached` at the first
access to the method as a value. In a MULTI-FILE graph — which is how the linked
lane compiles a body — the member-get dispatcher reserves the singleton before
the method body resolves its parameter ABI, so `class C { m([a]) {} }` captured
a module-internal tuple struct `(ref $10)` while `C_method` finally accepted
`externref`. `finalizeMethodTrampolines` rebuilds the trampoline BODY (#1602/
#1669) but leaves the wrapper func type, and that type is what CALLERS dispatch
on: the closure-call site matched the struct-param arm and emitted an unguarded
`ref.cast (ref $10)` of the argument, so `C.prototype.m([1, 2])` trapped.

Fix site: `finalizeMethodTrampolines` (`src/codegen/closures/method-trampolines.ts`)
widens the trampoline's own func type back to the method's final ABI — narrowing
direction only, and only to a wrapper that already exists
(`peekFuncRefWrapperTypes`, new in `funcref-wrapper-types.ts`), so every
already-emitted dispatch chain still knows the arm.

Not lane-gated by a flag, and it does not need to be: the drift requires a
multi-file graph, and the honest test262 lane compiles one file. Verified rather
than assumed — honest chunk 0/57 before vs after: **850 rows, 0 verdict
differences.**

| measurement | before | after |
| --- | --- | --- |
| `language/statements/class/dstr/async-gen-meth-ary-ptrn-elision-step-err.js` (real runner, linked) | fail: illegal cast | **pass** |
| linked chunk 0/57 vs honest, pass→fail | 11 | 10 |
| `illegal cast` rows in that chunk | 1 | **0** |

### Bucket `AsyncTestFailure … Cannot read properties of null (reading 'then')` (61) — FIXED

Root cause: **the `__cb_<id>` host-callback bridge erases `await`.**
`compileArrowAsCallback` compiles the callback body with no async activation, so
a suspending async function literal became a plain synchronous function
returning `undefined` (`__cb_0` drops the awaited call and returns
`__get_undefined`). #4648 had already noticed the AWAIT-FREE half of this and
added a Promise wrapper; the await-ful half was simply mis-lowered. Nothing
caught it because the static call-site repair (`isAsyncCallExpression`) covers
every call a single module makes ITSELF — and a separately compiled provider is
precisely the case where the caller is another module:
`asyncTest(async function () { await … })` → the provider's
`testFunc().then(…)` reads `.then` of null.

This is a **lane-independent compiler defect**, not a linked-lane artifact —
`Promise.resolve(1).then(async function () { await Promise.all([]); })` in an
ordinary single-file compile produces the same await-erased `__cb_0`. The fix
here is deliberately scoped to the linked consumer (`ctx.linkedPackageBindings.size > 0`):
such a callback routes to `compileArrowAsClosure`, which does activate the frame
engine. Widening it to every host callback is a real fix worth doing and is NOT
byte-neutral for the honest lane, so it is left for its own issue.

| measurement | before | after |
| --- | --- | --- |
| 93 sampled null-read rows (linked), honest-pass/linked-fail | 32 | **17** |
| … of which the `reading 'then'` family | 15 | **0** |
| async/Promise/Iterator families, 6,317 linked rows | — | **+33 pass, 0 lost** |
| linked chunk 0/57 vs honest, pass→fail | 10 | 9 |

Residual in that sample: 17 rows of a DIFFERENT family —
`Cannot read properties of null (reading 'next' / 'return')` in the
`Iterator.prototype.{map,filter,take,drop,flatMap,chunks,windows}` helpers,
where the consumer subclasses the harness/intrinsic `Iterator` and overrides
`next` as a getter. Not the same substrate; see the residual table.

### Bucket `Cannot convert 0 to a BigInt` (128) — NOT FIXED, root cause found

**Both of the plan's hypotheses are wrong**, and they were measured rather than
argued. It is not bigint boxing in `__call_function` argument marshalling, and
it is not the provider's BigInt typed-array constructor path. The BigInt message
is a symptom two steps downstream.

What actually happens, narrowed with `testWithAllTypedArrayConstructors(f,
[BigInt64Array], ["arraybuffer"])` (`.tmp/p6492/b7.js`): of the four
arraybuffer-family arg factories, factory #2 — `makeResizableArrayBuffer`, i.e.
`new ArrayBuffer(n, { maxByteLength: n * 2 })` — hands the consumer a value that
`new BigInt64Array(arg)` rejects. The consumer sees
`[object Array] isAB=false byteLength=16 resizable=true`, so the host
constructor treats it as an array-like of NUMBERS and throws on converting
element `0` to a BigInt. Factories #1, #3, #4 are fine.

**The crossing, not the ArrayBuffer, is what is broken** — a micro-provider
isolates it to four lines (`.tmp/p6492/seven.mts`):

| value | where inspected | reads as |
| --- | --- | --- |
| provider-made resizable AB | inside the provider | `[object ArrayBuffer] isAB=true` |
| provider-made resizable AB | in the consumer | `[object Array] isAB=false bl=16` |
| provider-made plain AB | in the consumer | `[object Object] isAB=false bl=undefined` |
| **consumer**-made resizable AB | handed to the provider | `[object Array] isAB=false bl=16` |
| consumer-made resizable AB | in the consumer | `[object ArrayBuffer] isAB=true` |

So a compiled ArrayBuffer is a wasm struct whose brand is consistent inside its
OWN module and is lost in BOTH directions across the boundary: the #5225
decoder registry has no ArrayBuffer discriminator, so `_wrapForHost` falls
through to the generic `__is_vec` facade and the value arrives as an array of
zeros. The plain-AB row is worse than the resizable one (`byteLength`
`undefined`), which says this is not a resizable-specific gap.

Fixing it means giving the cross-module mirror an ArrayBuffer brand the way
`_compiledTypedArrayKinds` gives one to TypedArrays — a #5225-family change in
`src/runtime.ts` plus a discriminator export from the owning module. That is a
larger, separate piece of work than this issue's other buckets, so it is left
here with the diagnosis rather than half-done. It is likely to also move part of
the `Thrown value was not an object!` and descriptor-shape residual, since those
have the same shape (a compiled object losing its brand at the boundary).

## Round 2 (2026-09-17, Opus lane) — branch `issue-6492-r2`, based on round 1

### Measurement setup — the real runner, not the smoke

Round 1's honest column came from a plain single-module compile, which is NOT
the runner's honest lane; three of the rows sampled below fail that column
identically and would have read as "no lane difference". Every number in this
section instead comes from `tests/test262-chunk-dynamic.test.ts` (the real
worker) run over the SAME explicit row list in both lanes, with a **fresh**
`JS2WASM_TEST262_HARNESS_CACHE` per run (#6488) and both bundles rebuilt after
every compiler edit. Base verdicts were captured before the first edit
(`.tmp/p6492r2/{base-honest,base-linked}.jsonl`).

One practical correction for whoever runs this next: `TEST262_PATH_FILTER` is a
**pipe-separated list of SUBSTRINGS, not a regex** (`tests/test262-runner.ts`
`parsePathFilter`). Escaping the dots — the natural thing to do — makes it match
nothing and the run reports "No test suite found", which reads like a broken
harness rather than an empty filter.

### Bucket `Cannot convert 0 to a BigInt` (128 rows) — FIXED

Round 1 diagnosed the brand loss and stopped there; the actual defect turned out
to be one line further down than "the registry has no ArrayBuffer
discriminator", and narrower.

`_compiledAbToHostBuffer` is the only consumer of the AB discriminator, and it
reads `__dv_byte_len` / `__dv_byte_get` / `__ab_max_len` off the READER's
exports. In a linked graph those are the wrong module's — and usually not
merely wrong but **absent**: a consumer body that never mentions `ArrayBuffer`
emits no `__dv_byte_len` at all, so the function returns `undefined` on its
second line. The buffer then fell through to `_materializeIterable`, arrived at
the host `BigInt64Array` constructor as an array of NUMBERS, and threw.

The #5225 registry could not cover this because its only probe is
`__struct_field_names`, and a byte vec has no field-name list — it answers `""`
in its OWN module too, so every buffer was cached under the `NONE` sentinel.
The fix is `bufferDecoderFor` (`src/runtime/cross-module-struct-owners.ts`): a
second owner probe keyed on `__dv_byte_len >= 0`, with its **own** cache, because
a struct that is not field-nameable can still be a buffer and the two answers
must not share a negative entry.

Sample: the 823 corpus rows that reach `testWithAllTypedArrayConstructors`
(directly or via `testWithTypedArrayConstructors` / `testWithBigInt…`), every
third one — 275 rows, real runner, both lanes.

| measurement | before | after |
| --- | ---: | ---: |
| honest-pass / linked-fail | 42 | **2** |
| … of which `Cannot convert 0 to a BigInt` | 40 | **0** |
| honest lane, before vs after | — | **0 differences** |

Honest lane byte-identical by construction (the registry short-circuits on one
boolean below two registered modules) and verified rather than assumed.
Test: `tests/issue-6492-linked-arraybuffer-brand.test.ts` (3 cases; 2 of the 3
fail on the pre-fix tree — the third is a regression guard on the arm that
already worked through the TypedArray mirror).

### `Expected a undefined …` (75) + `Expected a X but got a Y` (26) — ROOT CAUSE FOUND, not fixed

This is the largest remaining lever and round 1's guess for it ("likely
#6482-adjacent") is wrong. It is one defect, and it is not in the descriptor
substrate.

**A consumer class passed as a VALUE to a provider function crosses as the
class's PROTOTYPE struct, not as its class OBJECT.** Instrumenting
`_wrapForHost` (`.tmp/p6492r2/probe-param.mts`, a four-function micro-provider)
shows the provider wrapping a struct for which `_classObjectByProtoStruct` has
an entry and `_classCtorClosures` does not, so the constructible class-mirror
arm never runs and the value becomes a plain data proxy:

| read, inside the provider | `class MyErr extends Error {}` | `class Plain {}` |
| --- | --- | --- |
| `c.name` | `"Error"` (the extern BASE) | **`undefined`** |
| `typeof c` | `"object"` | `"object"` |
| `e.constructor === c` | **false** | **false** |

Put that through `assert.throws(C, fn)` and both buckets fall out verbatim:
`expectedErrorConstructor.name` is `undefined` → "Expected a **undefined** to be
thrown…", and the identity check `thrown.constructor !== expectedErrorConstructor`
fails against a correctly-named mirror → "Expected a Error but got a MyErr".
Round 1's note 2 (function `.name` wrong for a provider closure) is the same
family seen from the other side.

The fix is NOT a blanket redirect in `_wrapForHost` — `C.prototype` is a
legitimate value and must not become `C`. It belongs at the crossing: the
consumer's class binding must hand over the registered class object. Next
round should start at the linked class-binding lowering, and can reproduce in
seconds with the micro-provider above (no runner needed, unlike the iterator
family below).

### Iterator-helper `reading 'next' / 'return'` — NOT reproducible outside the runner

8 rows in a 327-row half-sample of `built-ins/Iterator` (4 `next`, 4 `return`),
against 35 rows of the class-identity family above in the SAME sample — so the
class-identity defect, not this one, is where the value is in this subtree.

Worth recording so the next lane does not repeat it: `class T extends Iterator`
instances have **no helper methods in either lane** outside the runner sandbox
(`typeof it.some === "undefined"`, `new T() instanceof Iterator === false`), so
the micro-provider cannot see this bucket at all and the runner is the only
instrument. That is a pre-existing intrinsic-subclassing gap, not a lane
difference.

### Extern class stubs (35) — not attempted

Round 1 could not put a lane-differing row in front of the runner and neither
sample here produced one. The evidence now suggests these rows are downstream
of the class-value crossing above rather than a linker rule, so they should be
re-measured AFTER that lands rather than fixed on their own.

### Buckets not reached

- **`Expected a undefined …` (75)**, **extern class stubs (35)**,
  **`Thrown value was not an object!` (22)** and the four small buckets: not
  fixed. Two hours of sampling did not put a clean honest-pass/linked-fail row
  of the extern-class bucket in front of the runner — every
  `No dependency provided for extern class` row found locally (2 in chunk 0/57,
  1 in a 892-row Proxy/Atomics/Reflect run) fails the HONEST lane identically,
  so those particular rows are not lane differences at all. Whoever picks this
  up should pull the row list from the parity report artifact rather than
  re-sampling: the buckets are too thin for a 1/57 slice.
- The **Iterator-helper `reading 'next' / 'return'` family** (17 rows in the
  93-row sample) is a real, reproducible lane difference and the best-value next
  target: the consumer subclasses the intrinsic `Iterator` and overrides `next`
  as a GETTER, and the provider's helper reads `.next` off null.

### Two findings for the #3451 slice-6 flip plan

1. **The provider cache is not keyed on the compiler build (#6488) and this
   silently fakes results.** Fine in CI today (fresh tmpdir per runner, no cache
   restore step), but any local re-measurement — including the one that decides
   the flip — must point `JS2WASM_TEST262_HARNESS_CACHE` at a fresh directory.
   If the flip work ever adds a cache-restore step to speed the lane up, it must
   key on the compiler build or it will publish stale verdicts.
0. **(round 2) `TEST262_PATH_FILTER` is substrings, not a regex.** An escaped
   path list matches nothing and the run fails with "No test suite found",
   which is indistinguishable from a broken harness. `TEST262_PATH_FILTER_FILE`
   (exact paths, one per line) exists but does not drive the chunk test's suite
   enumeration on its own, so the pipe-separated substring form is the one to
   use for a row-list measurement.
2. **Function `.name` is wrong for a provider closure read out of an array**:
   `factories[1].name` answered `fa` for `fb`, and `typedArrayCtorArgFactories[0..2].name`
   answered `undefined`. Harmless for pass/fail here, but it corrupts every
   harness failure MESSAGE that names the factory ("Testing with … and
   makePassthrough.") — which is exactly what sent the first pass of this triage
   down the wrong path. Any bucket table built from linked-lane error strings
   should be treated as approximate until this is fixed.

### Three more findings for the #3451 slice-6 flip plan (round 3)

3. **Bucket the residual by the THROWN VALUE, not by the error string.** Round
   2 already flagged that provider-closure `.name` corrupts failure messages;
   round 3 shows the stronger version — two unrelated defects (a cross-module
   constructor-identity miss and the intrinsic-`Iterator` subclassing gap) emit
   the byte-identical shape `Expected a X but got a Y`, and the CI table's 26
   rows turned out to be the second one. A bucket table built from message
   text will keep mis-assigning effort.
4. **`assert.throws`'s `.name` read is a MESSAGE-only path.** `C.name` is wrong
   in the honest lane too (`undefined` for a plain class, the base's name for
   an `Error` subclass), so every "Expected a **undefined** …" string in the
   parity report is cosmetic; the verdict was decided by the identity check or
   by no exception being thrown. Do not count those rows as a `.name` bug.
5. **`harness/*` self-test rows are not a proxy for the corpus.** 17 of the 25
   lane differences in the round-3 async sample are `harness/asyncHelpers-*`
   rows that test the HARNESS, which the linked lane replaces wholesale. They
   will move as a block when the provider publishes `$DONE`, and they say
   nothing about the compiler buckets.

### Acceptance

- [x] `illegal cast` bucket = 0 (no uncatchable traps in the linked lane) —
      locally: the sampled row passes and the bucket is 0 in chunk 0/57. Corpus
      confirmation needs the next dispatch.
- [ ] pass→fail residual ≤ 250 on the next `linked_lane=true` dispatch (record
      as P3d in #6486 with the bucket table). **Not reached.** After round 2
      three buckets are fixed — 22 trap + 61 async-null + 128 BigInt ≈ 211 rows
      by the CI table — which projects ~494 remaining, still above the bar. The
      next single change worth making is the class-value crossing (75 + 26 rows
      by the CI table, root cause in the round-2 notes); that alone would put
      the projection near 390, so ≤ 250 needs it plus the two ~40-row families.
- [x] Honest lane byte-identical / unaffected — the async fix is gated on
      `ctx.linkedPackageBindings.size > 0`; the trampoline fix needs a
      multi-file graph, which the honest lane is not, and that was verified
      rather than assumed (honest chunk 0/57 before vs after: 850 rows, **0**
      verdict differences). Equivalence gate: no new regressions.
- [x] Each FIXED bucket has a test —
      `tests/issue-6492-linked-method-trampoline-abi.test.ts` (4 cases),
      `tests/issue-6492-linked-async-callback-promise.test.ts` (5 cases) and
      `tests/issue-6492-linked-arraybuffer-brand.test.ts` (3 cases, 2 failing
      pre-fix); all fail on the pre-fix tree.

## Round 3 (2026-09-17, Opus lane) — branch `issue-6492-r3`, based on round 2

### Measurement setup

Same instrument as round 2 — `tests/test262-chunk-dynamic.test.ts` over an
explicit row list in BOTH lanes, fresh `JS2WASM_TEST262_HARNESS_CACHE` per run,
both bundles rebuilt after every compiler edit, base verdicts captured before
the first edit (`.tmp/p6492r3/basew-{honest,linked}.jsonl`). One local note:
`npx tsx --experimental-wasm-custom-descriptors` is rejected by the Node 22
in this container; the probes run with `--experimental-wasm-stringref` alone.

### The class-value crossing — round 2's diagnosis is HALF right

Round 2 concluded that a consumer class "crosses as the class's PROTOTYPE
struct, not as its class OBJECT". Re-instrumenting `_wrapForHost` and the
mirror handler says otherwise, and the correction matters for whoever picks
this up:

- **The class object DOES cross correctly.** In the provider it is the
  constructible mirror: `Object.prototype.toString.call(C)` is
  `[object Function]`, `new C()` works and returns `[object Error]` for an
  `Error` subclass, and `C.prototype` is the real facade. The one
  `protoStructOf=true` wrap round 2 saw is a *different* value crossing in the
  same window, not the class binding.
- **`.name` is wrong in BOTH lanes, so it is not a lane bug at all.** Measured
  as a single module: `C.name` is `undefined` for `class Plain {}` and `"Error"`
  for `class MyErr extends Error {}` — identical to the linked answer. Two
  independent causes, both worth recording: (1) the `.name` sidecar stamp in
  `emitLazyClassObjectGet` only fires when `__extern_set` is ALREADY in
  `ctx.funcMap`, and a small consumer body that never needs it emits no such
  import, so the stamp is silently skipped (confirmed: the linked consumer's
  wasm imports `__register_class_object`/`__register_class_ctor` and NOT
  `__extern_set`); (2) the class mirror's own handler is internally
  inconsistent — `getOwnPropertyDescriptor` answers `name`/`length` from the
  function target (which carries the correct registered class name) while `get`
  delegates them to the property proxy, which has no own `name` and falls
  through to `Error.prototype.name`. Either fix would work; **neither changes a
  single pass/fail**, because `assert.throws` only reads `.name` to BUILD the
  failure message on a path it has already decided to fail.
- **The real lane difference is constructor IDENTITY**, and it is one guard:
  `_classChainRead` bailed to `_MISS` whenever `_classObjectOwnedBy` said the
  reading module did not register the class — which is the normal state of
  affairs in a linked graph, where the harness provider reads instances the
  test body's classes minted. FIXED by re-asking with the owner's export view.

| micro-provider measurement (`e.constructor === C`) | single module | linked before | linked after |
| --- | --- | --- | --- |
| `class MyErr extends Error {}` | true | **false** | **true** |
| native `TypeError` | true | true | true |
| `class Plain {}` (struct-backed, fieldless) | true | false | false — see below |

The fieldless struct-backed case is still open: `_classObjectForInstance`
cannot resolve such an instance to its class object through the READER's
`__class_instance_proto`, and the #5225 decoder registry cannot help either —
its probe is `__struct_field_names`, which answers `""` for a fieldless struct
in its own module too. A third owner probe keyed on `__class_instance_proto`
was built and **measured not to fire** (the consumer's own export answers null
for the instance), so it was removed rather than left in as plausible-looking
dead code. Whoever resumes this should find out why that export declines its
own module's instance before adding a registry arm.

### What the corpus actually says — the honest number

The fix is a real parity repair and its **measured corpus delta is zero**.

Sample: every corpus row under `built-ins/` or `language/` that BOTH declares
its own error constructor (`class X extends Error` / `function XError() {}`)
AND calls `assert.throws` with one — 141 rows, real runner, both lanes, before
and after.

| measurement | before | after |
| --- | ---: | ---: |
| honest lane, before vs after | — | **0 differences** |
| linked lane, before vs after | — | **0 differences** |
| honest-pass / linked-fail in the sample | 3 | 3 |
| linked-pass / honest-fail in the sample | 2 | 2 |

All three honest-pass/linked-fail rows are `built-ins/Iterator/prototype/take/
next-method-returns-throwing-{value,done,value-done}.js`, and every one reports
`Expected a ReturnCalledError but got a TypeError`. That is **not** the
class-identity family: the value the provider caught really is a `TypeError`,
i.e. the intrinsic-`Iterator`-subclassing gap round 2 parked. So the CI
table's `Expected a X but got a Y` bucket is dominated by that defect, not by
the crossing — which is why a correct fix to the crossing moves nothing.

**Read this as a warning about bucketing by error STRING.** Two unrelated
defects produce the same message shape, and round 2's note 2 (function `.name`
is wrong for a provider closure) already said the strings are unreliable. The
next lane should bucket the residual by the *thrown value's* identity, not by
the message.

### Extern-class stubs (35) — re-measured, still not a lane difference

Re-checked after the crossing fix, as the plan asked. The only
`No dependency provided for extern class` row in the 141-row sample is
`built-ins/DisposableStack/prototype/dispose/throws-error-as-is-…`, and it
**fails the HONEST lane identically** (`DisposableStack` is unsupported, not
shadowed). Third independent sample to say so (round 1: 3 rows, round 2: 3
rows, round 3: 1 row, all honest-fail). The bucket should be re-derived from
the CI parity artifact's row list before anyone spends more time on it; local
sampling has now failed to produce a lane-differing row three times.

### Provider-side async callbacks — tried, measured, REVERTED

The plan's target 3 suggested routing provider-MINTED suspending callbacks the
same way round 1 routed consumer-minted ones, i.e. widening the
`compileArrowAsCallback` early bail from `ctx.linkedPackageBindings.size > 0` to
`|| ctx.exportsConsumedByWasm === true`. Implemented (one disjunct), both
bundles rebuilt, measured on a 116-row async sample (`harness/asyncHelpers-*`
plus all of `built-ins/Array/fromAsync/`, real runner, linked lane):
**0 of 116 rows changed.** Reverted rather than shipped — it rewrites the
PROVIDER's bytes for no measured gain, which is risk without return.

That sample is worth keeping for the next lane, because its lane gap is large
and NONE of it is await-erasure:

| rows | direction | signature |
| ---: | --- | --- |
| 17 | honest-pass / linked-fail | all `harness/asyncHelpers-*`; `$DONE is not defined` (4) and `Test262Error: Expected true but got false` (11) |
| 8 | linked-pass / honest-fail | `built-ins/Array/fromAsync/*` — the linked lane is BETTER here |

`$DONE is not defined` says the harness provider does not publish `$DONE` into
the body's scope — a harness-assembly gap, not a compiler one. The 11
`throwsAsync` rows are the harness testing ITSELF, so they are a poor proxy for
the corpus-wide async buckets; do not size those buckets from this sample.

### Not attempted this round

`__module_init` null `.catch`/`.next` (24 + 9 + 9), the async-null residual 23,
`Thrown value was not an object!` (22) and the typed-array bucket (18). No
sample taken this round contained a row of those buckets, and finding one needs
the CI parity artifact's row list rather than another local guess — which is
the same conclusion round 2 reached about the extern-class bucket.

### Residual table (what a follow-up picks up, in value order)

Updated after round 2 (2026-09-17).

| rows (CI table) | bucket | state |
| ---: | --- | --- |
| 128 | `Cannot convert 0 to a BigInt` | **FIXED** (round 2) — `bufferDecoderFor`. 40 → 0 in a 275-row real-runner sample; corpus confirmation needs the next `linked_lane` dispatch. |
| 75 + 26 | `Expected a undefined …` / `Expected a X but got a Y` | **PARTLY FIXED (round 3), and round 2's diagnosis CORRECTED.** The class object crosses fine; the lane difference was constructor IDENTITY (`_classChainRead` bailed on the owner guard) and is fixed for externref-backed instances. `.name` is wrong in BOTH lanes and changes no verdict. Measured corpus delta of the fix: **0 of 141 targeted rows**, because the bucket's corpus rows are dominated by the intrinsic-`Iterator` gap below, not by the crossing. Still open in the crossing: a FIELDLESS struct-backed class instance. |
| ~42 | `__module_init` null `.catch` / `.next` | the async half is round 1's fix; the Iterator-helper half is 8 rows in a 327-row sample and is **only visible through the real runner** — the micro-provider cannot see it (intrinsic `Iterator` has no helpers there in either lane). |
| 35 | extern class stubs (`badArrayType` / `OProxy`) | re-measured after the crossing fix (round 3): still NOT reproduced as a lane difference — three independent local samples, every hit fails the honest lane identically. Do not re-sample locally; pull the row list from the CI parity artifact or drop the bucket. |
| ~3 in 141 | `Expected a X but got a TypeError` in `Iterator/prototype/take` | **the actual dominant defect behind the `Expected a X but got a Y` string** (round 3). `class T extends Iterator` + helper; the provider's helper throws its own `TypeError` instead of propagating the consumer's error. Same intrinsic-subclassing substrate round 2 parked, and now the highest-value next target. |
| 22 | `Thrown value was not an object!` | untouched. No longer expected to fall out with the BigInt fix (that one was narrower than the "brand loss" framing suggested); more likely the class-identity family. |
| 59 | four small buckets | untouched. |

### Trap residual (2026-09-17, #3451 slice-6 merge_group run 35200783992)

The flip's first merge-group diff (honest v13 baseline vs linked v14) passed the
422 `regressions-allow` ceiling (406 of 422 excused) but hit the #3189
uncatchable-trap ratchet, which no regressions-allow can excuse. The parity
script's "no trap bucket" (P3e) counted *error-message* buckets; the ratchet
counts `error_category` per row, and 15 rows change category across lanes.
The flip PR declares `trap-growth-allow: count: 7` (the measured per-category
maximum, #3370 rebase-mode semantics). These rows are the follow-up:

| category | growth | rows (baseline status) |
| --- | ---: | --- |
| `null_deref` | 47 → 54 (+7) | `built-ins/Function/15.3.5.4_2-14gs.js` (pass), `language/eval-code/indirect/global-env-rec-fun.js` (pass), `language/function-code/10.4.3-1-19gs.js` (fail), `language/function-code/10.4.3-1-20gs.js` (fail), `language/statements/variable/12.2.1-{9,10,20,21}-s.js` (pass) |
| `illegal_cast` | 24 → 30 (+6) | `built-ins/ArrayBuffer/prototype/immutable/prop-desc.js` (fail), `built-ins/Error/prototype/stack/{instance-not-enumerable,prop-desc}.js` (fail), `built-ins/TypedArray/prototype/reverse/resizable-buffer.js` (fail), `built-ins/TypedArray/prototype/sort/{comparefn-resizable-buffer,resizable-buffer-default-comparator}.js` (fail) |
| `unreachable` | 2 → 3 (+1) | `language/expressions/in/private-field-rhs-await-present.js` (pass) |

Reading: the 8 honest-pass rows are already inside the 422 pass→fail residual
(the `*gs.js` / `12.2.1-*-s.js` family is global-strict-mode code whose
top-level binding differs once the harness is a separate module — same
substrate as the `__module_init` null bucket above). The 7 honest-fail rows
only change failure flavour (a thrown `TypeError` in the honest lane becomes a
trap in the linked lane) and change no verdict.

## Round 4 (2026-09-17, Opus lane) — the `built-ins/Iterator` family

Branch `issue-6492-r4`, based on `91e0fb35bd` (post-flip main).

### Measurement setup

The real runner (`tests/test262-chunk-dynamic.test.ts`), single chunk, over the
WHOLE `built-ins/Iterator/` directory — 654 rows — in BOTH lanes, before and
after, with a fresh `JS2WASM_TEST262_HARNESS_CACHE` per run (#6488) and both
bundles rebuilt after every edit. Scoring the whole directory rather than the
125-row bucket list is deliberate: a bucket list can only show improvement,
while the directory also shows what a fix BREAKS. Artifacts:
`benchmarks/results/test262-{honest,linked}-{base0,f1}-results-*.jsonl`
(base0 = before, f1 = after; the runs are ~2 min linked / ~4-6 min honest).

### Root cause — the linked assembler drops the `%Iterator%` binding stratum

Not a compiler defect, and not the intrinsic-subclassing gap rounds 2 and 3
assumed. **`assembleLinkedVariant` was missing a whole stratum of the
authoritative assembly.**

`assembleVariant` (the honest assembler, `tests/test262-original-harness.ts`)
appends `ITERATOR_BINDING_PREAMBLE` (`scripts/test262-iterator-binding.mjs`) —

```js
function Iterator() {}
Iterator.prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
```

— whenever the body mentions `Iterator` and does not declare it
(`needsIteratorBinding`). js2 exposes **no global `Iterator` constructor**, so
this local binding is the only `%Iterator%` a test ever sees. `assembleNativeHarness`
carries it too. `assembleLinkedHarness` never did, so in the linked lane
`typeof Iterator` was `"undefined"` — and everything downstream followed:
`class T extends Iterator` extended `undefined` (→ `instanceof` false,
`reading 'next' of null`), `Iterator.prototype.includes` was a read off
`undefined` (→ `includes is not a function`), and a helper called on such an
instance threw the provider's own `TypeError` instead of the consumer's error
(→ `Expected a X but got a TypeError`, the shape round 3 correctly refused to
attribute to the class-value crossing).

That single missing stratum is **all four** of the sub-buckets the round-3
residual table listed separately, which is why bucketing by message text kept
splitting one defect into many.

The fix puts the stratum in the **body** compile unit (`assembleLinkedVariant`),
not the harness prefix, for a reason that is load-bearing: the prefix is the
provider's cache key, so a per-test prefix would fork the provider per test and
destroy the compile-once property the linked lane exists for. The honest
assembler also emits it last, immediately before the body, so a body-side
declaration still wins — the gate is the same predicate in both lanes.
`bodyLineOffset` grows by the stratum's line count so body error lines still map.

### Before / after — real runner, both lanes, 654 rows

| measurement | before | after |
| --- | ---: | ---: |
| honest lane, passes | 342 | **342** (0 verdict differences, row by row) |
| linked lane, passes | 240 | **341** |
| honest-pass / linked-fail | **124** | **4** |
| linked-pass / honest-fail | 22 | 3 |

(The bucket list handed to this round had 125 rows; the directory run reproduces
124 of them — one row's baseline verdict moved with the flip itself.)

Honest-lane invariance is verified, not argued: `assembleLinkedVariant` is
reachable only from `assembleLinkedHarness`, which only the linked lane calls,
and the honest before/after run over the same 654 rows shows 0 differences.

**No collateral outside the directory.** 616 corpus rows outside
`built-ins/Iterator/` match `needsIteratorBinding` and therefore now receive the
stratum in the linked lane as well. Sampled the largest clusters —
`staging/sm/Iterator`, `language/statements/for-of/`,
`language/statements/class/subclass/`, `built-ins/AsyncFromSyncIteratorPrototype/`
— 901 scored rows, linked lane before vs after: **703 → 703, 0 rows changed in
either direction**.

### The 4 rows still honest-pass / linked-fail

| row | linked error |
| --- | --- |
| `Iterator/prototype/{filter,map}/underlying-iterator-advanced-in-parallel.js` | `Expected SameValue(«0», «3»)` |
| `Iterator/zipKeyed/iterables-iteration-after-reading-options.js` | own-keys missing from the observed operation list |
| `Iterator/zipKeyed/padding-iteration.js` | `Actual [] and expected [a]` |

Both families are boundary-crossing OBSERVATION order, not the binding: one
underlying iterator advanced by two helper wrappers must be shared across the
module boundary (the consumer's stepping is not observed by the provider's
wrapper), and `zipKeyed` must observe the consumer object's own-keys/padding
reads in spec order. Neither is worth a substrate change at 4 rows; they belong
with the `Thrown value was not an object!` / descriptor-shape residual if that
is ever picked up.

### For the next lane

6. **Check the ASSEMBLY before the compiler.** Three rounds attributed this
   bucket to compiler substrate (intrinsic subclassing, provider-side helper
   dispatch, cross-module `next` lookup) and none of it was. The honest and
   linked assemblers are twins that must agree stratum for stratum, and the
   only one that had drifted was the smallest. Whenever a whole DIRECTORY is
   honest-pass/linked-fail, diff `assembleVariant` against
   `assembleLinkedVariant` first — it costs a minute.
7. **A one-line synthetic row through the real runner beats a micro-provider.**
   Round 2 recorded that the micro-provider cannot see this bucket; that is
   true, and it is also true that the in-process harness does not reproduce the
   honest lane (its `[][Symbol.iterator]()` read fails without the runner's
   sandbox realm). Dropping a scratch test into the corpus and running both
   lanes on it isolated the difference to a single value in two 2-minute runs,
   after hours of deduction from WAT and import manifests had not.

### Residual table — updated after round 4

| rows (CI table) | bucket | state |
| ---: | --- | --- |
| 128 | `Cannot convert 0 to a BigInt` | **FIXED** (round 2). |
| 75 + 26 | `Expected a undefined …` / `Expected a X but got a Y` | **FIXED for the Iterator family** (round 4) — the dominant cause was the missing binding stratum, not the class-value crossing. Round 3's crossing fix stands; its own residual (a FIELDLESS struct-backed class instance) is untouched. |
| ~42 | `__module_init` null `.catch` / `.next` | async half fixed (round 1); the `.next` half was the binding stratum and is **FIXED** (round 4). |
| 35 | extern class stubs | not reproduced as a lane difference in four independent local samples. Pull the row list from the CI parity artifact or drop the bucket. |
| 4 | `Iterator` parallel-advance + `zipKeyed` observation order | **round 4 residual**, see above. |
| 22 | `Thrown value was not an object!` | untouched. |
| 59 | four small buckets | untouched. |

Test: `tests/issue-6492-r4-linked-iterator-binding.test.ts` (4 cases — the
assembler gate in both directions, `bodyLineOffset` exactness, and two linked
compile-and-run cases). All 4 fail on the pre-fix tree.

## Round 4b (2026-09-17, Opus lane) — the shim must not SHADOW `%Iterator%`

Branch `issue-6492-r4b`, based on `4a5d5c1dfb` (main, which contains round 4 as
`0deaa0d2bc`). Round 4's first merge-group diff (run 35256162280) reported 138
improvements and 20 regressions, 19 of them round 4's.

### What round 4 got wrong

The binding stratum was the right diagnosis; a SYNTHETIC binding was the wrong
mechanism. `function Iterator() {}` shadows the real `%Iterator%` — and before
the shim existed, `Iterator.concat` / `.from` / `.zip` / `.zipKeyed` and
`Iterator.prototype.<helper>` resolved through the compiler's builtin machinery
to that real object *while the bare identifier read `undefined`*. That split is
the whole story: round 4 fixed every row that needs the BINDING and broke every
row that needs the STATICS — `built-ins/Iterator/{concat,from,zip,zipKeyed}/{is-function,length,name,proto}.js`,
`from/callable.js`, `prototype/{chunks,windows}/next-method-returns-non-object.js`.

The two halves genuinely pull against each other, and both directions were
measured rather than reasoned:

| binding is… | statics | `new (class Sub extends Iterator {}) instanceof Iterator` |
| --- | --- | --- |
| synthetic `function Iterator() {}` (round 4) | **lost** | true |
| the intrinsic (`%IteratorPrototype%.constructor`) | present | **false** — a compiled class instance does not satisfy `instanceof` against a host function |
| synthetic + intrinsic's statics copied on (round 4b) | present | true |

So the shim keeps the binding and the constructor role, its `.prototype` stays
`%IteratorPrototype%` (measured: the builtin's `.prototype` IS the
array-iterator-derived object, so nothing about prototype-method resolution
changes), and the intrinsic's own function-valued statics are copied onto it.
The copy ENUMERATES rather than listing the four ES2025 statics by hand,
because the set is engine-dependent — CI runs Node 25
(`.github/actions/setup-node-pnpm`, default `"25"`), this container Node 22.22 —
and a hand list silently omits whatever the newer engine added.
`length`/`name`/`prototype` are excluded so the shim keeps `Iterator.name ===
"Iterator"`.

### Second defect: the gate counted mentions in COMMENTS

`needsIteratorBinding`'s comment claimed a false positive "merely adds a local
shim". True of a shim that only declares a name; false once it reads
`%IteratorPrototype%.constructor`. Measured: injecting into
`Iterator/prototype/{drop,take}/underlying-iterator-advanced-in-parallel.js` —
whose ONLY `Iterator` is `%Iterator.prototype%.drop` in the frontmatter `info:`
block — flips both rows pass → fail. The gate now strips block and line
comments before both halves of its test. A body that never names `Iterator` in
code cannot reference the binding, so declining there is free.

### Before / after — real runner, `built-ins/Iterator/`, 654 rows

Artifacts on this branch: `benchmarks/results/test262-linked-{p0,g2}-results-*.jsonl`
(p0 = the pre-round-4 assembler, i.e. the promoted linked baseline's behaviour;
g2 = round 4b) and `test262-{honest}-{hm,h1}-results-*.jsonl` (hm = main today,
h1 = round 4b). Fresh harness cache per run.

| lane | pre-round-4 (p0) | round 4 (main) | round 4b (g2 / h1) |
| --- | ---: | ---: | ---: |
| linked passes | 240 | 341 | **352** |
| honest passes | — | 265 (hm) | **280** |

- **Linked vs the promoted baseline: +114, −2.** The two are
  `prototype/{chunks,windows}/next-method-returns-non-object.js`, and they are
  **local artifacts, not verifiable here**: this container's Node has no
  `Iterator.prototype.chunks` at all, and the baseline's "pass" is accidental —
  probed, pre-shim `new Sub().chunks` is `undefined` and `new Sub().chunks(1)`
  returns **null** rather than throwing, so the TypeError the test asserts comes
  from the NEXT line (`iterator.next()` on null). On CI's Node 25 the shim's
  `.prototype` is the same `%IteratorPrototype%` the pre-shim read resolved, and
  `Iterator.from` — which these rows also need — is restored, so they are
  expected to pass for the real reason. **This is the one claim in this section
  that is a prediction rather than a measurement.**
- **Linked vs round 4: +17, −6.** The 17 are the regressed rows (all 16
  `{concat,from,zip,zipKeyed}/{is-function,length,name,proto}` plus
  `from/callable`). Of the 6: four are
  `{concat,from,zip,zipKeyed}/non-constructible.js` and two are
  `prototype/includes/{iterator-already-exhausted,result-is-boolean}.js` — **all
  six fail in the promoted baseline too**, so none is a regression against it.
  Round 4 passed the four `non-constructible` rows only because the property was
  MISSING (`new undefined()` throws); with the real function present, js2's `new`
  does not honour a host function's non-constructibility, so they fail honestly.
- **Honest lane: +17, −2.** The two are `from/non-constructible.js` and
  `zipKeyed/non-constructible.js` — the same accidental-pass mechanism, in the
  lane where they had been passing. Stated plainly because the brief asked for
  no honest losses: this trade (+17 real rows, −2 rows that passed because a
  property was absent) is inherent to restoring the statics, and cannot be
  avoided without breaking the `name`/`length`/`proto` rows it fixes.
- **No collateral outside the directory**: the same 901-row sample
  (`staging/sm/Iterator`, `language/statements/for-of/`,
  `class/subclass/`, `built-ins/AsyncFromSyncIteratorPrototype/`), linked lane,
  main's binding vs round 4b: **703 → 703, 0 rows changed either way.** (One row
  was cut from the second run's tail by a harness timeout and was re-scored on
  its own: `AsyncFromSyncIteratorPrototype/throw/throw-null.js` fails in both.)

Tests: `tests/issue-6492-r4b-iterator-binding-statics.test.ts` (3 cases — the
enumerate-and-exclude shape, the comment-stripping gate in both directions, and
one linked compile-and-run asserting the statics AND `instanceof` together). All
3 fail on main's binding. `tests/issue-6492-r4-…`, `issue-3451-linked-harness-lane`
and `issue-6463-strict-rerun-elision` still pass unchanged.

### For the next lane (continued)

8. **A shim that shadows an intrinsic inherits responsibility for its whole
   surface.** Round 4 replaced a name that resolved to a real object with one
   that resolved to an empty function, and the 19 rows it broke were invisible
   locally because the member-read path (`Iterator.from`) and the identifier
   path (`typeof Iterator`) answered DIFFERENTLY — the first from the builtin,
   the second `undefined`. Probe both shapes before shadowing anything.
9. **Guard against accidental passes when reading a delta.** Four of the six
   rows round 4b "loses" were passing because a property was missing. A row that
   flips because the code under it got MORE correct is not a regression, and the
   only way to tell is to look at why the baseline passed.

## Round 5 (2026-09-17, Opus lane) — the long tail

Branch `issue-6492-r5`, based on `c698c755bb` (origin/main) with round 4's
`%Iterator%` binding stratum (`ec8ff0752d`) and #6491's under-application fix
(`376b9af99c`) cherry-picked FIRST, so every number below is measured on top of
both.

### Measurement setup

Real runner (`tests/test262-chunk-dynamic.test.ts`), single chunk, over the
138-row list (the 134 `bucket-rest.txt` rows + round 4's 4 `built-ins/Iterator`
residuals) in BOTH lanes, fresh `JS2WASM_TEST262_HARNESS_CACHE` per run (#6488),
both bundles rebuilt from their ENTRIES (`npm run build:{compiler,runtime}-bundle`)
after every compiler edit. Base captured before the first edit:

| lane | base |
| --- | ---: |
| honest | **135 / 138 pass** (3 rows are honest-fail — not lane differences) |
| linked | **0 / 138 pass** |

### Mechanism 1 — `__instanceof` resolved the RHS in the WRONG REALM

Round 4's lesson applied again, one level down: the bucket was not a compiler
defect and not a cross-module decoder miss. The `harness/asyncHelpers-throwsAsync-*`
rows all assert `assert(p instanceof Promise)` on the promise the PROVIDER's
`assert.throwsAsync` returns, and that answered `false`.

A one-line synthetic corpus row through both lanes (round 4's finding 7) put the
difference on the table in two 1-minute runs, and an instrumented `__instanceof`
named it exactly:

```
v instanceof globalSandbox.Promise → true
v instanceof globalThis.Promise    → false
```

`__instanceof(v, "<name>")` resolves the RHS by NAME off the runtime's own
`globalThis`. But test262 gives every row a `globalSandbox`, and the
CONSTRUCTION sites already prefer it — `_createBoundaryPromiseImport` uses
`globalSandbox?.Promise ?? Promise`. So compiled code mints a SANDBOX Promise
and the identity check asks the WORKER's. Two paths, two realms, same value.

Three things this corrects for whoever reads the earlier rounds:

- **It is not the `_wrapForHost` / #5225 substrate.** A `promiseDecoderFor`
  owner probe (the exact shape of round 2's `bufferDecoderFor`) was built,
  measured — **0 rows moved** — and REVERTED rather than left in as
  plausible-looking code. The instrumented value is `isStruct=false`: it is a
  real host object, never a compiled struct, so no decoder question applies.
- **`coherentBuiltinRealms` does not cover this.** The worker
  (`scripts/test262-worker.mjs`) never calls `markCoherentBuiltinRealm`, so the
  `builtin()` helper always falls back to the host realm — while
  `globalSandbox?.Promise ?? Promise` bypasses that helper entirely. The fix is
  deliberately NOT gated on that flag: the flag governs which realm a builtin is
  TAKEN from, this is the weaker question of whether a value belongs to a realm
  the project is already handing values out of.
- The arm is **additive and second**: a `true` from the host realm is never
  overturned, so it can only turn `false` into `true`.

| measurement | before | after |
| --- | ---: | ---: |
| `harness/*` rows (22), linked | 0 pass | **10 pass** |
| 138-row list, linked | 0 pass | **10 pass** |
| 138-row list, honest | 135 pass | **135 pass** (0 verdict differences) |
| honest control slice, 867 rows (`instanceof` / `Promise` / `Error` / `Symbol.hasInstance`) | 512 pass | **513 pass, 0 lost** |

The honest lane is a shared path here, so it was A/B'd rather than argued: the
867-row control gains one row (`built-ins/Promise/resolve/S25.4.4.5_A4.1_T1.js`)
and loses none.

Test: `tests/issue-6492-r5-sandbox-realm-instanceof.test.ts` (2 cases, 7
assertions — sandbox promise, sandbox `Object`, host-realm control, no false
positive, unknown name, and a no-sandbox no-op case). The first case fails on
the pre-fix tree.

### Before / after on the 138 rows (real runner, both lanes)

| lane | before | after |
| --- | ---: | ---: |
| honest | 135 pass | **135 pass** — 0 verdict changes, row by row |
| linked | 0 pass | **10 pass** — 0 rows lost |

The 10 are exactly the `harness/asyncHelpers-throwsAsync-*` family
(`custom`, `custom-typeerror`, `incorrect-ctor`, `native`, `no-arg`,
`no-error`, `null`, `primitive`, `resolved-error`, `single-arg`).

### The 125 rows still honest-pass / linked-fail, by MECHANISM

Bucketed by mechanism, not by message (round 3's finding 3), each with the
narrowest reproduction found. **Every "minimal repro" below was run through the
real runner in BOTH lanes** — the ones marked `same in honest` are NOT lane
differences and must not be chased as such.

| rows | mechanism | evidence / minimal repro | owner |
| ---: | --- | --- | --- |
| 25 | **descriptor reads** (`Expected obj[N] to equal …` / `NOT to be writable` / `configurable:true` / `Getter must be a function`) — `Object.defineProperty|defineProperties`, `*/Symbol.species/*`, `Symbol.toStringTag/prop-desc` | untouched by this round, by instruction | **#6482 lane** (concurrent) |
| 8 | **`for await (let {…} of …)` destructuring binds `null` where the honest lane binds `undefined`** | minimal: `async function fn(){ for await (let {w:[x,y,z]=[4,5,6]} of [{w:[7,undefined,]}]) { /* typeof y */ } } fn().then($DONE,$DONE);` → linked `typeof y === "object"`, honest `"undefined"`. NOT a boundary coercion: the CONSUMER itself sees `object`. A `var` head, or reading `y` in a `===` first, both PASS — so the shape is narrow. Separately found and **not** a lane difference: a top-level `var a = [7, undefined,]` makes `typeof a[1] === "number"` in BOTH lanes (an f64-vec coercion bug worth its own issue). | open |
| 12 | **`Thrown value was not an object!` — a TDZ/`for-in`/`for-of` head-scope closure, and host `Symbol.species`/`this` type checks, whose throw reaches the provider's `assert.throws` as a non-object** | the CONSUMER catches it fine (`typeof e === "object"`, `[object Error]`); only the provider sees a non-object. Plain consumer throws cross correctly (`assert.throws(ReferenceError, function(){ throw new ReferenceError("x"); })` and a runtime `null.foo` TypeError both PASS in the linked lane), so this is NOT "exceptions lose their payload" in general. Same family: `const/global-closure-get-before-initialization.js` (`rethrowing null value`). | open |
| 6 | **indirect `eval` traps — `dereferencing a null pointer`** (`variable/12.2.1-{9,10,20,21}-s.js`, `Function/15.3.5.4_2-14gs.js`, `eval-code/indirect/global-env-rec-fun.js`) | minimal, 1 minute: **`var s = eval; s("1+1");`** — linked traps, honest passes. DIRECT `eval("var q=1;")` passes in both. `typeof s` answers `"function"`, so the alias is bound; the CALL is what traps. Start at `emitHostEvalGlobalBindingSeed` / the `name === "eval"` arm of `src/codegen/expressions/identifiers.ts` (~L1570) and check `ctx.oracle.valueDeclarationOf(id)` in the linked graph — the generated `__js2wasm_linked_*.d.ts` stub is in the same program. **TRAP category — the #3189 ratchet can never excuse these**, so they outrank everything else in this table for the flip. | open |
| 5 | **`$DONE` / `asyncTest` when the BODY defines its own `$DONE`** | `asyncTest` guards on `Object.prototype.hasOwnProperty.call(globalThis, "$DONE")` and then CALLS `$DONE`. A body-declared `function $DONE` is module-scoped in the linked lane, so the provider's own `$DONE` binding is what runs. A body that does NOT define `$DONE` is fine — verified: a one-line `flags:[async]` probe asserting `typeof $DONE === "function"` PASSES linked, as does a plain `asyncTest(async () => { await …; })`. Same shape as the #4626 `$262` stratum, opposite direction. | open |
| 4 | **`Promise.all{,Settled}Keyed` reject-vs-throw timing** (`Expected a TypeError to be thrown asynchronously but the function threw synchronously`) | untouched. | open |
| 4 | **`$262.createRealm()` rows** (`Proxy/*/trap-is-not-callable-realm`, `Array/length/define-own-prop-length-overflow-realm`, `expressions/new/non-ctor-err-realm`, `harness/assert-throws-same-realm`) | a THIRD realm on top of the sandbox one. Note these are adjacent to — but not the same as — the realm defect mechanism 1 fixed; `harness/asyncHelpers-throwsAsync-same-realm` now reports a sharper message than before but still fails. | open |
| 4 | **`built-ins/Iterator` boundary observation order** (round 4's residual: `filter`/`map` parallel advance, `zipKeyed` own-keys + padding) | unchanged from round 4. | open |
| 3 | **`await` of a non-thenable / rejection** (`Cannot read properties of null (reading 'then')`) | the residual half of round 1's await-erasure bucket. | open |
| 2 | **invalid Wasm binary** (`private-field-{in-nested,rhs-await-present}.js`) — `C_init` / `__cb_0` type mismatch | a real codegen type error in the body-only unit; deserves its own issue. | open |
| 2 | `String.prototype.replaceAll` — `Cannot convert object to primitive value` | open |
| 2 | `Reflect.deleteProperty` returns `true` where `false` is expected | open |
| 2 | `Proxy` handler is not the trap context | open |
| 2 | `RegExp/match-indices` structural equality | open |
| 2 | `TypedArray/prototype/sort` with `comparefn === undefined` | open |
| 2 | `harness/deepEqual-{array,deep}` | open |
| 2 | `delete String.prototype.toString` | open |
| 2 | `#5: parseInt === null` | **NOT reproducible as a lane difference in the obvious form**: a probe reading `parseInt`/`parseFloat`/`isNaN`/`isFinite`/`decodeURI`/`encodeURI` as VALUES fails IDENTICALLY in both lanes. Whatever separates the two rows is narrower than "bare global read". | open |
| 1 each | `isFinite`/`isNaN` property-on-null, `Array.from` mapFn, `Array.prototype.filter` ×2, `findLast{,Index}` ×3, `Object/fromEntries`, `String/indexOf` ToString, `String/replace` null, `tagged-template/tco-call`, `class/static-init-scope-lex-open`, `with/has-binding-idref-with-proxy-env`, `annexB` html-close-asi, `top-level-await/new-await-script-code`, `harness/proxytrapshelper-default`, `harness/detachArrayBuffer-host-detachArrayBuffer`, `Object/defineProperty/15.2.3.6-4-{91,95}` | singles | open |

### Findings for the next lane (round 5)

8. **Bucket by REALM as well as by thrown value.** Round 3 said the message text
   lies; round 5 adds that the *intrinsic identity* lies too. The runner gives
   every row a `globalSandbox` realm, and the runtime is inconsistent about
   which realm it uses — construction sites prefer the sandbox, the name-keyed
   `__instanceof` preferred the host. Any "identity is wrong across the
   boundary" symptom is worth testing against BOTH realms before it is blamed on
   the linked seam; the fix here also improved the HONEST lane by one row,
   which is the tell that it was never a linked-lane bug at all.
9. **Instrument the import, not the value.** Three probe generations tried to
   characterise the bad promise from inside the test body
   (`getPrototypeOf`, `.constructor`, `.then` identity) and produced a
   self-contradictory picture, because `===` is lenient at the boundary while
   `instanceof` is not. One `console.error` inside the `__instanceof` import,
   printing `isStruct` / `revProxy` / `v instanceof globalSandbox[name]`,
   settled it in a single run — and its FIRST line already falsified the
   leading hypothesis (`isStruct=false`: the value was never a compiled struct,
   so no #5225 decoder question applied).
10. **`run.sh … | tail -20` silently eats your instrumentation.** The first
    debug run printed nothing and read as "this import is never called", which
    would have sent the next hour into the codegen lowering. Keep a raw,
    untailed runner script next to the tailed one.

### Residual table — updated after round 5

| rows (CI table) | bucket | state |
| ---: | --- | --- |
| 128 | `Cannot convert 0 to a BigInt` | **FIXED** (round 2). |
| 75 + 26 | `Expected a undefined …` / `Expected a X but got a Y` | **FIXED for the Iterator family** (round 4). Round 3's constructor-identity fix stands; its own residual (a FIELDLESS struct-backed class instance) is untouched. |
| ~42 | `__module_init` null `.catch` / `.next` | async half fixed (round 1); the `.next` half was the binding stratum, fixed (round 4). |
| 35 | extern class stubs | not reproduced as a lane difference in four independent local samples. Pull the row list from the CI parity artifact or drop the bucket. |
| 12 | `AsyncTestFailure: Expected true but got false` (`harness/asyncHelpers-throwsAsync-*`) | **FIXED, 10 of 12** (round 5) — the realm-blind `__instanceof`. The 2 that remain are `same-realm` rows, which are a `$262.createRealm()` question, not this one. |
| 4 | `Iterator` parallel-advance + `zipKeyed` observation order | round 4 residual, unchanged. |
| 12 | `Thrown value was not an object!` | round 5 narrowed it: the consumer catches the value correctly, only the provider sees a non-object, and ORDINARY consumer throws cross fine. See the mechanism table above. |
| 6 | indirect-`eval` null-pointer TRAP | round 5 reduced it to `var s = eval; s("1+1");`. Highest priority of the residual: the #3189 trap ratchet cannot be excused by a re-baseline. |
| 8 | `for await` destructuring binds `null` | round 5, new; minimal repro in the mechanism table. |
| 25 | descriptor reads | #6482's lane. |
| ~30 | singles + small families | see the mechanism table above. |

## Round 4c (2026-09-17, Opus lane) — `chunks` / `windows`, and round 4b's wrong prediction

Branch `issue-6492-r4c`, based on `f25fd4bcda` (main, containing round 4b).
Round 4b landed with exactly 2 regressions in the merge-group diff (run
35272197717): `Iterator/prototype/{chunks,windows}/next-method-returns-non-object.js`.

### The 4b prediction was wrong, and the reason is worth keeping

Round 4b said those two rows "are expected to pass for the real reason" on CI,
because CI's Node 25 would supply `Iterator.prototype.chunks`. **It does not.**
Checked directly with `npx -y node@25` (v25.9.0 — the version
`.github/actions/setup-node-pnpm` pins by default): `Iterator.prototype.chunks`
and `.windows` are `undefined`, and `Object.getOwnPropertyNames(Iterator)` is
`length,name,prototype,from`. The container's Node 22.22 is identical on all
four counts.

Two corrections follow, and both were load-bearing for the earlier rounds'
reasoning:

1. **`concat`/`zip`/`zipKeyed` never came from the host at all** — they are
   js2's own polyfill (`_installIteratorHelperPolyfills`). Round 4b's framing
   ("the host engine's real global") was wrong about the source even though its
   fix was right about the mechanism (the shim shadowed *something real*).
2. **Node 22 and Node 25 are interchangeable for this family**, so a local
   measurement IS representative of CI. 4b's prediction was not just wrong, it
   was avoidable for the price of one `npx` invocation — which is what this
   round spent first.

The rows' pre-4b "pass" was accidental, and the mechanism is now pinned: with
`chunks` absent, probing under the pre-shim assembler showed `new Sub().chunks`
is `undefined` and **`new Sub().chunks(1)` returns `null`** rather than
throwing, so the `TypeError` the test asserts came from the NEXT line
(`iterator.next()` on null).

### The fix — option (a), js2 implements them

Two defects, both required:

- **The implementation.** `chunks`/`windows` join the other ten helpers in
  `_installIteratorHelperPolyfills`, with the proposal's argument handling:
  receiver Object-ness first, then `chunkSize`/`windowSize` validated WITHOUT
  coercion (non-Number or non-integral → TypeError; a valid Number outside
  `[1, 2^32-1]` → RangeError), and only then GetIteratorDirect reading `next`
  exactly once. `windows` takes the second `undersized` argument
  (`"only-full"` default, `"allow-partial"`, anything else TypeError).
- **The #3049 helper list.** `_ITER_HELPER_NAMES` in `src/runtime.ts` decides
  whether a COMPILED receiver gets the iterator-record bridge. Until `chunks`
  and `windows` were added, a generator's `.chunks(1)` reported "chunks is not
  a function" even with the method installed on the prototype — **31 of the 78
  rows in these two directories failed on that list alone**, not on the
  implementation. Measured in isolation: adding the implementation took the
  directories 0 → 47 passes; adding the two names took 47 → 49; the
  `undersized` argument took the family's last regression to zero.

### Before / after — real runner, `built-ins/Iterator/`, 654 rows, both lanes

Artifacts: `benchmarks/results/test262-{linked,honest}-{m0,n0,m3,n3}-results-*.jsonl`
(`m0`/`n0` = main, `m3`/`n3` = this branch), fresh harness cache per run, both
bundles rebuilt. The A/B was file-copy based and the final pair was re-run
AFTER the last edit, so the committed tree is the measured tree.

| lane | before (main) | after |
| --- | ---: | ---: |
| linked passes | 352 | **394** (+42, **0 lost**) |
| honest passes | 355 | **397** (+42, **0 lost**) |

Both target rows: `fail: chunks is not a function` → **pass**, in the linked
lane, for the asserted reason (the helper now steps the underlying iterator and
throws `TypeError` on a non-object result).

Collateral, same 901-row sample outside the directory (`staging/sm/Iterator`,
`for-of`, `class/subclass`, `AsyncFromSyncIteratorPrototype`), linked lane,
main vs this: **705 → 705, 0 rows changed either way.**

29 rows under `{chunks,windows}/` still fail — `return`-forwarding order,
`argument-validation-failure-*` close semantics, and two `assert is not
defined` rows. All of them failed before this change too; none is a regression.

Test: `tests/issue-6492-r4c-iterator-chunking.test.ts` (8 cases, host-side, so
they run in a second). 6 of 8 fail on the pre-fix tree; the other 2 assert
TypeErrors that the pre-fix tree throws for the WRONG reason (calling
`undefined`), which is precisely the accidental pass this round removes.

### For the next lane (continued)

10. **Check the environment claim before predicting from it.** One `npx -y
    node@25 -e 'typeof Iterator.prototype.chunks'` — seconds — would have
    replaced round 4b's prediction with a fact and saved a merge-group cycle.
    When a conclusion rests on "CI's runtime has X", go get that runtime.
11. **A prototype method is not reachable until BOTH halves agree.** Installing
    on `%IteratorPrototype%` is half the job; `_ITER_HELPER_NAMES` (#3049) is the
    other, and a helper missing from it is invisible to every compiled
    receiver while looking perfectly present in a host-side unit test. Any new
    `Iterator.prototype.*` needs an entry in both places.

## Round 6 (2026-09-17, Opus lane) — working the narrowed mechanisms

Same worktree and branch as round 5 (`issue-6492-r5`), continuing from its tip.
Three mechanisms fixed, one attempted-and-reverted, two defects split out into
their own issues.

### Before / after on the same 138 rows (real runner, both lanes)

| lane | round-5 tip | round-6 tip |
| --- | ---: | ---: |
| honest | 135 pass | **135 pass** — 0 verdict changes, row by row |
| linked | 10 pass | **40 pass** — +30, 0 rows lost |

Cumulative for the two rounds: linked 0 → 40 of 138; the honest-pass /
linked-fail residual is **135 → 95**.

### Mechanism 1 — `LIB_GLOBALS` missed the lib.es5 `declare function` globals (10 rows, 6 of them TRAPS)

`LIB_GLOBALS` / `sourceUsesLibGlobals` is the gate that decides whether
`collectDeclaredGlobals` runs **at all**, and it listed the ambient
CONSTRUCTORS but not `eval` / `parseInt` / `parseFloat` / `isNaN` / `isFinite` /
`decodeURI*` / `encodeURI*`. A compile unit whose only lib-global reference is
one of those skipped the pass, `ctx.declaredGlobals` never learned the name,
`calleeMayBeHostCallable` (via `isDeclaredHostGlobal`) answered false, and the
`__call_function` host arm was never emitted at the call site — so a first-class
read held a real host function while the dispatch had only the closure-struct
path:

```
var s = eval; s("1+1");   →  guarded ref.test nulls → struct.get TRAPS
```

The honest lane never hits it because the harness prefix shares the unit and
names `Array`/`Object`/`String` on its first lines; a body-only unit can
genuinely reference nothing else. The `EvalError` note already in that set
records the same failure for the constructors — this is its `declare function`
half, and the two now sit together.

Diagnosis took one instrumented compile of both lanes: honest
`varMay=true declaredGlobals.has("eval")=true`, linked `varMay=false … =false`,
and the registration loop **never ran** in the linked compile.

| measurement | before | after |
| --- | ---: | ---: |
| the 6 trap rows + 2 `parseInt === null` + `isNaN` + `isFinite`, linked | 0/10 | **10/10** |
| the same 10, honest | 10/10 | 10/10 |

### Mechanism 2 — an UNDEF-SENTINEL f64 boxed to `null` instead of `undefined` (8 rows)

`coerceType`'s f64→externref arm resolves the canonical `undefined` through
`canonicalUndefinedExternInstrs`, which is READ-ONLY by design (registering an
import mid-body shifts func indices under the emitter) and falls back to
`ref.null.extern` — JS **`null`** — when `__get_undefined` is not registered
yet. On the host lane that is not a fallback, it is a different VALUE.

Found by diffing the two WATs at the sentinel site: honest emits
`call $__get_undefined`, linked emitted `ref.null extern`.
`ensureCanonicalUndefinedExtern` (#6419) already existed for exactly this; it
simply was not called from the coercion engine. It must run BEFORE
`__box_number`'s index is read — `flushLateImportShifts` remaps emitted
instructions, not an index already captured in a local.

| measurement | before | after |
| --- | ---: | ---: |
| the 8 `for-await-of/*dstr*` rows, linked | 0/8 | **8/8** |
| the same 8, honest | 8/8 | 8/8 |

### Mechanism 3 — a HOST-thrown error lost its value crossing wasm→wasm (12 of 13 rows)

A wasm `catch_all` cannot see the thrown JS value; it recovers it through the
`caught_exception` import, which reads the runtime's "last host exception"
latch. That latch lived **inside `createHostImportCallState()`** — per IMPORT
OBJECT, written only by the host import of the module whose call threw. One
module, one object: correct for the compiler's entire single-module history.

A linked graph has two. The provider calls a consumer closure, a throwing host
import inside the CONSUMER raises a real JS error, it propagates wasm→wasm as a
JS exception, and the provider's `catch_all` asked its OWN latch — which
nothing had written — and got `undefined`. Hence
`Thrown value was not an object!` for a throw the consumer itself catches
perfectly (`typeof e === "object"`, `[object Error]`, `ReferenceError`).

The asymmetry that identified it — three probes of one shape, differing only in
how the error is raised:

| probe | before |
| --- | --- |
| `var g = function () { undeclaredXyz; };` (host-thrown) | FAIL |
| `var f; for (let x of (f = function(){typeof x;}, [])) ;` (TDZ, host-thrown) | FAIL |
| `var h = function () { throw new ReferenceError("x"); };` (wasm-thrown) | pass |

A wasm-thrown error rides the shared `env.__exn` tag (#5226) and the catching
module reads the payload off the tag, never off the latch. Making the latch
process-wide keeps the same last-write-wins discipline it already had.

| measurement | before | after |
| --- | ---: | ---: |
| the 13 `Thrown value was not an object!` / `rethrowing null value` rows, linked | 0/13 | **12/13** |
| the same 13, honest | 13/13 | 13/13 |

Still failing: `const/global-closure-get-before-initialization.js`
(`rethrowing null value`) — a trap-flavoured sibling at a different site.

### Mechanism 4 — body-declared `$DONE` (5 rows): ATTEMPTED, MEASURED AT ZERO, REVERTED

The prelude binds every referenced harness name with `var <name> = <getter>();`
ahead of the body, and that assignment runs AFTER hoisting — so a body's
`function $DONE(){}` is lifted above the prelude and then CLOBBERED by it.
That is a real latent defect and the fix is four lines (exclude names the body
declares in a hoisted form, the same "body-side declaration wins" rule round 4
established for the `%Iterator%` stratum).

It is **not** what these rows need. Implemented, measured on all 6
`harness/asyncHelpers-asyncTest-*` rows with the real runner: **0 changed**, and
reverted rather than shipped.

What they actually need, for the next lane: the provider's `asyncTest` does
`Object.prototype.hasOwnProperty.call(globalThis, "$DONE")` and then CALLS
`$DONE`, so the BODY's top-level `function $DONE` must be a property of the
**same global object the PROVIDER reads**. A body-only unit does publish its
top-level `var`/`function` onto `globalThis` (verified: a probe asserting
`typeof globalThis.probeFn === "function"` passes in the linked lane), so the
open question is whose `globalThis` — the two modules resolve it through their
own `__get_globalThis`, and the runner hands each a `globalSandbox`. This is
cross-module global-object IDENTITY, the same family as round 5's realm
finding, and it is the right next target for these rows.

### Split out into their own issues

- **#6496** — the two `language/expressions/in/private-field-*` rows emit an
  **invalid** Wasm binary (`C_init` `local.tee` anyref/i32, `__cb_0` call
  i32/externref). A validation failure is a compiler bug, not a parity bucket.
- **#6497** — `typeof [7, undefined][1]` is `"number"` in **both** lanes. The
  sentinel survives the store and the DESTRUCTURING read-back resurrects it
  (mechanism 2); the INDEX read takes the generic box, which per #3315 must not
  resurrect it. The fix belongs at the vec element read, which knows it is
  reading a slot. Not a lane bug — filed so the parity work stops tripping on it.

### The 95 rows still honest-pass / linked-fail

| rows | mechanism | owner |
| ---: | --- | --- |
| 34 | descriptor reads (`defineProperty`/`defineProperties`/`Symbol.species`/`Symbol.toStringTag` prop-descs) | **#6482 lane** — untouched by instruction |
| 12 | `harness/*` — 6 of them the `$DONE`/`asyncTest` family above, the rest `assert-throws-same-realm`, `detachArrayBuffer-host-detachArrayBuffer`, `proxytrapshelper-default`, `deepEqual-{array,deep}` | open |
| 4 | `Promise.all{,Settled}Keyed` reject-vs-throw timing | open |
| 4 | `$262.createRealm()` rows | open |
| 4 | `built-ins/Iterator` boundary observation order (round 4 residual) | open |
| 3 | `await` of a non-thenable (`reading 'then'`) | open |
| 2 | invalid Wasm binary | **#6496** |
| 2 each | `replaceAll` ToPrimitive · `Reflect.deleteProperty` · `Proxy` trap context · `RegExp/match-indices` · `TypedArray sort` undefined comparefn · `delete String.prototype.toString` | open |
| ~26 | singles (see the round-5 table; its `parseInt`, `isNaN`/`isFinite` and `for-await` entries are now FIXED) | open |

### Findings for the next lane (round 6)

11. **A gate list is a mechanism, not a lookup table.** Both mechanism 1 and
    mechanism 4's dead end were a NAME missing from a set — and in mechanism 1
    the consequence was three modules away from the set (no registration → no
    `declaredGlobals` entry → no host-call arm → an uncatchable trap). When a
    linked-lane row fails and the honest twin passes, ask early whether some
    whole PASS simply did not run; `LIB_GLOBALS`, `needsIteratorBinding` and
    `referencedHarnessNames` are all of this shape, and the honest lane hides
    every one of them because its harness prefix trips each gate incidentally.
12. **Diff the two WATs at the exact site, not the two behaviours.** Mechanism 2
    was 20 minutes once the sentinel `if` was on screen in both lanes
    (`call $__get_undefined` vs `ref.null extern`) and had resisted a round of
    behavioural probing before that. A scratch script that compiles ONE body
    both ways with `emitWat: true` is worth writing on day one of a parity
    round; it costs ~20 s per iteration against ~2 min for the runner.
13. **Keep a third probe whose job is to FAIL to reproduce.** Mechanism 3's
    wasm-thrown control is what turned "exceptions are broken across the
    boundary" (false — ordinary throws cross fine) into "HOST-thrown exceptions
    are", which is the sentence that names the latch. Round 5's note 8 said
    bucket by realm; this is the same discipline one level down.
14. **An in-process linked harness is not the runner, and the gap is the
    SANDBOX.** The scratch lane runner reproduces mechanism 3 exactly but cannot
    see mechanism 4 at all, because the runner gives each row a `globalSandbox`
    and the in-process seam does not. Use the in-process lane to iterate (20 s)
    and the real runner to decide (2 min) — and never let an in-process PASS
    retire a row.

## Round 7 (2026-09-17, Opus lane) — diagnosis round: no code landed, four rows retired anyway

Same worktree and branch. **This round landed no compiler change**, and the
138-row numbers are unchanged from round 6 (linked **40**, honest **135**). What
it produced is a decisive diagnosis of the largest remaining mechanism, a
correction to two hand-over items, and one more lane-independent bug split out.
Stating that plainly up front because a round whose value is knowledge is easy
to mis-read as a round that stalled.

### Mechanism 1 — cross-module global-object identity: DIAGNOSED, too large to land here

The brief asked whose `globalThis` a body-only unit publishes onto. Measured in
the REAL runner (the in-process seam cannot see this — it has no per-row
sandbox), by instrumenting `__throw_reference_error` to dump the sandbox:

```
[DBG refError] $DONE is not defined  hasSandbox=true  sandboxHasDONE=true
               sandboxDONEtype=function  sandboxKeysSample=$DONE
```

Two facts, both new, and together they close the question:

1. **The sandbox DOES have `$DONE`** (the runner's own
   `buildOriginalHarnessSandbox` stub) and the module STILL threw
   `$DONE is not defined`. So the thrower's bare-identifier read never consults
   the sandbox at all. It is the PROVIDER: a consumer probe
   (`undeclaredZzz;` at top level) does **not** throw in the linked lane, so the
   consumer's free reads are already sandbox-routed. The provider is compiled as
   a MODULE (`index.js` is the harness prefix PLUS `export const __h_x = x;`
   aliases in the SAME file), so `moduleGoalIdentifierIsUndeclared` is true for
   a symbol-less identifier and codegen emits an unconditional
   `__throw_reference_error` instead of a global-object read.
2. **The consumer's top-level bindings are NOT on the sandbox.** A body
   declaring `function probeFn(){}` / `var probeVar = 1` leaves the sandbox's
   own-property list unchanged (`sandboxKeysSample` shows only `$DONE`). The
   round-6 observation that `typeof globalThis.probeFn === "function"` holds in
   the linked lane is therefore NOT publication — it is a read-side fallback
   (`__extern_get` resolving the module's own binding when the global object
   lacks the property).

So these rows need BOTH halves, and fixing only (1) makes it worse in a
measurable way: the provider would then resolve the runner's no-op `$DONE`
stub, the body's own `function $DONE` would still never run, and the rows would
fail on `compareArray(doneValues, …)` instead of a ReferenceError.

(2) is the real work: a linked graph has to agree on ONE realm global object for
script top-level bindings, the way the honest whole-assembly does by
construction. That is an architecture change to the linked seam, not a patch,
and it is the right next slot — with the two facts above it no longer needs
discovery, only design.

### Hand-over item (a) — `new` on a non-constructible host function: ALREADY FIXED

Measured on the current tip rather than assumed, real runner, linked lane:

| row | verdict |
| --- | --- |
| `built-ins/Iterator/from/non-constructible.js` | **pass** |
| `built-ins/Iterator/zipKeyed/non-constructible.js` | **pass** |
| `built-ins/Iterator/concat/non-constructible.js` | **pass** |
| `built-ins/Iterator/zip/non-constructible.js` | **pass** |

All four already pass — round 4's `%Iterator%` binding stratum is what changed
them. No `new`-lowering work is needed; the hand-over was written against an
older tip.

### Hand-over item (b) — `Iterator/prototype/{chunks,windows}`: the gap is OURS, not only the container's

Both rows fail with `chunks is not a function` / `windows is not a function`.
The container's Node is **v22.22.2**, which has `Iterator.prototype.drop`
(`typeof === "function"`) but neither `chunks` nor `windows` — so the host
oracle genuinely cannot answer them here.

That is only half the answer, and the useful half is the other one:
`src/runtime/iterator-polyfills.ts` **already polyfills** `take`, `drop` and
`flatMap` onto `%IteratorPrototype%` exactly for hosts that lack them. It does
not implement `chunks`/`windows`. So these two rows are reachable without a
newer V8 — they need the two sequencing-proposal helpers added to that polyfill,
which is a small scoped feature, not a host-capability blocker.

### The trap row `const/global-closure-get-before-initialization.js` — narrowed, and it split in two

Reduced from the corpus row to three lines in a 20-second loop:

```js
var got = "none";
try { (function () { return x + 1; })(); } catch (e) { got = e && e.name; }
assert.sameValue(got, "ReferenceError", "consumer-side catch");
const x = 1;
```

Run through the real runner in BOTH lanes: **both fail identically** with
`Expected SameValue(«null», «"ReferenceError"»)`. The TDZ check fires (control
reaches the `catch`) but the bound value is `null`.

So a lane-independent compiler bug was hiding under a linked-lane trap. Filed as
**#6498**. The corpus row's own `rethrowing null value` — V8's message for
`throw_ref` on a null `exnref` — is very likely the same missing payload seen
from the rethrow side, and #6498 carries a follow-up box to re-check it. The
block-lexical TDZ shape is unaffected (round 6's fix covers it), so this is
specific to a GLOBAL lexical.

### Per-row status of the 95 residual rows

| rows | status after round 7 |
| ---: | --- |
| 34 | descriptor reads — **#6482's lane**, untouched by instruction |
| 6 | `harness/asyncHelpers-asyncTest-*` ($DONE family) — **mechanism named and fully diagnosed above**; needs the one-realm-global change |
| 4 | `$262.createRealm()` rows — same family (a THIRD realm on top of the sandbox); blocked behind the same design |
| 6 | other `harness/*` (`assert-throws-same-realm`, `detachArrayBuffer-host-detachArrayBuffer`, `proxytrapshelper-default`, `deepEqual-{array,deep}`) — untouched |
| 4 | `Promise.all{,Settled}Keyed` reject-vs-throw timing — untouched |
| 3 | `await` of a non-thenable — **not reducible in-process**: the in-process seam has no sandbox, so `asyncTest` short-circuits on its `hasOwnProperty(globalThis,"$DONE")` guard before the await runs. Needs the runner loop |
| 4 | `built-ins/Iterator` observation order — round 4 residual, untouched |
| 1 | `const/global-closure-get-before-initialization.js` — narrowed; lane-independent half filed as **#6498** |
| 2 | invalid Wasm binary — **#6496** |
| 12 | the six 2-row families (`replaceAll` ToPrimitive, `Reflect.deleteProperty`, `Proxy` trap context, `RegExp/match-indices`, `TypedArray sort` undefined comparefn, `delete String.prototype.toString`) — untouched |
| ~19 | singles — untouched |

### Findings for the next lane (round 7)

15. **Instrument the thing that THROWS, not the thing that fails.** One
    `console.error` inside `__throw_reference_error`, printing the sandbox's own
    keys, answered in a single 2-minute run two questions that three rounds of
    behavioural probing had left open — including the one that overturned the
    round-6 conclusion (a body's globals are *not* published; the read side just
    makes it look that way).
16. **A read-side fallback can impersonate a write.** Round 6 concluded "the
    consumer publishes its top-level bindings onto `globalThis`" from a passing
    `typeof globalThis.probeFn === "function"`. It does not; `__extern_get`
    falls back to the module's own binding. Whenever a cross-module question is
    answered by reading through the SAME module that would have written, the
    answer proves nothing — read the object's own-property list instead.
17. **Re-measure a hand-over before implementing it.** All four
    `non-constructible.js` rows were already passing on the current tip; the
    hand-over was written against an older one. One 2-minute runner call before
    any code is written.
18. **"The container can't do it" is usually half an answer.** The
    `chunks`/`windows` rows really are unsupported by this Node — and by our own
    polyfill, which already supplies `take`/`drop`/`flatMap` for exactly this
    reason. The actionable sentence is the second one.

## Implementation Plan — shared global object (2026-09-17)

Written before any code, as round 8 asked. The short version: **most of this
already exists in-tree, deliberately switched off for the host lane, and the
switch-off comment names this exact follow-up.** The work is two narrow arms,
not an architecture change — which reverses round 7's estimate, and the reason
it does is recorded in step 1 so the next reader can check it.

### 1. The current mechanism, exactly

**Write side — the consumer's script top-level bindings.**
`emitScriptGlobalFunctionBindings` (`src/codegen/global-function-bindings.ts`,
#4394, §9.1.1.4.18) and `emitScriptGlobalVarBindings`
(`src/codegen/global-var-bindings.ts`, #4491 T4, §9.1.1.4.17) already define a
script's top-level `function` / `var` names as own properties of the global
object, at the TOP of `__module_init` (hoisting order), with
`{writable, enumerable, configurable: false}`. Both are called from
`declarations.ts` (~L6134/L6138). Both open with the SAME two lines:

```ts
if (!ctx.standalone && !ctx.wasi) return;   // host lane: OFF
if (ctx.sourceIsModule) return;             // modules: correctly off
```

and #4394's header says why, and what the follow-up is, verbatim: *"Host/GC is
excluded on purpose for now: there `globalThis` is the embedder's own object —
in the test262 runner, the per-test sandbox … Extending this to the host lane
(and dropping the runner's `$DONE` stub) is the follow-up."* It even tabulates
the exact symptom this round is chasing (`hasOwnProperty(globalThis, "$DONE")`
false in host/GC, `typeof globalThis.$DONE` "function") and attributes 19
standalone harness failures to it.

So round 7's measurement — a body's `function probeFn(){}` is not an own
property of the sandbox, while `typeof globalThis.probeFn` still answers
`"function"` — is not a linked-seam defect at all. It is this gate, plus the
read-side fallback that masks it.

**Read side — the provider's free identifiers.** The harness provider's
`index.js` is the harness prefix PLUS `export const __h_x = x;` aliases in ONE
file, so it is an ES module and `ctx.sourceIsModule` is true. For `$DONE`,
`identifierValueSymbol` answers `undefined`, so
`moduleGoalIdentifierIsUndeclared` is true and lowering reaches the undeclared
arm in `src/codegen/expressions/identifiers.ts` (~L2258).

That arm ALREADY has a global-object read, and it is one condition away from
firing:

```ts
if ((!unresolvedInModuleGoal || !sym) && ctx.standaloneGlobalThisImport !== undefined) {
  … __extern_get(globalThis, name) …
}
```

`!sym` is true for `$DONE`, so the first half passes. It declines only because
`ctx.standaloneGlobalThisImport` is a STANDALONE-only carrier. The host lane
falls through to the unconditional `__throw_reference_error`, which is the
`$DONE is not defined` round 7 measured.

**The read-side fallback that masked the write side.** A consumer
`globalThis.probeFn` read goes through `__extern_get`, whose miss path resolves
the module's own binding (`normalizeSandboxValue` / `_resolveHostField`). That
is why the property looks present from inside the module that declared it and
is absent from the sandbox's own-property list — round 7 finding 16.

**#6474** is a different thing and is not part of this: it makes the linked
consumer compile at SCRIPT goal so its top-level `var` is a global-object
binding *in the compiler's model*. It sets up the conditions the two emitters
above need; it does not itself publish anything to the host object.

### 2. Options, with blast radius and cache-key impact

The provider prefix is the compile-once cache key, so **any option that makes
the provider's compiled bytes depend on the BODY is out** — that would fork the
provider per test and destroy the property the linked lane exists for. This
rules out, without measurement: declaring the body's names in the provider's
synthetic project, and specialising the provider per include-set + body.

| # | option | honest blast radius | cache key |
| --- | --- | --- | --- |
| (i) | lift the host-lane gate on the two emitters (write) + let a symbol-less free identifier read the host `globalThis` before throwing (read) | write: consumer-gated ⇒ none; read: every host-lane module with a symbol-less free identifier | untouched — the provider's bytes depend only on the prefix |
| (ii) | consumer registers a top-level binding table with the runtime; the provider's miss path consults it | none (runtime-only) | untouched | 
| (iii) | make the provider a SCRIPT (move the export aliases to a second file) | none | untouched, but cross-file script→module binding resolution is not a thing our front end does |

**(iii) is out**: the aliases are what force the linker to publish getter
boundaries; a script file has no exports to alias.

**(ii) is tempting and worse than it looks.** It is a second, parallel
global-environment mechanism living beside the spec one that already exists
(#4394/#4491). It would answer `hasOwnProperty(globalThis, "$DONE")` only if the
runtime ALSO faked the own-property — i.e. it re-creates the runner's `$DONE`
stub as a runtime feature rather than removing the need for it. It also cannot
serve `for…in this`, `Object.keys(this)` or `delete this.x`, which the spec
emitters already do correctly in standalone.

**(i) is the pick**, because it is the mechanism the tree already chose, tested
and documented; this round only widens its lane. Both halves are needed and
neither alone is enough — measured in round 7: with only the read side, the
provider resolves the runner's no-op `$DONE` stub and the rows fail later, on
`compareArray(doneValues, …)` instead of a ReferenceError.

### 3. The pick, exactly

**A1 — write side.** In `emitScriptGlobalFunctionBindings` and
`emitScriptGlobalVarBindings`, admit the host lane **for the linked consumer
only** (`ctx.linkedPackageBindings` non-empty), leaving every other host-lane
module byte-identical. That keeps the honest lane out of scope for this round,
which is what the acceptance criteria require; widening it to the whole host
lane (and deleting the runner's `$DONE` stub) stays #4394's own follow-up and
wants its own measured round.

Order preservation: both emitters already run at the TOP of `__module_init`,
and `deferTopLevelInit` (#6477) means the consumer's `__module_init` runs AFTER
the provider is instantiated — so the consumer's `$DONE` overwrites the
runner's sandbox stub before the body calls `asyncTest`. That ordering is the
whole reason this works; do not move the emitters later.

Known gap inherited from #4394: the seeded function value is a distinct closure
instance, so `globalThis.f === f` is false. It does not affect these rows (the
provider CALLS `$DONE`, never compares it) and closing it needs a value
trampoline the IR does not mint for a call-only name.

**A2 — read side.** In the undeclared-identifier arm of `identifiers.ts`, when
there is NO symbol at all and the lane is host/GC, read the global object and
throw ReferenceError only if the property is ABSENT — which is what §9.1.1.4.x
actually says, and is strictly more correct than both of today's answers (the
provider throws unconditionally; the consumer, through the `__extern_get`
fallback, never throws). Uses `__get_globalThis` + an existing has-check import.
A module with no symbol-less free identifier emits nothing new.

### Acceptance

- the 6 `harness/asyncHelpers-asyncTest-*` rows pass linked
- the other 6 `harness/*` rows and the 4 `$262.createRealm()` rows: measured and
  reported either way (they are a different family and may not move)
- the 3 `await` non-thenable rows: measured (they were unreachable in-process
  because `asyncTest`'s `hasOwnProperty` guard short-circuits; A1 makes that
  guard answer from the body's own binding)
- honest unchanged on a `harness/**` + `language/global-code/**` +
  `language/eval-code/**` slice

## Round 8 (2026-09-17, Opus lane) — the plan, one measured-negative attempt, one CI fix

Branch `issue-6492-r8`, cut from `origin/main` at `f25fd4bcda` (which carries
#5963's batch, #6491's widened-closure fix and the `%Iterator%`-statics fix)
with rounds 6–7 cherry-picked. The design above was written before any code, as
asked.

### Before / after on the 138 rows

| lane | round-7 tip | round-8 tip |
| --- | ---: | ---: |
| honest | 135 | **135** |
| linked | 40 | **40** |

Unchanged, because the one implementation attempt measured NET NEGATIVE and was
reverted. The round's output is the plan above, two facts that make the next
attempt concrete, and a CI fix that unblocks the PR carrying rounds 5–7.

### The equivalence-gate regression (round 6 mechanism 2) — FIXED

`equivalence-gate` shard 4 went red on
`binding-null-guard.test.ts :: class method with destructured param`:

```
LinkError: Import #11 module="env" function="__get_undefined":
           function import requires a callable
```

Not a late-import ordering bug and not a flag-conditional provider:
`tests/equivalence/helpers.ts` builds its import object as a **hand-rolled stub
table** that never contained `__get_undefined`. Round 6 made the coercion engine
register that import at the UNDEF-SENTINEL boxing site — correctly, and both
test262 runners serve it through `resolveImport` — so this row was simply the
first equivalence case to need it. Served now with the provider's own one-liner
(`createHostUndefinedImport` → `() => undefined`).

Whole gate after: **1,720 passing, 22 known-failures = baseline, 0 new
regressions**; shard 4 alone 166 passing, 0 failing. (`npx vitest run
tests/equivalence/` as one job OOMs in this container even single-forked — the
documented constraint; the gate script is what CI runs and it completed the full
corpus.)

### A1 (write side) — IMPLEMENTED, MEASURED, REVERTED at +1 / −2

The plan's first half is real and it works: admitting the linked consumer to
`emitScriptGlobalFunctionBindings` made the body's `function $DONE` an own
property of the sandbox, and the in-process probe moved from
`asyncTest called without async flag` (the `hasOwnProperty` gate) to
`$DONE is not defined` (the CALL) — exactly the predicted half-way point.

On the corpus it is net negative:

| rows | change |
| --- | --- |
| `harness/proxytrapshelper-default.js` | **GAIN** (was `trap getPrototypeOf is not a function`) |
| `built-ins/global/S10.2.3_A1.2_T2.js` | LOSS — `Cannot redefine property: test` |
| `language/eval-code/indirect/global-env-rec-fun.js` | LOSS — `Cannot redefine property: testcase` |

§9.1.1.4.18 defines the binding `configurable: false`, and on this lane the
global object is the embedder's SHARED, pre-seeded sandbox — so a second define
of the same name throws. The standalone twin never meets this because it owns a
fresh `$Object`.

**The obvious guard does not fix it, and that is the finding.** Adding the
spec's own step-2 test — `__hasOwnProperty(globalThis, name)` → `__extern_set`
when present, define when absent, which is exactly what the `var` twin
(`emitScriptGlobalVarBindings`) already does — left the measurement
**identical**: same +1, same two losses, same message. So the property is
refused as non-configurable while `hasOwnProperty` answers that it is absent.
Something other than a previous seed of the same name owns it; the two
candidates worth checking first are the row's two strict VARIANTS meeting one
sandbox, and the runner's own sandbox seeding. Until that is understood the
write side cannot be landed, and I reverted rather than ship a net-negative or
keep iterating blind.

### A2 (read side) — the design's assumption is WRONG, with the correction

Two measured corrections to the plan, both cheap to act on:

1. **The throw is not in `compileIdentifier`.** `$DONE(err)` is a CALL of an
   unresolvable identifier, and it lowers through
   `tryEmitUndeclaredCalleeReferenceError`
   (`src/codegen/expressions/undeclared-callee.ts`, #4650) →
   `emitAnnexBUnboundReferenceError`. An arm added to the identifier-read path
   never fires — verified with a debug print that produced ZERO lines — so it
   was removed rather than left in as plausible dead code.
2. **`declared_global` imports SNAPSHOT their value, so the tempting shortcut
   cannot work.** `platform-capability-adapter.ts` resolves a `global_<name>`
   import as
   `const ambient = globals[intent.name]; return ambient !== undefined ? () => ambient : () => {};`
   — read once, at import-resolution time. The provider is instantiated BEFORE
   the consumer's `__module_init` runs (#6477 `deferTopLevelInit`), so any
   scheme that declares `$DONE` as an ambient global in the provider's synthetic
   project — including naming a file `lib.*.d.ts` so `collectDeclaredGlobals`
   scans it — would capture the runner's stale stub and never see the body's
   binding. It also degrades to a silent no-op `() => {}` when absent.

So the read side needs a **live** lookup: at the unresolvable-callee site, read
`globalThis[name]` and dispatch through `__call_function`, throwing
ReferenceError only when `__extern_has` says the property is absent (the
has-guard is what keeps `assert.throws(ReferenceError, …)` over a genuinely
unbound name working). That is a contained codegen change of roughly 60–80
lines at one site, but it is a shared path and wants its own honest A/B, so it
is the next round's first commit rather than this one's last.

**Estimate for the whole of Part A, now that both halves are understood:** one
focused round for the read side (contained, one site), plus one for the write
side once the `Cannot redefine property` owner is identified — the latter may
turn out to be a runner-side fix (one sandbox per variant) rather than a
compiler one, which would be smaller still. Not multi-day, but not one commit
either.

### Per-row status of the 95 (unchanged this round)

34 descriptor (#6482's lane) · 6 `$DONE` family (both halves now diagnosed;
A1 measured, A2 sited) · 4 `$262.createRealm()` · 6 other `harness/*` (one of
them, `proxytrapshelper-default`, is a confirmed A1 gain waiting on A1 landing)
· 4 `Promise.all*Keyed` timing · 3 `await` non-thenable · 4 `Iterator`
observation order · 1 → #6498 · 2 → #6496 · 12 in six 2-row families · ~19
singles.

### Findings for the next lane (round 8)

19. **A hand-rolled import table is a silent second provider.**
    `tests/equivalence/helpers.ts` lists host imports by hand, so any codegen
    change that registers a NEW import breaks it with a LinkError rather than a
    wrong answer — and only on whichever row first needs it, which can be a
    shard the author never runs. When a change makes codegen register an import
    it did not before, grep for every place that builds an import object, not
    just `resolveImport`.
20. **Check the CALL path and the READ path separately.** An unresolvable
    identifier has two lowerings (#1380 read, #4650 call) and they live in
    different files. A fix written against the wrong one is not merely
    ineffective, it is invisible — it compiles, it passes lint, and it emits
    nothing.
21. **A capability import that SNAPSHOTS is not a binding.** `declared_global`
    reads its value once at instantiate. Anything that must observe a value
    written later — by another module in the same linked graph, or by the body
    itself — has to be a live lookup, and no amount of declaring the name more
    convincingly changes that.

## Round 9 (2026-09-17) — provider-side free-global CALL

**Shipped: one mechanism.** `src/codegen/expressions/linked-free-global-call.ts`
— a `__extern_has(globalThis, name)`-guarded live lookup for a CALL of an
undeclared free identifier inside a linked PROVIDER, dispatched from
`compileIdentifierCall` immediately before `tryEmitUndeclaredCalleeReferenceError`.
The absent arm keeps the ReferenceError, and arguments are compiled inside the
present arm so §13.3.6.1's "resolve the callee reference first" is preserved.

Measured on the real runner (138-row #6492 set):

| lane | before | after | flips |
| --- | --- | --- | --- |
| linked | 40 / 138 | **44 / 138** | +4, 0 losses |
| honest | 135 / 138 | 135 / 138 | 0 |

Honest control slice `harness/**` + `language/global-code/**` +
`language/eval-code/**` (505 rows, base vs. change): **0 flips**.
`tests/issue-3451-linked-harness-lane.test.ts`: 8/8.

Rows gained: `harness/asyncHelpers-asyncTest-func-throws-sync.js`,
`…-rejects-non-callable.js`, `…-return-not-thenable.js`,
`harness/proxytrapshelper-default.js`.

### Not shipped: the write side, and why the round-8 measurement was misleading

Round 8's write side (seed the consumer's script-goal bindings onto the realm
object via `emitScriptGlobalFunctionBindings`) was re-measured this round with
its flag defect fixed, and it is **redundant with the read side, not
complementary**: read-side-only, write-side-only and both-together each give
exactly the same 4 rows (22 harness rows: base 10 → 14 in all three arms).
Only the read side ships — it is gated to the provider role and to CALL sites,
where the write side changes every script-goal consumer binding.

That redundancy also explains round 8's "read side alone: 0 rows". It was not
0; it was measured against a tree whose write side was *actively poisoning* the
read side. `SCRIPT_FUNCTION_BINDING_FLAGS = 0x03` carries **no presence bits**
in `__defineProperty_value`'s encoding (`1<<7` value, `1<<3/4/5` writable/
enumerable/configurable-specified), so it decodes to the EMPTY descriptor: the
seed created a **frozen `undefined`** property. `__extern_has` then answered
true and the provider called `undefined`. The round-8 verdict
`Cannot redefine property: test` was the body's own later write colliding with
that frozen seed — not, as assumed at the time, a second seeder.

The correct encoding is `0xbb` (value-present, writable=true, enumerable=true,
configurable specified-false). It is **not** in this change: the flag constant
is on the standalone path as well, so correcting it is its own measured change
with its own standalone A/B — filed as **#6499**. Anyone re-enabling the write side must fix the
constant first or they will re-derive this same false negative.

### Findings for the next lane (round 9)

22. **A redundant mechanism can read as a broken one.** Two independent fixes
    for the same rows will each measure as "+0" when the other is already
    present — and if one of them is *wrong*, it measures the other as +0 too,
    which is indistinguishable from "does not work". Measure each mechanism
    against the BASE tree alone before concluding anything about it.
23. **The in-process linked seam is not the runner and cannot witness this
    class of bug.** A behavioural test built on `buildHarnessProvider` +
    `compileHarnessLinkedBody` passed all three cases ON THE PRE-FIX TREE,
    because that seam never seeds the realm the provider reads. The shipped
    test asserts the WAT instead, with a non-provider control compiled from
    identical source — see the header of
    `tests/issue-6492-r9-linked-provider-free-global-call.test.ts`.
24. **`exportsConsumedByWasm` is not inert on standalone.** It changes codegen
    through `standalone-link-boundary.ts`, so "provider vs. non-provider
    byte-identity" is the wrong standalone guard; gate-level reasoning plus the
    #3451 per-row binary guard is the right one.

## Round 10 (2026-09-17) — two root causes, no shippable mechanism

**No code landed this round.** Both mechanisms worked turned out to be larger
than a same-round fix, and both are now diagnosed to the instruction rather than
to the symptom. Linked baseline re-measured on the merged tree
(`origin/main` @ 78bd11c4c9 + round 9): **44 / 138**, honest **135 / 138** —
unchanged, nothing regressed.

### A. `Promise.all{,Settled}Keyed` (4 rows) — the lanes take different lowerings

`Promise.allKeyed` does not exist in Node, is not polyfilled anywhere in this
repo, and yet the **honest** lane passes these rows while the **linked** lane
reports `"Expected a TypeError to be thrown asynchronously but the function threw
synchronously"`.

Measured with the runtime instrumented (the runner executes
`scripts/runtime-bundle.mjs`, **not** `src/runtime.ts` — an unrebuilt bundle
silently measures the old code, which cost one full probe cycle):

| probe | honest | linked |
| --- | --- | --- |
| `__extern_method_call` entry, method `allKeyed` | never | **hit** |
| `__extern_method_call` not-a-function tail | never | **hit** (`obj=Promise`) |
| `__extern_method_call_N` fixed-arity wrapper | never | — |
| `__extern_get` for key `allKeyed` | never | — |
| `__proto_method_call` for `allKeyed` | never | — |

So the linked body resolves the name **dynamically at runtime** and throws;
the honest unit never asks the host for it at all. The honest module imports
the `allKeyed` string constant but never references it in a body — consistent
with a **static** lowering that keeps the name only for an error message, and
with the honest-only `Promise_reject` import, i.e. an abrupt completion turned
into a rejected promise (§27.2.4.x `IfAbruptRejectPromise`) rather than a throw.

**Eliminated:** provider/consumer disagreement on `moduleHasHostPromiseSource`
(its only consumer, `standaloneThenMissArmCanBeNative`, is standalone-only);
`promise-static-call-typeerror.ts` (standalone-only, and `allKeyed` is not in
its `PROMISE_STATIC_METHODS`); the native combinator table
(`promise-combinators.ts` has no `Keyed` entry); `skipSemanticDiagnostics`
(the runner sets it true — with it false the row is a compile error).

**Next step:** identify the honest arm that emits `Promise_reject` for this call
— the honest WAT references the `allKeyed` string global nowhere in a body, so
it is reachable by index only; dump the honest module's function that imports
`Promise_reject` and read its callers. Then find the gate that excludes the
consumer-alone compile. Reproduce with `.tmp/r9/dump-source.js` (the exact
honest source the runner compiles, captured by a temporary dump hook in
`tests/test262-shared.ts`, since the linked assembler's prefix+body is **not**
the honest source and does not reproduce the verdict).

### B. `await` non-thenable (3 rows) — a cross-module closure call answers `null`

`asyncTest(foo)` over an `async function foo` declaration fails with
`Cannot read properties of null (reading 'then')`. The `.then` is the harness's
own `testFunc().then(…)`, so **`foo()` returned `null`** to the provider.

Instrumented on `await-awaits-thenable-not-callable.js`:

```
[DBG prom]     Promise_new_pending    -> object      (the consumer's async machinery works)
[DBG prom]     Promise_settle_resolve -> undefined
[DBG hostcall] wasmClosureDynamicBridge nargs=1 result=null out=null
[DBG dispatch] args=1 dispatchArity=1 declared=1 maxArity=4 -> NULL
```

The closure is dispatched at its **own declared arity**, so this is neither
#6491's under-application nor #2664's method-arity omission. `__closure_arity`
recognises the closure (answers 1) while `__call_fn_1`'s `ref.test` ladder does
not match it and falls through to `ref.null.extern`. Two exports of the same
module disagree about the same closure: one can name its arity, the other has no
dispatch arm for it — invisible in-module (the call is compiled directly) and
fatal the moment a foreign module calls it.

Filed as **#6502**, with the fix direction (emit a `__call_fn_N` arm for every
closure that can ESCAPE the module, and make a ladder MISS distinguishable from
a genuine `null` return).

### Per-row status of the 94 non-passing (linked, r10 baseline)

Grouped by error class, largest first:

| n | class | lane/owner |
| --- | --- | --- |
| ~31 | property-descriptor family (`Expected obj[N] to equal N`, `NOT to be writable`, `configurable:true`, getter/setter must be a function, …) | #6482 |
| 4 | `Promise.all{,Settled}Keyed` sync-throw | A above |
| 4 | `Expected a undefined to be thrown but no exception was thrown` (`findLast`/`findLastIndex` return-abrupt-from-predicate, `deepEqual-deep`) | open |
| 3 | `await` non-thenable | **#6502** |
| ~8 | the `*-realm` cluster (`$262.createRealm()`, `Proxy/*/trap-is-not-callable-realm`, `non-ctor-err-realm`, `define-own-prop-length-overflow-realm`, `assert-throws-same-realm`, `asyncHelpers-throwsAsync-same-realm`) | open — round 5 fixed the `instanceof` half only |
| 4 | `Iterator/zipKeyed` + helper observation order | Iterator lane |
| 2 | `private-field` → `invalid Wasm binary` | #6496 |
| 2 | `TypedArray/prototype/sort` comparefn | open |
| 2 | `String/prototype/replaceAll` replaceValue | open |
| 2 | `RegExp/match-indices` | open |
| 2 | `Proxy/set` call-parameters | open |
| 2 | `Reflect/deleteProperty` | open |
| ~25 | singles (String.prototype deletions, `Array.from` mapfn, tagged-template TCO, `with`-proxy env, DisposableStack extern-class dependency, …) | open |

### Findings for the next lane (round 10)

25. **The runner executes the BUNDLES, not `src/`.** `tests/test262-shared.ts`
    hashes `scripts/compiler-bundle.mjs`, and the import object is built from
    `scripts/runtime-bundle.mjs`. An instrumentation probe in `src/runtime.ts`
    measures nothing until `npm run -s build:runtime-bundle` runs — and the
    silent version of that mistake is a probe that prints nothing, which reads
    exactly like "this code path is not taken".
26. **`assembleLinkedHarness`'s prefix + body is NOT the honest source.** The
    honest lane compiles `harnessAssembly.primary.source`. Reproducing an
    honest verdict from the linked assembler's parts gives a different verdict
    and sends the investigation after a difference that is an artifact of the
    probe.
27. **A silent `null` is the linked lane's characteristic failure shape.** Both
    root causes this round end in a `ref.null.extern` fall-through that the host
    cannot distinguish from a real value — the r6 UNDEF-sentinel bug had the
    same shape. When a linked row fails with "cannot read X of null", suspect a
    ladder miss before suspecting the value.

## Round 11 (2026-09-18) — #6502's loudness half measured and deliberately not shipped

**No code landed.** Linked baseline re-verified on the merged tree: **44 / 138**
(honest 135 / 138), unchanged.

The round-10 hand-off said finding 27 — a silent `null` from the `__call_fn_N`
ladder is this lane's characteristic failure — was the thread to pull. It was
pulled, in four measured variants, and the answer is that the **two halves of
#6502 cannot be shipped in the given order**: making the miss loud is +9 / −4 on
its own, because at least four call sites read the null as a protocol answer
("not my closure", "no trap here"). Full table, the ruled-out alternatives and
the instrumentation are recorded in **#6502**; the short version:

- terminal-throws: 44 → 49, **+9 −4**; and the same +9/−4 with a `ref.test`
  gate, with a runtime peer re-dispatch, and restricted to `__call_fn_0`.
- **+9** is the whole `Symbol.species` / `Symbol.toStringTag` descriptor family
  in this set — so the silent null is corrupting descriptor reads well beyond
  the three `await` rows #6502 was filed for.
- **−4** are `harness/asyncHelpers-asyncTest-*` ×3 and
  `harness/proxytrapshelper-default` — three of them this issue's own round-9
  gains.
- A peer re-dispatch recovers none of the 4, and the reason is decisive:
  instrumented, **every `__call_fn_0..4` in both modules returns null** for the
  failing closure while both modules' `__is_closure` answer 1 and both
  `__closure_arity` answer 1. No module in the project has an arm for it.

So #6502(a) — widen the arm set to every closure that can ESCAPE — is the
blocking half, and it is worth more than the 3 rows it was filed for. #6502(b)
is a free follow-on once (a) lands.

### Per-row status

Unchanged from the round-10 table (94 non-passing, same classes). Items 2
(`Promise.all{,Settled}Keyed`) and 3 (the `*-realm` cluster) of the round-11
brief were not reached.

### Findings for the next lane (round 11)

28. **A silent sentinel is often a PROTOCOL, not an oversight.** Before making
    one loud, find its readers: here the same `ref.null.extern` means "no arm
    for this closure" to one caller and "this value is not mine" to another, and
    no static property (`ref.test`, arity, module identity) separates them —
    only fixing the underlying gap does.
29. **Measure the fix halves in the order that can actually ship.** A two-part
    plan whose second half is independently measurable is worth measuring FIRST
    when it is the cheap one — the +9/−4 here took four runs and settled the
    sequencing question for the expensive half before a line of (a) was written.

## Round 12 (2026-09-18) — #6502 step 1 answered: the type is not in the census

**No code landed** (step 1 was a measurement task). Linked **44 / 138**, honest
**135 / 138**, unchanged.

The escaping closure's struct type is **absent from
`ctx.closureInfoByTypeIdx`** — the census every `__call_fn_N` arm set is built
from. Proof, full table and the two temporary probes are in **#6502**; the
decisive four facts:

1. `__is_closure` says 1 (base-wrapper `ref.test`).
2. `__closure_arity` says 1 — a **field** read, so authoritative about the value.
3. A census `ref.test` ladder answers **type 41 / 3 params** in the consumer and
   **type 17 / 0 params** in the provider: two answers, neither matching (2),
   i.e. structural neighbours rather than the value's type.
4. **Every `__call_fn_0..4` in both modules returns null**, including the arity
   where the neighbour's func type IS admitted.

A runtime-only fix is therefore ruled out — no module has an arm at any arity,
so no owner lookup or arity retry can reach it. Step 2 is emitter work: register
the missing closure kind into the census at mint time (or build the arm set from
the same registry the base test and the arity field come from). The prime
suspect is the async-function / trampoline family — every failing row is
`asyncTest(foo)` over an `async function` declaration, and that lowering exports
its `__cb_N` continuations directly rather than through the closure registry.

### Finding for the next lane (round 12)

30. **When several `ref.test` ladders disagree about one value, the value's type
    is in none of them.** Here three ladders gave three answers (yes / 3 params
    / 0 params) while the one non-ladder helper — an arity FIELD read — gave the
    true one. A ladder cannot report "absent"; it reports its nearest
    structural neighbour, which reads exactly like a wrong answer instead of a
    missing entry. Cross-check any ladder answer against a field read before
    believing it.

## Round 13 (2026-09-18) — #6502 step 2 blocked, and round 12's finding CORRECTED

**No code landed.** Linked **44 / 138**, honest **135 / 138**, unchanged.

Round 12 concluded the escaping closure's struct type was absent from
`ctx.closureInfoByTypeIdx`. **That conclusion is withdrawn.** It came from a
probe that laddered only over census types, which cannot tell "absent" from
"present but mis-described". Laddering over the module's ENTIRE type section
gives the same answer — type 41 — which is in the census (ft 40, host arity 3).

The real inconsistency is narrower: the value's **struct** is type 41 (census:
funcref should be ft 40, host arity 3) while `__closure_arity` answers **1**,
and that helper decides its answer by `ref.test`ing the **extracted funcref**
over func types using the very same `closureHostArity` the arm admission uses.
Struct and funcref disagree about what the value is, so the arity chosen from
`__closure_arity` lands in a ladder where ft 40 is not admitted, and the ladders
that do admit ft 40 fail their funcref test.

One measurement remains unexplained and is flagged as such in #6502: every
`__call_fn_0..4` in both modules returns null, including arity 3. The next probe
is to export the extracted funcref's own type and null-ness for the value rather
than inferring it from `__closure_arity`. Ruled out this round: a census
overwrite at either `createSignatureWrapperType` writer (instrumented, zero hits).

Step 2's edit is deliberately not started — this round already withdrew one
conclusion drawn from a too-narrow probe, and the remaining unknown is one probe
away.

### Finding for the next lane (round 13)

31. **A `ref.test` ladder answers about the SET IT ENUMERATES, so it cannot
    distinguish "absent" from "present but wrong".** Round 12 read a
    census-only ladder as proof of absence; the whole-type-section ladder gave
    the identical answer, and the identity of those two answers is what showed
    the first reading was wrong. When a probe's domain is a subset of the
    question's domain, widen the probe BEFORE concluding — and treat "the wider
    probe agrees" as the falsification test, not as confirmation.

## Round 14 (2026-09-18) — #6502's null is a VOID RETURN, not a dispatch miss

**No code landed.** Linked **44 / 138**, honest **135 / 138**, unchanged.

The funcref probe answers state (ii) and reframes the issue. Struct type 41 is
`__constructible_fn_wrap_4_struct` (census ft 40); the funcref it actually
carries is **ft 43 = `func(ref, externref) -> ` — a VOID closure**. So
`__closure_arity`'s answer of 1 was correct all along (it reads the funcref),
and the `null` this chain has been chasing since round 10 is most likely **not a
miss**: the arm matched, the closure ran, and a void return surfaced as null
because `buildClosureResultBoxing`'s canonical-`undefined` producer
(`__get_undefined`) is not registered in this unit — the #6419 fallback, in a
second emitter (the first was `coerceType`'s f64 arm, round 6).

That single fact explains three earlier puzzles: why every `__call_fn_0..4`
"missed" (a void function answers nothing at any arity), why round 11's loud
terminal broke exactly four rows, and why the arity retries never helped.

**Measured:** registering the producer in `emitClosureCallExportN` gives
**44 → 49: +9, −4 — the same nine gains and four losses as round 11's loud
terminal**, with verbatim-identical errors, from a completely different change.
Two independent ways of stopping a void closure from answering `null` produce
one delta, so the +9 and the −4 share a cause: four call sites read a void
closure's `null` as load-bearing; nine read it as a corrupt value.

Not shipped — same refused trade as round 11. Full detail, the probe output and
the narrow next target (instrument the four readers on
`harness/proxytrapshelper-default.js`) are in **#6502**, whose framing is
revised there: the bridge cannot distinguish a ladder MISS, a VOID return, and a
genuine `null`, and (2) is the common case in this corpus.

### Finding for the next lane (round 14)

32. **Two independent fixes producing an IDENTICAL delta means one shared
    cause, and it is upstream of both.** Round 11 (throw at the terminal) and
    round 14 (return `undefined` for void) touch different files and different
    mechanisms, yet moved exactly the same 13 rows with the same messages. That
    identity is the evidence — it located the real subject (what a void closure
    answers) faster than either change's own reasoning did, and it says the four
    losses are one bug, not four.

### Round 14 addendum — `Promise.all{,Settled}Keyed`: the honest lane wraps the callback, the consumer does not

Picking up round 10's open thread (item 3 of the round-14 brief). Round 10 left
it at "the honest unit carries a `Promise_reject` the linked body lacks"; the
caller is now named.

Both `Promise_reject` call sites in the honest module sit inside a closure of
this exact shape (`$__closure_36`, `$__closure_54` in the honest WAT):

```wat
(try (result externref)
  (do    … body …  call 47)      ;; 47 = Promise_resolve
  (catch 0     call 48)          ;; 48 = Promise_reject
  (catch_all   call 26  call 48))
```

— a synchronous throw converted into a REJECTED promise. That is exactly what
`assert.throwsAsync` needs: `res = func()` returns a thenable that rejects with
the TypeError instead of throwing out of the call.

Compiling the same test BODY alone (the consumer's shape) emits **no
`Promise_reject` at all** — zero occurrences, and the only Promise-related
import is the `global_Promise` capability. So the wrapper is present in the
honest whole-assembly unit and absent from the linked consumer, and the
verdict follows mechanically: the throw escapes `func()` synchronously and
`asyncHelpers` reports *"Expected a TypeError to be thrown asynchronously but
the function threw synchronously"*.

**Next step for this bucket:** identify which emitter mints that wrapper —
`async-closure-promise.ts` (#4648, the `__cb_<id>` host-callback-bridge
wrapper) and the `isAsyncCallExpression` call-site repair in `expressions.ts`
are the two candidates — and why its gate does not fire for the consumer.
The likely shape is the same seam problem as everywhere else in this issue: the
gate needs to see the CALL SITE (`assert.throwsAsync(…)`), which now lives in
the provider, while the callback it must wrap lives in the consumer.

## Round 15 (2026-09-18) — the +9/−4 was an INDEX-SHIFT artifact; rounds 11 and 14 withdrawn

**No code landed.** Linked **44 / 138**, honest **135 / 138**, unchanged.

Round 15 set out to fix the four readers of a void closure's `null`. Before
touching them it tested the premise, and the premise is false.

Registering **one late import that nothing reads** at the exact point rounds 11
and 14 registered theirs — inside `emitClosureCallExportN`, just before its
funcIdx snapshots — reproduces the delta **exactly**: 44 → 49, the same nine
gains, the same four losses.

```ts
ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
flushLateImportShifts(ctx, null);   // nothing reads the index
```

So the +9/−4 published in rounds 11 and 14 measured neither the loud terminal
nor the canonical-`undefined` producer. It measured the **index shift** those
changes caused by registering an import there. Filed as **#6503**.

Both readings are withdrawn:

- **Round 11**: "the loud miss is +9/−4, so (a) must land before (b)" — the
  trade-off it described does not exist. The sequencing conclusion may still be
  right, but it has no measurement behind it any more.
- **Round 14**: "registering the `undefined` producer gives the same +9/−4, so
  the 13 rows share one cause" — they do share one cause, and it is #6503, not
  what a void closure answers.

Round 14's *diagnostic* half stands on its own evidence (the probe output): the
value's funcref is ft 43, `func(ref, externref) -> void`, so `__closure_arity`'s
answer of 1 is correct and the null is a void return rather than a dispatch
miss. What is withdrawn is the claim that fixing it was worth +9/−4.

### Findings

32. ~~Two independent fixes producing an IDENTICAL delta means one shared cause,
    and it is upstream of both.~~ CORRECTED. The premise held — there was a
    shared cause — but the inference was wrong, and the sharper rule is: **an
    identical delta from two unrelated mechanisms is first evidence of a shared
    ARTIFACT, not shared semantics.** Before interpreting it, run the null
    change that carries only the mechanism's incidental side-effect (here:
    register the import, use nothing). One run; it would have saved two rounds.
33. **In this emitter, adding an import is not behaviour-neutral.** Until #6503
    is fixed, any `emitClosureCallExportN` change that registers an import is
    measured against a corrupted baseline — subtract #6503's delta, or fix it
    first.

## Round 4d — the four `built-ins/Iterator` observation-order rows

Measured with the real single-row runner, fresh harness cache, rebuilt bundles,
A/B against this branch's own base (`git show HEAD:` copies of the two files):

| row | linked before | linked after |
| --- | --- | --- |
| `Iterator/prototype/map/underlying-iterator-advanced-in-parallel.js` | fail `Expected SameValue(«0», «3»)` | **pass** |
| `Iterator/prototype/filter/underlying-iterator-advanced-in-parallel.js` | fail `Expected SameValue(«0», «3»)` | **pass** |
| `Iterator/zipKeyed/iterables-iteration-after-reading-options.js` | fail `Actual [get mode, get padding] and expected [get mode, get padding, own-keys]` | **pass** |
| `Iterator/zipKeyed/padding-iteration.js` | fail `Actual [] and expected [a]` | **pass** |

Wider, same A/B:

| slice | lane | before | after | lost |
| --- | --- | --- | --- | --- |
| `built-ins/Iterator/` (654) | linked | 394 | 398 | 0 |
| `Proxy + Reflect + assignment + destructuring + Iterator` (1,624) | linked | 1,165 | 1,172 | 0 |
| same 1,624 | honest | 1,152 | 1,155 | 0 |

The three extra linked rows are `Proxy/has/call-in-prototype.js` and
`Proxy/set/call-parameters-prototype{,-dunder-proto}.js` (they assert the
handler is the trap's `this`); the three extra honest rows are
`Iterator/prototype/{every,find,some}/iterator-has-no-return.js`.

### They were not one bug, and neither one is about iterators

**Lead 1 — which implementation does `Iterator.zipKeyed` resolve to?**
`src/codegen/expressions/calls.ts:6554` is `tryIteratorStaticsIntrinsicCall`,
whose first line is `if (!ctx.standalone && !ctx.wasi) return undefined;` — it
is **dead in the host linked lane**. The call resolves to the host polyfill in
`src/runtime/iterator-polyfills.ts`, reached through the #3049
`_iteratorRecordForHost` shim; evidence is the emitted import list, which
carries `env.__extern_method_call_2` and no `__j2w_iter_*` (a standalone build's
prelude intrinsics). The polyfill's `zipKeyed` was already correct: it does
`Reflect.ownKeys(iterables)` and then `paddingOption[key]` per key, exactly what
the two tests observe.

What was wrong is that the tests observe it **through a Proxy whose handler the
harness built**. `_buildProxyBridgeHandler` read the handler's trap fields with
the READER module's `__sget_<trap>` getters; a handler minted by the linked
harness provider (`allowProxyTraps(...)` from `proxyTrapsHelper.js`) is a struct
of the PROVIDER module, so every getter `ref.test`-missed, every trap resolved
ABSENT, and §7.3.10's "missing trap ⇒ the target's own internal method" kicked
in. No trap fired, nothing threw, `own-keys` and the padding `Get`s simply never
appeared in the log. Every other struct read in the runtime already performs the
#5225 cross-module decoder selection (`_decoderExportsFor`); the proxy bridge was
the one reader that skipped it. Fixed in both the eager and the lazy builder.

One asymmetry the fix has to respect, and the first cut got wrong: the
**handler's** owning module decides how to READ the trap fields, but each **trap
closure's** own owning module decides how to DISPATCH it — a provider-minted
handler routinely holds a consumer-minted closure (`allowProxyTraps({ get })`
with a body-defined `get` is precisely that shape). Using the handler's module
for both sends the dispatch back through the wrong `__call_fn_*` family and
recurses until `Maximum call stack size exceeded`. So: `_decoderExportsFor(handler, …)`
for the field read, `_crossModuleCallbackState(rawTrap, …)` for the dispatch.

**Lead 2 — `_iteratorRecordForHost` snapshot vs `_GeneratorState`.** Neither.
Instrumenting the shim showed it returning `{value: 3}` and `{value: 4}`
correctly while the test still read `0`, so the ordering was never wrong. The
defect is in codegen and has nothing to do with iterators: in a module-init
chunk, a top-level destructuring **assignment** `({ value, done } = …)` stored
ONLY to the `$__mod_<name>` global, while every read resolved the mirrored LOCAL
that the `let { value, done } = …` **declaration** had established.
`emitResolvedIdentifierWriteFromStack` already mirrors the durable global store
into a shadow local — but only via `fctx.moduleBindingShadowLocals`, which is
populated solely by the closure-global arm of `statements/variables.ts`. A
destructuring declaration registers nothing there, so the mirror was skipped and
the assignment was silently lost. The fix falls back to the same-named local
when its ValType matches the global's (a `local.tee` of a mismatched type is
invalid wasm; those bindings keep the old global-only store).

### Findings for the next lane (round 10)

25. **The failure that looks shape-dependent is usually a missing mirror, not a
    heisenbug.** The lost-assignment bug reproduced only in bodies that also
    contained an `assert.sameValue(a, b)` call, and not in an otherwise
    identical body that used `console.log`. That is not randomness: whether the
    reader takes the local path or the global path is decided by what else the
    body compiles. Bisecting the *source shape* cost far more than reading the
    emitted WAT for the two variants, which showed `global.set 12` with no
    matching `local.set 10` in about a minute.
26. **Instrument the layer you suspect before narrowing the input.** Four
    rounds of source bisection pointed at iterators. One `console.error` inside
    `_iteratorRecordForHost` showed it answering `3` and `4` correctly and moved
    the search to the consumer in a single run.
27. **"Trap absent" and "trap unreadable" are indistinguishable at the call
    site, and the spec makes the first one silent.** A cross-module read that
    misses degrades into correct-looking default behaviour with no throw and no
    log. Any `__sget_*` read in the runtime that does not go through
    `_decoderExportsFor` is a candidate for the same class of silent wrong
    answer — this was the last one in the proxy path, not necessarily the last
    one in the runtime.

## Round 5 — `Promise.all{,Settled}Keyed` implemented; the `*-realm` cluster handed back

Two long-tail clusters were assigned. One turned out not to be a parity problem
at all and is fixed at the source; the other is the global-object/realm lane's
and is handed back with the measurements that localise it.

### Cluster A — `Promise.all{,Settled}Keyed`: the honest passes were ACCIDENTAL

**Do not "fix" this cluster by making the linked lane agree.** `allKeyed` is
routed to the HOST `Promise` object (`HOST_PROMISE_SOURCE_METHOD_NAMES` in
`src/codegen/declarations/import-collector.ts`), and the container's Node does
not have it — so `Promise.allKeyed({…})` throws
`TypeError: allKeyed is not a function` **synchronously in both lanes**. The
honest lane "passed" only because its whole-assembly lowering wraps the test's
callback in the try→`Promise_resolve` / catch→`Promise_reject` closure round 14
identified, which converts that *unrelated* TypeError into exactly the rejection
`assert.throwsAsync(TypeError, …)` is looking for. Round 14's addendum read the
missing wrapper as the bug; it is the thing that produced the false positive.

Measured over the whole 89-row family on the round-5 base: **linked 2/89,
honest 6/89**. The four "honest-pass/linked-fail" rows are four of those six.

So js2 implements the proposal (same posture as round 4c's `chunks`/`windows`:
no engine ships it, so the polyfill is the implementation) in a new
`src/runtime/promise-keyed-combinators.ts`, installed from
`installAmbientCompatibility` next to the iterator-helper polyfills and gated on
`typeof PromiseCtor[name] === "function"` so a future native one always wins.

| slice | lane | before | after | lost |
| --- | --- | --- | --- | --- |
| `Promise/{allKeyed,allSettledKeyed}/` (89) | linked | 2 | **52** | 0 |
| same 89 | honest | 6 | **56** | 0 |
| whole `built-ins/Promise/` (729) | linked | 439 | **489** | 0 |

**The four assigned rows are still failing, and now for a DIFFERENT, named
reason.** All four mutate `Promise.resolve` from compiled code
(`Promise.resolve = function () { return {}; }`) and then require the combinator
to observe that mutation. It does not: instrumenting the polyfill's receiver in
the real runner prints `C=function resolve=function native=true` — the compiled
write landed on the compiled `Promise` mirror, while the host combinator still
sees the native `Promise.resolve`. That is builtin-static **write visibility**
across the compiled/host boundary (#4120 / #2623 territory), not the
combinator's semantics, and it accounts for most of the 37 residual rows too
(every `invoke-resolve-*`, `resolve-*`, `invoke-then-*` file mutates
`Promise.resolve` or supplies a custom `Constructor`). The remaining residuals
split into: `not-a-constructor` / `prop-desc` (a polyfill installed as an
ordinary function IS constructible — needs the non-constructor shape), the
Proxy-argument rows (`arg-is-function`, `getownproperty-returns-undefined`,
`prototype-keys-ignored`), and the `ctx-ctor-*` capability rows.

### Cluster B — `*-realm`: not taken, and here is why plus what is known

Six rows, one idiom (`$262.createRealm()`), five unrelated mechanisms. Handing
it back to the global-object/realm lane rather than half-fixing it. What was
established, so the next lane does not repeat it:

1. **The in-process linked seam cannot witness these rows** — finding 23,
   confirmed again. `probe.mts` built on `buildHarnessProvider` +
   `compileHarnessLinkedBody` **passes**
   `language/expressions/new/non-ctor-err-realm.js` in both lanes, with a fresh
   provider cache, with the worker's exact `bodyOptions`, and with the worker's
   exact provider `compileOptions`. The real runner fails the same row. Any
   round-6 work on this cluster must be measured in the runner.
2. **The failure is a value, not a throw.** Tracing `__typeof` inside the runner
   prints `v=undefined` for `otherParseInt`, i.e.
   `$262.createRealm().global.parseInt` evaluated to `undefined` — the honest
   lane and the probe both get the host `parseInt`.
3. **The chain IS emitted.** Dumping the runner's own linked WAT (temporarily
   flipping the worker's `emitWat`) shows
   `global.get $__mod_$262 → __extern_method_call_0("createRealm") →
   __extern_get("global") → __extern_get("parseInt") → global.set $__mod_otherParseInt`,
   with null-checks around each hop. So this is not a folded or missing read.
4. **Unresolved, and the next thing to chase:** a trace inside `__extern_get`'s
   own arm in `src/runtime.ts` never fires for that row, while a trace in
   `__typeof`'s arm (same `resolveImport` switch, same `buildImports` call,
   same module) fires every time. Either the consumer's `env.__extern_get` is
   not the one `buildImports` returns, or the func-index reading above is
   wrong. Settle that first — it is one trace away and it decides whether this
   is a realm bug or an import-wiring bug.

### Findings for the next lane (round 6)

28. **A cluster that is honest-pass/linked-fail is not automatically a parity
    bug — check whether the honest pass is EARNED.** Here the honest lane was
    passing on an unrelated TypeError that its own async wrapper laundered into
    a rejection. The cheapest check is the one that settled it: run the feature
    directly and look at what the engine actually has
    (`typeof Promise.allKeyed` → `undefined` in both lanes). A parity patch
    would have locked in a wrong answer and closed the row forever.
29. **When the feature is simply absent, count the whole family before
    choosing a fix size.** The brief named four rows; the family is 89 and was
    at 2/89. Implementing the proposal was barely more work than a parity patch
    and returned +50 instead of +4.
30. **A polyfill that fixes the mechanism can still leave the ORIGINALLY
    ASSIGNED rows red, and that is a result, not a failure — provided the new
    reason is measured and named.** All four assigned rows now fail on
    compiled-write visibility of `Promise.resolve`, which is a different issue's
    subject; saying so is worth more than forcing them green.
## Round 16 (2026-09-18) — the `lastCaughtException` regressions: two shapes measured, and the phantom-read premise does not hold on the repro

**No code landed.** Linked **44 / 138**, honest **135 / 138**, unchanged.

Both states reproduce on this branch (which carries round 6's module-scope
latch, upstream `ea9bb68887`): the descriptor lane's 5-row filter is **5 failed
(5)**, and its r6 filter is **55 passed / 26 failed (81)**.

### Two invalidation shapes measured, both ineffective

The endorsed direction was to give the latch a lifetime so a `catch_all` can
tell "mine" from "someone's old one". Two shapes narrower than the four the
descriptor lane already rejected:

| shape | 5-row result |
| --- | --- |
| clear the latch when a host import returns **normally at depth 0** (narrower than their rejected "clear on every normal host return" — the depth-0 condition keeps a nested call made between the throw and its `catch_all` from clearing a live latch) | **5 failed** (no change) |
| clear on the next host import **ENTRY at depth 0, excluding the caught-exception getter** (entry proves the program is running forward, not unwinding; the getter must be excluded because the legitimate read IS itself a depth-0 host call) | **5 failed** (no change) |

### The measurement that matters — the premise does not hold here

Instrumenting every read of the latch on
`language/expressions/await/await-awaits-thenables.js` (there is exactly one
reader, `getCaughtException`, and every import object's closure reads the same
module variable, so the instrumentation is complete):

```
[LATCH read] [object Error] Expected SameValue(«[object Object]», «42») to be true
```

**One read, and it carries the row's OWN assertion failure** — it happens
*after* the test has already gone wrong, not before. There is no spurious
pre-failure read of another module's handled throw on this row. The failure
itself (`[object Object]` where 42 was expected) is upstream of any latch read.

So on this repro the "async state machine's `catch_all` reads a phantom
exception" diagnosis is not what is happening, which also explains why two
plausible lifetime fixes moved nothing. Since a 3×-stable A/B says reverting
*only* that binding fixes the row, the effect of the module-scope move must
reach the row through something other than a spurious read — the write path, or
something else in the cherry-picked commit — and that is where the next attempt
should start rather than on latch lifetimes.

**Handoff note for the descriptor lane:** worth re-running their A/B with the
same instrumentation to see whether a pre-failure read appears in *their*
worktree. If it does not there either, the shared premise behind all six
measured shapes (theirs and mine) is the thing to retire.

### Finding for the next lane (round 16)

34. **Instrument the reader before designing the lifetime.** Six invalidation
    shapes were designed against "a stale value is read too early"; the first
    instrumented read showed the only read on the repro is post-failure. One
    `console.error` in the accessor would have ordered the work differently —
    the same lesson as round 15, one level up: check that the mechanism you are
    fixing is the mechanism that fires.

## Round 17 (2026-09-18) — the bisect is one line, and the A/B pins the whole delta to ONE read

**No code landed.** Linked **44 / 138**, honest **135 / 138**, unchanged.

### Hunk bisect

`ea9bb68887` (this branch: `3b7d1e3c5d`) has **one code hunk**. The whole commit
is:

| file | change |
| --- | --- |
| `src/runtime/host-import-call-state.ts` | `let lastCaughtException: any = undefined;` moved from inside `createHostImportCallState()` to module scope — **one line**, plus the rationale comment |
| `tests/issue-6492-r6-cross-module-host-throw.test.ts` | new test, +111 |

There is nothing else to bisect: no import-object construction order, no change
to where the value is written, nothing touching `__await` / thenable resolution
or how a `then` callback's argument is boxed. So the 5 rows flip on the single
line, and the question is only *how*.

### The A/B that answers it

`language/expressions/await/await-awaits-thenables.js`, run **solo** (so this is
not cross-row contamination — it fails alone), with every latch read
instrumented, on both trees:

| tree | reads | the read answers | row |
| --- | --- | --- | --- |
| **pre-fix** (latch inside the factory, per import object) | **1** | `undefined` | **pass** |
| **post-fix** (latch at module scope, shared) | **1** | `[object Error] Expected SameValue(«[object Object]», «42»)` | **fail** |

Same program point, same single read, opposite answers. So the entire regression
is: **one `catch_all` read that used to answer `undefined` now answers a stale
foreign error**, and the async state machine treats any non-`undefined` answer as
a pending exception and takes the abrupt-completion path — which is what makes
the `await` yield an object where 42 was expected.

This also corrects round 16's conclusion. The read IS the mechanism after all;
what was wrong there was reading the post-fix log alone, where the latched
message *looks* like the row's own assertion failure and therefore reads as
"post-hoc". The pre-fix arm is what disambiguates it — a single-arm
instrumentation of a two-arm question cannot.

### What this specifies for the fix

The discriminator is now exact, and it is a property of **that one read**:

- it must answer **`undefined`** here (a foreign, already-handled throw), and
- it must answer **the value** in r6's case (a consumer host throw whose unwind
  is being caught by the provider).

Both my round-16 lifetime shapes fail this because the pollution is written with
no intervening quiescence before the read — there is no "nothing is unwinding"
moment between them. "Local latch with shared fallback" also fails it, because
the reader's own latch is empty at that point in BOTH cases, so the fallback
fires in both. What is left is to tag the entry with the unwind it belongs to
(the shared `env.__exn` route #5226 already gives wasm-thrown errors), so the
reader can ask "was this written by the throw that is currently unwinding
through ME" rather than "is anything latched".

### Finding for the next lane (round 17)

35. **Instrument BOTH arms of an A/B, not the failing one.** Round 16 read the
    post-fix log alone, saw a latched message that matched the row's own
    assertion text, and concluded the read was post-hoc and the premise dead.
    The pre-fix arm — one more run — showed the same single read answering
    `undefined` and the row passing, which reinstates the premise and pins the
    delta exactly. A one-arm measurement of a two-arm question can only tell you
    what happens, never what *differs*.

## Round 18 (2026-09-18) — the shared-tag route works and fixes nothing: the failure is UPSTREAM of exception handling

**No code landed.** Linked **44 / 138**, honest **135 / 138**, unchanged.

### Preflight — all three checks pass

| check | result |
| --- | --- |
| (1) do provider and consumer share ONE tag object? | **yes** — `installSharedExceptionTag` (`src/linked-provider-runtime.ts`) creates one process-wide `WebAssembly.Tag({parameters:["externref"]})` and puts the same object on both import objects |
| (2) can this Node rethrow `new WebAssembly.Exception(tag, [value])`? | **yes** — constructs, throws, `is(tag)` true; a `null` payload is accepted; the `traps` option is accepted and not needed |
| (3) does the payload round-trip by IDENTITY? | **yes** — `getArg(tag, 0) === obj` |

The catch sites already have the arm, too: the honest WAT's async wrapper is
`(try (do … call Promise_resolve) (catch 0 …) (catch_all …))`, and `catch 0` is
the `__exn` tag arm — so no codegen change was needed to receive it.

### Implemented, and it engages

The tag moved to a leaf (`src/runtime/shared-exception-tag.ts`) so the host
import wrapper can reach it without a cycle; all 7 wrapper arms rethrow on the
tag after latching, gated on `peekSharedExceptionTag()` so a single-module
program (which never installs a tag) stays byte-identical.

**5-row filter: still 5 failed.** Instrumented, the rethrow fires exactly once
per row, and the value it carries is
`Expected SameValue(«[object Object]», «42») to be true` — the row's OWN
assertion failure. Same single position as the latch read.

### What that proves, and it retires the whole line of attack

Put together with round 17's two-arm A/B:

- post-r6: `await thenable` yields an **object**, `assert.sameValue(v, 42)`
  fails, the Test262Error is thrown → latched → (now also) tagged → read by the
  reporting `catch`. The read/tag is the row REPORTING its failure.
- pre-r6: the same single read answers `undefined` and the row passes — because
  the assertion never failed, i.e. the await yielded **42**.

So the latch read is downstream in BOTH arms, and the module-scope latch changes
**the value the `await` produces**, before any exception exists. Neither the
latch's lifetime nor the exception's carrier can reach that: rounds 16 and 18
were both aimed at a mechanism that only reports the failure.

Round 17's reading is corrected accordingly: the delta between the arms is real
and is exactly at that read, but the read is an EFFECT — pre-fix there is
nothing to report, post-fix there is.

### Where the next attempt should look

Something in the await/thenable resolution path is sensitive to the latch being
process-wide. The single-line diff has no other content, so the coupling has to
be through a READ of `getCaughtException` on the resolution path that does not
go through the instrumented accessor, or through a consumer of
`hostImportCallState` that captures it (`src/runtime.ts:19288` hands
`hostImportCallState.getCaughtException` to the async-import adapters —
`src/runtime/host-async-imports.ts`). Instrument THERE, not in the wrapper: the
question is what the async adapter does differently when that function answers
non-`undefined` while a promise is being resolved.

### Finding for the next lane (round 18)

36. **A carrier fix cannot repair a value bug.** Three rounds (16, 17, 18)
    treated "the wrong thing is reported" as the defect; the reporting channel
    was faithful the whole time and the wrong VALUE was produced upstream. The
    tell was available early and was read past twice: the failure message names
    a value (`[object Object]` where 42 was expected), not an exception. When a
    row's message is about a VALUE, the exception plumbing is downstream of the
    bug however suspicious it looks.

## Round 19 (2026-09-18) — r6 did not regress the 5 rows: it UNMASKED them

**No code landed.** Linked **44 / 138**, honest **135 / 138**, unchanged.

Both arms instrumented on `await-awaits-thenables.js`, run solo, logging every
host-import throw (import name, depth, import-object id) and every latch read.
The full trace is three lines per arm and diverges on exactly one:

```
pre-fix  [R19 throw] obj=0 import=__extern_method_call_2 depth=2 [object Error] Expected SameValue(«[object Object]», «42») to be true
         [R19 read]  obj=1 -> undefined                                    → 1 pass, 0 fail
post-fix [R19 throw] obj=0 import=__extern_method_call_2 depth=2 [object Error] Expected SameValue(«[object Object]», «42») to be true
         [R19 read]  obj=1 -> [object Error] Expected SameValue(…)         → 0 pass, 1 fail
```

**Line 1 is identical in both arms.** The assertion fails either way — `await
thenable` yields the thenable where 42 is expected. The only difference is
whether the OTHER import object's single read surfaces that failure.

So `ea9bb68887` did not regress these five rows; it **unmasked** them. Pre-r6
the cross-module rejection reason was lost and a failing async row reported as
**passing** — a false PASS, which is the worse defect of the two and the one r6
fixed.

**Recommendation: do NOT revert `ea9bb68887`.** Reverting re-hides five real
failures and loses r6's seven genuine gains. The linked lane's headline was 5
too high before r6; the residual is now honest.

Both defects are filed as **#6504** (the `await`-of-a-cross-module-thenable
value bug, with `_wrapThenable`'s module-scoped `exports` probes as the starting
point, plus the false-pass accounting).

This also closes out rounds 16–18, all three of which were aimed at a reporting
channel that was working: the channel became MORE correct in r6, and what it
started reporting was a pre-existing bug.

### Finding for the next lane (round 19)

37. **A "regression" that a revert fixes may be an unmasking — check whether the
    failure exists in the passing arm too.** Four rounds and a 3×-stable A/B all
    pointed at one line; the line was innocent. What settled it was logging the
    *failing assertion* in the arm that PASSES. A revert-fixes-it A/B proves
    causation of the VERDICT, never of the defect — and a verdict can flip
    because a real failure stopped being swallowed. Corollary for conformance:
    a row that passes because a reason was lost is worse than a red row, and no
    row-count gate can see it.

## Round 20 (2026-09-18) — #6504's named site is not on the path

**No code landed.** Linked **44 / 138**, honest **135 / 138**, unchanged.

The brief's fix was implemented exactly as specified: `_wrapThenable`
(`src/runtime.ts`) now decodes through `_decoderExportsFor(v, …)` — the #5225
owner-exports helper already used by `_classChainRead`, the `__shas_` probes and
the Date carrier — so a consumer-minted thenable is recognised when it reaches
the provider's Promise machinery.

**5-row filter: still 5 failed.** Instrumented, the reason is categorical:

| probe, on `await-awaits-thenables.js` (solo) | fired? |
| --- | --- |
| `_wrapThenable` entry (both the struct and the not-a-struct arm) | **never** |
| `Promise_resolve` import lambda | **never** |
| `Promise_then2_frame` import lambda | **never** |

The linked consumer's `await` reaches **none** of the host Promise imports. A
single-module compile of the same body imports `Promise_resolve`,
`Promise_new_pending`, `Promise_settle_{resolve,reject}` and
`Promise_then2_frame`; the linked consumer uses none of them on this row, so the
await is being driven somewhere else entirely (the wasm-side frame engine is the
obvious candidate — `src/runtime/wasmgc/async/frame-engine.ts`).

So `_wrapThenable` cannot be the fix, and the #5225 owner-exports idea is right
in kind but aimed at the wrong reader. #6504 has been updated with this
elimination and now points the next attempt at finding which mechanism actually
resolves the awaited value in the linked consumer — dump the consumer's import
list and its `__async_*` locals for this row, and compare against the
single-module compile whose imports are listed above.

### Finding for the next lane (round 20)

38. **Before fixing a named site, prove the site RUNS.** One `console.error` at
    the entry of `_wrapThenable` would have shown it is never called on this row
    and saved implementing, building and measuring a correct-looking fix. The
    round-16 lesson ("instrument the reader") generalises: instrument the site
    you are about to change, not only the value you expect it to produce.

## Round 21 (2026-09-18) — ROOT CAUSE: the linked consumer erases `await` entirely

**No code landed** (localization round). Linked **44 / 138**, honest **135 / 138**.

Neither branch of the brief is right, because the linked consumer takes *no*
async path at all. Dumping the real linked-seam compile of
`await-awaits-thenables.js` (`compileHarnessLinkedBody`, `emitWat: true`) and
reading `$foo`:

```wat
(func $foo (type 10)                  ;; <- no result
  global.get 9    local.set 0         ;; assert
  global.get 10   extern.convert_any  ;; the THENABLE, read directly
  local.set 1
  global.get 17   local.set 2         ;; 42
  local.get 0  global.get 4  local.get 1  local.get 2
  call 7                              ;; __extern_method_call_2 -> assert.sameValue(thenable, 42)
  drop)
```

**The `await` is not lowered at all.** Its operand is read and handed straight to
`assert.sameValue`, so `await thenable` evaluates to the thenable by
construction. Corroborating, across the whole consumer module:

| evidence | count |
| --- | --- |
| host Promise imports (`Promise_resolve`, `Promise_new_pending`, `Promise_settle_*`, `Promise_then2_frame`) | **0** |
| native thenable substrate (`__promise_has_callable_then`, `__promise_thenable_job`, #3125) | **0** |
| any `__async_*` local or frame-engine artefact | **0** |
| `$foo`'s result type | **none — it returns void** |

So the host-free-floor verdict is not choosing the native path and the native
path is not missing thenable unwrapping: the async machinery is **absent**, and
`async function foo` compiled as an ordinary void function with its `await`
erased.

### This unifies two issues

`$foo` returning **void** is the same fact rounds 12–14 chased from the other
end: the closure whose funcref is `func(ref, externref) -> ` with no result, and
`foo()` answering `null` so `asyncTest`'s `testFunc().then` threw. #6502's three
`await` rows and #6504's five rows are **one defect** — the linked consumer
drops async lowering — approached from the reporting side and the value side.

That also retires the remaining #6502 framing: there is no dispatch miss and no
void-return ABI question to fix; the callee should never have been void.

### Where the fix belongs

Find the predicate that decides a body unit gets no async lowering and make the
linked consumer unit take the same path the single-module compile of the same
body takes (that one imports `Promise_resolve`, `Promise_new_pending`,
`Promise_settle_{resolve,reject}` and `Promise_then2_frame`). Suspects, in the
order worth checking: the `entryScriptGoal` consumer compile (#6474), the
`deferTopLevelInit` window (#6477), and `asyncFnNeedsHostDrive`'s pre-body
verdict running without the harness prefix in view. The A/B is cheap and
already scripted — `.tmp/r9/linkedwat.mts` dumps the consumer WAT for any row.

### Finding for the next lane (round 21)

39. **Read the emitted code for the construct, not the machinery around it.**
    Rounds 16–20 asked which mechanism mishandled the awaited value; the answer
    was that no mechanism ran, because the `await` was not emitted. Thirty
    seconds of `grep` in the consumer's own WAT — `$foo` has no result type and
    no suspension — outranked four rounds of runtime instrumentation. When a
    value is wrong, disassemble the function that should produce it before
    instrumenting anything that consumes it.

## Round 22 (2026-09-18) — round 21's A/B compared two different sources; the real discriminator is the CALL TARGET

**No code landed.** Linked **44 / 138**, honest **135 / 138**.

### Correction to round 21

Round 21 concluded "the linked consumer erases `await`, the single-module
compile does not". The consumer observation is right; the comparison was not.
The single-module probe used `var r = await thenable; return r;` while the row's
actual body is `assert.sameValue(await thenable, 42)`. Compiling the **row's**
shape single-module reproduces the erasure exactly — **no Promise imports** — so
the erasure is NOT a property of the linked seam.

### What actually decides it

| source | Promise imports |
| --- | --- |
| `var r = await thenable; return r;` (single module) | **yes** — all four |
| `assert.sameValue(await thenable, 42)` with `assert` UNDECLARED (single module) | **none** |
| same, with `assert` defined locally in the unit | **yes** (`Promise_resolve`, `Promise_reject`) |
| same, linked consumer (`assert` is a PROVIDER import) | **none** |

So the async engine's verdict turns on **whether the awaited expression's
enclosing call target is resolvable in this unit** — not on the await's
position, and not on the link seam per se. The linked lane is hit because
`assert` is a provider import there, which puts it in the same class as an
undeclared identifier as far as the verdict is concerned.

That is also why the honest lane passes these rows: in the whole-assembly
compile `assert` is a compiled harness function in the SAME unit, the engine
claims the async function, and `await` is lowered normally.

### Where the fix belongs (refined)

`asyncFnNeedsHostDrive` (`src/codegen/async-frame.ts` ~L231) declines, and a
decline means the "legacy synchronous pass-through", which compiles `await` as a
no-op (`async-closure-promise.ts` header states this). Its early exits are ruled
out — `awaitIsStaticallyResolved` returns false for a bare identifier, so
`anyRealSuspension` is true — which leaves `planLinearAwaits(...) === null`
followed by `computeTryCatchSpills(...) === null`. **Next step: instrument those
two on the three sources above** and find which one needs the call target's
type; then make an unresolvable / cross-unit call target not force a decline.

A decline that silently erases `await` is the deeper problem: the same shape
that says "this function suspends" is being compiled as if it does not. Worth
considering whether a decline should refuse loudly (the #3587 hazard guard
already exists for rejection-observing shapes) rather than emit a no-op await.

### Findings

40. **An A/B is only an A/B if the two arms differ in ONE thing.** Round 21's
    arms differed in the link seam AND the source shape; the conclusion named
    the wrong one, and it took a third compile (the row's real shape,
    single-module) to see it. When constructing the comparison, copy the exact
    source from the failing row rather than writing a "minimal equivalent".

## Round 23 (2026-09-18) — the decline is LANE-INDEPENDENT: `planLinearAwaits` returns null for an await in a call ARGUMENT

**No code landed.** Linked **44 / 138**, honest **135 / 138**.

Instrumented `asyncFnNeedsHostDrive`'s three decision points and ran the row's
exact body on both round-22 sources:

| source | `awaits` | `anyRealSuspension` | `planLinearAwaits` | `computeTryCatchSpills` | verdict |
| --- | --- | --- | --- | --- | --- |
| `assert.sameValue(await thenable, 42)`, `assert` **undeclared** | 1 | true | **NULL** | **NULL** | **DECLINE** |
| same, `assert` **defined locally** | 1 | true | **NULL** | **NULL** | **DECLINE** |

**Identical.** So round 22's discriminator is wrong too: the async engine
declines this shape either way, and the Promise imports I used as the signal in
round 22 come from the #4648 closure-promise wrapper / call-site repair, not
from the frame engine. I was reading a different mechanism's fingerprint.

### The actual defect

`planLinearAwaits` returns `null` for an `await` nested as an **argument of a
call**, `computeTryCatchSpills` returns `null` (there is no try/catch), so
`asyncFnNeedsHostDrive` declines — and a decline means the legacy synchronous
pass-through, which compiles `await` as a **no-op**. It is lane-independent and
has nothing to do with the link seam, the call target's resolvability, or
thenables.

`await thenable` is merely the shape that makes the erasure *visible*: with a
real promise the pass-through's wrong value is often indistinguishable from the
right one in a synchronous harness, but a thenable is returned unchanged and the
assertion catches it.

### Open question for the honest lane

If the decline is lane-independent, the honest lane erases the `await` too — yet
it reports these rows as PASSING. Given round 19 established that a lost
rejection reason turns a failing async row green, the likely explanation is that
**the honest lane is false-passing these rows for the same reason the pre-r6
linked lane was**. That is worth confirming before the honest 135/138 number is
relied on: instrument the assertion throw on the honest arm of one row.

### Where the fix belongs

`planLinearAwaits` must plan an `await` in a call-argument position (spill the
already-evaluated callee/receiver and the preceding arguments across the
suspension), rather than answering `null`. That is a real planner extension, not
a gate flip, and it is the whole of #6504 plus #6502's three rows.

The loud-refusal half of the round-23 brief now looks more important, not less:
this decline is reachable from ordinary source on every lane, and it silently
produces a wrong value.

### Findings

41. **Two arms agreeing is as informative as two arms differing — instrument
    the decision, not a downstream artefact.** Rounds 21 and 22 each named a
    discriminator (the link seam; the call target) from an artefact that
    correlated with it (which Promise imports appeared). Logging the predicate's
    own branches took one edit and showed both arms decline identically, which
    no amount of comparing emitted imports could have.

## Round 24 item 1 (2026-09-18) — the honest lane is NOT false-passing these rows

**No code landed.** Linked **44 / 138**, honest **135 / 138**.

Round 23 suspected the honest 135/138 was overstated, because a lane-independent
decline should erase the `await` on the honest lane too. Measured, and it is
not:

```
HONEST, await-awaits-thenables.js, solo, instrumented:
  [R24 throw] import=__extern_method_call_2 depth=1 [object Error] Expected SameValue(«[object Object]», «42») to be true
  [R24 read]  [object Error] Expected SameValue(«[object Object]», «42») to be true
  → 0 pass, 1 fail
```

Two facts follow:

1. **The honest lane FAILS this row**, and reports it correctly — the assertion
   throws, the reason survives, the verdict is red. No false pass.
2. **The row is not in the 138-row set at all** (`grep` of `.tmp/r5/rows138.txt`
   — that set is the #6492 honest-pass/linked-fail bucket, and this row is
   honest-FAIL). So the honest 135/138 I have reported every round never
   included these five rows and is not overstated by them.

So the picture from round 19 stands unamended: the honest lane has always
reported these rows honestly; the pre-r6 LINKED lane was false-passing them; r6
made the linked lane agree with honest. The decline is lane-independent (round
23) and both lanes produce the wrong value — only the pre-r6 linked lane hid it.

**No baseline correction is needed.** The comparison baseline for this bucket is
unchanged.

### Item 2 not started

The planner extension (`planLinearAwaits` for awaits in call-argument position,
with the five shapes and evaluation-order constraints) is a scoped codegen piece
and is left for its own round. Item 3's residual-decline census depends on it.

## Round 25 (2026-09-18) — the planner already has a call-argument arm; our rows miss it BY DESIGN, and widening it needs spills

**No code landed.** Linked **44 / 138**, honest **135 / 138**.

`planLinearAwaits` is not missing call-argument support — it has a bounded arm,
`replaySafeNestedCallAwait` (`src/codegen/async-cps.ts` ~L594), and reading its
conditions explains every measurement in rounds 21–23 and settles what shape (a)
actually requires.

### The existing arm's conditions

For `EXPR_STATEMENT` containing the await, it admits the await only when:

| condition | our row `assert.sameValue(await thenable, 42)` |
| --- | --- |
| statement is an `ExpressionStatement` | ok |
| await is **`arguments[0]`** of the call | ok |
| callee is an **`ts.isIdentifier`** | **NO** — it is `assert.sameValue`, a property access |
| the first parameter's type is `any`/`unknown` | n/a |
| callee symbol has exactly ONE declaration, a **`const` variable** | **NO** |

So the decline is deliberate, and the module's own doc says why: *"Mutable/global
callees, earlier arguments, and an awaited call embedded as an argument/operand
of another expression are rejected. Those shapes need explicit pre-await operand
spills rather than continuation recompilation."*

### Why the mechanism cannot simply be widened

The arm works by **recompiling the containing statement after resume**, with the
delivered value substituted for the `AwaitExpression`. That is sound only when
everything evaluated *before* the suspension is replay-equivalent — which is why
it is restricted to reading one `const` binding.

`assert.sameValue` is a **property access**: §13.3.6 evaluates the callee before
the arguments, so re-reading `assert.sameValue` after the suspension is
observably wrong — the awaited thenable's `then` runs arbitrary user code in
between and may replace it. Relaxing the `const`-identifier rule to admit a
member expression would trade a silently-erased `await` for a silently-re-read
callee: a different wrong answer, not a fix.

**So shape (a) as our rows need it is not a gate widening; it is the spill path
the doc names.** Concretely it needs:

1. a second synthetic frame binding for the **callee value** (and, for `o.m(...)`,
   the receiver) evaluated BEFORE the suspension and spilled;
2. spills for every **preceding argument** already evaluated, in order;
3. a resume path that **calls the spilled callee** with the spilled arguments
   plus the delivered value, instead of recompiling the statement;
4. the same for `new C(await x)` (spilled constructor) and for an await nested
   inside an argument expression (`f(1 + await x)`), where the partial operand
   must be spilled too.

Today's `resumeBinding` / `asyncAwaitValueLocals` machinery delivers exactly ONE
value into a recompiled statement; (1)–(4) are a different continuation ABI.

### Why I did not land a partial version

A partial widening here is the same failure mode this whole arc has been
chasing: the subsystem's declines exist because each one was a measured
regression (#2967, #2906, #3134, #5367 are all carve-outs in this file), and an
unsound admission produces a **wrong value silently** rather than a red row. The
one widening that IS sound without new spills — accepting the await at a later
argument index when every preceding argument is itself a literal/const read —
does not cover any of the 5 + 3 rows, because all of them have a property-access
callee.

### What the next lane should do

Implement the spill-based continuation ABI above as its own piece, shape by
shape, with the WAT A/B (`.tmp/r9/wat2.mts` single-module, `.tmp/r9/linkedwat.mts`
linked) checking for a result type + the four Promise imports before each runner
pass. Item 3's census (declines with `anyRealSuspension` true across the async
slices) is worth running FIRST and independently: it sizes the loud-refusal
decision and will also show how much of the corpus rides on this one arm.

### Finding

42. **Read the decline's own documentation before designing around it.** The
    module states exactly which shapes it rejects and that they "need explicit
    pre-await operand spills rather than continuation recompilation" — the
    design answer to four rounds of investigation was a comment above the
    predicate. Rounds 21–23 measured their way to the same sentence.

## Round 26 (2026-09-18) — the decline census, and a bucket nobody predicted

**No code landed.** Linked **44 / 138**, honest **135 / 138**.

`replaySafeNestedCallAwait` was instrumented to report WHICH condition rejects,
and the six async slices were run on the linked lane
(`expressions/await/**`, `built-ins/Promise/**`, `expressions/async-function/**`,
`expressions/async-arrow-function/**`, `statements/async-function/**`,
`statements/for-await-of/**`) — **2,212 rows, 1,532 pass / 671 fail / 9 CE**
(this is also the pre-round state for the regression comparison).

### Declines with `anyRealSuspension` true, by rejecting condition

| bucket | events | what it means |
| --- | --- | --- |
| `no-checker` | **31** | `checker === undefined` — the planner was called without a checker, so the shape was never examined |
| `member-callee` | **27** | `o.m(await x)` — the 5 + 3 rows' shape |
| `nested-operand` | **12** | the await is not the direct argument of a call (`f(1 + await x)`, operand positions) |
| `not-expression-statement` | **1** | the containing statement is not an `ExpressionStatement` |
| **total** | **71** | |

Buckets that did **not** appear at all in these slices: `preceding-argument`,
`new-expression`, `mutable-or-global-callee`, `typed-first-parameter`,
`no-first-parameter`. So of the five shapes the round-25 design enumerated, only
**two** are actually exercised here — member callee and nested operand — and the
`new C(await x)` / preceding-argument work has no corpus evidence behind it yet.

### The unpredicted bucket: 31 of 71 declines are not about shape

`no-checker` is the largest bucket and is not a shape rejection at all:
`planLinearAwaits` is invoked without `opts.checker`, so
`replaySafeNestedCallAwait` returns false on its first line regardless of what
the code looks like. That is a threading gap, and it is plausibly far cheaper to
fix than the continuation ABI — it may also move rows that the ABI would
otherwise have to cover. **It should be checked before any ABI work starts.**

### The ≤ 20 rule: indeterminate, deliberately not resolved

These are decline EVENTS, not rows: the same function is planned more than once
per compile (a sample body logged 3 events for 1 function), so the distinct-row
count is bounded above by 71 and is plausibly ~24. That straddles the threshold,
which is exactly the case the rule exists to catch, so **the loud refusal is not
landed**. Resolving it needs one more run that attributes each event to its row
(print the row path alongside the reason); that is a bounded measurement and
should precede the decision.

### Finding

43. **Census the decline reasons before designing for them.** The round-25
    design enumerated five shapes from reading the predicate; the corpus
    exercises two of them, and the single largest cause — a missing checker —
    was not one of the five and is not a shape at all. One instrumented run over
    2,212 rows reordered the whole workplan.

## Round 27 (2026-09-18) — the `no-checker` bucket is real and its fix is NEUTRAL; #6503 blocks the measurement

**No code landed.** Linked **44 / 138**, honest **135 / 138**.

### Step 1: what `no-checker` actually is

Not a call-site omission — all four `planLinearAwaits` call sites already pass
`ctx.checker`, and `ctx.checker` is non-optional. A stack trace names the real
path:

```
replaySafeNestedCallAwait <- lowerLinearStatements <- lowerChunk
  <- lowerRegionBody <- analyzeTryCatchAsync <- tryCatchAsyncSpillInfo
```

That is the **try/catch analysis** — the SECOND chance `asyncFnNeedsHostDrive`
gives a body after `planLinearAwaits` declines. It builds its `LowerState` with
no checker, so the shape arm's first line (`checker === undefined` → false)
fires regardless of the code. The caller (`computeTryCatchSpills`) has `ctx` and
therefore `ctx.checker` already, so it is a pure threading gap.

Implemented the threading (`ctx.checker` → `tryCatchAsyncSpillInfo` →
`analyzeTryCatchAsync` → `lowerRegionBody` → `lowerChunk` → `LowerState`;
`planTryCatchCfg` given the same optional parameter). Typecheck clean.

### Step 1 measurement: neutral where it matters, #6503 noise where it does not

| measurement | before | after |
| --- | --- | --- |
| six async slices, linked (2,212 rows) | 1,532 pass / 680 fail | **1,532 / 680 — identical** |
| 138-row set, honest | 135 | 135 |
| 138-row set, linked | 44 | **49: +9 / −4** |

The 138-row delta is **#6503's signature, exactly**: the same nine
`Symbol.species` / `toStringTag` gains and the same four `harness/*` losses that
an *unused* late import reproduced in round 15. The change alters which
functions the async engine claims, hence codegen, hence function indices — and
#6503 says any index perturbation in this area moves precisely those 13 rows.

So the honest reading is: **the threading fix is semantically neutral** (0 gains
on the 2,212 async rows, which is where it could possibly matter), and its only
visible effect is to trip a known unrelated bug.

**Not committed.** Landing it would import a +9/−4 churn whose cause is #6503,
against a baseline #6503 has already corrupted. It is a correct change with no
measured benefit and a known-noisy footprint.

### This is a second, independent confirmation of #6503

Round 15 produced the signature with an unused import; round 27 produces it with
an unrelated planner-threading change. Two different perturbations, one identical
13-row delta. **#6503 should be fixed before any further work in this area** —
it is now demonstrably taxing every measurement, and finding 33 has been paid
twice.

### Steps 2 and 3 not run

The attribution run and the spill ABI both measure into the same corrupted
baseline. Running them before #6503 would produce numbers that need re-doing.

### Finding

44. **A neutral change that trips a known bug is still not shippable.** The
    temptation is to land it because it is "correct anyway" and explain the
    delta; but the delta is real churn for reviewers and for the next
    measurement, and the fix costs nothing to defer. Fix the measurement
    substrate first — the second time you pay the same tax, stop and fix it.

## Round 28 (2026-09-18, Opus long-tail lane) — #6503 does not reproduce on this base; the round-27 threading fix is shippable

Base: `claude/compiler-performance-bn5g3l` @ 887e87650a (+ `278b5d1aa5`), which is
**not** the base rounds 10-27 measured on (`issue-6492-r8`). That difference is
the whole of this round's first finding.

### The 138-row baseline is already 49, not 44

| set | lane | r8 base (rounds 10-27) | this base |
| --- | --- | --- | --- |
| 138-row | linked | 44 | **49** |
| 138-row | honest | 135 | 135 |

The nine `Symbol.species` / `Symbol.toStringTag` rows all **pass** here and the
four `harness/*` rows all **fail** here — i.e. this base already sits on the far
side of the exact 13-row block that rounds 11, 14, 15 and 27 each moved. So the
+9/−4 signature is a property of the TREE, not of any perturbation applied to it.

### #6503's probe is vacuous as published, and null once made effective

The published probe registers `__throw_type_error`. That name is **already in
`ctx.funcMap`** at this point in every module measured here, so `ensureLateImport`
returns the existing index and **no import is added** — the probe changes nothing
by construction. Re-running it is what surfaced this: the harness provider binary
for `built-ins/Array/Symbol.species/symbol-species.js` is **byte-identical** with
and without it (195,777 bytes, `cmp` clean), and the consumer WAT is identical too.

Re-probed with a name that is genuinely absent (`__object_is`, a real host import
so the module still instantiates). Instrumented, it does add one import at each
of the five `emitClosureCallExportN` arities (`155 -> 156`, then funcMap hits).
Measured:

| measurement | base | + unused late import |
| --- | --- | --- |
| harness provider binary (symbol-species include-set) | 195,777 B | **byte-identical** |
| 138-row set, linked | 49 | **49 — +0 / −0 per test** |
| 900-row honest control (`built-ins/Object`, first 900) | 703 | **703 — +0 / −0 per test** |

`storeSpills`-class side channels, `funcMap`, the trampoline/scheduler/generator
caches and the export/element/start-index walks all remap correctly here, and the
now-unused import is pruned before emission — hence byte-identical output rather
than merely equal row counts.

**#6503's acceptance criterion ("registering an unused import at this site leaves
all 138 rows unchanged") is therefore MET on this base, with no code change.**
What is not established is why the r8 base behaved differently; the honest reading
is that the r8 delta was never demonstrated to be an index shift — the probe that
"reproduced" it added no import at all.

### The round-27 threading fix: THREE builders, one silently dropped argument

Re-applied, and it is bigger than round 27 described. `LowerState` — the record
`replaySafeNestedCallAwait` reads its checker from — is built in **three**
places, not one:

| builder | reached via | had a checker before |
| --- | --- | --- |
| `planLinearAwaits` | the primary claim | yes |
| `lowerChunk` | `tryCatchAsyncSpillInfo` / `planTryCatchCfg` -> `analyzeTryCatchAsync` -> `lowerRegionBody` | **no** |
| `analyzeWhileAsync` | `planWhileLoopCfg` / `loopAsyncSpillInfo` | **no** |

Round 27 found the second. The third is the `while`-with-await plan, and it has
the same property. Both plan builders are now threaded **together with their
spill-info twins** (`loopAsyncSpillInfo`, `tryCatchAsyncSpillInfo`): those two
pairs must make the SAME shape decision, because one computes the frame fields
for the plan the other builds — a shape admitted by one and not the other is a
frame whose live values have no field.

**The first cut of this fix did not work, and nothing said so.**
`tryCatchAsyncSpillInfo` got the parameter in its signature while its body kept
calling `analyzeTryCatchAsync(fn, plan, hoist)` — three arguments, checker
dropped on the floor. Typecheck passed (the parameter is optional), the plan
still came back, and no row count moved. The only thing that changed was the
decline reason, which no gate reads. Instrumenting the reject reasons on one
row's linked-consumer compile is what caught it:

| repro (`await-awaits-thenables.js`, linked consumer) | `no-checker` | `member-callee` |
| --- | --- | --- |
| before | 3 | 6 |
| after the signature-only "fix" | 3 | 6 |
| after the body actually forwards | **0** | **9** |

All nine declines are now the real shape gate. `tests/issue-6492-r28-trycatch-planner-checker.test.ts`
asserts the FORWARDING, not just the signature, for exactly this reason.

### Measurement

| measurement | before | after |
| --- | --- | --- |
| six async slices, linked (2,212 rows) | 1,532 / 680 | 1,532 / 680 — +0 / −0 per test |
| 138-row set, linked | 49 | 49 — +0 / −0 per test |
| equivalence-gate | 22 failing / 1,720 passing | unchanged, no new |

Both diffs are per-TEST, not per-count. Round 27 declined to land this because
its only visible effect was a +9/−4 it attributed to #6503; on this base that
delta does not occur, so the change is what it is — correct, and with no
measured behaviour change.

Closing the largest decline bucket while moving **zero** rows is itself the
result: the `no-checker` declines were not rows the shape gate would have
admitted. The remaining buckets — `member-callee` 27, `nested-operand` 12 — are
the real work, and they need the spill continuation ABI (#6504), not a
parameter.

### #6504: the defect reproduces here, and there is now a seconds-long repro

`.tmp/r28/linkedwat.mts <row> <out.wat>` compiles a row's body through the real
linked seam and dumps the consumer WAT. On
`language/expressions/await/await-awaits-thenables.js` the consumer contains
**zero** matches for `Promise_resolve` / `Promise_then2_frame` / `__async_` —
round 21's "the consumer erases `await`" observation holds on this base, and the
row still fails the linked lane with `SameValue(«[object Object]», «42»)`.

That replaces the corpus run as the inner loop for #6504: a fix's first
acceptance signal is async artefacts appearing in this one WAT, in seconds,
instead of 11-45 minutes.

**Note for round 22's table:** the single-module arm no longer reproduces. With
`assert` undeclared, `async function foo() { … assert.sameValue(await thenable,
42); }` compiled as ONE module DOES import `Promise_resolve` / `Promise_reject`
on this base. Only the linked consumer erases the await. So the repro is
lane-specific now, and round 22's "compiling the ROW's shape single-module
reproduces the erasure" no longer holds — use the linked dumper.

### What was NOT done

The `member-callee` spill ABI (#6504's real fix) is **not implemented**. The
design is unchanged from round 25 and the carrier for it now looks concrete —
`AsyncCfgState` already has the two hooks it needs (`emit`, which runs after the
lead and before the terminator, is the pre-suspension spill slot; `postDeliverEmit`,
which runs after delivery, is the resume-side call slot), `storeSpills` /
`restoreSpills` already move any name bound in `fctx.localMap`, and
`buildHostCallFallbackArm` (`src/codegen/expressions/host-call-fallback.ts`)
already emits `__call_function_N(fn, thisArg, args…)`. What is missing is the
plan-side carry (the callee/receiver/argument nodes per segment), the synthetic
spill names in `computeAsyncSpills`, and a host-lane gate on the dynamic call.

**There is no cheap sound shortcut, and this was checked rather than assumed.**
Admitting the shape through the existing replay path re-reads `o.m` AFTER the
suspension, and the awaited thenable's `then` runs arbitrary code in between.
The existing identifier arm is sound only because re-reading a single-`const`
binding is provably the same value; a property read is not. The trade on offer
is "silently erased await" for "silently re-read callee", and round 25 already
declined it.

### The loud-refusal decision is still open

Round 26 left the ≤ 20 rule indeterminate because it counted decline EVENTS, not
rows. Round 28 tried to attribute events to rows from the runner's stderr and
that does not work — vitest batches worker stderr and attributes it to whichever
test it flushes under, so a 12-event sample mapped to ONE (wrong) row.

The measurement that actually answers it needs no attribution at all: gate the
loud refusal behind a flag, run the six slices with it on, and diff against the
base run — the rows that flip pass -> fail ARE the set, by definition. That run
was not completed here (the box was running three other agents' vitest suites
and the corpus runs were taking 3-4x their normal wall time). The refusal
channel to widen is `reportDeclinedAsyncRejectionHazard`
(`src/codegen/async-activation.ts`): today it fires only when the suspension sits
inside a `try`; the candidate change is to drop that condition for declines with
`anyRealSuspension` true.

### Findings

45. **A null-change probe is only a control if it actually changes something.**
    Round 15's probe was `ensureLateImport(ctx, "__throw_type_error", …)` at a
    site where that name is already registered — an early `funcMap` return. The
    control that was supposed to prove "the import alone moves 13 rows" added no
    import. Verify the perturbation landed (here: one `cmp` of the emitted
    binary, or one `numImportFuncs` print) before reading its delta.
46. **Re-measure the baseline on YOUR base before inheriting a delta.** The
    13-row block was already flipped here, so any change measured against the
    inherited "44" would have shown a phantom +5. One 150-second run replaced
    two rounds of inherited premise.
47. **An optional parameter that is accepted but not forwarded fails silently,
    and no gate in this repo can see it.** Typecheck passes, the plan still
    returns, row counts do not move; only the decline reason changes. Any fix
    whose success criterion is "a predicate now RUNS" needs a direct observation
    that it runs — an instrumented reject-reason count on one repro — and a test
    that asserts the forwarding, not the signature.
48. **Build the seconds-long repro before the corpus run, not after.** #6504 had
    18 rounds of corpus-scale measurement behind it; the single-compile linked
    dumper that shows the same defect takes about four seconds and immediately
    invalidated one inherited premise (the single-module arm) and confirmed
    another (the erased await).

## Round 29 (2026-09-18, Opus long-tail lane) — #6504's spill continuation, built

The ABI round 25 designed and rounds 26-28 kept deferring is implemented, in a
new subsystem module `src/codegen/async-spilled-call.ts`. `o.m(await x)` no
longer declines into the legacy pass-through that compiles `await` as a no-op.

### What it does

For `<callee>(…, await x, …)` as an expression statement, in source order:

| when | step | where it lives |
| --- | --- | --- |
| before the suspension | evaluate the receiver `o` | spill `__async_call_recv@<pos>` |
| before the suspension | read `o.m` **off that value** (`__extern_get`) | spill `__async_call_callee@<pos>` |
| before the suspension | evaluate each argument left of the await | spill `__async_call_arg<i>@<pos>` |
| — | suspend on `x` | — |
| on resume | `__call_function_<n>(callee, recv, spilled args…, delivered, remaining args)` | resume state |

Reading the method off the already-evaluated receiver, rather than recompiling
`o.m`, is the step that keeps `o` to exactly ONE evaluation — the difference
between correct and usually-correct for `getObj().m(await x)` and for a
getter-valued receiver.

### It needed no new frame machinery

The carrier was already there, which is why this is a small change in the
god-files (+76 `async-cps.ts`, +24 `async-frame.ts`) and a new module for the
mechanism:

- `AsyncCfgState.emit` runs after a state's leads and before its terminator
  evaluates the awaited operand — exactly where JS evaluates the callee
  reference and the preceding arguments.
- `AsyncCfgState.postDeliverEmit` runs after the settled value is bound and
  before the resume state's leads — exactly where the call belongs.
- `initializeSpillLocals` / `storeSpills` / `restoreSpills` already move any
  name bound in `fctx.localMap`, so the continuation's fields are ordinary
  spills. `computeAsyncSpills` appends them because they are not source
  bindings and `plan.liveAfterAwait` cannot know about them.

The one genuinely new thing is the resume-side call, which goes through the
existing `__call_function_<n>` host import. That makes this **host lane only**;
`spilledCallLaneSupported(ctx)` gates it, and wasi/standalone keep their
existing decline.

### Scope, and the two boundaries that are deliberate

Admitted: member callee (`o.m(await x)`, `o.m(a, await x)`, `o.m(await x, b)`),
plain identifier callee including `let`/`var`/global/import — i.e. everything
the pre-existing replay arm could not take, because it re-reads the callee after
the suspension. Up to 4 user arguments (the fixed-arity import family).

Not admitted, each for a stated reason rather than by omission:

- **`new C(await x)`** — `__call_function_<n>` performs `[[Call]]`, not
  `[[Construct]]`, so admitting it would silently build the wrong thing. It did
  NOT fall out for free; it needs its own resume-side op.
- **try/catch ACROSS the await** — that shape leaves the linear planner for the
  try/catch analysis, whose CFG states carry no spill hooks. `lowerChunk`
  therefore leaves `allowSpilledCall` unset, so the plan can never describe a
  call that path's emitter would not emit. The shape keeps its pre-round-29
  behaviour exactly, and `tests/issue-6504-spilled-call-await.test.ts` pins that
  boundary rather than blessing it.
- **await nested INSIDE an argument** (`f(1 + await x)`, the round-26 census's
  12-event `nested-operand` bucket) — the partial operand needs spilling too.
  Same ABI, more plan-side carry; not this round.

### The shape decision is derived, never plumbed

`asyncFnNeedsHostDrive` (claim), `computeAsyncSpills` (frame layout) and
`planAsyncCfg` (plan) each compute `allowSpilledCall` from `ctx` via the same
predicate. They cannot disagree about which shapes exist, which is the failure
mode that would produce a frame whose live values have no field. The IR-overlay
planner (`async-linear-planning.ts`) does not pass the flag, so it declines
these bodies and the AST path takes them — also consistent by construction.

### Tests: the sentinel, and why "no failures" was not a safe pass condition

`tests/issue-6504-spilled-call-await.test.ts` runs bodies on the real linked
lane and reads failures off the `unhandledRejection` channel. The first draft
asserted "no rejections" and was **vacuous**: with the lane gate forced off, the
old behaviour reports ZERO failures — the legacy pass-through's rejection never
reaches an unhandled promise, which is #6504's own defect B. So every body now
ends in a deliberate `assert(false, SENTINEL)` and every case expects exactly
that one failure, which proves the body ran to its last line and every
assertion before it held.

Measured falsifiability: with `spilledCallLaneSupported` forced to `false`,
**7 of the 8 cases fail** (the eighth is the try/catch boundary case, which is
supposed to be unaffected). The order cases are the load-bearing ones:

- a `then` that reassigns `obj.m` — the PRE-suspension callee must run;
- a getter-valued receiver source — evaluated exactly once;
- getters left and right of the await — `a,then,b`, and `1-2-3` arriving in
  their source positions;
- a `var` callee reassigned from `then` — the pre-suspension read wins.

A recompile-the-statement resume passes the value case and fails all four.

### Measured

Fresh `JS2WASM_TEST262_HARNESS_CACHE` per run, both bundles rebuilt between arms
(`pnpm run build:compiler-bundle` / `build:runtime-bundle`). The honest arms are
a file-copy A/B against `HEAD` (round 28), not an env switch.

| slice | lane | before | after | delta |
| --- | --- | --- | --- | --- |
| six async slices (2,212 rows) | linked | 1,532 | **1,533** | **+1 / −0** |
| six async slices (2,212 rows) | honest | 1,526 | **1,530** | **+4 / −0** |
| 138-row #6492 long-tail set | linked | 49 | 49 | +0 / −0 |

Zero regressions in either lane. The rows that moved:

| row | lane(s) |
| --- | --- |
| `language/expressions/await/await-awaits-thenables.js` | linked + honest |
| `language/expressions/async-function/named-reassign-fn-name-in-body.js` | honest |
| `…/named-reassign-fn-name-in-body-in-arrow.js` | honest |
| `…/named-reassign-fn-name-in-body-in-eval.js` | honest |

The three `named-reassign` rows were not predicted and are the clearest
confirmation that the mechanism is the right one: a named function expression
whose own name binding is reassigned in its body is precisely the
"callee is not an immutable binding" case, which the replay arm must refuse and
the spill ABI takes by construction.

`tests/issue-6492-r6-cross-module-host-throw.test.ts`,
`tests/issue-6492-r28-trycatch-planner-checker.test.ts` and the new
`tests/issue-6504-spilled-call-await.test.ts` — 17 tests, all green.

### #6504's other four rows are NOT fixed, and they are a different defect

Measured individually on the linked lane after the change:

| row | verdict | error |
| --- | --- | --- |
| `await/await-awaits-thenables.js` | **PASS** | — |
| `dynamic-import/assignment-expression/await-expr.js` | fail | `SameValue(«undefined», «"Te…»)` |
| `optional-chaining/iteration-statement-for-await-of.js` | fail | `[object Object] is not iterable` |
| `optional-chaining/member-expression-async-identifier.js` | fail | `Cannot read properties of null` |
| `optional-chaining/optional-chain-async-square-brackets.js` | fail | `SameValue(«0», «undefined»)` |

None of the four is an erased `await` in a call argument: three are optional
chaining (`?.`), which `planSpilledCallAwait` declines by name, and one is
dynamic `import()`. They were grouped into #6504 because they failed together
with the thenable row, not because they share its cause. #6504's Defect A should
be split: the call-argument erasure is fixed; the optional-chaining and
dynamic-import rows need their own diagnosis.

### The loud-refusal flag-diff plan (not run this round)

Deliberately deferred. When it is run, it needs no event-to-row attribution —
that approach failed in round 28 because vitest batches worker stderr:

1. gate the widening behind an env flag in `reportDeclinedAsyncRejectionHazard`
   (`src/codegen/async-activation.ts`): drop the `findSuspensionInsideTry`
   condition for declines with `anyRealSuspension` true, keeping the existing
   FunctionDeclaration/closure scope;
2. run the six async slices on the linked lane with the flag ON;
3. diff against the round-29 baseline (`as-d`, 1,533/2,212). Rows that flip
   pass → fail ARE the loud-refusal set, by definition;
4. ≤ 20 distinct rows ⇒ land it and list them in #6504; > 20 ⇒ list them for
   follow-up and land nothing.

Note the baseline moved this round, so an older run cannot be reused for step 3.

### Finding

49. **A verdict channel that is silent under the old behaviour makes every test
    on it vacuous.** The natural assertion here ("the body reports no
    failures") passes both when the fix works and when the bug is fully present,
    because the bug's signature IS the silence. Testing that the body reached a
    known last line — rather than that it reported nothing — is what makes the
    difference observable. Always run the suite once with the mechanism disabled
    and count how many cases actually fail.

## Round 16 (2026-09-18, Opus lane) — the `*-realm` cluster: the SANDBOX had no global functions

**Shipped: one mechanism, entirely in the runner's harness sandbox.** No
compiler change. `SANDBOX_GLOBAL_NAMES` (`scripts/test262-sandbox-globals.mjs`)
listed constructors and namespace objects but **none of the ES §19.2 global
FUNCTIONS** — no `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `decodeURI*`,
`encodeURI*`, `escape`, `unescape`. A compiled `globalThis.parseInt` therefore
resolved to `undefined` through the `globalSandbox` bridge, silently.

That is the `$262.createRealm()` cluster's failure, one level below where the
previous rounds were looking: `scripts/test262-fyi-runtime.js` **builds** the
foreign realm's global by copying those names off `globalThis`
(`parseInt: globalThis.parseInt`), so `createRealm().global.parseInt` was
`undefined` while every hop of the chain ran exactly as round 5 described it.

### Round 5's open question, answered: it is not import wiring

Round 5 note 4 left "a trace inside `__extern_get`'s arm never fires for that
row, while `__typeof`'s arm fires every time" as the thing to settle first.
There are **two `extern_get` implementations in `src/runtime.ts`** and they sit
~1,100 lines apart:

| arm | where | reached by |
| --- | --- | --- |
| `if (name === "__extern_get")` | ~L12780, the by-NAME builtin switch | modules importing it by spelling |
| `case "extern_get":` | ~L18883, the typed-INTENT switch | the linked consumer — `import-manifest.ts` maps `__extern_get` → `{type:"extern_get"}` |

The previous lane instrumented the first; the row uses the second. Nothing was
mis-wired. (Worker `console.error` is also invisible through this vitest entry —
the traces here were written to a file via an env-named path.)

With the right arm instrumented the whole chain reads out in one run:

```
[DBG emc]   createRealm typeof=object isStruct=false
[DBG eget2] key=parseInt typeof=object isStruct=false has=false val=undefined   ← inside the shim, off the SANDBOX
[DBG eget2] key=global   typeof=object isStruct=true  ...
[DBG eget2] key=parseInt typeof=object isStruct=true  ...
```

`has=false` on the second line is the whole bug: the property is **absent**, not
shadowed and not mis-decoded.

### The first cut was net-negative, and the reason is the attributes

Adding the names alone measured **+29 / −6 linked and +32 / −6 honest**. The six
losses were the same rows in both lanes — `S15.1.2.2_A9.5`, `S15.1.3.x_A5.5`,
`S15.1.2.3_A7.5` — all asserting `propertyIsEnumerable(<name>) === false`. The
sandbox builders populate with `sandbox[name] = …`, which creates an
**enumerable** property; §19.2 defines these as
`{ writable: true, enumerable: false, configurable: true }`. Those rows had been
passing only because the property was absent altogether.

So the shipped change is two parts, not one: the names, **and**
`applySandboxGlobalFunctionAttributes(sandbox)` — one shared helper called from
both sandbox builders (`scripts/test262-worker.mjs`, `tests/test262-runner.ts`),
for the #3441 reason that two hand-kept twins drift. The pre-existing
constructors are deliberately left enumerable: same latent defect, but their
attributes are baked into the committed baseline, so that is its own measured
change.

### Measurements (real runner, fresh harness cache per run, both bundles rebuilt)

Slice: `realm|parseInt|parseFloat|isNaN|isFinite|encodeURI|decodeURI|global-code|built-ins/escape|built-ins/unescape` — **768 rows**.

| lane | base | names only | names + attributes (shipped) |
| --- | ---: | ---: | ---: |
| linked | 500 | 523 (+29 / **−6**) | **539 (+39 / −0)** |
| honest | 483 | 509 (+32 / **−6**) | **525 (+42 / −0)** |

Per-row, the six honest-pass/linked-fail `*-realm` rows this round was given:

| row | linked before | linked after |
| --- | --- | --- |
| `language/expressions/new/non-ctor-err-realm.js` | fail `SameValue("undefined","function")` | **pass** |
| `harness/assert-throws-same-realm.js` | fail `Expected a Test262Error, but no error was thrown` | unchanged |
| `harness/asyncHelpers-throwsAsync-same-realm.js` | fail (same, async) | unchanged |
| `built-ins/Proxy/getPrototypeOf/trap-is-not-callable-realm.js` | fail `Expected a TypeError … no exception` | unchanged |
| `built-ins/Proxy/deleteProperty/trap-is-not-callable-realm.js` | fail (same) | unchanged |
| `built-ins/Array/length/define-own-prop-length-overflow-realm.js` | fail `Expected a RangeError` | unchanged |

Control slices, base vs. shipped, row by row:

| slice | lane | base | after | flips |
| --- | --- | ---: | ---: | ---: |
| `harness/` (116) | honest | 113 | 113 | **0** |
| `harness/` (116) | linked | 101 | 101 | **0** |

`equivalence-gate`: 1,720 passing / 22 known failures = baseline, 0 new
regressions.

The other five share the idiom and not the mechanism — they depend on the
realm's **distinct error constructors** (`mkerr()` closures minted inside the
PROVIDER) and on a Proxy trap read across the module boundary, i.e. round 4d's
`_decoderExportsFor` family, not the sandbox. Naming that is the result; forcing
them green is not available from here.

Test: `tests/issue-6492-r16-sandbox-global-functions.test.ts` (4 cases). All
four fail on the pre-fix tree — the list, the callables, the ATTRIBUTES, and a
scan that ties the list to its consumer (every `globalThis.<name>` the realm
shim reads must be on the list; `Iterator` and `eval` are the two documented
exemptions).

### Findings for the next lane (round 16)

30. **When a whole cluster answers `undefined` with no throw, suspect the
    FIXTURE before the compiler.** Three rounds treated this as a linked-seam
    defect. The chain was correct at every hop; the runner's sandbox simply did
    not have the property, and a `has=false` in one trace line settled it. The
    sandbox is the test262 lane's model of the global object — it is as much a
    source of wrong answers as codegen is, and far cheaper to check.
31. **A duplicated runtime arm makes a trace lie.** `__extern_get` exists twice
    in `src/runtime.ts` (by-name builtin vs typed intent) and only one is live
    for a linked consumer. "My instrumentation never fires" is evidence about
    the INSTRUMENTATION until you have confirmed which arm the module's import
    manifest actually selects.
32. **Adding a property is also choosing its attributes.** The names alone were
    +29/−6; the six losses were entirely `propertyIsEnumerable` assertions, and
    they had been passing on ABSENCE. Any fix that makes a missing thing present
    must be measured against the rows that were asserting it missing.
## Round 30 (2026-09-18, Opus long-tail lane) — the loud refusal costs 402 rows, and #6504's "optional-chaining rows" are three different bugs

**No behaviour change landed.** The round's two results are a measurement that
closes a long-open question and a diagnosis that invalidates the round's own
premise.

### The loud refusal: −402 / 2,212. Not 20. Not a tuning question.

Rounds 26-29 kept deferring this because the ≤ 20-row rule was indeterminate.
Round 29 wrote the plan that needs no event-to-row attribution; round 30 ran it.

The widening (drop `findSuspensionInsideTry` in
`reportDeclinedAsyncRejectionHazard`, refuse loudly for every decline with
`anyRealSuspension` true) was put behind a temporary env flag and measured
against round 29's baseline:

| | linked, six async slices (2,212 rows) |
| --- | --- |
| round 29 baseline | 1,533 pass |
| loud refusal ON | **1,131 pass** |
| delta | **+0 / −402** |

Where the 402 live:

| bucket | rows |
| --- | --- |
| `language/statements/for-await-of` | **396** |
| `language/{expressions,statements}/async-function`, `async-arrow-function` | 6 |

Every one becomes `compile_error: async shape not supported…`.

**The conclusion is not "the budget was slightly too small".** It is that the
declined-with-real-suspension population IS most of the for-await-of corpus —
destructuring heads the engine does not claim and the synchronous fallback runs
acceptably today. The `try`-scoped condition is therefore load-bearing: it is
what makes the guard a residue rather than the whole population. The rationale
now lives at the condition itself in `src/codegen/async-activation.ts`, so the
next reader does not re-derive it.

**Any future widening must name a SUBSET** — by decline reason, most plausibly
the `member-callee` / `nested-operand` shapes, whose sync fallback is a known
silent miscompile — never the whole declined set. The env flag was removed
rather than left in the tree: an env var that turns 402 passing rows into
compile errors is a hazard, and the one-line change is described in the issue.

### #6504's four residual rows are THREE defects, none of them the erasure

The dispatch brief for this round asked for "the optional-chaining rows"
(3) plus the dynamic-`import()` row (1), on the premise that `?.` is declined by
name in the planner. Reduced individually with the single-compile probe, that
premise does not hold and the four rows do not share a cause. Filed as **#6508**;
summary:

| row | actual cause | evidence |
| --- | --- | --- |
| `optional-chain-async-square-brackets.js` | await NESTED in an operand (`[22,33]?.[await P]`) — the round-26 `nested-operand` bucket | line-by-line reduction: `await [11]?.[0]` PASSES; the index-operand line is the one that declines |
| `member-expression-async-identifier.js` | **#6502** null closure dispatch | fails at `asyncTest`'s `testFunc().then` on null; all of the body's own await statements pass when reduced |
| `iteration-statement-for-await-of.js` | `Symbol.asyncIterator` not selected by the for-await head | `[object Object] is not iterable`; the optional chain resolves fine |
| `dynamic-import/assignment-expression/await-expr.js` | dynamic `import()` resolves to `undefined` | unrelated to all of the above |

So the round's stated acceptance ("the 3 rows pass linked") was **not
achievable as scoped**: two of the three are not optional-chaining defects and
one of those is not an async defect at all. The one that IS in the spill ABI's
family is an instance of a bucket #6504 already tracks (`nested-operand`), whose
fix is the partial-operand spill — deliberately not started here rather than
begun late in the async engine on a premise that had just been falsified.

The optional-chain-specific constraint IS real and is recorded with that work:
`undefined?.[await Promise.reject(…)]` must short-circuit **without awaiting**,
so the suspension has to be skipped entirely, not merely ordered.

### Findings

50. **Co-occurrence in a failure list is not shared causation.** Five rows were
    one issue from round 6 to round 29 because they failed together in one run.
    They were three defects plus one already-fixed. The mis-grouping survived 23
    rounds and propagated into a dispatch brief. Reducing each row took under a
    minute with the probe that already existed.
51. **When a guard's scope looks conservative, measure the cost of widening it
    BEFORE calling it conservative.** "Refuse loudly everywhere a rejection could
    be dropped" reads like strictly better engineering. It costs 402 rows,
    because the silent fallback is not a rare degradation — it is how most of the
    for-await-of corpus currently passes.

## Round 17 (2026-09-18, Opus lane) — `Promise.allKeyed` runs in the WRONG REALM; half of it fixed

**Shipped: the install target.** `installAmbientCompatibility` put `allKeyed` /
`allSettledKeyed` on `options.deps?.Promise ?? Promise` — the ambient intrinsic
— and never consulted `globalSandbox`. It now resolves the target through
`resolvePromiseCompatibilityTarget`: injected `deps.Promise`, else the
**sandbox's** `Promise`, else the intrinsic (the ordinary product embedding,
unchanged).

**Not shipped, because it is a second realm split one hop upstream: the ~37
`invoke-resolve-*` / `resolve-*` / `invoke-then-*` rows are still red.** Stating
that first because the round's numeric bars are met and the assigned rows are
not, and those are different things.

### What was actually measured (real runner, linked, single row `allKeyed/invoke-resolve-get-once.js`)

Two sites instrumented at once. Before the change:

```
[DBG dpa] prop=resolve  isWorkerPromise=false isSandboxPromise=true   ← the test's Object.defineProperty target
[DBG gpr] typeofC=function isWorkerPromise=true resolveIsNative=true  ← C inside the combinator
```

The test writes to the **sandbox's** `Promise`; the combinator was reached
through the **worker's**. The combinator itself was never wrong — it already
reads `C = this` and `Get(C,"resolve")` per §7.3.x.

After the change the install lands correctly (`[DBG install] isWorkerPromise=false`)
— and `[DBG gpr]` STILL reports the worker's `Promise`. So the receiver that
reaches `__extern_method_call(obj, "allKeyed", …)` is *already* the worker's
intrinsic:

```
[DBG emc] allKeyed isWorkerPromise=true isSandboxPromise=false sandboxPromiseIsWorker=false hasSandbox=true
```

Four facts that bound where that value can come from, each from its own probe:

1. The module's ONLY `Promise`-shaped import intent is
   `{"type":"declared_global","name":"Promise"}` — dumped by stringifying every
   intent through `resolveImport`.
2. That intent resolves to the **sandbox's** Promise:
   `[DBG dg] Promise hasSandbox=true depHit=false ambientIsWorker=false`.
   `platform-capability-adapter.ts` already prefers `context.globalSandbox`.
3. There is **no** `__extern_get(_, "Promise")` in the row at all — the
   harness-binding shim's `var Promise = globalThis.Promise` does not reach the
   boundary; the read folds to (1).
4. The provider is NOT the divergence: `scripts/test262-worker.mjs` hands the
   linked provider the same `globalSandbox` (#6475/#6476), and the consumer's
   own import object reports `hasSandbox=true` with
   `globalSandbox.Promise !== Promise`.

So a third producer puts the worker's intrinsic in the callee position, and it
is not any Promise-shaped import intent. **That is the next lane's first
question, and it is one probe deep**: instrument the callee operand at the
`Promise.<static>` call lowering (`src/codegen`), not the runtime — the runtime
has been excluded from above.

### Numbers (real runner, `built-ins/Promise/` = 729 rows, both lanes, fresh cache per run, bundles rebuilt per arm)

| slice | lane | base | after | lost |
| --- | --- | ---: | ---: | ---: |
| `built-ins/Promise/` (729) | linked | 488 | **491** | **0** |
| `built-ins/Promise/` (729) | honest | 483 | **486** | 0 (the one flip, `Promise/all/prop-desc.js`, was a 10 s **timeout** under load and passes on a single-row re-run) |
| keyed family (89) | linked | 51 | **54** | 0 |
| keyed family (89) | honest | 56 | **58** | 0 |

Gained, linked: `allKeyed/prop-desc.js`, `allSettledKeyed/prop-desc.js`,
`allKeyed/result-property-descriptors.js` — i.e. exactly the rows that ask
whether the static is an own property **of the realm they read `Promise`
from**. That is the change's own mechanism, measured.

Realm canary, `TEST262_REALM_CANARY=log`, 168-row linked slice
(`allKeyed|allSettledKeyed|resolve|reject`): **zero `Promise.*:added` drift**.
Four `Promise.allKeyed.{name,length}:deleted` lines remain — tests deleting
those props off the PRIMED worker copy, which is a consequence of the unfixed
receiver hop above, not of this change.

The #6492-r5 canary prime in `scripts/test262-worker.mjs` is **kept
deliberately**: a no-sandbox embedding still installs onto the intrinsic, and
the prime is what keeps that one-time install inside the baseline snapshot.

Tests: `tests/issue-6492-r17-promise-keyed-realm-target.test.ts` (5 cases —
sandbox preferred, intrinsic fallback with and without a sandbox lacking
`Promise`, `deps` wins, install leaves the intrinsic unchanged, and a
sandbox-side `Promise.resolve` accessor observed once per enumerable key by
`allKeyed`). `tests/issue-6492-r5-promise-keyed-combinators.test.ts` 13/13.

Host-import policy ceilings moved in the same commit:
`maximumRuntimeTsLines` 19990 → 19994 (the four-line `globalSandbox` pass-through
at the `installAmbientCompatibility` call) and `maximumOwnedAdapterLines`
823 → 874 (`resolvePromiseCompatibilityTarget` plus the doc block recording the
two instrumented identities above — the measurement is the reason the rule is
what it is, and it belongs next to the rule).

### Findings for the next lane (round 17)

33. **"Same name, two realms" can happen twice in one expression.** `Promise`
    in `Object.defineProperty(Promise, …)` and `Promise` in
    `Promise.allKeyed(…)` — same identifier, same module, same statement
    sequence — resolved to two different host objects. Fixing the install
    target aligned the polyfill with the first one and left the second
    untouched. When a realm bug is suspected, probe every occurrence
    separately; one identity check is not a result.
34. **Excluding the runtime is a result worth writing down.** Four probes here
    prove the worker-realm `Promise` is NOT produced by any import intent, any
    `__extern_get`, or the provider's host context. That turns an open-ended
    hunt into a single codegen question, and it is the reason this round stops
    where it does instead of guessing at a fix.
