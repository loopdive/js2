---
id: 2097
title: "absolute standalone pass-count floor — high-water-mark backstop against compounding small regressions"
status: in-progress
sprint: 62
created: 2026-06-11
updated: 2026-08-30
assignee: ttraenkler/dv2
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: testing, compiler, standalone
language_feature: n/a
goal: host-independence
related: [2095]
origin: "2026-06-11 analysis program (report 06 §4); stub 08-C12"
---

# #2097 — a moving floor ratchets nothing

## Problem

The #1897 standalone regression floor is MOVING (re-seeded from the new
baseline on every push to main), so a sequence of small net-negative PRs
each within tolerance compounds without any ratchet catching the trend.

## Root cause

Tolerance-vs-rolling-baseline design — no absolute reference.

## Plan

Commit a standalone high-water mark (like
benchmarks/results/test262-current.json); a weekly job (or a step in the
sharded workflow) asserts standalone pass-count ≥ high-water − 50, with
the mark auto-raised on improvement.

## Acceptance criteria

- High-water file committed and auto-raised; breach fails loudly with the
  trend window in the message

## Dupe check

#1897 (merged) is the per-PR rolling gate; the absolute backstop is
unfiled. New (analysis program).

## Resolution (2026-06-16, dv2)

**Committed high-water mark.** `benchmarks/results/test262-standalone-highwater.json`
holds the absolute standalone pass-count floor reference
(`{ pass, sha, generated_at, tolerance }`), seeded at the current published
standalone baseline (`pass: 21184`, full corpus). It only ever ratchets UP.

**Check script.** `scripts/check-standalone-highwater.mjs`:
- reads the merged standalone report's `full_summary.pass` (matching the
  standalone JSONL row count),
- asserts `pass ≥ mark.pass − tolerance` (default 50) — on breach it fails
  loudly with the slide magnitude, the mark's commit/timestamp (the trend
  window), and a re-seed pointer; exit 1,
- with `--update`, RAISES the committed mark when pass improved (never lowers).

**CI wiring** (`.github/workflows/test262-sharded.yml`):
- A `Standalone pass-count high-water floor (#2097)` step inside the **required**
  `merge shard reports` job (right after the standalone report build) runs the
  assert, so a compounding slide below `mark − tolerance` blocks the merge
  queue — independent of the moving #1897 per-PR floor.
- In `promote-baseline` (push:main), a `Raise standalone pass-count high-water
  mark (#2097)` step runs `--update`, and the raised file is staged into the
  same atomic main-repo summary commit (`stage_files`). So the mark auto-rises
  with conformance and is never silently lowered.

### Acceptance criteria — met
- ✅ High-water file committed and auto-raised (promote-baseline `--update`;
  ratchet verified: raises on improvement, refuses to lower).
- ✅ Breach fails loudly with the trend window (commit + timestamp + slide
  magnitude) in the message; gated inside the required `merge shard reports`
  check.

### Files
- `benchmarks/results/test262-standalone-highwater.json` — committed mark.
- `scripts/check-standalone-highwater.mjs` — assert + ratchet.
- `.github/workflows/test262-sharded.yml` — required-check assert step +
  promote-baseline auto-raise + stage.
- `tests/issue-2097-standalone-highwater.test.ts` — decision-logic unit tests.

### Test Results
- `tests/issue-2097-standalone-highwater.test.ts` — 7/7 pass.
- Script smoke (within-tolerance pass, breach exit 1, ratchet raise/refuse) —
  all correct.

## 2026-08-30 incident — recover the pre-existing 1,295-pass slide

The #2097 backstop is working as designed. It blocked the protected IR merge
queue after exposing a genuine standalone host-free regression that predates
the queued IR branches. The repair must restore the lost behavior; it must not
lower, re-seed, bypass, or reinterpret the high-water mark.

### Frozen evidence

All authoritative measurements use the same **48,735-test** denominator:

| Revision / queue composition | Host-free pass | Delta from 33,876 mark | Evidence role |
| --- | ---: | ---: | --- |
| `fc6fd3b5f3df1fbce731bf74c391aca41fcd08c2` | 33,876 | 0 | committed high-water source |
| `01fb67624e2f645b7e92dd9f8e47478e3face9ba` | 32,581 | −1,295 | exact later main ancestor, already bad |
| #5297 atop `01fb676…` | 32,593 | −1,283 | first later complete queue measurement |
| #5295 only, `60f3707751b86f5701a7f4e771924293e3b6f762` | 32,717 | −1,159 | C37 is not the cause |
| #5295 + #5308, `8daa0d5be74e20cf9a01d7b1f5b779cdd7dfdeb0` | 32,719 | −1,157 | #5308 restores only two more passes |

The endpoint and queue evidence is content-addressed as follows:

| Evidence | Workflow run / attempt | Evidence locator / authority | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| `fc6fd3…` high-water source | Test262 Sharded `33228968210` | `js2wasm-baselines` commit `9657d806b1d6ed0f54256c74b390f232677bd8e4`, blob `f762926801f85f7bb630b53e9d727647ecc45d94` | 23,209,263 JSONL | `d3341cf6b6dbcc237f18f1461dc97dcddf1f2cbbfb944496d7ae73e8489adb87` |
| `01fb676…` forced snapshot | Baseline Refresh `33308136754` | persistent baseline commit `f0d6b57da9362471decffeb6f3d98d650d477bd5`, blob `3b99ba94b2a1a8625f869a84464bd497eeb732c0`; ephemeral artifact `9731533771`, `emergency-merged-report`, expires `2026-08-31T11:40:26Z` | 5,220,517 ZIP / 23,482,700 JSONL | artifact `1953f7c82a2446d1c1aac8a9b04f8f66fbb3633bd671573221b85e016c3bb8b0`; JSONL `5d6cb6e5a39fbb6e20c9ac655a1cc6987d6555c222ad42aab9dbb70b0ec23ff3` |
| #5297 first complete post-breach | Test262 Sharded `33306986588`, attempt 2 | ephemeral artifact `9731640668`, `test262-merged-report`, expires `2026-08-31T11:49:15Z` | 5,163,176 ZIP | `9c863f3a18531849f22d86c856f87a1b93f2e516689e2daa86f36422f1fcd4e7` |
| #5295 only | Test262 Sharded `33315219028`, attempt 3 | ephemeral artifact `9734619149`, `test262-merged-report`, expires `2026-08-31T15:35:27Z` | 5,157,789 ZIP | `c2206cb1696fa3a4e40ba8b22a6e8a1805e5b1b6ccf1da629e59c3ceaf1ac7a1` |
| #5295 + #5308 | Test262 Sharded `33317003311`, attempt 3 | ephemeral artifact `9734689995`, `test262-merged-report`, expires `2026-08-31T15:40:55Z` | 5,162,309 ZIP | `4d5c3f9b4f791a069c655b1a2a88170addef98212ac97b065483f03ab100e51e` |

The `fc6fd3…` Actions artifact has expired. Its promoted baseline blob, exact
byte length, and independently computed content digest are therefore the
persistent endpoint authority; the plan must not invent a live artifact ID or
claim recovery of streams GitHub no longer retains. The promoted `01fb676…`
JSONL is the other persistent endpoint authority. All four Actions artifacts
were authenticated through the API when recorded but expire on 2026-08-31;
the three downstream queue artifacts are ephemeral confirmation only, not
causal authority. Do not describe their IDs or archive digests as durable
unless their raw bytes are first copied into a separately authenticated
content-addressed store.

The refreshed combined queue head
`4f978ead0c022677f806c3c424f93fbe05e3a135` has the exact same tree,
`c3228e27325a217e374401638570944c6da1ba01`, as `8daa0d5b…`; rerunning that
tree cannot materially close the floor gap. Infrastructure cancellations may
require a failed-job rerun for evidence completeness, but they are not a
semantic repair.

The later protected merge-group run `33322681387` supplies the clean rerun for
the #5295-only composition: exact merge-group head `85f0925f…`, all 50
standalone shards and the Test262 regression check passed, no job was
cancelled, and the sole failure was the unchanged #2097 floor at 32,717 versus
33,826 (−1,159). It confirms the earlier #5295-only measurement byte-for-byte
at the aggregate-count level; it does not move either causal endpoint or
justify changing #5295.

The exact immutable `fc6fd3…` → `01fb676…` endpoint JSONLs contain **1,764 raw
host-free pass regressions** and **469 raw improvements**, net −1,295. The
fine-gate's post-quarantine view is a different population: **1,696 stable
non-timeout regressions** and **461 improvements**, net −1,235. Never combine
one side of the raw census with the other side of the filtered census.

Observed raw regression groups include 683 `assertion_fail`, 681
`other`-category outcomes (578 runtime failures plus 103 compile errors), 307
`host_import_leak`, and 39 `compile_timeout` rows. Those named groups account
for 1,710 paths; the remaining 54 regressions must stay explicit in the
canonical manifest rather than being silently folded into “other.” The
unchanged denominator rules out corpus growth as the explanation.

The canonical sorted 1,764-path high-to-low regression manifest is **147,235
bytes including its final LF**, SHA-256
`ad2a2e1fcc59c86ef95cc9815c759322a70669be4cc81c42f7d2a68b147cddac`.
It is a path-vector seed, not an acceptance summary. The operative predicate is
standalone `host_free_pass` under the exact no-host-import contract, not raw
`full_summary.pass` or an aggregate offset by unrelated improvements.

Intervening queue runs contain cancelled or incomplete shards, so current
evidence proves the bad interval but not one causal commit. Do not attribute
the regression to the nearest completed PR, to #5295, or to #5308 without
path-level replay.

A fresh depth-500 public clone proves that `(fc6fd3…, 01fb676…]` contains
**83 first-parent main transitions / 84 endpoint-inclusive snapshots** and
**332 reachable DAG commits**. The shared development clone is shallow at
`c882d1b…` and exposes only the final seven transitions; that truncated view
must never bound the causal search or be recorded as the interval census.

The `01fb676…` forced refresh is an authenticated measurement only: bypassing
the gate to publish evidence did not accept the regression. #5297 is the first
complete post-breach observation, not the first bad commit. #5295 and the
#5295/#5308 composition are downstream confirmations, not origin anchors.

### Non-goals and ownership boundary

- Do not change PR #5295 or #5308, their branch histories, or their semantic
  acceptance contracts.
- Do not lower `benchmarks/results/test262-standalone-highwater.json`, increase
  its tolerance, switch it from `host_free_pass`, skip the required job, or
  mark known regressions as passes.
- Do not weaken Test262 completeness, host-import leak classification,
  timeout/error accounting, or the moving #1897 regression gate.
- Do not treat runner cancellation, artifact absence, or a partial aggregate
  as acceptance evidence.
- Do not mix a speculative IR/legacy migration change into the diagnostic
  checkpoint. Production ownership is assigned only after the first causal
  boundary and exact path family are proven.

The diagnosis may read any commit in `(fc6fd3…, 01fb676…]` and existing CI
artifacts. Its first committed checkpoint is limited to this issue, a bounded
path-transition manifest, and reusable verifier/test assets if they are needed.
Once attribution is proven, amend this section with the exact production files
before assigning implementation to Terra. Coordinate with the parallel Claude
Program ABI/#3525 work and preserve every unrelated worktree change.

### Phase A — preserve and authenticate the two endpoints

1. Recover the full raw standalone JSONL/report evidence for `fc6fd3…` and
   `01fb676…` from the persistent blobs above. Record run ID, available
   artifact ID, exact compressed and JSONL byte lengths, SHA-256, Git blob,
   compiler SHA, runtime-provider SHA, Node/pnpm versions, Test262 revision,
   shard count, and exact command/environment contract. Mark the historical
   `fc6fd3…` Actions artifact as expired; do not manufacture unavailable raw
   stream evidence.
2. Validate each endpoint before comparison:
   - exactly 48,735 unique canonical test keys;
   - no missing, duplicate, malformed, or foreign row;
   - exact shard census and successful completeness validator;
   - every comparison row retained in the durable content-addressed JSONL;
   - available run stdout/stderr and artifact references retained without
     treating their historical absence as row evidence;
   - finite, non-negative load metadata where a local replay is used.
3. Produce one deterministic, sorted transition manifest. Every row names the
   test key, baseline/candidate statuses, host-import sets, compile/runtime
   outcome, timeout duration, and error class. Retain any content hash the
   authenticated historical row actually carries, but do not invent
   compiler/runtime/source hash aliases absent from the producer schema;
   endpoint and oracle provenance are authenticated separately. Canonical input
   reordering must not change the semantic-row or transition digest.
4. Add fail-closed manifest mutations for a dropped row, duplicate key,
   unknown path, wrong endpoint SHA, status rewrite, missing import set,
   malformed timing, and digest-preserving reorder control.

Raw 48,735-row reports need not be committed, but the plan and verifier must
make their content-addressed evidence recoverable. Compact totals without raw
or referenced rows are diagnostic summaries, not acceptance evidence.

#### Endpoint evidence schema correction (2026-08-30 Sol audit)

The persistent endpoint bytes contradict a hypothetical schema in which every
host-free row literally contains `imports: []`. Both the `fc6fd3…` stream at
baseline commit `9657d806…` and the `01fb676…` stream at baseline commit
`f0d6b57d…` are oracle-version 13, `oracle_lane: "honest"` producer rows. Their
producer records `imports` and `host_import_leak_class` only when the import set
is nonempty; an empty set is encoded by both fields being absent. This is the
authenticated historical producer contract, not permission for a generic
reader to guess that an omitted field means empty.

The Phase A verifier must therefore enforce all of the following:

1. Raw input authentication is mandatory and external to the report JSON. The
   immutable production policy supplies the expected byte length, SHA-256, and
   Git blob for each JSONL and each report JSON; the build API takes the raw
   bytes, and the CLI takes only paths to those bytes, then validates them
   against that policy before parsing. Neither production entry point accepts
   caller-supplied descriptors as authority. Optional lookalike fields inside
   mutable report metadata are not an authority. The frozen JSONL descriptors
   remain those in the table above.
   The newly recorded report descriptors are:
   - `fc6fd3…`: 108,028 bytes, SHA-256
     `e5626e5a57a37d9e29a051be0d5175e7771dd1cf5bf237065e43fbb586d82147`,
     Git blob `3b34346a96caef48484f939a7ca6d0c030802ccb`;
   - `01fb676…`: 110,636 bytes, SHA-256
     `8738617eefa12fe0bc54ddfb7773d21635b9bb6b68850a1b09ed4e3cc5584b20`,
     Git blob `7a033b31cb16947a1d1bfcbba2ddabe1a2734b62`.
2. The real producer schema is the semantic-row authority. Retain and
   canonicalize its timestamp, oracle version/lane/fast revision, file,
   category, status, error fields/signature, reached-test flag, timing, scope,
   official/strict/scope-reason fields, retry fields, import/leak evidence,
   vacuity/hard-error fields, and any actual Wasm hash. Reject an unrecognized
   key instead of silently dropping it from the endpoint digest. Every row's
   oracle identity must match the authenticated report metadata.
3. Only after the endpoint bytes, report bytes, endpoint SHA, oracle version,
   honest lane, and exact producer schema all authenticate may the historical
   absent pair (`imports`, `host_import_leak_class`) canonicalize to an empty
   import set and null leak class. Explicit nonempty imports remain sorted and
   deduplicated only in the semantic projection; inconsistent explicit fields
   fail closed. A future or unknown producer with omitted import evidence is
   refused.
4. Publish two different digests. The mandatory raw-byte descriptors are
   order-sensitive provenance. The full canonical semantic-row digest sorts by
   canonical test key and is invariant to input-row order while binding every
   recognized field. Reordering a stream must recompute its raw descriptors;
   only the semantic-row and transition digests remain stable. Never claim the
   entire manifest or raw endpoint digest is byte-identical after reorder.
5. Mutations cover oracle version/lane, timestamp, scope/retry fields, an
   unknown field, absent imports under an unauthenticated producer, wrong raw
   JSONL/report bytes/hash/blob, and a non-transition semantic rewrite, in
   addition to the Phase A mutations above. None may pass by recomputing only a
   transition digest.

6. Reconcile the authenticated report with the authenticated JSONL instead of
   treating the two raw descriptors as unrelated provenance. The two preserved
   report blobs have the exact top-level key set
   `baseline_generated_at`, `baseline_sha`, `categories`,
   `error_categories`, `full_summary`, `hard_errors`, `mode`,
   `official_summary`, `oracle_version`, `root_cause_map`, `scope_summaries`,
   `skip_reasons`, `strict_summary`, `summary`, and `timestamp`. Neither report
   carries `oracle_lane` or `oracle_fast_rev`; require version 13 from the
   report, bind honest lane and null fast revision through the externally
   authenticated endpoint expectation plus every JSONL row, and reject any
   contradictory optional report field if a future producer adds one. Derive
   `total`, every verdict-status count, `compilable`, `host_free_pass`, and
   `stale` from the complete parsed JSONL and require exact equality with the
   report's `full_summary`; require `total` to equal the expected-key census.
   Add mutations for a mismatched report total, status bucket,
   `host_free_pass`, `compilable`, and stale count. A byte-authenticated report
   paired with a different byte-authenticated JSONL is not a valid endpoint.

The raw-free form of the manifest verifier is a structural/content-address
validator only: it can validate canonical transition rows and the format of
the endpoint digests, but it cannot recompute semantic endpoint evidence from
bytes it was not given. Acceptance and CLI publication must always invoke the
authenticated build/replay path with both raw streams and their immutable
descriptors. Tests must prove that simultaneous edits to endpoint totals or a
non-transition semantic digest are rejected when authenticated build options
are supplied; documentation and call sites must not describe raw-free
verification as provenance authentication.

#### Pinned Phase A endpoint policy

The issue-specific CLI and acceptance wrapper must not accept caller-invented
descriptors as authority. Pin the following policy in source and require an
exact match before parsing:

| Endpoint | Tested commit | Baseline-store commit / tree | JSONL path / blob | Report path / blob | Report mode |
| --- | --- | --- | --- | --- | --- |
| baseline | `fc6fd3b5f3df1fbce731bf74c391aca41fcd08c2` | `9657d806b1d6ed0f54256c74b390f232677bd8e4` / `135a3c26544ea44409d93e8f3b9e7d6bfcc3326b` | `test262-standalone-current.jsonl` / `f762926801f85f7bb630b53e9d727647ecc45d94` | `test262-standalone-current.json` / `3b34346a96caef48484f939a7ca6d0c030802ccb` | `target=standalone`, `include_proposals=0`, `official test262 (default scope)` |
| candidate | `01fb67624e2f645b7e92dd9f8e47478e3face9ba` | `f0d6b57da9362471decffeb6f3d98d650d477bd5` / `aa8f1f95b9d3da3c5ae60d3a71abe53d23733e50` | `test262-standalone-current.jsonl` / `3b99ba94b2a1a8625f869a84464bd497eeb732c0` | `test262-standalone-current.json` / `7a033b31cb16947a1d1bfcbba2ddabe1a2734b62` | `target=standalone`, `include_proposals=1`, `official test262 + proposals` |

Both endpoints have exactly 48,735 canonical keys and the same sorted key-list
SHA-256 `d5da0c8e80b17c9617275dd9d2feb84288b4ec9fd7d03578a763995648d85c6f`.
The baseline full-summary vector is
`pass=33876, fail=9506, compile_error=5227, compile_timeout=12, skip=114,
compilable=43382, host_free_pass=33876, stale=0`; the candidate vector is
`pass=32581, fail=10122, compile_error=5755, compile_timeout=163, skip=114,
compilable=42703, host_free_pass=32581, stale=0`. The JSONL and report byte,
SHA-256, and blob descriptors remain the values recorded above. The CLI may
take file paths to those raw bytes but must source authority from this policy,
not from user-supplied expected JSON. A generic fixture helper may accept a
test-only policy, but it is not an acceptance API and the production CLI must
never call it.

### Phase B — locate every causal boundary

This interval may contain several independent regressions and improvements;
ordinary aggregate binary search is unsound because the count is not
monotonic. Use path-vector segmentation:

1. In a clone whose history is verified complete through both endpoints,
   enumerate and assert exactly 83 first-parent transitions / 84 snapshots in
   `(fc6fd3…, 01fb676…]`, while retaining all 332 reachable DAG commits for
   provenance. Classify each transition's touched production, runtime,
   harness, provider, workflow, and baseline files. Fail closed on a shallow
   boundary or census drift. Do not exclude a commit merely because its title
   says docs or CI.
2. Start with the canonical 1,764-regression path set plus all 469 raw
   improvements, not the full count alone. Replay that scoped union for all 84
   first-parent snapshots in isolated detached worktrees, using each snapshot's
   exact historical compiler/runtime/provider/harness/corpus/config dependency
   closure and the same no-host-import predicate. At a dependency-changing
   boundary, add a cross-pin replay only to distinguish compiler behavior from
   provider/harness/corpus behavior; never replace the historical primary
   observation with one endpoint-wide pin. Record each path's canonical
   status, import set, error signature, and timing at every snapshot. Parallel
   execution is allowed only when every child independently passes the strict
   load gate.
3. Coalesce adjacent snapshots only when the complete Test262-relevant
   dependency hash (compiler, runtime, provider, harness, corpus, config, and
   workflow inputs) is byte-identical. Otherwise every one of the 84 snapshots
   must be observed. Midpoint/endpoint pruning is forbidden: equal half
   endpoints can conceal pass→fail→pass or signature A→B→A excursions.
4. Derive every adjacent pass→fail, fail→pass, and signature-change edge for
   every path. Preserve multi-transition histories such as
   pass→fail→pass→fail; do not report only the final or nearest loss. Cluster
   first/final loss edges by exact failure signature, then refine each
   implicated first-parent merge across that PR's unique commits.
5. Replay deterministic parent/child boundaries twice. Rerun only timeout or
   otherwise unstable paths a third time, serialized under the strict load
   gate, before classifying them as semantic. Runner cancellation never
   supplies a status vector. Run the complete 48,735-test lane after a bounded
   repair candidate exists; scoped vectors locate causes, while the final full
   lane proves aggregate recovery and detects collateral paths outside the
   seed manifest.

The output is a signed causal ledger mapping every one of the 1,764 endpoint
regressions to a first causal commit or an explicit still-unattributed HOLD.
Do not begin a broad production repair while any large path family remains
unattributed.

### Phase C — classify before repairing

For each causal family, preserve the legacy optimization and standalone
host-free contracts:

- `host_import_leak`: compare exact import module/name/type projections and
  locate the first newly required host capability. A test is not repaired by
  relabeling the import, excluding the path, or loosening leak classification.
- `assertion_fail` and other runtime outcomes: compare emitted Wasm/WAT,
  exported ABI, instantiation/start protocol, and exact runtime value/error.
  Separate compiler miscompile, runtime shim, test harness, and oracle changes.
- `compile_timeout`: compare compilation phase timings and emitted artifact
  census under serialized low load. A timeout may be accepted as runner noise
  only when repeated evidence proves the same source/compiler result.
- IR/direct ownership changes: compare source-qualified unit selection,
  outcomes, imports/exports, fallback reasons, and optimized body shape. Fixing
  the pass count must not restore a legacy route or drop an optimization that
  the migration has already made IR-owned.

Amend this issue with one bounded repair slice per independent cause. Each
slice must name exact files, path set, expected pass recovery, mutation
controls, and rollback behavior before code edits begin.

### Acceptance matrix

The final repair series is accepted only when all of the following hold:

1. Apply the same bounded repair patch, without rewriting history, atop
   isolated descendants of the immutable `01fb676…` endpoint, refreshed
   current `main`, and the current #5295/#5308 combined tree. Each descendant
   runs the complete 48,735-test standalone lane with
   `host_free_pass >= 33,826` (the unchanged 33,876 mark minus 50).
2. The canonical transition manifest reports zero unexplained baseline-pass
   regressions. Any intentionally changed path has a separate reviewed
   semantic acceptance record; aggregate offsetting improvements do not hide
   it.
3. No new host imports, hard compiler errors, completeness failures, or stable
   compile-timeout growth are introduced. The host lane and moving #1897 gate
   remain non-regressing.
4. The high-water JSON and tolerance are unchanged during repair. After a
   protected merge, normal `--update` behavior may ratchet the mark upward but
   may never lower it.
5. PR #5295 and #5308 are re-synthesized by the normal protected queue from
   their unchanged reviewed heads and pass their own required checks. No admin
   merge, direct merge, or queue bypass is permitted.

Every heavy command samples a finite, non-negative one-minute load strictly
below logical cores minus two immediately before execution and uses an
archive-backed `TMPDIR`. Run the relevant focused tests, both TypeScript
lanes, Test262 completeness/diff/hard-error/high-water validators, IR
layering/fallback/kind-neutrality/IR-only gates, and optimization ledgers.
Immediately before every commit run the LOC and function-growth ratchets.
Keep all precommit and prepush hooks enabled, sign every commit, and require a
fresh independent Sol review of the exact pushed SHA before readiness or queue
entry.
