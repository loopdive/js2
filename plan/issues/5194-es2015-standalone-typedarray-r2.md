---
id: 5194
title: "ES2015 standalone typedarray — r2 residual pass (post-#5188 clustering)"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-08-30
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/new-builtin-globals.ts
func-budget-allow:
  - src/codegen/dataview-native.ts::ensureTaDynSetHelper
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructFromLocals
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
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

### 2026-08-30 static handoff (validation pending)

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

No broad Test262 residual-list sweep was run in this worktree. The serial
120-program differential check above is the only broader behavioral gate. The
branch remains dirty and based on `a62aacba5ccc154f6fc378235aaaeeb4a7204231`;
current upstream `main` is `c882d1b110` (including #5290 at `4b715bada1`). A
clean current-main transplant followed by exact25, controls, and proportionate
gate revalidation is required before publication. No commit, push, rebase, or
PR action was performed here.

### Slice A completion and handoff

This slice is owned in isolated worktree
`/private/tmp/js2-es2015-typedarray-set-r2-20260830` on branch
`codex/5194-typedarray-set-r2`. It may open one non-draft upstream PR only when
the branch is mergeable and the exact 25-row standalone cohort plus regression
controls are green. If interrupted or still non-mergeable, push the checkpoint,
record the precise remaining rows and root cause here, and use a draft PR.

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
