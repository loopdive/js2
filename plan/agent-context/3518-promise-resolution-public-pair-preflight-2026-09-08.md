# Promise resolution public-source comparison: preflight

Astra Low sidecar, prepared without running a compiler, suite or typecheck.
Parent owns the heavy slot. No production/test-owner file was changed and
nothing was written to Pauli's worktree, the baseline or the parent checkout.

## Candidate binding

Read-only candidate:
 /private/tmp/js2-3518-promise-resolution-20260908
 on codex/3518-promise-resolution-20260908.

Baseline:
 /private/tmp/js2-3518-explicit-rec-integration-20260908.

Both HEADs are 2b9cb408c18446361fcf9837045067d1fd97c642. Pauli's
.tmp/promise-resolution-v2-checkpoint.json was read in full. All four source
SHA256s match; a complete recursive src comparison finds exactly these changes:

- src/codegen/async-scheduler.ts:
  159c7eba9ed415784307a460aa8617fd31a65850b621966d1e3f22fedc4d1723
- src/codegen/closed-method-dispatch.ts:
  9379464bd8386f5b203bdfc2d21d4dbb2a9584529b9a8cac53441f5124e02dfc
- src/runtime/wasmgc/promise/resolution-bodies.ts:
  a68e90829a719de5a83898e0df10eee61aed10cc1f6355391f7212bc9e52fe91
- src/runtime/wasmgc/promise/thenable-bodies.ts:
  9a802504e895b011a9e3b7a2a5cf975046fd679a1a14ce5af37ca410f88ff3ec

Baseline src census: 1,316 files,
48f52a45be1b9b37622d146297ec630dd4a2e3d8458852e804f30d57951bff18.
Candidate: 1,318 files,
25ba254acc6a4ba8434456302fa222245b0a65460630e76b9f16151c8e6e2afa.

The runner rechecks both commits, a clean baseline, candidate four hashes,
and the complete source-difference set before/after every child. The candidate
is Pauli's four-file slice, not this worker's unrelated vector draft or the
parent's larger integration.

## Proposed fixed denominator

Twelve recipes, each with experimentalIR=false and true:

1. Native promise adoption through the executor resolve, with no own then.
2. Pending native promise returned by a reaction and recursively adopted.
3. Executor self-resolution, preserving the original truthy-reason control.
4. Ordinary user thenable invocation.
5. Recursively resolving thenables.
6. Ordinary numeric resolution.
7. Non-thenable object resolution.
8. Real thrown-reason identity delivered through native rejection.
9. Throwing then getter on the closed Object.defineProperty target.
10. Throwing then getter on the open any-typed object.
11. Captured native promise own then, replaced before the queued call.
12. Callable-getter capture/order trace described below.

This means **24 pairs / 48 compiles / 96 fresh module instances / 184 external
export observations** if all actions are supported. No rows may be skipped.
Compile, artifact, instantiate and execute failures remain separate located
records; all baseline/candidate rows must still be compared.

Eleven source recipes are extracted from existing tests:

- issue-3125.test.ts
- issue-3125-widen.test.ts
- issue-2867.test.ts
- issue-5197-own-then-indirection.test.ts
- issue-4167-async-rejection-identity.test.ts

Their exact source strings, originating test titles/full-file hashes, source
wrapper adaptations, required exports, call order and expected values are in
scripts/fixtures/3518-promise-resolution-public-pair.json. The old WASI-oriented
source recipes deliberately run on the active standalone target here. This
does not invoke a Test262 runner or create host/linear work.

## Execution mechanism and positive observations

Only selected-root src/index.ts public compile is dynamically imported. Native
Promise settlement is observed through the actual module's microtask drain,
either called inside the original source fixture or as an explicit required
export action. There is no optional-drain fallback, host Promise substitution,
synthetic subscription or await of an opaque native Promise carrier.

Each compile is instantiated twice with its exact recorded bytes and empty
imports. The fresh-instance repetitions avoid reusing old fixture globals.
Every source expectation is independent of the other arm. Wrong values are
recorded without stopping later trace reads, then fail semantic acceptance
even if baseline/candidate agree.

Most existing positives return distinct sentinels for fulfilment, rejection,
identity failure and non-delivery. The pending-adoption row preserves explicit
run/drain/getResult actions. The rejection-identity row preserves explicit
module-init/drain/identityOk actions. These are observations, not helper-name
or WAT-position coverage claims.

Recipe 12 is explicitly a **new source observation**, not an unchanged known
passing repository test. It combines the existing open-object getter shape
with the resolve-before-job replacement test. Expected exported observations:

- start reads the getter once; getter call count is 1.
- Before drain, then invocation count is 0.
- After drain, getter count remains 1, original then invocation count is 1,
  replacement invocation count is 0, delivered value is 42, and trace is 1324
  (get, return from resolve, call captured then, fulfil reaction).

This addition needs parent/reviewer acceptance before execution if the desired
denominator is restricted to byte-unchanged existing test source strings.

## Concrete feasibility risk retained

The moved non-Promise resolution arm currently enqueues a null callback after
the callability predicate. The thenable job redispatches through the vararg
then method when that callback is null. The native-Promise own-then arm instead
captures the function into the callback field before queuing it.

Consequently, an ordinary object's callable getter may be read again at job
time and select the replacement. This is a source-reading prediction, not a
measured regression. The new trace row will expose it without changing the
compiler or its checker. If it fails on both arms, preservation can remain true
while semantic acceptance is false. Do not replace it with a native-promise
capture row and claim ordinary-getter capture has passed.

The old JS2WASM_ASYNC_CARRIER_WIDEN switch is retired in the actual baseline
scheduler. This sidecar does not use that obsolete switch or the old getter
test's throwing host stubs. Binary and declared imports must both be empty.
A resulting refusal remains in the denominator.

## Reproducible runner and unrun command

Prepared repository-path files:

- scripts/verify-promise-resolution-public-pair.mts
- scripts/fixtures/3518-promise-resolution-public-pair.json
- this handoff.

Runner SHA256:
13f3ef003d15cecdee9c9f8fc2263f2c2f7170ae63a3fc7fd49b31a41d62ba40.

Fixture SHA256:
fb38fbd8180ba54b029b5ec8034929b301d9ab5831f4879385aaebcb417fa0b8.

The runner is root-parameterized; no absolute host roots are embedded.
Outputs are restricted to the invoking instrument worktree's .tmp directory.
The output directory must be fresh. Do not delete prior receipts to rerun.

From /private/tmp/js2-3518-vector-grow-store-20260908, only after a new grant:

~~~sh
NODE_OPTIONS=--max-old-space-size=2048 \
TSX_TSCONFIG_PATH=/private/tmp/js2-3518-vector-grow-store-20260908/tsconfig.json \
TSX_DISABLE_CACHE=1 \
node --import tsx scripts/verify-promise-resolution-public-pair.mts \
  --baseline /private/tmp/js2-3518-explicit-rec-integration-20260908 \
  --candidate /private/tmp/js2-3518-promise-resolution-20260908 \
  --output /private/tmp/js2-3518-vector-grow-store-20260908/.tmp/promise-resolution-public-r1 \
  > .tmp/promise-resolution-public-r1-controller.log 2>&1
~~~

The controller spawns baseline then candidate, never parallel. Each child uses
its selected tsx loader/config, disabled tsx cache, a 2 GiB heap and scrubbed
compiler/loader overrides. GVN/ownership/escape/allocation/dominance/inline
controls are explicitly off; the two IR modes are distinct compile options.
skipSemanticDiagnostics is explicitly false: no checker waiver is added.

Retained evidence includes source census before/after, runtime/loader/harness
identities, fixture digest, launch and clean terminal receipts, exact binary
inputs, full WAT/resource ordering, imports/exports, IR outcomes, full errors,
and actual per-action values/traces. No difference normalization is allowed.

Authored comparator negatives cover missing row, wrong root, stale provenance,
substituted instantiation bytes, wrong expected value, and changed outcome.
They are **unrun**, as is the entire compiler pair. Static TS parsing passed
for the runner and all 12 recipe strings; this is not a typecheck.

Source-free prepared-consumer execution remains separate. This sidecar does
not establish resource closure, native-family acceptance or retirement.
