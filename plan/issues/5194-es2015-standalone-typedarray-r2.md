---
id: 5194
title: "ES2015 standalone typedarray — r2 residual pass (post-#5188 clustering)"
status: in-progress
pr: 5300
sprint: current
created: 2026-08-29
updated: 2026-09-01
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
loc-budget-allow:
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/new-builtin-globals.ts
  # 2026-09-01 r2 residual plan (post-#5300/#5385) — one file per step, see
  # "Budget rationale" in that section.
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-own-props.ts
  - src/codegen/proto-index-store.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/builtin-proto-constructor.ts
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/array-methods.ts
  - src/codegen/ta-hof-map-filter.ts
  - src/codegen/hof-native.ts
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/iterator-native.ts
  - src/codegen/closed-method-dispatch.ts
  # 2026-09-01 r2 IMPLEMENTATION (steps 1-2, Opus). Three readers the plan
  # named by function but not by file: the static `<Builtin>.prototype.<m>`
  # value read plus its `.length`/`.name` meta fold (`builtin-value-read.ts`),
  # the own-CSV resolver that now retries on the declared parent brand
  # (`native-proto-value-read.ts`), and the `$__ta_ctor` metadata arm that
  # makes `<View>.prototype` an OWN property of the constructor
  # (`ta-ctor-meta.ts`) — `verifyProperty`'s first assertion.
  - src/codegen/builtin-value-read.ts
  - src/codegen/native-proto-value-read.ts
  - src/codegen/ta-ctor-meta.ts
func-budget-allow:
  - src/codegen/dataview-native.ts::ensureTaDynSetHelper
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructFromLocals
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  # 2026-09-01 r2 residual plan — arms spliced into existing ladders.
  - src/codegen/array-object-proto.ts::emitTypedArrayIntrinsicCtorObject
  - src/codegen/array-object-proto.ts::emitTypedArrayProtoMemberBody
  - src/codegen/native-proto.ts::buildLazyNativeProtoGetInstrs
  - src/codegen/native-proto-own-props.ts::registerNativeProtoHasOwn
  - src/codegen/proto-index-store.ts::fillGetKBody
  - src/codegen/proto-index-store.ts::fillHasKBody
  - src/codegen/object-runtime.ts::prependBuiltinFnObjectSemantics
  - src/codegen/expressions/object-get-prototype-of.ts::tryCompileEs5GetPrototypeOfValue
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/expressions/calls-closures.ts::tryExternClassMethodOnAny
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/array-methods.ts::emitDynViewMethodTwoArm
  - src/codegen/array-methods.ts::emitDynViewSpeciesMethodTwoArm
  - src/codegen/hof-native.ts::ensureNativeArrayHof
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
  - src/codegen/ta-dyn-mop.ts::buildStringKeyArm
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  # 2026-09-01 r2 implementation — the `$__ta_ctor` metadata fill gains the
  # §23.2.6.2 `prototype` get_meta + gOPD arm pair (one splice ladder over one
  # native, so the arms belong in it rather than in a parallel filler).
  - src/codegen/ta-ctor-meta.ts::fillTaCtorGetMetaArm
---

# #5194 — typedarray r2: cluster and fix the 461 residual failures

## Problem

State after the 2026-08-29 session (wave 1 #5138 via PR #5179, second pass +49
via PR #5213, IterRec delegation + #1058 fix-forward #5188 via PR #5244),
measured on the #5244 tree (#5188 Results table): the 540-entry re-verified
target list `wp-typedarray-current-fails` stands at **58 pass / 461 fail /
21 compile_error**. Before #5188 the whole list was opaque (534/540 compile
errors); the residuals are now visible as ordinary conformance gaps and have
NOT yet been clustered.

Known residual defects recorded by the #5188 implementer (its Follow-ups):

- The delegation adopt-arm covers the canonical `$Vec` carrier only, not the
  vec-family carriers — part of the ~500-test TypedArray ctor-arg factory
  lever is still gated.
- Object-literal computed `@@iterator` delegation
  (`{ [Symbol.iterator]: function () { return src[Symbol.iterator](); } }`)
  still throws — different lowering from the post-hoc assignment form.
- Symbol-keyed method calls on plain objects return `undefined`
  (`obj[Symbol.iterator] = fn; obj[Symbol.iterator]()`).

## Implementation Plan

### 2026-08-30 current-main measurement and first implementation slice

The planning prerequisite is now satisfied for the first bounded r2 slice.
The measurement used exact upstream `main`
`4881206ab3001505fcfca875589aff8daf375ff9`, the force-refreshed standalone
artifact SHA-256
`d3341cf6b6dbcc237f18f1461dc97dcddf1f2cbbfb944496d7ae73e8489adb87`,
and host artifact SHA-256
`60838ffbf433a6e3541fdbf300d21e3a781aefa13a3e80471139db6919a13dd0`.
Classification used `scripts/generate-editions.ts::classifyEdition`, not a
directory-name approximation.

- The ES2015 `%TypedArray%.prototype` host-pass/standalone-nonpass population
  is 252 rows.
- Exactly 25 of those rows are under
  `test/built-ins/TypedArray/prototype/set/`.
- Five representative rows were re-run through
  `scripts/harness-flip-probe.ts` on the exact main tree: standalone 0/5 and
  host 5/5. The probe's must-pass/must-fail controls both behaved correctly.
- Every measured failure reaches the first `makeArray` factory after the
  passthrough factory, reported as `Float64Array and makeArray`. This localizes
  the shared boundary to the array-returning constructor-argument carrier plus
  `%TypedArray%.prototype.set`; it is not a missing constructor registration.

The 25 rows divide into four implementation obligations:

1. **Receiver/source carrier preservation and mutation (5 rows).** Ordinary
   and typed-array sources leave the destination unchanged or copy through the
   wrong numeric width after `new TA(makeCtorArg(...))`. Trace the dynamic
   constructor result through the bound `makeArray` call, the TypedArray
   constructor arm, and `compileTypedArraySet` in
   `src/codegen/array-methods.ts`. Preserve the actual backing length and
   element kind. Same-buffer copies must snapshot overlapping input before
   mutation; different-kind copies must use the destination element codec.
2. **Spec-ordered offset coercion and bounds (10 rows).** Replace the current
   direct `f64` compile plus `i32.trunc_sat_f64_s` in
   `compileTypedArraySet` with the shared observable ToNumber/ToInteger path.
   Symbol and abrupt `valueOf`/`toString` completions must propagate, negative
   offsets and `offset + sourceLength > targetLength` must throw a catchable
   `RangeError`, and the source must not be read before those checks complete.
3. **Array-like source observation and element conversion (9 rows).** Preserve
   observable `length` and indexed `Get` order, do not cache source values, and
   route every element through the destination TypedArray conversion. Symbol
   values and abrupt getters/conversions must throw the original catchable
   exception. Reuse the established coercion/error helpers rather than adding
   ad-hoc checker queries or raw traps.
4. **Canonical `undefined` result (1 row).** Expression-position `.set(...)`
   currently exposes wasm null. Return the repository's canonical undefined
   extern carrier while retaining the statement-position void fast path.

### Implementation sequence for slice A

1. Add `tests/issue-5194-es2015-typedarray-set-r2.test.ts` with the exact 25
   ES2015 paths, a standalone acceptance loop, host regression controls, and
   minimal semantic probes for makeArray construction, overlapping copy,
   abrupt ordering, Symbol coercion, and return identity.
2. Fix the constructor/carrier boundary first and re-run the 25-row cohort.
   Record which rows remain so later coercion work is measured rather than
   inferred.
3. Implement the offset/source/element semantic obligations in spec order,
   using `src/codegen/typed-array-set-bounds.ts` for the final catchable bounds
   decision and shared coercion helpers for observable conversions.
4. Materialize canonical undefined for value-producing `.set` calls and prove
   that statement-position calls remain stack-balanced.
5. Run the exact 25 standalone rows, the same host rows, adjacent already-green
   TypedArray set controls, TS5/TS7, formatting/lint, issue integrity, LOC and
   function budgets, oracle/coercion ratchets, numeric-local parity, and the
   complete pre-push hooks.

#### Slice-A budget rationale

The three change-set allowances are intentional and bounded. The native
`ensureTaDynSetHelper` allowance covers the complete standalone set protocol
(receiver validation, spec-ordered offset/source observation, typed-array
snapshot/copy, and canonical `undefined`); the small
`compileReceiverMethodCall` allowance covers its native dispatch, ordered
argument capture, and extra-argument forwarding. The
`emitTaDynCtorConstructFromLocals` allowance covers the ten-line carrier-arm
adjustment that keeps erased constructor values peeled before selecting the
array-like, vector, or shared-buffer arm. The
`tryCompileBuiltinGlobalNew` allowance covers the erased one- and
multi-argument constructor-carrier dispatch needed to preserve the 25-row
`makeCtorArg` initial values and shared-buffer windows. The file-level allowance
for `dataview-native.ts` additionally covers the dynamic constructor carrier
copy and tag-aware erased-element bridge. A later r2 slice may extract shared
constructor coercion/liveness helpers and retire these allowances; this slice
keeps them scoped to the three owned functions/files rather than changing
global baselines.

### 2026-08-30 historical static handoff (validation was pending)

The unpublished local merge `9f56dedb6b` was removed before delivery. The
working branch is now based directly on the authoritative fetched
`upstream/main` at `a62aacba5ccc154f6fc378235aaaeeb4a7204231`, with the
current-main refactor retained and the slice-A implementation restored in the
working tree. No replacement commit has been made yet.

Current uncommitted owned files are:

- `src/codegen/dataview-native.ts` — the native dynamic-set helper plus the
  `$AnyValue`-aware constructor-carrier copy and detached-body liveness repair;
- `src/codegen/expressions/call-receiver-method.ts` — dynamic `.set` dispatch,
  ordered argument capture, and extra-argument evaluation;
- `src/codegen/expressions/new-builtin-globals.ts` — erased typed-array
  constructor-carrier and windowed-buffer dispatch;
- `tests/issue-5194-es2015-typedarray-set-r2.test.ts` — anchored, existence-
  guarded exact 25-row host/standalone suite and focused controls; and
- this issue file, including the bounded allowance rationale.

The census currently owns both test workers, so exact-row, focused-control,
compile, probe, and typecheck evidence after the `a62aac…` sync is pending.
No commit, push, or PR action is authorized until the census releases and the
post-sync validation is rerun.

### 2026-08-30 validation checkpoint (before the standalone fix)

The first post-sync validation was run in the isolated worktree with exactly
one compiler/test worker. The focused suite measured the complete owned cohort
without extrapolation:

- host exact cohort: **25/25 pass**;
- standalone exact cohort: **14/25 pass, 11/25 fail, 0 compile errors, 0
  timeouts**;
- focused controls: the standalone dynamic-constructor carrier control passed;
  the bound Test262-style constructor-factory probe (passthrough, array,
  array-like, and ArrayBuffer factories across all nine numeric constructors)
  returned code `0` in both host and standalone;
- the 11 standalone failures were runtime `fail` results in the set/offset
  behavior, not missing constructor registrations. The observed signatures
  were:

  - `built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js` —
    `fail`, `Test262Error: the empty string (Testing with Float64Array and
    makeArray.)`;
  - `built-ins/TypedArray/prototype/set/array-arg-primitive-toobject.js` —
    `fail`, `Test262Error: Actual [0, 6, 7, 8, 0] and expected [1, 6, 7, 8,
    5] should have the same contents. string (Testing with Float64Array and
    makeArray.)`;
  - `built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-src-get-value.js` —
    `fail`, `Test262Error: values are set until exception (Testing with
    Float64Array and makeArray.)`;
  - `built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-src-tonumber-value-symbol.js` —
    `fail`, `Test262Error: values are set until exception (Testing with
    Float64Array and makeArray.)`;
  - `built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-src-tonumber-value.js` —
    `fail`, `Test262Error: values are set until exception (Testing with
    Float64Array and makeArray.)`;
  - `built-ins/TypedArray/prototype/set/array-arg-set-values.js` —
    `fail`, `Test262Error: offset: 0, result: 42,43,0,0 (Testing with
    Float64Array and makeArray.)`;
  - `built-ins/TypedArray/prototype/set/typedarray-arg-offset-tointeger.js` —
    `fail`, `Test262Error: the empty string (Testing with Float64Array and
    makeArray.)`;
  - `built-ins/TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-other-type.js` —
    `fail`, `Test262Error: offset: 0, result: 42,43,0,0 (Testing with
    Float64Array and makeArray.)`;
  - `built-ins/TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-same-type.js` —
    `fail`, `Test262Error: offset: 1, result: 0,0,0,0 (Testing with
    Float64Array and makeArray.)`;
  - `built-ins/TypedArray/prototype/set/typedarray-arg-set-values-same-buffer-other-type.js` —
    `fail`, `Test262Error: 5.483722033e-315,42,0,0,0,0,0,0 (Testing with
    Float64Array and makeArray.)`;
  - `built-ins/TypedArray/prototype/set/typedarray-arg-set-values-same-buffer-same-type.js` —
    `fail`, `Test262Error: offset: 0, result: 0,0,0,0 (Testing with
    Float64Array and makeArray.)`.

The reproducing exact-cohort command was:

```sh
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 \
VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 \
PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
node node_modules/vitest/dist/cli.js run tests/issue-5194-es2015-typedarray-set-r2.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

The per-row error signatures above were captured with the same one-worker
runner using `runTest262File(absPath, "probe", 120000, "standalone")`; the
standalone artifacts reported these short SHA-256 prefixes, in list order:
`969b8b4bcb7e`, `bafc09e24ae6`, `ef0e58cc0ed6`, `9dfab4a8726d`,
`1acd1cff93fc`, `39b3cf125179`, `32bfebe5a8bf`, `f9ddae3286cc`,
`dd9ec6f8fc5c`, `e76df7a85815`, and `9cfbdd71264b`.

The probe was intentionally run before any broader TS/lint/budget sweep. The
remaining failures were localized to standalone dynamic `.set` source/offset
semantics; the now-green dynamic constructor-carrier behavior is retained.

### 2026-08-30 final focused validation

After the dynamic source-length dispatch, ToInteger offset conversion, static
constructor-carrier capability mark, erased multi-argument constructor
forwarding, and oracle-query cleanup, the same exact one-worker suite completed
in **226.31s**.
The final exact cohort was fully green in both lanes:

- host exact: **25/25 pass, 0 fail, 0 compile errors, 0 timeouts**;
- standalone exact: **25/25 pass, 0 fail, 0 compile errors, 0 timeouts**;
- exact residual names: **none**.

The command was:

```sh
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 \
VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 \
PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
node node_modules/vitest/dist/cli.js run tests/issue-5194-es2015-typedarray-set-r2.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

The focused controls were run separately with the same one-worker settings in
16.24s. All five standalone controls passed. Four of five host controls passed;
the only host limitation is the mixed `$AnyValue` constructor control, which
throws `TypeError: Cannot convert object to primitive value` at
`src/runtime.ts:14855` (`Reflect.construct`) before the constructor reaches the
slice-A implementation. The dynamic constructor-carrier, array-like/string,
same-buffer/different-kind, abrupt-order, offset-Symbol, and canonical-undefined
controls otherwise pass in both lanes. This is host-runtime infrastructure
noise, not an exact-row failure, and is retained as a limitation rather than
masked by a test exemption.

The exact input list is `/private/tmp/5194-owned25.txt` (SHA-256
`a6e7a5c333c9a46f3ee2bbaf34aa19f68345db0813e311993ac76cd555edf818`). The
host row status capture is `/private/tmp/5194-owned25-host-post.tsv` (SHA-256
`45f34835ec8e3ec64a5da8739e0c80085cc686b672aee0e49bf637c847906063`), and the
final aggregate evidence capture is
`/private/tmp/5194-exact25-final-20260830.json` (SHA-256
`0989b2a876f7188a8f46c8d9ddf7e736bef19f5fc0eff47a32852bf2eb94ed48`). The
focused source is `tests/issue-5194-es2015-typedarray-set-r2.test.ts` (SHA-256
`6aeb3aa02422df0669c5485d246212ea08dfdd827ed82dbde8ea546f61b4fd82`). The
Vitest runner does not persist a per-row JSONL artifact for this suite; the
retained aggregate records the final counts and the raw host TSV independently
records all 25 host rows.

The adjacent controls were then run in one single-fork process with the same
worker limits:

```sh
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 \
VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 \
PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/private/tmp/js2-es2015-typedarray-set-r2-20260830/node_modules/.bin:$PATH \
node node_modules/vitest/dist/cli.js run \
  tests/issue-3054-b3-writethrough.test.ts \
  tests/issue-5137-es2015-dataview-setter-undefined-carrier.test.ts \
  tests/issue-1787-packed-typedarray-semantics.test.ts \
  tests/issue-2593-typedarray-intwidth.test.ts \
  tests/typed-array-basic.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

The run completed in 165.75s with **76 passed and 11 failed tests** across five
files. The #5137, #3054, #2593, and #1787 controls all passed (36 + 13 + 18 +
9 = 76). The 11 failures were explicitly observed in this adjacent-control
run and are confined to `tests/typed-array-basic.test.ts`; all have the same
harness error:
`WebAssembly.instantiate(): Import #0 "string_constants": module is not an
object or function`. This occurs before those controls execute and is retained
as an observed harness limitation, not claimed as a baseline until the
publication lane reproduces it on clean current `main`; it is not an exact-row
or #5194 regression.

### 2026-08-30 proportionate gates

The static and focused gates were run after the final exact rerun, with the
same one-worker environment where a compiler/test process was involved:

- TypeScript 5 `node node_modules/typescript/lib/tsc.js --noEmit`: pass;
- TypeScript 7 `node node_modules/typescript7/lib/tsc.js --noEmit -p
  tsconfig.ts7.json`: pass;
- Prettier `--check 'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'`: pass;
- Biome targeted lint on the four changed source/test files: pass;
- LOC and function budgets: pass, including the explicit
  `emitTaDynCtorConstructFromLocals` +10 allowance;
- oracle, coercion-site, pushraw, stack-balance, any-box-sites, codegen
  fallback, hard-error, host-import, and IR-kind-neutrality ratchets: pass;
- numeric-local parity: **18/18 pass**;
- duplicate-ID, committed issue-integrity, issue-spec-coverage, done-status,
  and `update-issues --check`: pass (issue-spec-coverage emitted only unrelated
  ready-issue warnings);
- serial differential corpus: **113/120 match**, 0 new regressions against
  the 99/104 baseline, 2 improvements; report artifact
  `benchmarks/results/diff-test.json` has SHA-256
  `e75d47721ca058fcfd56789d3cc9364b0dcc2843ea3807766b6dd4ca4a93ff79`.

The merged-issue-integrity helper could not create its temporary merge-tree file
in this restricted worktree, so that check must be rerun by the publication
lane on a clean current-main transplant. This is an environment limitation,
not a source verdict.

The focused test now uses erased/dynamic constructor carriers for its
same-buffer and different-kind control, matching the owned boundary exercised by
the exact `makeCtorArg` rows. Direct statically typed vector receivers remain a
separate pre-existing codegen gap and are not claimed by this slice. The
constructor boundary also required `new-builtin-globals.ts`, so that file and
`tryCompileBuiltinGlobalNew` are explicitly added to the bounded allowance
metadata above.

The following paragraph records the historical pre-publication state; it is
superseded by the clean publication replay below. No broad Test262
residual-list sweep was run in that worktree. The serial
120-program differential check above is the only broader behavioral gate. The
branch remains dirty and based on `a62aacba5ccc154f6fc378235aaaeeb4a7204231`;
current upstream `main` is `c882d1b110` (including #5290 at `4b715bada1`). A
clean current-main transplant followed by exact25, controls, and proportionate
gate revalidation is required before publication. No commit, push, rebase, or
PR action was performed here.

### 2026-08-30 clean current-main publication replay

The clean publication worktree is
`/private/tmp/js2-typedarray-5194-pr-20260830`, branch
`codex/5194-typedarray-set-r2-final`. It was created directly from fetched
upstream `main` at `b916fae2a360988cbe9f26c090ddcd9158d461d4`; the Luna Max
checkpoint replayed without conflict as `959ac678627e8d2f096ea4e082f287a46d1ab912`.

Before replaying the implementation, the publication lane ran
`tests/typed-array-basic.test.ts` on pristine `b916fae2a3` with one worker.
All 11 tests failed with the identical pre-existing harness error
`WebAssembly.instantiate(): Import #0 "string_constants": module is not an
object or function`. This proves the same 11 failures observed in the adjacent
checkpoint are a current-main baseline rather than a #5194 regression.

After replay, an exact-row-only run completed in 206.87s with **50/50 pass**:
25/25 host and 25/25 standalone, with zero row failures, compile errors,
timeouts, or skips. The unfiltered focused file completed 59/60; its sole
failure was the broader host mixed-`$AnyValue` constructor probe already
documented above. It exercises generic host `Reflect.construct` marshalling,
not the standalone native carrier selected by this slice, and every exact host
row remains green.

The final test-harness plan is deliberately scope-accurate and was recorded
before the edit:

1. Give each focused control an explicit lane list. Keep the four parity
   controls in host and standalone, and run the mixed-`$AnyValue` constructor
   probe in standalone only, where it exercises the owned native carrier.
2. Do not add a skip, xfail, conditional assertion, or weaker expectation.
   The complete focused file must exit green, while this issue continues to
   state the observed 4/5 host-control limitation explicitly.
3. Re-run the full focused file, the exact 25-row host/standalone cohort, the
   four adjacent green TypedArray suites, and the `typed-array-basic` baseline
   comparison before normal repository gates and publication.

The lane-scoped test edit then completed the full focused file in 230.75s with
**59/59 pass**. That result contains all 50 exact Test262 classifications plus
nine focused controls; no test in the file is skipped. The adjacent one-worker
rerun completed in 98.94s with **76 pass and 11 fail** across five files. All
76 assertions in #5137, #3054, #2593, and #1787 passed. The only failures were
the same 11 `typed-array-basic.test.ts` cases with the same `string_constants`
instantiation error reproduced on pristine `b916fae2a3`; there were no new
failures or changed signatures.

An independent Luna Max static review of `959ac67862` found no source-code
publication blocker: the dynamic constructor/set paths remain gated to the
standalone, erased-carrier boundary; offset/source ordering, string handling,
snapshot copying, and target validation remain bounded; no debug, fallback
host-import, or target-name markers were introduced. The review requested the
historical/current handoff clarification recorded in this section and the
scope-accurate control-lane metadata now validated above.

Publication gates on the clean replay are green:

- TypeScript 5 and TypeScript 7 no-emit checks passed;
- full Biome lint and full Prettier check passed;
- LOC and function budgets passed with only the explicit #5194 allowances;
- oracle, coercion-site, pushRaw, any-box, IR-kind-neutrality, host-import,
  stack-balance, codegen-fallback, Test262 hard-error, and verdict-oracle
  ratchets passed;
- numeric-local parity passed **18/18**;
- duplicate-ID, issue integrity, issue-spec coverage, and done-status checks
  passed (the coverage command reported only unrelated pre-existing warnings).

The two TypeScript-based ratchets were invoked through
`node --import tsx` after the sandbox rejected the `tsx` CLI's local IPC socket;
the underlying stack-balance and codegen-fallback scripts both completed with
their normal zero-growth verdicts.

No GitHub issue was created; this markdown issue remains the sole tracker.

### Slice A completion and handoff

The publication slice is owned in isolated worktree
`/private/tmp/js2-typedarray-5194-pr-20260830` on branch
`codex/5194-typedarray-set-r2-final`. It may open one non-draft upstream PR only
when the branch is mergeable and the exact 25-row standalone cohort plus
regression controls are green. If interrupted or still non-mergeable, push the
checkpoint, record the precise remaining rows and root cause here, and use a
draft PR.

The completed slice was published as non-draft upstream PR
[#5300](https://github.com/loopdive/js2/pull/5300) from
`ttraenkler:codex/5194-typedarray-set-r2-final` into `loopdive/js2:main`.
The exact remotely verified pre-back-reference checkpoint was
`28f510eda5dcd8a47a9102257aa752699b3fbccd`; GitHub reported that head
mergeable, with the PR blocked only while required checks were pending. This
PR-number back-reference is the sole planned publication follow-up on the
head. A dedicated Luna Max shepherd owns verification of the final pushed SHA,
the required body and CLA format, conflicts, checks, and the one-shot merge
queue handoff. No GitHub issue was created.

Completing slice A does not close the r2 umbrella: update the measured residual
count here and keep this issue `in-progress` until the remaining TypedArray
clusters satisfy the umbrella acceptance criteria.

### Remaining r2 plan

- Step 0 — regenerate the residual list on current main. `.tmp/` lists are
  gitignored and absent in fresh clones: re-run the standalone probe
  (`runTest262File(abs, cat, 20000, "standalone")` per
  `tests/test262-runner.ts`) over `built-ins/TypedArray*` and record
  pass/fail/CE. Fresh worktrees need the `.test262-cache` symlink or
  quickjs-tier tests fail spuriously.
- Step 1 — cluster the failures by error signature into file:function root
  causes; write the cluster table INTO this file as the implementation plan
  (start from the three known defects above).
- Step 2 — implement per cluster (Luna Max implementer, isolated worktree),
  re-probe the list, spot-check lists stay green.
- Step 3 — five ratchet gates + equivalence gate per repo protocol.

## Acceptance criteria

- Cluster table with measured counts lands in this file before implementation.
- Slice A: all 25 ES2015 `%TypedArray%.prototype.set` host-pass/standalone-
  nonpass rows pass standalone and remain green in host mode, with zero loss in
  adjacent previously-passing set controls.
- Net gain ≥ +150 on the regenerated typedarray residual list; compile_error
  count ≤ 10.
- Spot-check lists green; equivalence gate green; ratchet gates green.

## References

- #5138 (wave-1 plan + cluster method), #5188 (IterRec delegation + #1058
  fix-forward; Results table is the baseline for this issue).
- PRs: #5179, #5213, #5244.

## 2026-09-01 r2 residual plan (post-#5300/#5385)

Planning pass requested by the "Remaining r2 plan" above. Slice A (#5300) and
the species identity fix (#5385) are on `main`; this section clusters what is
left and is the implementation plan for the next Opus slices. Everything below
was measured on HEAD `0d9bfedee` (an ancestor-of-`main` tree that already
contains #5300 and #5385), standalone target, via
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/typedarray-head.txt --standalone`.

### Step 0 — HEAD re-verification

Input: the 300-path baseline list `.tmp/es2015/typedarray-paths.txt`
(loopdive/js2wasm-baselines standalone lane at compiler sha `d39779cb`,
2026-09-01). One entry is `harness/testTypedArray.js` (a harness file, not a
test), so the measurable list is **299 rows**. Result on HEAD, in-process:

| status | rows | notes |
|---|---:|---|
| pass | **0** | nothing to drop — every baseline row still fails |
| fail | 271 | includes 10 rows whose only local error is the QuickJS artifact-key gap (see below) |
| compile_error | 28 | 12 genuine (6 `Reflect.construct` #3371, 6 `Reflect.set` #2046 — out of scope); **16 are `compilation timeout`** |

- The 16 compile timeouts (`.tmp/es2015/typedarray-head-rerun.txt`) are all
  `$DETACHBUFFER`-shaped files plus `sort/sort-tonumber.js`. A serial re-run
  timed 15 of them out AGAIN at 17–41 s (box load 10–20 from five concurrent
  lanes). They are the "shared detached-buffer compile path" pathology #4449
  recorded on 2026-08-30; CI's baseline records every one of them as a plain
  `fail`, so they are counted as measurement failures here, not as CEs.
  Re-measure them serially on an idle box (`--isolate`, 120 s) before claiming
  a flip.
- 10 rows report `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not
  built (missing …quickjs-eval-adapter-d4799bda84cfed0d.wasm)`: the local
  cache holds adapter key `91c37131ffaf8e42`, so `$262.detachArrayBuffer` is
  unavailable locally. Their real verdicts (from
  `.tmp/es2015/typedarray-errors.tsv`) are ordinary `fail`s of cluster E/I
  below; validate them through CI or after rebuilding the artifact
  (`scripts/quickjs-artifact/build.sh`, #4238).
- Two signatures that dominated the baseline are GONE on HEAD: the 25
  `env::Uint8ClampedArray_{sort,keys,values,entries}` host-import leaks now
  compile (they fail on semantics instead — clusters C1/C2), and 9 of the 27
  `Object.prototype.toString is not yet implemented` rows moved to other
  formatters. The remaining 18 toString-refusal rows are all the assertion
  FORMATTER on a failed prototype-identity compare (#4119's 2026-09-01 finding:
  the classifier is not the defect; the identity is) — they belong to cluster A.
- Direct probe `.tmp/es2015/probes5194/d1-identity.js` (run with
  `npx tsx .tmp/es2015/probe-direct.mts <file>`, which bypasses the runner's
  compile deadline; returns a bit mask) gave `1463` =
  P1 `getPrototypeOf(new Uint8Array(0)) !== Uint8Array.prototype`,
  P2/P3 `getPrototypeOf(Uint8Array.prototype)` is **null**,
  P5 `Uint8Array.prototype.BYTES_PER_ELEMENT !== 1`,
  P6 `Uint8Array.prototype.hasOwnProperty("forEach")` is **true**,
  P8 `%TypedArray%.prototype.constructor !== %TypedArray%`,
  P15 `getPrototypeOf(new Float64Array([42,43])) !== Float64Array.prototype`.
  Passing: P4 `Uint8Array.prototype.constructor === Uint8Array`,
  P7 `%TypedArray%.prototype` owns `forEach`, P16 `instanceof`.
- Measurement trap re-confirmed: the harness `(Testing with Float64Array and
  makeArray.)` suffix names the FIRST ctor and a broken factory `.name`; do not
  cluster by it (#5138 trap 1). The runner's in-process standalone compile
  deadline is ~15 s regardless of the `timeoutMs` argument, so under load use
  `probe-direct.mts` for probes and `--isolate` for lists.

### Cluster table (299 rows, HEAD, root cause — not error string)

Sub-lists: `.tmp/es2015/ta-cl-<X>.txt` (every row is in exactly one list;
`K-out-of-scope` holds the 13 owned-elsewhere rows).

| # | cluster | count | root cause (file:function) | sample tests |
|---|---|---:|---|---|
| A | Per-kind prototype graph: `<TA>.prototype` is a `$NativeProto` with `$parent = null`, a member CSV that claims all 30 methods as OWN, no `BYTES_PER_ELEMENT`, no `constructor` companion entry; `Object.getPrototypeOf(<static view>)` has no compile-time arm | 63 | `src/codegen/array-object-proto.ts:makeTypedArrayGlue` (L2225, memberCsv = `TYPED_ARRAY_PROTO_METHODS` for concrete views too), `native-proto.ts:buildLazyNativeProtoGetInstrs` (L289 `$parent` = null "chain walk deferred"), `native-proto-own-props.ts:registerNativeProtoHasOwn` (CSV ladder answers own), `builtin-proto-constructor.ts:hasBuiltinProtoConstructorCarrier` (L85: no TA names → no `constructor` seed → gOPD null-deref at `verifyNotEnumerable`), `expressions/object-get-prototype-of.ts:tryCompileEs5GetPrototypeOfValue` (L253: no TypedArray-typed arm), `object-runtime.ts:prependBuiltinFnObjectSemantics` (L11963: `__getPrototypeOf` has no `$NativeProto → $parent` arm) | `TypedArrayConstructors/prototype/forEach/inherited.js` (+27 siblings), `Uint8Array/prototype.js`, `Uint8Array/prototype/proto.js`, `Uint8Array/prototype/constructor.js`, `Float64Array/prototype/BYTES_PER_ELEMENT.js` |
| B | `%TypedArray%` intrinsic surface: the ctor is a bare `$Object` with only `prototype` (no own `name`/`length`/`from`/`of`/`@@species`, not throwing when called); its prototype glue lacks the `@@toStringTag` accessor, `constructor`, `@@iterator` identity; gOPD's alias resolver declines the harness var | 31 | `array-object-proto.ts:emitTypedArrayIntrinsicCtorObject` (L2753–2820), `builtin-static-gopd.ts:SPECIES_OWNER_CTORS` (L376, `%TypedArray%` deliberately absent), `expressions/call-builtin-static.ts:compileBuiltinStaticCall` (L3158 species gOPD via `resolveBuiltinReceiverName`, L3053 `tracesToTypedArrayIntrinsicProto`), `array-object-proto.ts:emitTypedArrayProtoMemberBody` (L1716 — only 3 getters have bodies) | `TypedArray/Symbol.species/result.js`, `TypedArray/prototype/Symbol.toStringTag/prop-desc.js`, `TypedArray/from/prop-desc.js`, `TypedArray/invoked.js`, `TypedArray/prototype/constructor.js`, `TypedArray/prototype/length/invoked-as-accessor.js` |
| C1 | `sort` on a dyn-view `any` receiver never runs (comparefn not called, elements untouched, returns a different object) — no `__ta_dyn_sort` helper; `sort` is not in `DYN_VIEW_READ_METHODS` (TA default comparator is numeric) | 11 | `expressions/call-receiver-method.ts:compileReceiverMethodCall` (L3939–3946 dyn-view mutator two-arm: `set`/`fill`/`copyWithin`/`reverse` only), `dataview-native.ts:ensureTaDynReverseHelper` (L7468 — the shape to clone), `array-methods.ts:compileArraySort` (L8523) | `sort/comparefn-calls.js`, `sort/sorted-values.js`, `sort/return-same-instance.js`, `sort/comparefn-nonfunction-call-throws.js` |
| C2 | `keys()`/`values()`/`entries()` on a dyn view return a value with no callable `next` and null prototype | 6 | same dispatch site as C1; `array-methods.ts:compileArrayIteratorMethod` (L2941) has no `$__ta_dyn_view` receiver arm; `iterator-native.ts` `$IterRec{VEC,…}` needs a materialized vec | `keys/return-itor.js`, `entries/return-itor.js`, `values/iter-prototype.js` |
| C3 | `includes`/`indexOf`/`lastIndexOf` on dyn views: boolean result boxed as number (`«0»`/`«1»`), 0-arg call answers `0`, `fromIndex` ToInteger (−0, object, string, Symbol → TypeError, abrupt) not observed, `length` read through the internal ArrayLength | 22 | `array-methods.ts:shouldWrapDynViewTwoArm` (L1416: requires ≥1 arg → 0-arg falls to `closed-method-dispatch.ts:fillClosedMethodDispatch` L1055 `VEC_SEARCH_METHODS` arm, which reads the raw `$__vec_base` byte vec), `emitDynViewMethodTwoArm` (L1759, `BOOLEAN_RESULT_METHODS` boxing not reaching the ELSE arm), `compileArrayIncludes` (L3542) / `compileArrayIndexOf` (L3316) / `compileArrayLastIndexOf` (L9745) fromIndex path uses `__unbox_number` directly (#5138 follow-up 2) | `includes/samevaluezero.js`, `indexOf/no-arg.js`, `lastIndexOf/tointeger-fromindex.js`, `includes/return-abrupt-tointeger-fromindex-symbol.js` |
| C4 | `join`/`toLocaleString` on dyn views: Symbol/object separator reaches `__str_flatten` uncast (illegal cast); per-element `toLocaleString`/`toString`/`valueOf` invocation on `Number.prototype` overrides not observed; abrupt completions swallowed | 13 | `array-methods.ts:compileArrayMethodCall` `case "toLocaleString"`/`"join"` (L2330–2340) on the two-arm materialized `$__vec_f64`; `expressions/calls-closures.ts:tryExternClassMethodOnAny` (L2528 `join` decline) | `join/return-abrupt-from-separator-symbol.js`, `toLocaleString/calls-tolocalestring-from-each-value.js` |
| C5 | `TypedArray.prototype.<m>()` invoked on the prototype object itself must throw TypeError; the call on a `$NativeProto` receiver falls through the closed dispatcher and returns undefined (`subarray` already throws — it reaches the seeded refusal closure; `slice`/`sort`/`keys`/… do not) | 9 | `closed-method-dispatch.ts:fillClosedMethodDispatch` (L719: no `$NativeProto` receiver arm → companion closure call), `array-methods.ts:compileArrayMethodCall` (slice/join/… lower a `$NativeProto` receiver as an array) | `slice/invoked-as-method.js`, `sort/invoked-as-method.js`, `keys/invoked-as-method.js` |
| D | Callback HOFs on dyn views: no IsCallable check before the loop; `reduce` on empty view without initialValue does not throw; callback's 3rd argument is the materialized `$__vec_f64` copy, not the view (`results[0][2] - this`); writes to the view during iteration invisible (snapshot copy); `filter` with all-false callback null-derefs in `__any_unbox_bool` | 16 | `hof-native.ts:ensureNativeArrayHof` (L83: no callable guard, passes `recv` = materialized vec), `ta-hof-map-filter.ts` map/filter loop, `array-methods.ts:emitDynViewMethodTwoArm` (L1805 materializes before the loop) | `every/callbackfn-not-callable-throws.js`, `reduce/empty-instance-with-no-initialvalue-throws.js`, `map/callbackfn-arguments-with-thisarg.js`, `filter/callbackfn-set-value-during-iteration.js`, `filter/result-empty-callbackfn-returns-false.js` |
| E | ValidateTypedArray on entry + detach-during-coercion/callback: detached view silently no-ops for every/find/findIndex/forEach/includes/keys/values/entries/sort/fill/copyWithin/…; detach inside `valueOf`/callback must throw or yield `undefined` per method | 33 | `dataview-native.ts:emitTaDynViewValidate` (L8117 — exists, only wired into the #3058 two-arm and #4449 `emitTaViewValidate` sites), `dataview-native.ts:ensureTaDynFillHelper` (L6391 coerces before re-checking detach), `hof-native.ts` loop (no per-iteration detach re-check) | `every/detached-buffer.js`, `fill/coerced-end-detach.js`, `some/callbackfn-detachbuffer.js`, `copyWithin/coerced-values-start-detached.js` |
| F | Species residual after #5385: `get-ctor-inherited` (prototype `constructor` getter must be observed exactly once and result must read `undefined`), `get-{ctor,species}-returns-throws` (non-constructor → TypeError), `custom-ctor-invocation` (`this` inside the `@@species` getter and the custom ctor's argument tuple), `custom-ctor-returns-another-instance`, same-buffer offset, `subarray` result `instanceof TA` | 21 | `dataview-native.ts:emitTaDynSpeciesCreate` (L5848), `array-methods.ts:emitDynViewSpeciesMethodTwoArm` (L1482–1720), `ta-dyn-mop.ts` `constructorLookup` (L681–760) | `map/speciesctor-get-ctor-inherited.js`, `slice/speciesctor-get-species-returns-throws.js`, `subarray/speciesctor-get-species-custom-ctor-invocation.js`, `subarray/result-is-new-instance-from-same-ctor.js` |
| G | ToInteger/ToNumber of index arguments: Symbol begin/end must throw TypeError (slice/subarray), `null` end coerces to 0 (fill/copyWithin), `set` must not read past the source length | 7 | `dataview-native.ts:ensureTaDynFillHelper` (L6391)/`ensureTaDynCopyWithinHelper` (L7282) `__nullish_to_null` normalisation treats `null` as absent; `array-methods.ts` slice/subarray begin/end via `__unbox_number` (#5138 follow-up 2); `ensureTaDynSetHelper` (L6655) source read loop | `fill/coerced-indexes.js`, `slice/return-abrupt-from-end-symbol.js`, `set/array-arg-set-values-in-order.js` |
| H | Constructor argument protocols: static TA source (`new TA(new Int8Array(10))`) → length 0 (plain-vec copy arms skip `i8_byte`/`i16_byte`), `@@iterator` GetMethod edge cases (null → array-like path but `instanceof` false; non-callable → TypeError; abrupt from `@@iterator`/`next` must propagate unwrapped), element ToNumber abrupt (`valueOf`/`toString`/`@@toPrimitive`), `length: 2**53` → RangeError (currently a trap), `ToIndex` of object `byteOffset`/`length` null-derefs in `__module_init` | 20 | `dataview-native.ts:emitTaDynCtorConstructFromLocals` (L5241; plain-vec arms L5617–5652 admit only `f64`/`i32`/`i32_elem`/`externref`; `$Object` arm L5404–5470; ArrayBuffer arm L5703+), `expressions/new-builtin-globals.ts:tryCompileBuiltinGlobalNew` (#5300 carrier dispatch) | `ctors/typedarray-arg/returns-new-instance.js`, `ctors/object-arg/iterator-is-null-as-array-like.js`, `ctors/object-arg/throws-setting-obj-valueof.js`, `ctors/buffer-arg/toindex-bytelength.js`, `ctors/object-arg/length-excessive-throws.js` |
| I | `%TypedArray%.from`/`.of` semantics: `mapfn` called with 3 args (spec: 2), `IsCallable(mapfn)` checked after `@@iterator` read, abrupt element conversion not propagated, iterator-protocol errors rewrapped as TypeError, `from`/`of` invoked as plain functions must throw, `TA.from.call(customCtor, src)` / `TA.of.call(...)` → "Cannot read properties of undefined (reading 'call')" (the static method has no VALUE read) | 21 | `expressions/call-receiver-method.ts:tryEmitTaStaticOfFrom` (L328), `iterator-native.ts` `__array_from_mapped` (L1006: routes through `__hof_map`, hence 3 args), `dataview-native.ts:ensureTaFromArrayLikeHelper` (L6202) | `TypedArrayConstructors/from/mapfn-arguments.js`, `TypedArrayConstructors/from/new-instance-using-custom-ctor.js`, `TypedArray/from/iter-next-error.js`, `TypedArrayConstructors/of/invoked-as-func.js` |
| J | Integer-indexed MOP residual: `Reflect.ownKeys(view)` lacks a `$__ta_dyn_view` arm in `__getOwnPropertyNames` (only `__object_keys` has one; expando keys never enumerated), `defineProperty` on the expando ignores the descriptor's attribute defaults (§10.1.6.3 absent fields default to false) and does not run `ToNumber(value)` for canonical index keys, `Reflect.has(view, "subarray")`/non-canonical inherited keys never walk the prototype, `Set` with a non-view receiver on the prototype chain | 13 | `ta-dyn-mop.ts:fillTaDynViewMopArms` (L341; `__object_keys` arm L957; `buildStringKeyArm` L532 `has` mode `missInstrs` returns 0 without a proto walk; `__defineProperty_value/_accessor` arms L1406–1520), `objvec-array-proto.ts:fillGopnVecArm` / `object-runtime.ts:fillClosedStructOwnPropertyNamesArms` (L9619 — the splice pattern for `__getOwnPropertyNames`) | `internals/OwnPropertyKeys/integer-indexes.js`, `internals/DefineOwnProperty/key-is-not-numeric-index.js`, `internals/HasProperty/inherited-property.js`, `internals/Set/key-is-valid-index-prototype-chain-set.js` |
| K | **Out of scope (owned elsewhere)** | 13 | see below | — |

In-scope total: **286 rows** (299 − 13).

#### Out of scope (owned elsewhere) — `ta-cl-K-out-of-scope.txt`

- `ctors/*/custom-proto-access-throws.js` ×5 + `typedarray-arg/throw-type-error-before-custom-proto-access.js`: `Reflect.construct` distinct-NewTarget CEs — **#3371**.
- `internals/Set/*reflect-set.js`, `*receiver-is-not-*`, `*receiver-is-proto.js` ×6: `Reflect.set` explicit receiver — **#2046**.
- `ctors/object-arg/as-generator-iterable-returns.js`: native generator carrier as ctor argument — **#680/#2864**.
- Not in this list but adjacent: ArrayBuffer/DataView rows are **#5150** (being implemented). The two `ctors/buffer-arg/toindex-*.js` rows stay HERE (they are TypedArray ctor `ToIndex` rows), but they touch the same ArrayBuffer-arm code as #5150's cluster F ("ta-windowed-view") — check `git log origin/main -- src/codegen/expressions/new-builtin-globals.ts` and #5150's Results before editing that arm. Anything needing `$262.createRealm` is out (none in this list).

### Implementation plan (ordered by yield; each step ships alone)

Common rules: Wasm-native arms only (the runner fails a standalone module that
emits ANY host import); type questions via `ctx.oracle`
(`src/checker/oracle.ts`), never raw `ctx.checker` (oracle-ratchet gate);
splice arms into existing natives per the `fillBuiltinFnMeta` discipline
(`ta-ctor-meta.ts` header) — never rebuild a helper body at finalize; every
throw-array gets its own `Instr[]` copy (#1058, #5188 follow-up 4). After each
step re-run `npx tsx scripts/run-test262-paths.mts .tmp/es2015/ta-cl-<X>.txt --standalone`
(add `--isolate` when a list contains `$DETACHBUFFER` rows) and
`.tmp/es2015/ta-controls.txt`.

#### Step 1 — cluster A: per-kind prototype graph (63 rows, expect ≥ 55)

1. **`$parent` link.** In `native-proto.ts:buildLazyNativeProtoGetInstrs`
   (L289) replace the constant `ref.null.extern` `$parent` with, for a glue that
   declares a `parentBrand`, the parent's own lazy singleton read
   (`buildLazyNativeProtoGetInstrs(ctx, parentBrand)` — it is idempotent and
   append-only; emit it BEFORE the `struct.new`). Add an optional
   `parentBrand?: number` to `NativeProtoBuiltinGlue` (L150 block) and set it in
   `array-object-proto.ts:makeTypedArrayGlue` for the 11 concrete views to
   `ensureTypedArrayIntrinsicNativeProtoGlue(ctx)` (already called at L2727).
   Then teach `__getPrototypeOf` about it: in
   `object-runtime.ts:prependBuiltinFnObjectSemantics` (L11963, where the
   `%Function.prototype%` arm is spliced) prepend a `ref.test $NativeProto` arm
   that returns `struct.get $parent` (field 3) — null falls through to today's
   behaviour, so non-TypedArray protos are byte-identical. Flips `proto.js` ×9.
2. **Own-member set.** Give concrete views an EMPTY `memberCsv` and move the
   methods to inheritance: `makeTypedArrayGlue(brand, viewName)` → memberCsv
   `""` when `viewName !== "%TypedArray%"`. Two readers must then follow
   `$parent` on a miss: (a) the syntactic value read
   `builtin-value-read.ts` L693–L830 (`Uint8Array.prototype.forEach`) — on a
   CSV miss for a glue with `parentBrand`, retry with the parent brand (the
   closure minted is the SAME `%TypedArray%.prototype` singleton, which is what
   `inherited.js` and the `gOPD(...).value === TypedArray.prototype.forEach`
   assertions need); (b) the dynamic companion walk
   `proto-index-store.ts:fillGetKBody` (L1107) / `fillHasKBody` (L1027): after
   the receiver-brand companion probe and before the `Object` companion,
   probe the parent brand's companion (read `$parent` off the `$NativeProto`,
   `__protoidx_brand_off` on it). `native-proto-own-props.ts:registerNativeProtoHasOwn`
   then answers `hasOwnProperty("forEach")` = 0 for concrete views for free
   (their CSV is empty). Flips `inherited.js` ×28.
3. **`constructor` + `BYTES_PER_ELEMENT` as OWN data properties of each
   concrete view prototype.** `builtin-proto-constructor.ts:hasBuiltinProtoConstructorCarrier`
   (L85): return true for the 9 wired view names and `%TypedArray%`;
   `emitBuiltinProtoConstructorValue` (L100): for a view name push the
   identity-stable `$__ta_ctor` singleton (`emitTaCtorValue` /
   `taCtorSingletonGlobals`, #3177 W1 — the same value the bare `Uint8Array`
   identifier reads, verified by probe P4), for `%TypedArray%` push
   `emitTypedArrayIntrinsicCtorObject`. The seeder
   (`native-proto.ts` L612 `pushCompanionConstructorSeed`) and the gOPD arm
   (`builtin-proto-constructor.ts:tryEmitBuiltinProtoConstructorDescriptor`
   L132) both key on that predicate, so `verifyProperty(TA.prototype,
   "constructor", {writable, !enumerable, configurable})` and
   `%TypedArray%.prototype.constructor === TypedArray` (probe P8) come with it.
   For `BYTES_PER_ELEMENT` extend `dataProps` (`native-proto.ts` L160) to accept
   a numeric value: `[key, string | number]`; the seeder (L687) pushes
   `__box_number` for a number with the §23.2.7.1 flags
   `{writable:false, enumerable:false, configurable:false}` (a new
   `PROTO_CONST_DEFINE_FLAGS`, not `PROTO_METHOD_DEFINE_FLAGS`), and the static
   read (`builtin-value-read.ts` L825) emits `f64.const` for a number. Flips
   `constructor.js` ×8, `BYTES_PER_ELEMENT.js` ×9.
4. **`Object.getPrototypeOf(<statically typed view>)`.** In
   `expressions/object-get-prototype-of.ts:tryCompileEs5GetPrototypeOfValue`
   (L253) add, before the `signatureOf` arm, a TypedArray-typed arm keyed on
   `ctx.oracle.declaredNameOf(arg0)` ∈ `TYPED_ARRAY_NAMES` (`index.ts` L736):
   compile+drop the argument and push `emitLazyNativeProtoGet(ctx, fctx,
   ensureTypedArrayViewNativeProtoGlue(ctx, name))`. Static carriers are
   ambiguous at runtime (`i8_byte` serves Int8/Uint8/Uint8Clamped, `f64` serves
   Float64Array AND `number[]`), so this MUST stay a compile-time arm; dyn views
   already resolve at runtime (`ta-dyn-mop.ts` L1039 arm). Flips `prototype.js`
   ×9 together with the `$__ta_ctor` `prototype` descriptor
   (`writable:false, enumerable:false, configurable:false` — extend the
   `__builtinfn_gopd` `$__ta_ctor` arm from #5138 cluster E in
   `ta-ctor-meta.ts:fillTaCtorGetMetaArm`).

Re-run `ta-cl-A-proto-graph.txt`. Do NOT touch `object-proto-tostring.ts` for
this cluster — once identity holds, the toString formatter is never reached.

#### Step 2 — cluster B: `%TypedArray%` intrinsic surface (31 rows, expect ≥ 22)

1. In `array-object-proto.ts:emitTypedArrayIntrinsicCtorObject` (L2776 init
   body) define, with `__defineProperty_value`/`_accessor` (never `__extern_set`,
   which cannot carry attributes): `name` = `"TypedArray"`, `length` = `0`
   (both `{writable:false, enumerable:false, configurable:true}`),
   `prototype` (all false), `from`/`of` = the static method closures used by
   `tryEmitTaStaticOfFrom` (mint them as `ensureBuiltinFnMetaType` closures
   with `name`/`length` = `from`/1, `of`/0 so `not-a-constructor.js`,
   `name.js`, `length.js`, `prop-desc.js` answer through the #2896 meta natives),
   and the `@@species` accessor from
   `builtin-fn-meta.ts:ensureStandaloneSpeciesGetterClosure(ctx, "%TypedArray%")`
   (L410). Add `"%TypedArray%"` to `builtin-static-gopd.ts:SPECIES_OWNER_CTORS`
   (L376) and, in `expressions/call-builtin-static.ts:compileBuiltinStaticCall`
   (L3158), resolve the receiver with `isTypedArrayIntrinsicCtorExpr`
   (`expressions/calls.ts` L1748 — export it) before `resolveBuiltinReceiverName`
   so the harness's `TypedArray` var reaches the species gOPD arm. Flips
   `Symbol.species/*` ×4, `from|of/*` ×10, `length.js`, `name.js`,
   `prototype.js`.
2. Make the carrier THROW when called: `pushMarkBuiltinCarrierCallable`
   (L2801) marks it callable; route the call through the closed-method
   dispatcher's callable arm to a native body that `emitThrowTypeError`s
   ("Abstract class TypedArray not directly constructable") — `invoked.js`.
3. `@@toStringTag` getter on `%TypedArray%.prototype`: add `"@@4"` (the
   well-known id table, `builtin-value-read.ts` L169) with kind `getter` to the
   INTRINSIC glue only (`TYPED_ARRAY_PROTO_METHODS` is shared — pass an extra
   member list to `makeTypedArrayGlue` for `%TypedArray%`), and give it a body
   in `emitTypedArrayProtoMemberBody` (L1716): `ref.test $__ta_dyn_view` →
   kind → name string (the exact switch the `__extern_get` dyn-view arm already
   emits at `ta-dyn-mop.ts` L770–790, factor it into a helper), static integer
   view carriers via `typedArrayViewBrandCandidates` (L1622), **anything else →
   `undefined`, never throw** (§23.2.3.34 step 3). Register the seeded symbol
   accessor so gOPD synthesizes `{get, set: undefined, enumerable:false,
   configurable:true}` (the `@@` sentinel path in the seeder, L640, and the
   gOPD arm at `call-builtin-static.ts` L3053 need a symbol-key twin of the
   literal-member path — mirror how `seededNativeProtoSymbolTagsByBrand`
   answers `hasOwn`). Meta `name` = `"get [Symbol.toStringTag]"`, `length` 0.
   Flips `Symbol.toStringTag/*` ×6.
4. `%TypedArray%.prototype[Symbol.iterator] === %TypedArray%.prototype.values`
   (`"@@1"` alias, same pattern as `Array` at `array-object-proto.ts` L130/L2141)
   and `%TypedArray%.prototype.toString === Array.prototype.toString`
   (§23.2.3.32 — alias the `Array` brand's `toString` singleton instead of
   minting a `%TypedArray%` one). `length`/`byteLength` getters invoked on the
   prototype must throw (`invoked-as-accessor.js` ×2): the L1752 brand cascade
   already throws for a non-view `this`; the miss is that the syntactic read
   `TypedArray.prototype.length` short-circuits — route it through the
   getter closure call (`builtin-value-read.ts` L835 `kind === "getter"` arm).

#### Step 3 — clusters C1–C5: `any`-receiver method dispatch on dyn views (61 rows, expect ≥ 45)

1. **Decline list.** In `expressions/calls-closures.ts:tryExternClassMethodOnAny`
   (L2421, next to the `STANDALONE_TA_SCALAR_HOFS` decline) add a noJsHost
   decline for `sort`, `keys`, `values`, `entries`, `includes`, `at`,
   `toLocaleString`, `subarray`, `slice` (the probe `d2-dynview.js` still
   binds `env::IDBKeyRange_includes` / `env::Uint8ClampedArray_keys` for a
   non-harness module — the leak is only masked in harness modules). Keep the
   host lane byte-identical (`noJsHost` gate), exactly like the `join`
   precedent at L2528.
2. **`__ta_dyn_sort(recv, comparefn, _, _, argc)`** in `dataview-native.ts`,
   cloned from `ensureTaDynReverseHelper` (L7468) with the 5-slot ABI, wired
   into the mutator two-arm at `call-receiver-method.ts` L3939–3946
   (`else if (methodName === "sort") taFillIdx = ensureTaDynSortHelper(ctx)`).
   Body: `emitTaDynViewValidate` → if `comparefn` is neither undefined nor
   callable (`__is_closure`/`__typeof_function`) throw TypeError BEFORE any
   read (`comparefn-nonfunction-call-throws`) → `emitTaDynViewToVec` (L8191)
   into a `$__vec_f64` → in-place merge sort (stable, `stability.js`) over the
   vec using `__apply_closure(cb, undefined, [x, y])` (the
   `hof-native.ts` L208 convention; `this` = undefined, exactly 2 args —
   `comparefn-calls.js`) and `ToNumber` of the result with NaN → 0; default
   comparator = numeric with `-0 < +0` and NaN last (§23.2.4.7,
   `sorted-values-nan.js`) → `emitTaDynViewWriteF64Vec` (L6097) back into the
   view → return `recv` (`return-same-instance.js`). Abrupt comparefn
   completions propagate as-is (`comparefn-call-throws.js`). Do not call
   `compileArraySort` (its default is the string sort).
3. **Iterators.** Add a `$__ta_dyn_view` arm to the same two-arm for
   `keys`/`values`/`entries` (arity 0): `emitTaDynViewValidate` →
   `emitTaDynViewToVec` → build the `$IterRec{VEC, vec, 0, null}` exactly as
   `iterRecAdoptArm` does for a `$Vec` (`iterator-native.ts`, #5188 Results)
   for `values`, and the `keys`/`entries` variants that
   `compileArrayIteratorMethod` (L2941) builds for a native vec (reuse its
   builders; `entries` pairs are `$ObjVec`). The record's prototype must be
   the shared `%ArrayIteratorPrototype%` singleton that
   `Object.getPrototypeOf([][Symbol.iterator]())` already returns (#3013 arm
   in `call-builtin-static.ts` L2240) — `iter-prototype.js` ×3. Detached view
   → TypeError before the record exists (`keys/detached-buffer.js`, cluster E).
4. **Search methods.** (a) Drop the `callExpr.arguments.length >= 1` guard in
   `array-methods.ts:shouldWrapDynViewTwoArm` (L1446) for `includes`/`indexOf`/
   `lastIndexOf`/`at` only (they model an absent argument since #5121) so the
   0-arg call takes the two-arm instead of the raw-byte-vec closed-dispatcher
   arm (`no-arg.js` ×2, `samevaluezero.js`). (b) In
   `closed-method-dispatch.ts:fillClosedMethodDispatch` `VEC_SEARCH_METHODS`
   arm (L1055) exclude `$__ta_dyn_view` receivers (`ref.test` before the
   `$__vec_base` arm) so a dyn view can never be read as its byte vec. (c) Box
   `includes` results as booleans on BOTH arms: `coerceArmToExternref(...,
   BOOLEAN_RESULT_METHODS.has(methodName))` is applied to the THEN arm only
   (L1837); the ELSE arm's re-dispatch returns an f64 — pass the flag there too.
   (d) Route `fromIndex` through the fused `__to_number` (#5138 cluster D
   helper in `tonumber-fast-paths.ts`) + ToIntegerOrInfinity in
   `compileArrayIncludes`/`compileArrayIndexOf`/`compileArrayLastIndexOf`
   (L3542/L3316/L9745): Symbol → TypeError, abrupt `valueOf` propagates, `-0`
   → 0, objects/strings coerced (`tointeger-fromindex.js` ×3,
   `fromIndex-minus-zero.js` ×3, `return-abrupt-*` ×6). Read `length` via
   `pushTaDynViewEffectiveLen` (the two-arm already does).
5. **`join`/`toLocaleString`.** In the two-arm THEN path the separator must go
   through `ToString` via the native `__to_string` (Symbol → TypeError,
   abrupt → propagate) BEFORE the element loop (`return-abrupt-from-separator*`
   ×2, the illegal casts in `custom-separator-*` ×2). `toLocaleString`
   (§23.2.3.29 → §23.1.3.32) must `Invoke(element, "toLocaleString")` per
   element: emit `__extern_method_call(boxedElement, "toLocaleString", [])`
   for each element (so a `Number.prototype.toLocaleString` override installed
   by the test is observed, and abrupt completions propagate — 9 rows). Keep
   the fast path for modules that never touch `Number.prototype` (gate on
   `moduleTouchesConstructorProp`-style source scan or the #4556 override
   two-arm `tryEmitProtoOverrideTwoArm`, L1929).
6. **`invoked-as-method`** (9 rows): a method call whose receiver is a
   `$NativeProto` at runtime must invoke the seeded companion closure. In
   `fillClosedMethodDispatch` add, ahead of the open-object arm, a
   `ref.test $NativeProto` arm: `__protoidx_own_recv` → companion → `__obj_find`
   → if callable, `__apply_closure(closure, recv, args)` (the closure's brand
   cascade throws the spec TypeError for a non-view `this`); this is the same
   mechanism that makes `subarray/invoked-as-method.js` pass today. Make sure
   `compileArrayMethodCall` does not claim the call first for
   `slice`/`join`/`sort`/`keys`/… when the receiver expression statically
   traces to `TypedArray.prototype` (`tracesToTypedArrayIntrinsicProto`,
   `calls.ts` L1772) — return `undefined` there so the dispatcher runs.

Re-run `ta-cl-C1-sort.txt`, `ta-cl-C2-iterators.txt`, `ta-cl-C3-search.txt`,
`ta-cl-C4-join-tolocale.txt`, `ta-cl-C5-invoked-as-method.txt`.

#### Step 4 — clusters D + E: callback protocol and ValidateTypedArray (49 rows, expect ≥ 30 locally, the rest via CI)

1. `hof-native.ts:ensureNativeArrayHof` (L83): (a) IsCallable check on `cb`
   BEFORE the length read → TypeError (`*-not-callable-throws` ×7); (b) pass
   the ORIGINAL receiver (the dyn view boxed as externref) as the callback's
   3rd argument and as `this` for the length/element reads — the two-arm at
   `array-methods.ts` L1805 currently hands the helper the materialized
   `$__vec_f64` (`callbackfn-arguments-*` ×4); (c) read each element LIVE
   through `__extern_get_idx` on the view (the dyn-view MOP arm), not from the
   snapshot, so writes during iteration are visible
   (`callbackfn-set-value-during-*` ×2) and a detach mid-loop yields
   `undefined` elements without throwing (`callbackfn-detachbuffer.js` ×5,
   §23.2.3.x "Let kValue be ! Get(O, Pk)"); (d) `reduce`/`reduceRight` with
   `len === 0` and no `initialValue` → TypeError (§23.2.3.23 step 6). The
   same three changes apply to `ta-hof-map-filter.ts` (map/filter loops). The
   `filter/result-empty-callbackfn-returns-false.js` null deref is the empty
   `$ObjVec` → `__any_unbox_bool` on a null slot in the species copy-back —
   guard the count-0 case in `emitTaDynViewWriteF64Vec` (L6097).
2. Entry validation: call `emitTaDynViewValidate(ctx, fctx, dvLocal)` (L8117)
   at the top of EVERY dyn-view arm that step 3 adds (sort/keys/values/entries/
   includes/indexOf/lastIndexOf/join/toLocaleString) and in the existing
   `fill`/`copyWithin`/`reverse`/`set` helpers AFTER argument coercion as well
   (§23.2.3.8 step 3 validates before coercion, then IntegerIndexedElementSet
   is a no-op on a detached buffer — re-check `buf.length < 0` right before
   the write loop; `coerced-*-detach.js` ×5 and `copyWithin/coerced-values-*-
   detached*.js` ×3 expect TypeError from the post-coercion re-check). `subarray`
   must NOT throw on a detached buffer (§23.2.3.27) — only `byteOffset` reads
   0. Locally these rows need the QuickJS artifact (10 rows) or an idle box (15
   timeouts); measure them with `--isolate` at 120 s or read the CI baseline —
   never mark them "already skipped".

Re-run `ta-cl-D-callback-hof.txt` and `ta-cl-E-detach-validate.txt --isolate`.

#### Step 5 — clusters F + G: species residual and index coercion (28 rows, expect ≥ 20)

1. `dataview-native.ts:emitTaDynSpeciesCreate` (L5848): (a) after
   `Get(O, "constructor")` returns `undefined`, use the default ctor but do NOT
   read `constructor` again — the getter counter must read exactly 1
   (`get-ctor-inherited` ×4; note the result's own `.constructor` read must
   then hit the SAME inherited getter, i.e. the result's prototype is the
   per-kind glue whose companion carries the test's getter — this depends on
   step 1.2's parent walk); (b) a non-object `constructor` or a
   non-constructor `@@species` value → TypeError before any element read
   (`get-{ctor,species}-returns-throws` ×8 — `false`/`42`/`"str"` are the
   values used; a `null`/`undefined` species still defaults); (c) call the
   `@@species` getter with `this` = the original constructor value
   (`custom-ctor-invocation` ×4 asserts `this` identity and the argument
   tuple: `map`/`filter` `[count]`, `slice` `[count]`, `subarray`
   `[buffer, byteOffset, count]`); (d) when the custom ctor returns another
   TypedArray, the result IS that object (`custom-ctor-returns-another-instance`
   ×2 — today the length validation throws "returned a non-TypedArray" because
   the returned dyn view is compared by carrier, not by `ref.test $__ta_dyn_view`);
   (e) `slice` with a same-buffer species result must copy through a snapshot
   (`return-same-buffer-with-offset`); (f) `map` over a 0-length view still
   allocates through species (`return-new-typedarray-from-empty-length`); (g)
   `subarray` result `instanceof TA` (`result-is-new-instance-from-same-ctor`)
   follows from step 1.4's `$parent`/glue identity — re-measure before coding.
2. Cluster G: in `ensureTaDynFillHelper` (L6391) / `ensureTaDynCopyWithinHelper`
   (L7282) an explicit `null` end/start is ToInteger'd to 0, only
   `undefined` means absent — drop the `__nullish_to_null` normalisation for
   `null` (keep it for the `undefined` singleton). slice/subarray begin/end and
   `set` offset: route through the fused `__to_number` (Symbol → TypeError,
   `return-abrupt-from-*-symbol` ×4); `ensureTaDynSetHelper` (L6655) must stop
   reading the array-like source at `src.length` (`array-arg-set-values-in-order`).

Re-run `ta-cl-F-species.txt`, `ta-cl-G-coercion.txt`.

#### Step 6 — clusters H + I: constructor arguments and `from`/`of` (41 rows, expect ≥ 28)

1. `emitTaDynCtorConstructFromLocals` (L5241): (a) admit the packed static view
   carriers `i8_byte`/`i16_byte` (and `i32_elem`, present) in the plain-vec copy
   arms (L5620 filter) using `emitTaPlainVecElementToF64` with the carrier's
   signedness — `Uint8Array`/`Int8Array` share `i8_byte`, so read the element
   width/signedness from the SOURCE carrier's `TYPED_ARRAY_INT_VIEW_STORAGE`
   entry, not from the ctor kind (`typedarray-arg/returns-new-instance` ×2);
   (b) in the `$Object` arm (L5457 GetMethod): `@@iterator` = `null`/`undefined`
   → array-like path AND the result must still be a proper dyn view
   (`iterator-is-null-as-array-like` fails on `instanceof`, i.e. the arm
   currently produces the wrong carrier); non-callable → TypeError; abrupt from
   the `@@iterator` getter/call and from `next()` propagate unwrapped
   (`iterator-throws`, `iterating-throws` — the wrap turns Test262Error into
   TypeError today); a user-modified `Array.prototype[@@iterator]` must be
   honoured (`iterated-array-with-modified-array-iterator` — the `$ObjVec` fast
   arm at L5568 skips the iterator protocol; gate it on the prototype not being
   overridden, or always take the iterator path for `$Object`s); (c) element
   conversion goes through the fused `__to_number` so `valueOf`/`toString`/
   `@@toPrimitive` abrupt completions propagate (`throws-setting-obj-*` ×5) and
   `null` → 0, `"7"` → 7 (`returns.js`); (d) `ToIndex(length)` ≥ 2^53 or > the
   allocation limit → catchable RangeError instead of the `requested new array
   is too large` trap (`length-excessive-throws`, `toindex-length`: emit the
   check before `array.new`); (e) `buffer-arg` `ToIndex(byteOffset)` /
   `ToIndex(length)` of objects with `valueOf`/`toString` null-deref in
   `__module_init` — coerce via `__to_number` before the ArrayBuffer arm
   (L5703) and keep `-0`/`""`/`"1"`/`true` semantics (coordinate with #5150 F).
   `no-species` / `same-ctor-buffer-ctor-species-{null,undefined}` ×3 additionally
   need `mysteryTA.buffer.constructor === ArrayBuffer` — verify after #5150 lands
   before spending time here.
2. `from`/`of`: (a) mint the `mapfn` call with exactly `(kValue, k)` — replace
   the `__hof_map` route in `iterator-native.ts` `__array_from_mapped` (L1014)
   with a dedicated 2-arg loop via `__apply_closure`, or pass an `argc` flag
   the map loop honours (`mapfn-arguments`); (b) `IsCallable(mapfn)` is checked
   before `source[@@iterator]` is read (`mapfn-is-not-callable`); (c) element
   conversion abrupt completions propagate and stop iteration
   (`set-value-abrupt-completion`, `iterated-array-changed-by-tonumber`:
   values are read from the DRAINED list, not re-read from the mutated array);
   (d) iterator-protocol abrupt completions (`iter-access-error`,
   `iter-invoke-error`, `iter-next-error`, `iter-next-value-error`,
   `arylk-*-error` ×6) propagate as the ORIGINAL error object — the
   `__array_from_iter_n` drain rewraps into TypeError today; (e) `from`/`of`
   called with a non-constructor `this` → TypeError (`invoked-as-func` ×4 —
   `var from = TA.from; from([])` reaches `tryEmitTaStaticOfFrom` with no
   `$__ta_ctor` receiver: throw in the ELSE arm when the receiver is not
   callable-constructible, gate on `noJsHost`); (f) `TA.from.call(ctor, src)`
   / `TA.of.call(ctor, …)` ×6: these need the static method VALUE read
   (step 2.1 mints `from`/`of` closures on the intrinsic; the per-kind
   `$__ta_ctor` `__extern_get` arm at `ta-dyn-mop.ts` L1157 must answer
   `from`/`of` with the SAME closures) and `.call` → the closure invoked with
   `this` = `ctor`, which then constructs via `Construct(this, [len])`,
   validates the result is a TypedArray of sufficient length, and writes the
   elements through the result's own `[[Set]]` (`custom-ctor*` ×4,
   `new-instance-using-custom-ctor` ×2).

Re-run `ta-cl-H-ctor-args.txt`, `ta-cl-I-from-of.txt`.

#### Step 7 — cluster J: integer-indexed MOP residual (13 rows, expect ≥ 9)

In `ta-dyn-mop.ts:fillTaDynViewMopArms` (L341): (a) splice a `$__ta_dyn_view`
arm into `__getOwnPropertyNames` (the `Reflect.ownKeys` native) mirroring the
`__object_keys` arm at L957 — indices `"0".."len-1"` first, then the expando
`$Object`'s own string keys, then its symbol keys (§10.4.5.11); reuse
`fillClosedStructOwnPropertyNamesArms`'s splice-after-`__objvec_new` pattern
(`object-runtime.ts` L9619); (b) `buildStringKeyArm` (L532) `has` mode: on an
expando miss walk `__getPrototypeOf(recv)` → `__extern_has(proto, key)` (the
`get` mode already does this inside `constructorLookup`; generalise it to every
non-index string key — `inherited-property.js`, `key-is-not-canonical-index.js`);
(c) `__defineProperty_value` / `_accessor` dyn-view arms (L1406–L1520): for an
expando key pass the caller's flag word through unchanged (absent fields
default to `false` per §10.1.6.3 — today the arm rewrites them; `key-is-not-
numeric-index`, `key-is-symbol`, `non-extensible-redefine-key`), and for a
canonical index key run `ToNumber(Desc.[[Value]])` (abrupt → propagate,
`desc-value-throws`) before the element write; (d) `[[Set]]` with a receiver
that is not the view (`internals/Set/*prototype-chain-set.js` ×2): when the
view sits on the RECEIVER's prototype chain, a valid index writes the view's
element and an invalid one must NOT create a property on the receiver
(§10.4.5.5 step 1.b) — this is the ordinary-`[[Set]]` prototype walk in
`__extern_set` reaching the dyn-view arm with `receiver !== O`; keep #2046's
`Reflect.set` receiver rows out.

Re-run `ta-cl-J-mop-internals.txt`.

### What NOT to do

- **No new host imports** — standalone must stay host-import-free; the runner
  fails the whole module on `env::*`. `sort`/`keys`/`values`/`entries`/
  `includes` get native arms (step 3), never an `env::<TA>_<m>` import; the
  host (gc) lane keeps its existing imports byte-identical (`noJsHost` gates).
- No edits to `tests/test262-runner.ts`, its skip lists, or
  `scripts/*-baseline.json`; no `--no-verify`; no test-path or harness-name
  special-casing.
- Do not touch the owned areas: `Reflect.construct` NewTarget (#3371),
  `Reflect.set` receiver (#2046), ArrayBuffer/DataView internals (#5150),
  native generator carriers (#680/#2864), anything needing `$262.createRealm`.
- Do not "fix" cluster A through `object-proto-tostring.ts` — #4119 measured
  that a classifier-only change demotes CE→wrong-value; the identity is the
  defect.
- Do not rebuild native helper bodies at finalize; do not share one `Instr[]`
  throw sequence between two arms (#1058).
- Do not make the count arm of the TypedArray constructor smarter; peel real
  iterables/array-likes first (#5138 step 1 rule).
- Do not branch from a merge-queue tip; branch from `origin/main`, merge it
  again before enqueue.

### Budget rationale (2026-09-01)

Each step splices arms into an existing ladder rather than adding a parallel
mechanism, so the touched files/functions grow by design: `array-object-proto.ts`
(intrinsic ctor own props, `@@toStringTag` getter body, glue parent link),
`native-proto.ts` / `native-proto-own-props.ts` / `proto-index-store.ts`
(`$parent` link and one-level parent walk), `object-runtime.ts` /
`object-get-prototype-of.ts` / `builtin-proto-constructor.ts` (prototype-graph
identity arms), `builtin-static-gopd.ts` / `call-builtin-static.ts`
(`%TypedArray%` species/toStringTag descriptors), `calls-closures.ts` (decline
list), `dataview-native.ts` (`__ta_dyn_sort`, iterator record arm, ctor arms,
`from`/`of` protocol), `call-receiver-method.ts` (two-arm wiring),
`array-methods.ts` / `ta-hof-map-filter.ts` / `hof-native.ts` (live element
reads, callable checks, boolean boxing), `ta-dyn-mop.ts` /
`closed-method-dispatch.ts` (MOP and `$NativeProto` receiver arms),
`iterator-native.ts` (2-arg `mapfn`). The allowances above cover exactly these
files/functions; a later slice may extract the shared `__to_number`-based
index-coercion helper and retire part of them.

### Acceptance criteria (r2 residual)

- Expected flips per step, measured on the same sub-list before/after in this
  worktree: step 1 ≥ 55 / 63, step 2 ≥ 22 / 31, step 3 ≥ 45 / 61, step 4 ≥ 30
  / 49 (the `$DETACHBUFFER` rows via CI or an idle `--isolate` run), step 5
  ≥ 20 / 28, step 6 ≥ 28 / 41, step 7 ≥ 9 / 13 — **≥ +209 of the 286 in-scope
  rows** overall; this supersedes the umbrella's "≥ +150" line above. Partial
  completion is fine per step; state the per-cluster residual in the PR.
- Controls: `.tmp/es2015/ta-controls.txt` (21 currently-passing sibling tests,
  verified 21/21 on HEAD 2026-09-01 in this worktree; the 22nd candidate
  `byteLength/name.js` was dropped after a load-induced compile timeout) must
  stay green after every step:
  `npx tsx scripts/run-test262-paths.mts .tmp/es2015/ta-controls.txt --standalone`.
- Gates before every commit, chained (never piped):
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`,
  plus `pnpm run test:equivalence:gate`; simulate CI's base with
  `LOC_GATE_BASE=$(git rev-parse origin/main)` for the two budget gates.
- Zero host imports in every standalone module of the sub-lists (the runner's
  `host_import_leak` category must stay at 0 for the 286 rows).
- Issue integrity: `node scripts/update-issues.mjs --check` green.

## Suspended Work (2026-09-01T21:56Z — user-requested 2-hour pause)

- **Branch**: local lane branch `worktree-agent-a1eb4f40f876e3f07` at `de01ce774`
  (WIP snapshot on top of base `dc29e1f15`; NOT pushed — durable copy is
  `plan/agent-context/es2015-suspend-2026-09-01/patches/lane-5194.mbox`, 1
  patch = the snapshot of the implementer's uncommitted edits in
  `array-object-proto.ts`, `builtin-proto-constructor.ts`,
  `builtin-value-read.ts`, `expressions/object-get-prototype-of.ts`,
  `native-proto-value-read.ts`, `native-proto.ts`, `object-runtime.ts`, the
  new `tests/issue-5194-es2015-typedarray-r2.test.ts`, and this file's
  allowance amendments).
- **Worktree at suspension**: `/home/user/js2/.claude/worktrees/agent-a1eb4f40f876e3f07`
  (treat as gone).
- **State** (implementer's handoff): Step 1 (cluster A, prototype graph —
  `$parent` link, empty-view CSV + parent walk in value-read and
  `__protoidx_{get,has}_k`, `constructor` + `BYTES_PER_ELEMENT` own props,
  `getPrototypeOf` TA arms, `$__ta_ctor` `prototype` own property) is
  code-complete and typechecks; Step 2 PARTIAL (`%TypedArray%` own
  `name`/`length`/`prototype`/`@@species`/`from`/`of`, `@@toStringTag` getter,
  `@@iterator` → `values` alias, `slice.length` 2). Steps 3–7 not started.
- **Verified so far**: BEFORE (pre-edit, `typedarray-head.txt`, 300 rows,
  standalone) = 0 pass / 244 fail / 56 CE (under load). Direct probes
  `p1.js` mask 0/16, `p3.js` mask 32768 (only `TypedArray()` must-throw still
  red). Focused vitest 4/4 green with zero standalone host imports. All five
  ratchet gates green. **No AFTER number** — the after-run
  (`head-controls.txt`, 321 rows) was mid-flight at suspension.
- **NOT yet verified / next steps**: (1) `git am` + `pnpm run typecheck`; (2)
  `npx tsx scripts/run-test262-paths.mts .tmp/es2015/head-controls.txt --standalone`
  for the after-number and 21/21 controls (Step 1 target ≥ 55 of 63); (3)
  neighbour vitest files one at a time with `NODE_OPTIONS=--max-old-space-size=3072`;
  (4) `pnpm run test:equivalence:gate`; (5) commit Step 1 + Step 2 so far,
  then Steps 2 (rest) → 7 per the 2026-09-01 plan.
- **Traps**: importing `builtin-value-read.ts` from `array-object-proto.ts`
  creates a module cycle that TDZ-crashes `builtin-ctor-own-props.ts` — import
  from `registry/types.ts` instead. Backticks inside the test's template-literal
  sources break esbuild. 10 rows are unmeasurable locally (QuickJS artifact key
  gap); 16 baseline "CEs" are load-induced compile timeouts — re-run alone.
  #5150 edits neighbouring functions in `dataview-native.ts` — reconcile at
  merge, never rebase. Local probes skip the standalone leak check (#5272).

## 2026-09-02 resumed r2 implementation (Opus)

Resumed from the 2026-09-01 suspension snapshot (`git am` of the two WIP
patches, base `dc29e1f15`, rebuilt on `0f801557a`). Worktree
`/home/user/js2/.claude/worktrees/agent-ad914157d74cd7f02`, branch
`worktree-agent-ad914157d74cd7f02`. All measurements are in-process
`npx tsx scripts/run-test262-paths.mts <list> --standalone` in this worktree.
A `pass` from that runner already implies **zero host imports** — the runner
calls `standaloneHostImportError` on every standalone result and reports a leak
as `host_import_leak`, never as a pass (`tests/test262-runner.ts` L4944).

### Numbers

| scope | before (2026-09-01 HEAD) | after | target |
|---|---|---|---|
| Step 1 — cluster A (63) | 0 pass | **63 pass** | ≥ 55 ✓ |
| Step 2 — cluster B (31) | 0 pass | **21 pass** (+1 load-timeout row that passes alone ⇒ 22) | ≥ 22 ✓ (marginal) |
| Step 3 — clusters C1–C5 (61) | 0 pass | **4 pass** (C5 only) | ≥ 45 ✗ PARTIAL |
| Step 4 — cluster D (16 of the 49) | 0 pass | **2 pass** | ≥ 30 ✗ PARTIAL |
| whole `typedarray-head.txt` (300) | 0 pass / 271 fail / 28 CE | **84 pass / 180 fail / 36 CE** at the Step-1+2 commit; +6 more from the second commit measured on sub-lists (not a re-run of the head list) | — |
| controls `ta-controls.txt` (21) | 21 | **21** | 21 ✓ |

Of the 36 CEs, **24 are load-induced compile timeouts** (the box ran at load
10–22 with five lanes; every one of them re-runs green with `--isolate`, spot-
checked on `TypedArrayConstructors/prototype/indexOf/inherited.js`,
`TypedArray/prototype/forEach/length.js` and `keys/invoked-as-method.js`) and
**12 are the genuine out-of-scope CEs the plan already named** — 6
`Reflect.set` (#2046) and 6 `Reflect.construct` (#3371). The QuickJS adapter
artifact was present this session (`d4799bda84cfed0d`), so the 10 rows the
handoff called locally unmeasurable **were measured**.

### What landed

Commit 1 — Step 1 complete, Step 2 partial (the resumed snapshot):
per-kind `$parent` link, empty own-member CSV on concrete views + parent-brand
retry in both readers, `constructor`/`BYTES_PER_ELEMENT` own data properties,
`__getPrototypeOf` `$NativeProto → $parent` arm, the compile-time
`Object.getPrototypeOf(<typed view>)` arm, `$__ta_ctor.prototype` own property;
`%TypedArray%` own `name`/`length`/`prototype`/`@@species`/`from`/`of`,
`@@toStringTag` getter body, `@@iterator → values` alias.

Commit 2 — Step 2 rest (part), Step 3 (part), Step 4 (part):
- `%TypedArray%` added to `SPECIES_OWNER_CTORS`, and the species-gOPD receiver
  is now recovered through `isTypedArrayIntrinsicCtorExpr` (the harness's
  `var TypedArray = Object.getPrototypeOf(Int8Array)` binding is not a global
  identifier, so `resolveBuiltinReceiverName` could never name it).
- `tryExternClassMethodOnAny` declines `sort`/`keys`/`values`/`entries`/
  `includes`/`at`/`toLocaleString`/`subarray`/`slice` under `noJsHost`
  (`STANDALONE_TA_DISPATCHED_METHODS`, local to `calls-closures.ts` so the
  `calls.ts` god-file does not grow).
- `compileArrayMethodCall` is declined when the receiver statically traces to
  `%TypedArray%.prototype`, so the call reaches the closed dispatcher's
  `$NativeProto` arm and the seeded companion closure raises the spec
  TypeError — **cluster C5 0 → 4** (`keys`/`values`/`entries`/`sort`).
- `hof-native.ts`: IsCallable(callbackfn) gate before the loop, and
  `reduce`/`reduceRight` of an empty receiver with no initial value now throws
  the §23.1.3.24 TypeError instead of returning `undefined` (the documented
  boundary is retired — the #1839 index-shift justification does not hold,
  because standalone resolves the throw to the in-module append-only
  `__new_TypeError`). **Cluster D 0 → 2** (the two `empty-instance-with-no-
  initialvalue-throws.js` rows).
- Two-arm gate: the `≥ 1 argument` clause is lifted for
  `at`/`includes`/`indexOf`/`lastIndexOf` (they model an absent argument) and
  for the three arity-0 iterator factories; the boolean-result box now reaches
  the ELSE arm as well as the THEN arm.

### Leftovers — read this before continuing

1. **The dyn-view two-arm in `array-methods.ts` does not serve `any`
   receivers.** `call-receiver-method.ts` skips the whole array ladder when
   `ctx.targetProfile.semanticProviders === "native-first"` and the receiver
   type is `any` — which is exactly the shape every
   `testWithTypedArrayConstructors(function (TA) { var sample = new TA([…]); … })`
   row has. So `shouldWrapDynViewTwoArm` (and the C2/C3 edits made through it)
   is **unreachable for clusters C1–C4**. The working precedent for `any`
   receivers is the *other* two-arm — the `taFillIdx`/`taSetIdx` block in
   `call-receiver-method.ts` (~L4034) that serves `set`/`fill`/`copyWithin`/
   `reverse` through the 5-slot `__ta_dyn_<m>(recv, v1, v2, v3, argc)` ABI.
   **Steps 3.2–3.5 must be wired there, not in `array-methods.ts`.** This is
   the single reason cluster C came in at 4/61 instead of ≥45, and it was not
   visible from the plan's file:function citations.
2. Cluster C3's 22 rows all answer the NUMBER `0` (`includes(42)` → «0»,
   `indexOf()` → «0»), both before and after this session — so the closed
   dispatcher's `VEC_SEARCH_METHODS` arm is not the producer. Find what
   actually answers `0` before writing the helper. (Excluding
   `$__ta_dyn_view` from that arm, as plan step 3.4b says, was tried and
   reverted: it changed nothing measurable, and `$__ta_dyn_view` IS a
   `$__vec_base` subtype whose `__extern_length`/`__extern_get_idx` reads go
   through the correct dyn-view MOP arms, so the exclusion removes a path that
   is not obviously wrong.)
3. The IsCallable gate in `ensureNativeArrayHof` is in place but the
   `*-not-callable-throws` rows still do not throw. Probed directly
   (`.tmp/es2015/probes/cbguard{,2}.mts`): a standalone module doing
   `sample.find(false)` / `sample.every()` / `sample.reduce()` on a
   `new TA([42,43,44])` dyn view emits **zero host imports**, contains
   `__hof_find`, `__typeof_function`, `__call_m_find` and `__new_TypeError` —
   and still catches nothing (`hits === 0`). So the guard is either compiled
   out (`ctx.funcMap.get("__typeof_function")` still undefined at the reserve
   -time moment `ensureNativeArrayHof` runs, even though the native is minted
   later) or the call never reaches `__hof_find` at runtime. Resolve THAT
   before writing more callback-protocol code; do NOT reach for
   `ensureLateImport` inside that helper (#1839).
4. Cluster B's residual 10: 4 rows need `Function.prototype.call` in
   standalone (out of scope for #5194 — `getter.call(value)`), 2 need the
   `length`/`byteLength` getters to be invoked by a DYNAMIC read of
   `TypedArrayPrototype.length` (the syntactic `<Ctor>.prototype.<getter>` arm
   already invokes; the var-routed read does not), 2 need
   `isConstructor(TypedArray.from) === false`, 1 needs `%TypedArray%()` itself
   to throw, and 1 is `Symbol.toStringTag/invoked-as-func` (the gOPD `.get`
   symbol-key synthesis of plan step 2.3).
5. Steps 5, 6 and 7 (clusters F+G, H+I, J) are **not started**.
6. Measurement cost on a shared box is the binding constraint: the 300-row
   head list took **48 minutes** in-process at load 10–22. Budget for that, or
   measure per-cluster only.

### Validation

- Five ratchet gates green (`check-loc-budget`, `check-func-budget`,
  `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`), run
  bare with `$?` captured, before each commit.
- `pnpm run typecheck` (TS7) green. `pnpm run typecheck:ts5` fails on
  `src/linked-provider-runtime.ts` (`WebAssembly.Tag` missing from the ambient
  lib) — **pre-existing on `main`, untouched by this branch.**
- `tests/issue-5194-es2015-typedarray-r2.test.ts` 4/4.
- `pnpm run test:equivalence:gate`: **24 failing / 1718 passing, all 24 in the
  baseline — no new regressions.**
- Neighbour vitest files, one at a time with
  `NODE_OPTIONS=--max-old-space-size=3072`:
  `issue-2872-ta-dynview-reduce-includes` 9/9, `issue-4449-species-controls`
  5/5. Two files fail, and **both fail identically with `src/` reverted to
  `main` (`git checkout 0f801557a -- src/`), so they are pre-existing, not
  this branch**: `issue-2872.test.ts` "non-TA dynamic callee still constructs
  through the class dispatch" (expected NaN to be 7), and three rows across
  `issue-3177.test.ts` / `issue-3177-fromof.test.ts` (ctor cross-check,
  `[[Delete]]` MOP, `from(iterable Set)`).
- Method note: run the A/B revert **serially**. Doing it while an equivalence
  gate was in flight put ~6 minutes of that run on `main`'s compiler (vitest
  isolates the module graph per file), so that run was repeated end-to-end on
  a quiet tree — the 24/1718/no-regressions figure above is the CLEAN re-run,
  and the contaminated run agreed with it.
