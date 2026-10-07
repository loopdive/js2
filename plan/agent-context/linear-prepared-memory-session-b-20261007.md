# Session B: Linear Prepared IR memory handoff

Issue: [Linear Prepared IR memory materialization and ownership handoff](../issues/6905-linear-prepared-memory-materialization.md)
(6905). Branch `codex/6905-linear-prepared-memory-plan-20261007`, based on
canonical `3c671f11506f91f4eb91624cf9a8456ca95a6ce8`.
This began as a specification and existing-control checkpoint. The later section
records an implemented, used initializer extraction and new regressions; it is
still not an implemented shared allocation route. Use the PR's actual immutable
head for publication custody.

## Measured current-main control

Unchanged `tests/issue-3525-prepared-linear-early-return.test.ts`:
**17 passed / 17 tests**, one file, exit 0, zero skipped/pending.
The scalar application exercises genuine Prepared IR emission and legacy
reference binaries on both WasmGC and Linear, including generated-helper paths.
It does not prove allocation, string/vector carriers, async or full IR parity.

Command, in this worktree, with an external 240-second subprocess deadline:

```sh
pnpm exec vitest run tests/issue-3525-prepared-linear-early-return.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

Test SHA256: `8c3787b33a1d38dd42a261a1d8f40fdea10053a37816bef38c064f761387fd3d`.
Raw combined-channel log SHA256:
`5057f2b17ba35b094561c4a00b79e77f3f0d07eaefa9eb55397c6bd4949e5e21`.
Lossless raw log: `plan/log/6905-linear-prepared-memory-20261007/prepared-scalar-control.log.gz`.
Reported test duration 118.059 seconds; total 167.84 seconds. This is not a
performance comparison. No test or production source was changed for the run.

## Exact integration request to Session A

A retains `src/ir/program-physical-plan.ts`, `src/ir/program-consumer.ts`,
shared preparation, physical emitters and active source-map paths. B requests
that A publish a supported shared input contract and wire a B-owned resource
module under `src/backend/linear/` through acceptance, reservation, signature
conversion and body resolution. This is a proposal, not a scope transfer.

Current source proves why removing just the rejection would be unsound:

- `planPhysicalSetup` rejects Linear allocation sites.
- `physicalSignatureConverter` uses native GC vector/string carriers.
- `physicalBodyResolver` builds GC-native vector layout handles.
- `fillPrimaryBody` delegates to `fillPreparedPrimaryUnit`; the genuine
  per-backend emitter/resolver installation must preserve ownership evidence.
- `PhysicalModuleReservations` already owns memory/data reservation APIs;
  a target resource module must use those rather than mutate module arrays.

B's exact plan claim is `6905:prepared-memory-plan-20261007`, owner
`ttraenkler/codex-linear-b-memory-astra-20261007`. No source/test implementation
claim has been acquired. Astra High writes the plan; Sol 6.1 Medium implements
after concrete file/function partition and shared contract publication.

## Operational note

An initial dependency provisioning invocation accidentally omitted its worktree
argument and scanned registered worktrees. It left populated dependencies
untouched and linked missing dependencies, including B's prior isolated
worktrees. The exact owned provisioning process was stopped; the subsequent
invocation named this worktree explicitly and completed normally. No tracked
source, peer test process, signing setting or protection hook was changed.

The Mac has no configured commit signing; do not label this publication as
signed. Normal commit/push hooks remain required. A owns queue submission.
Legacy remains until full tested equality, not merely this scalar control.

## Implemented initializer and measured comparison (later checkpoint)

Publication: [PR #6577](https://github.com/loopdive/js2/pull/6577), same branch,
non-draft, `hold`, no automatic merge. A still owns coordinated submission.
This supersedes the earlier statement that no source/test claims exist; the
original scalar-control log above remains historical evidence on `3c671f`.

Canonical tested production epoch: `9e22f80ce60956ea2f397b4dfbe1cd46cdabac0a`.
Baseline HEAD `609286c99f06ea7abcfed51aebd33ecaec3f454c` contains the main merge
and earlier documentation, with production source equal to that canonical epoch.
V1 candidate HEAD `1d44c3e08359d50d8a6a15481bd24e14e9acb13a`;
V2 tested candidate HEAD `0ab3a68cf0744f2b4b56616ce7b505998d62d7fc`.
Later publication commits add only documentation/evidence; read the PR head for
the final exact publication hash. Upstream advanced externally to `6e5a583e56553c6066646591d1637c45c15e99e8`
during this frozen comparison; its advance changes no relevant shared contract
and is not a scope release or a claim that this later epoch was tested.

Implementation commit `af5cdbf4bf8af89344a4434336a13fc2ec8c39f5` extracts
`buildLinearF64VectorInitializationBody()` into
`src/codegen-linear/runtime/vector-initialization.ts`. The existing
`runtime.ts::addLinearIrVecRuntime` calls it directly. Registration, idempotence,
value-first `(f64,i32,i32)->()` ABI, seven instructions and store layout remain.
Fresh arrays and instruction objects are returned; no module mutation, allocator
copy or shared compiler/index/source-map edit. Folder README records this boundary.

### Exact claims and owned files/functions

Verified canonical claim snapshot tip `a761ce321a03ad824b0d02ef87aeed0353e836d7`
contained 973 held claims and exactly these B slices under issue 6905:

- `prepared-memory-plan-20261007`: `ttraenkler/codex-linear-b-memory-astra-20261007`, parent plan branch; Astra High owns the issue plan.
- `prepared-memory-regression-20261007`: `ttraenkler/codex-linear-b-memory-tests-sol61-20261007`, branch `codex/6905-linear-prepared-memory-tests-20261007`; Sol 6.1 Medium owns only the new issue-6905 test.
- `vec-initializer-body-20261007`: `ttraenkler/codex-linear-b-vec-initializer-sol61-20261007`, branch `codex/6905-linear-vec-initializer-source-20261007`; Sol 6.1 Medium owns only the initializer function/import and new vector-initialization leaf.
- `runtime-body-docs-20261007`: `ttraenkler/codex-linear-b-memory-docs-20261007`, parent plan branch; parent owns runtime README and publication custody.

The issue reservation remains `ttraenkler/codex-linear-b-prepared-memory-20261007`.
All claims use `CLAIM_ASSIGN_REMOTE=upstream`. None supersedes A or allocator-owner
claims; none is complete/on-main. No shared source ownership transfer was received.

### Preserved test populations and observations

V1 new test SHA `dc1fc260e3a8239cb87056d3b38e32db97e0645d9c8079ec3dec08c3a8e2c002`.
Both arms: **23 passed / 2 failed / 25**, exit 1, zero skipped/pending: unchanged
scalar control **17/17** plus new source/unit population **6/8**.
Baseline total 157.77s; candidate 145.91s. These are not performance conclusions.
All eight new observation objects matched exactly, including emitted unit bytes.

V1 overlay failed before generation because its extensionless module filename
produced `[undefined]` in source ASTs; original test and failure logs are retained.
V2 changes only the overlay row's module filename to `issue-6905.ts`.
V2 SHA `d63ce7141a98425a490405127cbbd63e382f5de857ebb8031c15da2a64ce7d31`.
Both arms: **7 passed / 1 failed / 8**, exit 1, zero skipped/pending.
Baseline total 64.07s; candidate 62.21s. All eight observation objects match
exactly; all seven untouched rows match V1→V2 in each arm. The 17-case control
was measured on each V1 arm, not rerun or reattributed to the V2-only instrument change.

Passed new rows: native 1.25; genuine shared scalar 1.25; direct allocation 1.25;
real overlay body and initializer caller 1.25; exact ABI/idempotence; fresh-object
custody; real allocator-backed vectors with four fractional stores and exact
surrounding-memory/headers/heap preservation. Unit evidence is not Prepared coverage.
The overlay verifies actual current module/preparation/emission identities,
one initializer registration and two bound initializer calls—not a stale report.

The remaining ordinary positive shared allocation test fails during preparation:
`array-representation-unsupported`, resolver cannot register vec for array literal
`run`. Actual receipts: prepare 1, accept 0, emit 0; all legacy/overlay calls 0.
This precedes the known planner refusal. Do not remove just that refusal.

Commands: both V1 arms run the new test plus
`tests/issue-3525-prepared-linear-early-return.test.ts`; V2 arms run the new test
alone, all with `pnpm exec vitest run`, `--pool=forks`,
`--poolOptions.forks.singleFork=true`, `--no-file-parallelism`, external 300s deadline.
Runs were serialized; source/toolchain/settings and every fixture were frozen.
Raw gzip logs and comparison JSON are in `plan/log/6905-linear-prepared-memory-20261007/`.

### What A must publish next

1. Shared frontend representation/admission for this unchanged real array source.
2. The detached allocation-facts projection contract and reservation-compatible
   runtime reuse; initializer body reuse is now available without module mutation.
3. Explicit shared planner/consumer/signature/body/scratch wiring, or a bounded
   file/function handoff. B's proposed memory module stays unimplemented until a
   real contract/caller and ownership partition exist.

A's published coordination doc was read through GitHub-backed canonical refs;
B's request is published here and in the issue plan. There is no two-way
acknowledgment or shared scope release yet. PR remains held because the positive
shared allocation requirement is red. Legacy retirement and full IR migration
are not justified by this preservation checkpoint.

### Final V3 custody and test-inclusive typing

V2 strict TS7 reported twelve test-only diagnostics because the heterogeneous
generator-spy array erased its index-specific return types. V3 adds only
`as const` to that array: no `any`, module cast, configuration weakening or
behavior/fixture/assertion change. Original V2 test and diagnostics are retained.
Strict TS7 then returned **exit 0 / zero diagnostics**, with all source files and
this exact new test included via `.tmp/6905-validation/tsconfig-test.json`.
Command: `node node_modules/typescript7/lib/tsc.js --noEmit -p` that config,
external 180s deadline. It extends `../../tsconfig.ts7.json`, rootDir `../..`,
includes `../../src/**/*.ts` and the exact new test, excluding node_modules/dist/website.
The ordinary root push typecheck alone does not include new tests.

Final test SHA `0afcb36a4cb3e783a06191bfe6356d568d96791d7aeca8249bfcdd580eac8d77`;
tested candidate HEAD `4ad7fd4279b40273f0d01200e32ab38fc86c3ad0`.
V3 new-file-only runs: **7 passed / 1 failed / 8 in each arm**, exit 1,
zero skips/pending; baseline 52.14s, candidate 56.38s. All eight complete
observation records match baseline/candidate and V2→V3 separately in both arms.
The shared preparation failure remains unchanged. No performance credit.

Archive `compare-rows.mjs` reads raw logs, positively floors eight unique rows
and one provenance/population record per input, compares every row object
without normalization, and fails on disagreement. Two-input mode compares all
eight rows; four-input V1/V2 mode excludes only the deliberately repaired overlay
row from within-arm version comparisons while comparing all eight across arms.
Use two-input mode for each V2/V3 comparison; all eight must agree.
Versioned lossless raw logs, original tests, typing diagnostics and generated
comparison JSON are published alongside it. Reproduce by decompressing the
named log archives and passing those raw paths to this script.
