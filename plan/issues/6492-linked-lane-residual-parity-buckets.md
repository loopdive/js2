---
id: 6492
title: "Linked lane P3c residual: 705 pass→fail rows in ~12 provider-side buckets (BigInt convert, __module_init null, extern class stubs, illegal-cast trap)"
status: ready
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
loc-budget-allow:
  - src/codegen/closures.ts
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

### Acceptance

- [ ] `illegal cast` bucket = 0 (no uncatchable traps in the linked lane).
- [ ] pass→fail residual ≤ 250 on the next `linked_lane=true` dispatch (record
      as P3d in #6486 with the bucket table).
- [ ] Honest lane byte-identical (every change gated on
      `exportsConsumedByWasm` / provider-only code paths); equivalence gate: no
      new regressions.
- [ ] Each fixed bucket has a `tests/issue-6492-*.test.ts` case that compiles a
      minimal provider + consumer pair through `compileHarnessLinkedBody` and
      asserts the verdict (template: `tests/issue-6490-linked-callback-param.test.ts`).
