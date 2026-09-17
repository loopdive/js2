---
id: 6492
title: "Linked lane P3c residual: 705 pass→fail rows in ~12 provider-side buckets (BigInt convert, __module_init null, extern class stubs, illegal-cast trap)"
status: in-progress
sprint: current
created: 2026-09-16
updated: 2026-09-16
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
loc-budget-allow:
  - src/codegen/closures.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/closures.ts::compileArrowAsCallback
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
