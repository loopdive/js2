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
causal evidence. PR5751 and dependent PR5798 remain held.

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
