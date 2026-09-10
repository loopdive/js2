---
id: 5807
title: "Bisect two BigInt TypedArray regressions blocking semantic-provider landing"
status: in-progress
created: 2026-09-09
updated: 2026-09-10
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

## Completed paired replay: failure reproduced in both commits

Corrected workflow run34417885898 finished both jobs successfully as complete
diagnostics; both Vitest processes returned1. Parent independently validated all
four historical/replay completion manifests:939 registered/canonical rows each,
zero exclusions. The constructor target now fails on BOTH donor129e and candidate
efa with the original opaque-BigInt64Array marshalling error. Historical donor
PASS remains preserved. Three controls selected from original shard evidence
during the replay remain PASS in all four populations; they were not predeclared
independent controls and do not clear the regression.

Both replay arms have748pass,171fail,15compile_error,1compile_timeout,4skip.
The donor loses exactly the constructor pass relative to its historical run;
the candidate status population is unchanged. Named verdict fields (status,
error, error_category, oracle_version, oracle_lane, semantic_providers, scope,
scope_official, strict, reached_test) are equal between the replay arms. Three
dynamic-import error texts differ from historical records without status changes.
This is not byte equality or full-row equality and does not identify cause.

Independent review confirmed all four populations and the replay verdict-field
comparison. The three dynamic-import error texts gain `/subject/` in missing-module
paths; retain these literal differences. Original donor/candidate logs contain
one/two OOMs, versus two/three in replay. Candidate replay records SIGABRT and a
fresh-worker retry for `test/built-ins/Object/defineProperty/15.2.3.6-4-155.js`;
that test has retry_count1 in all four canonical records. Constructor rows have
no retry/PID/request fields, so this does not attribute their failure to a worker.

Donor runner image20260831.293.1 matches the original image; candidate image is
20260907.300.1. Node25.9.0/Linuxx64/pool4 and pinned corpus/provider admission
passed in both. Runtime history and scheduling remain unproven. These observations
contradict a simple deterministic candidate-only explanation, not the original
failure record. Do not waive it, claim flakiness, or repeat the run merely for green.

Evidence: [replay summary and complete file-hash inventory](../agent-context/5807-linux-shard34-replay-evidence-2026-09-10.json).
Artifacts10130095338/10130101382 remain on run34417885898; local originals are
preserved at `/private/tmp/js2-5807-linux-replay-results.WJtxny`.
Next diagnosis is to trace the demonstrated opaque-value marshalling failure and
its dependency on compiler/worker state. No causal fix, merge or retirement
clearance exists. Shard31/BigInt set remains outside this approved replay.

## Approved observation-only follow-up

The user approved the paired diagnostic tracing run on 2026-09-10. Preserve
the same two historical commits, corpus, provider, and all 939 shard paths.
No reset intervention, fixture edit, exclusion, oracle change, or regression
waiver is authorized by this diagnostic. The prior four raw populations remain
the historical evidence; instrumented execution is explicitly a new experiment,
not an unmodified historical replay or proof of byte equality.

The linked instantiate branch resets its decoder registry; the non-linked branch
does not. A local empty-Wasm probe with an injected reset counter observed
linked/non-linked/linked counts 1/1/2. The original shard contains 90 Temporal
paths, but registration order does not prove worker dispatch order. Independently,
the exact constructor fixture requests only `passthrough`, while its error suffix
names `makeArray`; the callback ignores the factory argument. Do not infer a
factory invocation from that suffix.

Implementation: admit clean historical sources before installing exact,
hash-checked observation patches. Observe request/worker lifecycle and available
decoder state at the existing failing boundary without new decoder calls or
property reads that might change behavior. Mark unavailable observations explicitly.
Verify that only the exact approved patches differ afterward, preserve patch
receipts and traces alongside original verdicts, and reject empty or incomplete
diagnostics rather than treating them as clearance. Review tracing tooling and
negative controls before pushing to existing PR5798 and starting the two jobs.

Separately, PR5809 (`chore(ci): refresh npm-compat artifacts`) reached main at
`035b760edc661e48f1069339ffaa8624683d5d3d`; reviewed head `95e60a484d0e692f8105f7672fd8d564164e4a82`
is an ancestor. This data-only delivery does not clear the IR hold.

Pre-launch verification: 59 tracing tests plus four replay-guard tests pass
(63/63, no skips). The exact transforms syntax-check for both historical pins.
Parent also installed and verified the instrumentation in a new disposable donor
checkout at `/private/tmp/js2-5807-trace-install-check.06XSun/subject`, without
executing a compiler or fixture. Installer SHA256:
`3d23c7d9ead75f8b6a5a388fbe2dcd5faff388f7426cc7858a006ee6b5fdd911`;
patch-file inventory SHA256:
`56c04cec43e1be6a870833fd5b22d69c0e69da67e2d610d3072c9f0d2f4e519c`.
Tests prove bounded observation properties, not the constructor's cause.
Factory identities are unavailable without extra compiled reads; abrupt worker
death can leave an unknowable final trace tail. Both limits remain explicit.
Artifact upload retains traces and hash receipts, not full patched source files.

## Observation run complete; failing state not captured

Run34424328148 completed both diagnostic jobs (candidate12m1s, donor12m41s).
Both original Vitest exits remain1. Parent independently reran the original
completeness validator and trace audit:939/939 rows, zero exclusions,34 trace
streams/33 workers/1620 dispatches and two target requests in each arm.
Both images are20260831.293.1. Both populations contain749pass,170fail,
15compile_error,1compile_timeout,4skip; all ten named verdict fields compare
equal between these instrumented arms, not complete rows or Wasm bytes.

The constructor target passes primary and strict variants in both arms. Donor
worker3501 and candidate worker3422 record no preceding linked instantiation,
28 empty/disabled registry observations each, no selected peer decoder, no
constructor refusal, and four existing mirror-length reads of3 each. Thus this
run does NOT capture the retained-state failure hypothesis. It neither proves
that hypothesis nor explains away the earlier failures. Observation/scheduling
effects have not been separated; no reset intervention or causal fix occurred.

Compared with the uninstrumented replay, only the constructor's named verdict
fields change (fail to pass). Historical comparisons also retain the three
literal dynamic-import error-path changes. All prior failures remain preserved.
The BigInt set regression and cumulative IR hold remain unresolved.

Evidence and96-file extracted hash inventory:
[observation replay evidence](../agent-context/5807-observation-replay-evidence-2026-09-10.json).
Raw artifacts10132355779 (donor) and10132338406 (candidate) are retained locally
at `/private/tmp/js2-5807-observation-results.jjunUu`. Archive digests are
API-reported; extracted files were independently hashed. Do not rerun simply
to obtain green. Next causal test must explicitly distinguish prior linked
worker history from observation effects while preserving original fixtures;
any reset intervention remains a separately reviewed action.

Independent review reproduced both trace audits and reconstructed all six
instrumentation postimage hashes per pin against the receipts. This is not a
comparison against omitted uploaded source bytes or generated Wasm. Donor's
target worker had six earlier requests; candidate's had seven; all ended
normally without recycling. Both workers were replacements after
`Boolean.prototype.Symbol(Symbol.search):added` realm-drift recycling, and
neither had a preceding linked request or reset. All trace streams lack exit
markers, so final unwritten tails remain unknown. The original failing workers'
corresponding histories are unavailable; do not infer them from these replacements.

## Bounded local controlled-history diagnosis

Next diagnostic uses four serial, fresh one-worker pools: target alone and
linked seed followed by target at each historical pin. The seed is
`test/built-ins/Temporal/Duration/from/argument-string-invalid.js`, the
lexicographically first of66 Temporal fixtures passing all six preserved
populations. Its observed linkedModules1/PASS/no-recycle events establish an
actual linked positive control. Keep original fixture bytes and original
primary/conditional-strict assembly; at most12 requests across the four pools.

No reset or registry manipulation is added. Reject a seeded trial if its seed
fails, does not link, or its worker crashes, times out, recycles, retries, or is
replaced before the target. Record identity/history rather than inferring it
from completion order. Use a separate controlled-history checker; never reduce
the existing939-row replay gate. Equal outcomes remain inconclusive.

Subjects and independent corpus checkouts are newly created under
`/private/tmp/js2-5807-controlled-history.Di6H7Q/{donor,candidate}`; protected
originals are untouched. A fresh1.2GiB dependency copy has2204 symlinks, all
resolving inside that copy. Both original provider caches and the exact reviewed
observation patch are installed. Node25.9.0 is the previously retained Darwin
ARM64 binary. This local one-worker/order-controlled diagnostic is not Linux
reproduction and cannot clear either historical regression on its own.

## Controlled history result: shared failure reproduced locally

All four serial trials completed with diagnostic exit0, ten actual requests
out of the twelve-request maximum. At donor129e3efd4530ae1be56dbf5fdea54ddbbd87443e
and candidateefa0908e09998c73da592fba32708c7ecca8d6e5, target-alone primary and
strict both PASS. In each seeded pool, both original Temporal seed variants
PASS, then the target primary FAILS with the preserved error:
`cannot marshal opaque compiled value to host BigInt64Array constructor (Testing with BigInt64Array and makeArray.)`
The original conditional rule correctly omits the target strict rerun after
failure. Diagnostic exit0 means complete evidence, not a passing target.

Both seeded traces preserve one original worker across all three requests,
actual linkedModules1 for the seed and0 for the target, and a warm provider
cache. The seed's strict request registers decoder identities subsequently
retained during the target. Each target selects one retained peer decoder,
observes an undefined mirror length, and records one constructor refusal.
Alone, neither pin selects a peer; all four existing mirror-length reads per
trial are numeric3. Both existing resets occur during seeded requests; no reset
was added and neither target resets. All four post-run source, fixture, corpus,
dependency, bundle and provider comparisons passed. Independent parent trace
audits also passed with exact request populations.

This reproduces a shared worker-history-sensitive failure on the older pin as
well as the candidate. It does not prove that registry retention alone caused
it: the preceding Temporal workload changes more than that registry. It does
not establish the original failing Linux workers' history, clear the BigInt
set regression, authorize a baseline promotion, or release the cumulative IR
hold. No production runtime changes or further cloud runs were made.

Reproducible driver: `scripts/issue-5807-controlled-history.mjs`; its62 synthetic
tests plus the unchanged observation/replay tests pass125/125 on Node25.9.0.
Prepared inputs: [setup receipt](../agent-context/5807-controlled-history-setup-2026-09-10.json).
Results, decisive trace records, exact pins, and raw-file hash inventory:
[controlled-history evidence](../agent-context/5807-controlled-history-evidence-2026-09-10.json).
Raw logs, admissions, results and traces remain in the four exclusive trial
directories under `/private/tmp/js2-5807-controlled-history.Di6H7Q`; do not
overwrite, retry in place, or delete them.

Independent subagent review verified50/50 final artifact hashes and matching
fixture/assembly hashes across all trials. In each seeded trace the retained
seed decoder reports `years,months,weeks,days` for the target's object instead
of the target-local decoder. The four original controller trace inventories
were captured before controller exit: each later hash discrepancy reconciles
exactly to one appended `observer-exit` line. Those original receipts remain
unchanged; the published final inventory hashes the complete files after exit.

Next reviewable step is a narrowly scoped intervention proposal at the
linked-to-nonlinked transition, with original failures kept as controls and
exact fixture preservation. A registry-only intervention must be distinguished
from broader linked-project/realm cleanup and tested on both pins before any
causal or repair claim. That intervention remains unapproved and unexecuted.

## Approved registry-only attribution experiment

The user approved the outstanding six local trials after the controlled-history
checkpoint. This supersedes the preceding unapproved status for the diagnostic
only, not for production runtime changes or regression clearance.

At each historical pin, use three fresh seeded one-worker pools: unchanged
observation-only control, diagnostic hook present but inactive (sham), and the
same hook with decoder-registration reset enabled. Maximum24 requests, original
fixture bytes and primary/conditional-strict behavior, no driver retries.
Keep all previous trial roots and receipts unchanged. New isolated subjects
are under `/private/tmp/js2-5807-registry-intervention.AyGZPo`.

The diagnostic export calls only `_crossModuleStructs.reset()`: do not call
`resetLinkedProjectRegistry()`, which also resets linked mirror ownership, or
Temporal realm cleanup. Invoke through the worker's existing runtime bundle
immediately before target `buildImports`, after successful compilation, only
for the exact nonlinked target. Preserve seed behavior and normal resets.
The reset clears decoder registrations/enabled state, not the ownership/state
WeakMaps; do not claim otherwise. Sham and active hook source/bundle bytes must
match; original control distinguishes the effect of merely adding/rebuilding
the hook. Use a separate intervention-aware audit, retaining the original
observation-only target-reset prohibition. Record final hashes after exit.

Require both seed variants to pass and actually link in the same surviving
worker. Original and sham must reproduce the exact constructor failure for
attribution. Preserve every outcome, including strict-variant failures. A
rescue shows only local sufficiency of retiring decoder registrations; it does
not prove the historical Linux worker history or justify a production repair.

Queue-drain side result: artifact PR5810 landed at
`1429cfdf2167f31532d70c5304430a9300c2a982`; reviewed head09f343dcae is an
ancestor and all six reviewed artifact blobs match the merge. Both differential
gates preserve115/120 matches with zero new regressions. The separate unchanged
workflow assertion failure remains documented in that PR. This data-only
delivery does not clear this issue or the cumulative IR hold. Fresh queue
count35; no PR targets the artifact branch, so no dependent retarget is needed.

Preparation admission caught one changed Vitest results-cache file in the
dependency copy. No package code differed. Preserve that rejected tree at
`node_modules-rejected`; the replacement copied from the earlier controlled
trial now matches its full census exactly. Six source/corpus/provider admissions
pass, with zero fixture requests executed. Receipts:
[dependency mismatch](../agent-context/5807-registry-intervention-dependency-drift-2026-09-10.json)
and [preparation](../agent-context/5807-registry-intervention-preparation-2026-09-10.json).

Parent review rejected the first unexecuted installer draft because it added
hooks to the original control and generated different sham/reset worker source.
The correction must prove original output equals the published observation-only
patch and sham/reset overlay source and rebuilt bundles are byte-identical;
only the admitted runtime switch may differ. No diagnostic execution is allowed
before those tests and the final installer review pass.

## Intervention V1 stopped on a diagnostic defect

The first two admitted trials have exited; six requests were consumed. Donor
original has two passing seed variants and the exact opaque constructor failure
on the primary target (valid diagnostic, controller exit0). Donor sham has two
passing seed variants, then `compile_error: invalid decoder-only intervention
target/linkage` before target instantiation (invalid diagnostic, exit2). No reset
intervention ran. The other four trials remain unexecuted; do not run their V1
overlay or overwrite any trial directory.

Both pinned workers normalize raw `msg.target === "gc"` to local
`target === undefined`. V1 incorrectly required local `target === "gc"`;
its synthetic hook tests repeated the same wrong assumption. The corrected
installer checks both the raw GC request and normalized undefined value. Two
new contract tests extract and execute the actual normalization function from
both pinned git blobs. The five diagnostic test files pass218/218, without
executing additional historical fixtures or changing runtime production code.

The executed V1 driver is frozen at
`/private/tmp/js2-5807-registry-intervention.AyGZPo/control-v1/issue-5807-registry-intervention.mjs`,
SHA256 `f8046fb560338ab9310e5cd905208c89d707a5f84aa563a929c974cb7c7d9c7b`.
Existing receipts bind that version, not the corrected installer. Do not
re-audit old subjects using the changed control file and relabel the evidence.
The independent post-exit collector captures all34 raw files across both trials,
including all four trace streams even though sham's final audit is null. Its
19 synthetic tests pass; complete raw capture is not diagnostic acceptance.
See [unchanged V1 outcomes and final hashes](../agent-context/5807-registry-intervention-v1-evidence-2026-09-10.json).

Next intervention execution requires fresh versioned subjects and an explicit
request-budget reconciliation; preserve the invalid attempt in every report.
No production fix, Linux causal attribution, TypedArray `.set` clearance,
baseline relaxation, or IR retirement certificate follows from this checkpoint.
