# ES2015 standalone checkpoint handoff — 2026-09-08

This checkpoint preserves the current implementation at the user's request to
commit the work, write a handoff, and open a PR. **It is not merge-ready and does
not establish 100% conformance.** Do not enable automatic merging while the
recorded generator protocol failures and final validation remain open.

## Goal and scope

The goal remains all **11,704 core ES2015 Test262 paths passing in standalone
mode**. The frozen sorted, LF, `test/`-prefixed filter SHA256 is
`45de809c6bfce7371cee1d20e327758246b0524ecd75481a08b8c03344fced8a`;
Test262 checkout is `b363f29d3c43c626dc852744ad64a0b48a003693`.
The edition map additionally labels 74 Intl402 paths, which are outside this
previously frozen core ECMA-262 selection. No core paths were dropped.

A downloaded honest-oracle-v13 snapshot has 10,228 pass, 1,146 fail,
329 compile_error, and 1 compile_timeout in this scope. These are triage data,
not a new execution or a candidate pass rate. The complete feature-tagged
generator regression cohort is 2,486 paths (2,122 pass, 228 compile_error,
136 fail in that snapshot), not merely the 653 paths in four directories.

## Worktree and commit state

- Integration: `/workspace/.tmp/es2015-standalone-resume`, branch
  `codex/4444-es2015-standalone-resume`, source base `95186a4835a1fe`.
- Verified super increment: `357b05f68c8c76b8c4888690941edf9d247243ab`.
- Generator source: `/tmp/js2-es2015-generators`,
  `codex/5199-generic-yield-star`; checkpoint integrated into this branch.
- TypedArray source: `/workspace/.tmp/es2015-typedarray-species`,
  `codex/5317-typedarray-species-resume`; current increment integrated here.
- Immutable comparison archive: `/tmp/js2-es2015-base-95186a`; all 6,012
  archived source/script/test blobs were verified against the base commit.
- `/workspace` remains on `main` at `28be5a4714ab089f551b60a06beba01b922e15ac`
  as last synchronized, with the user's local `src/ir/lower.ts` comment and
  untracked files preserved. No user working files belong to this checkpoint.

## Verified super increment

Issue 5350, **ES2015 standalone super property access — r1: class
[[HomeObject]] read, dynamic-key base-before-key, extends null, uninitialised
this, object-literal super calls**, owns the implementation and detailed results. Retain declaration-proven class prototype assignments in
source order; resolve literal computed class prototype reads through the same
singleton; execute supported missing-super constructor bodies before the
fallthrough ReferenceError.

The unchanged Test262 harness measures **36/58 → 43/58 passing**, seven exact
pass gains and zero lost passes. Focused pins: **41/41** with no imports.
Class/capture neighbours remain **29/34 on both trees**, with identical failure
names and messages. Six host/WASI probes are byte-identical. Default-this and
super-write replay regressions found during review were fixed before the final
run. Return/this/eval and other documented constructor completion gaps remain.

## Generator checkpoint and next actions

Issue 5199, **ES2015 standalone generators — r2 residual pass**, owns the source
checkpoint. Generic yield-star now carries a live iterator record, captures
next, forwards abrupt resumes, preserves raw non-done iterator results, and
handles observed done/value access order. Native generator method/property and
prototype materialization is partially integrated through canonical closures
and identity bags.

Final worker source characterization: TS7 and compiler bundle build pass;
a basic import-free smoke returns 12; the focused suite passes **27/27**.
The original nine bridge probes now compile without imports and measure
**4/9 passing**, versus **1/9** on the immutable base. The original invalid-only
receiver probe is weak: its positive call used a different dispatch path.
Do not treat that row as proof until the strengthened extracted-method control
passes. Eleven prototype fixtures currently have **Node oracle results only**.

Remaining original bridge failures include inherited next override, own next
overrides in direct/delegated calls, undefined-shadow/delete behavior, own
return accessors, and null/undefined symbol method overrides. Also unresolved:
three numeric-generator payload probes return 0 instead of Node's 1; passing
an object to next/return must not coerce it just because source yields are
numeric. Sent/return and result payload types need decoupling from yield type.
Cross-family IteratorPrototype identity remains incomplete.

The earlier **44/44** real Test262 protocol result predates the final prototype
and factory changes; its fresh baseline was **8/44**. It is historical evidence,
not proof for this checkpoint. Rebuild both bundles and the QuickJS adapter,
then rerun 27 pins, original bridge probes, strengthened prototype probes,
44 protocol rows, and the broader regression cohort before merge readiness.
The adapter in the generator worktree is stale for its final source.

## TypedArray checkpoint

The owning issue 5317, **ES2015 standalone typedarray — r4: species protocol,
coercion order, sort, join traps, integer-indexed internals**, records exact
final results: **44/55 → 48/55 passing**, four gains, zero lost passes, and
identical first-error texts for the seven remaining failures. Focused checks
pass **15/15** (10 new controls plus five existing neighbours). The change
preserves ordinary constructor getter results and
receivers instead of replacing undefined with the intrinsic constructor.
Concrete TypedArray prototypes now seed their own constructor properties even
without reflection, using existing dynamic-view demand to reserve the store.

Removing the fallback initially regressed all nine intrinsic constructor
identities in minimal modules. The underlying seeding repair was added and
those controls now pass. Untyped/aliased descriptor probes and direct
Object.setPrototypeOf variants have preserved pre-existing failures; rewritten
controls do not establish those forms as fixed. Custom species constructor
this/prototype identity, returned static-view validation, and overlapping slice
copy are separate remaining mechanisms. Do not widen a representation check
without implementing writes and identity for the accepted representation.

## Combined checkpoint validation

After integration, the normal `pnpm run typecheck` passes and the three focused
suites pass **78/78** on the combined source (41 super, 27 generator, 10
TypedArray), with one compiler worker and one Vitest fork. This does not
replace the pending generator bridge/prototype or full Test262 checks.

## Reproduction and environment

Use at most two runtime compiler workers globally, one per lane. Set
`COMPILER_POOL_SIZE=1` and `VITEST_MAX_FORKS=1`; maxWorkers alone does not
replace this repository's Vitest pool configuration. Do not kill a test because
its log is buffered. Preserve worktrees and evidence; never prune worktrees,
stash, or alter the user's main working files.

Pinned QuickJS artifact: `/workspace/.tmp/es2015-toolchain/artifact`, SHA256
`8533e46749cc1dbce2684fcfb92539e63a69046c923d0cdcde286faaebda4ba6`.
It was built using the repository's pinned dependencies, passed six value
acceptance probes, and has only WASI imports. Rebuild the **QuickJS**, not the
interpreter, provider whenever source changes. Node used for these runs is
25.8.2. Exact TypeScript 7.0.2 is available at
`/tmp/js2-es2015-typescript7/package/lib/tsc.js`; the integration worktree has
an isolated dependency overlay so normal `pnpm run typecheck` can use it
without changing shared dependencies.

```sh
pnpm run -s build:compiler-bundle
node_modules/.bin/esbuild scripts/runtime-bundle-entry.ts --bundle --platform=node --format=esm --outfile=scripts/runtime-bundle.mjs --external:typescript --external:binaryen --external:typescript7 --external:typescript7/*
JS2WASM_QUICKJS_ARTIFACT_DIR=/workspace/.tmp/es2015-toolchain/artifact COMPILER_POOL_SIZE=1 node scripts/build-quickjs-eval-provider.mjs
GOMAXPROCS=2 pnpm run typecheck
COMPILER_POOL_SIZE=1 VITEST_MAX_FORKS=1 pnpm exec vitest run tests/issue-5350-super-property-r1.test.ts tests/issue-5199-generic-yield-star.test.ts tests/issue-5317-r4-constructor-lookup.test.ts
COMPILER_POOL_SIZE=1 node --import tsx scripts/run-test262-paths.mts --isolate PATH_LIST_WITHOUT_TEST_PREFIX --standalone
```

Portable selected evidence and reproduction fixtures are in
[the handoff evidence directory](./es2015-standalone-handoff-2026-09-08/).
Detailed local run logs remain in each worktree's `.tmp` and are indexed by the
owning issue documents. Frozen scope maps can be reconstructed from the checked
in edition map; record physical row counts, unique paths, missing/duplicate
paths, source/provider hashes, and zero skips for final acceptance. Only an
exact current 11,704/11,704 standalone run can complete the original goal.
