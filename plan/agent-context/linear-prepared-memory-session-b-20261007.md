# Session B: Linear Prepared IR memory handoff

Issue: [Linear Prepared IR memory materialization and ownership handoff](../issues/6905-linear-prepared-memory-materialization.md)
(6905). Branch `codex/6905-linear-prepared-memory-plan-20261007`, based on
canonical `3c671f11506f91f4eb91624cf9a8456ca95a6ce8`.
This is a specification and existing-control checkpoint, not an implemented
allocation route. Use the PR's actual immutable head for publication custody.

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
