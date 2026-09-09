---
id: 5807
title: "Bisect two BigInt TypedArray regressions blocking semantic-provider landing"
status: in-progress
created: 2026-09-09
updated: 2026-09-09
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bug
area: ir, runtime, test262
language_feature: typed-arrays
goal: ir-full-coverage
sprint: current
related: [3518]
origin: "Actual PR 5751 merge-group regression gate; GitHub issue 5807"
---

# Landing blocker

## Updated landing state

PR5751 subsequently merged at 2026-09-09T16:31:32Z as
`efa0908e09998c73da592fba32708c7ecca8d6e5`. Its exact head and merge commit
are ancestors of main `96c4970002f09ea90c4c5620f4076643250fd2a8`.
Run34374533493 still reports failure; no causal fix or regression clearance
has been established. Thus the failure below now concerns landed code, not an
unmerged PR. Keep the dependent cumulative PR5798 held pending reconciliation
and its remaining composed validation. The original failure record follows.

[GitHub issue](https://github.com/loopdive/js2/issues/5807) tracks the actual
failure of PR5751 candidate `efa0908e09998c73da592fba32708c7ecca8d6e5`
(PR head `1330f172f78ed794915ffabeacbf2c39cf5bea07`). Run34374533493,
regression job102551653768, compared48735 baseline and candidate rows:
38384 to38382 passes, two regressions, zero improvements. The verified donor
is `129e3efd4530ae1be56dbf5fdea54ddbbd87443e`; corpus is
`b363f29d3c43c626dc852744ad64a0b48a003693`. No quarantine transitions were
excluded. Compile timeouts stayed16; out-of-bounds category grew11 to12.

- `test/built-ins/TypedArray/prototype/set/BigInt/array-arg-src-values-are-not-cached.js`:
  pass to fail, RangeError offset out of bounds; candidate records one retry.
- `test/built-ins/TypedArrayConstructors/ctors-bigint/object-arg/new-instance-extensibility.js`:
  pass to fail, opaque compiled value cannot marshal to host BigInt64Array.

These are blockers, not waived historical noise. Both raw CI rows lack
`wasm_sha`: the comparator's hash-change classification is not independent
byte/hash evidence. Passing rows can report strict-rerun imports while primary
failures never reach that variant; missing `__extern_set_strict` is not alone
causal evidence. PR5751 was held at diagnosis; dependent PR5798 remains held.

## Current evidence and limits

The existing dynamic-chunk/shared CompilerPool runner, Node25.9.0, honest host
gc lane and providers auto passed3/3 rows on each exact root. The third row,
non-BigInt constructor object-argument extensibility, is independently PASS in
both original CI artifacts. Both local shard receipts contain exactly three
registered, settled canonical rows. Local execution was macOS ARM64 with one
worker, not Linux x64 with four workers and the original shard history.

A separate older fresh-per-row artifact driver produced6/6 passing variants
per root; independent comparison found all six same-variant Wasm pairs byte
identical. Its admission metadata is incomplete, so this is bounded diagnostic
evidence, not an authoritative CI reproduction or permission to re-enqueue.
No causal source fix or flakiness claim is established.

## Implementation plan

### Recovered shard-34 provenance

Baseline job102525608071 (run34368952422) downloaded Temporal artifact10111137104;
candidate job102544492575 (run34374533493) downloaded artifact10113341443.
Their own shard logs establish Ubuntu24.04.4 image20260831.293.1, Node25.9.0
Linux x64, pool4, worker/fork heaps1024MiB, gc, proposals included, chunk33/52,
empty path filter and939 complete canonical verdicts without exclusions.
Both provider Wasm files independently hash to
`1e277d9b4bc3e634f5838bdeff0f8088f56dba8c7e8a394ee38c2c63286df18b`;
both stamps use key `372a41be9bdeb22ade63a811b4b26afce75694ee0d9b7cf928c24ddad739020b`
and size1702133. Build times differ, provider bytes do not.

Own logs are preserved in `/private/tmp/js2-5807-shard34-provenance.oIbwng`;
provider artifacts in `/private/tmp/js2-5751-temporal-provider-evidence.NcNzcW`.
The baseline also recorded an OOM; candidate recorded two. There is no target
request/worker attribution, so these events do not establish cause.

Minimum history-preserving workload replay is the exact ordered939-path shard
per root on Linux x64 with the original provider cache and runner settings,
plus separate genuine passing controls. Membership, complete receipts and
variant/retry status must be checked. Scheduling remains unrecoverable from
registration/completion order alone. Local Docker currently exposes ARM64,
not a verified equivalent x64 runner; no provisioning or replay has occurred.
The existing workflow has no bounded single-shard dispatch input. No full
matrix run or workflow modification is implied by this plan.

1. Preserve the original donor/candidate rows, actual gate and shard evidence.
2. Recover exact shard membership and observed worker-request history; do not
   infer per-worker predecessors from timestamps without a worker mapping.
3. Reproduce the failure under the relevant original conditions with a genuine
   passing control. Trace emitted carrier projection, initialization authority
   and host marshalling to the first demonstrated divergence; bisect as needed.
4. Independently review a minimal fix and regression coverage. Preserve live
   getter reads and rejection of genuinely unsupported opaque values.
5. Push to the existing landing PR, validate through the real protected gate,
   then refresh dependents after actual main delivery. Never weaken a gate,
   quarantine, baseline, population or test to admit this failure.

## Acceptance

- [ ] Original failure conditions reproduced and cause attributed.
- [ ] Minimal fix independently reviewed with both exact rows and controls.
- [ ] Actual candidate conformance gate passes with verified donor provenance.
- [ ] Fixed content reaches main; affected dependents are refreshed.

Full prepared async execution and direct-codegen retirement remain separate
unfinished requirements of3518. Resolving this blocker does not complete them.

## Approved bounded Linux replay (2026-09-10)

The user approved adding a diagnostic Linux x64 workflow on existing PR5798,
running the exact 939-path shard against both historical commits. This is
shard34 (index33/52) and contains only the constructor-extensibility regression.
The BigInt set regression is in shard31 (942 paths); it is not covered or waived.
No full matrix, baseline promotion, unrelated test filtering or merge is allowed.

The additive `issue-5807-linux-replay.yml` pins two checkouts, Node25.9.0,
pnpm10.30.2, pool4 and worker/fork heaps1024. It downloads original provider
artifacts10111137104/10113341443 and host shard artifacts10111668904/10113885435
(verified nonexpired). The wrapper requires the exact ordered939-path digest
`a96bc8efe43b6924c8d35af68d108a1ac1dd30a970d21212f8b0845971f5c737`,
the original corpus file census, complete receipts, and the unchanged provider
bytes. It runs the original dynamic shard without filtering or repartitioning.

Current ubuntu24.04 hosted image may differ from original20260831.293.1;
record both the actual image and this limitation. Original worker scheduling
cannot be reconstructed. A complete replay is diagnostic, not automatic
regression clearance. Upload all receipts/logs, including failures; do not retry
or expand repair scope merely to obtain green. Parent owns integration.

Initial run34417551787 stopped in pnpm/action-setup for both arms, before
dependency installation or compiler/test execution. The action rejects an
explicit plain version alongside the packageManager integrity-qualified pin.
Remove only the redundant workflow version; retain the exact historical package
pin and independently assert pnpm10.30.2 in admission. Preserve the failed run.
Setup inputs are now included in artifact upload even if no test receipts exist.
This setup correction changes neither test scope nor validation gates.
