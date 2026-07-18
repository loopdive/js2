---
id: 3426
title: "Quarantine exact same-SHA unstable host Test262 paths from fine gates"
status: in-review
sprint: current
created: 2026-07-18
updated: 2026-07-18
pr: 3367
priority: critical
horizon: m
feasibility: hard
reasoning_effort: max
task_type: infrastructure
area: testing
language_feature: n/a
goal: ci-reliability
depends_on: [3425]
related: [1217, 1942, 3287, 3434]
assignee: "ttraenkler/codex-sendev-test262-quarantine"
---

# #3426 — Quarantine exact same-SHA unstable host Test262 paths from fine gates

## Problem

PR #3363 fixed the known compiler-pool mismatch: baseline publication and
merge-group comparison now both use `COMPILER_POOL_SIZE=4`. That alignment was
necessary, but an authoritative canary under the aligned conditions proves a
second source of host-lane nondeterminism:

- Test262 canary run `29632875780` compiled compiler SHA
  `852c40a9f5167a2a959d53faa066cb0753b623cc` twice at pool size 4.
- All 114 shard jobs passed. Artifact `8426392963`
  (`test262-canary-report`) contains the two complete 48,088-row JSONLs.
- The same-SHA comparison found 360 pass↔non-pass flips and 150
  different-non-pass transitions, with no paths missing from either run.
- Independent current-main canary run `29643714720` compiled SHA
  `dae79d5a311a0bf683341230c39e6c5a7f6176ad` twice at pool size 4. All
  114 shards passed; only the expected flip-count compare failed. Artifact
  `8429653584` contains two complete 48,088-row JSONLs with zero missing paths,
  366 pass↔non-pass flips, and 165 different-non-pass transitions.
- The exact union is 932 paths; 109 paths are in the intersection and changed
  status in both independent same-SHA canaries.
- Porffor PR #3287 retry `29641967485` at exact held head
  `a69b80aacee99c039d7456c79719822d3207fcc3` showed only 60 non-timeout host
  regressions and 92 pass→compile_timeout transitions. This is smaller than the
  proven same-compiler noise envelope, while all 114 shards and the standalone,
  CI, Differential, and CLA lanes passed.

Global numeric threshold increases would weaken every path and every compiler
change. The canaries give a stronger discriminator: the exact union of paths
that changed status with no compiler change, with their repeat-confirmed
intersection retained for audit and removal decisions.

## Root cause and prior mitigation

The pool mismatch documented by #3425 explained cross-environment timeout
churn, but it cannot explain run A versus run B at the same SHA, pool, corpus,
oracle, and workflow. Reproducing hundreds of transitions in two independent
canaries, including a 109-path intersection, confirms path-specific host
harness or runtime nondeterminism. Repeating #3425 or raising the global
ratio/timeout limits would treat the symptom without preserving signal on
stable paths.

### Residual metadata-contamination root cause

Gibbs' follow-up isolated all but one of the requested-baseline residual
non-timeout regressions to destructive original-harness descriptor checks:

- `propertyHelper.js` and legacy descriptor tests delete configurable method,
  `name`, or `length` descriptors during the primary variant;
- primary and strict variants are separate pool jobs and can therefore reach a
  reused (or different) fork;
- `runtime.__get_builtin` intentionally returns host-realm intrinsic objects;
- worker cleanup returns early when the parent method identity is unchanged,
  so deleted child metadata survives; and
- the realm canary did not include `SharedArrayBuffer` or
  `AsyncDisposableStack`, and only snapshotted one descriptor level.

The affected requested-baseline paths were:

1. `test/built-ins/String/prototype/at/length.js`
2. `test/built-ins/AsyncDisposableStack/prototype/defer/prop-desc.js`
3. `test/built-ins/String/prototype/concat/S15.5.4.6_A9.js`
4. `test/built-ins/AsyncDisposableStack/prototype/disposeAsync/length.js`
5. `test/built-ins/Object/groupBy/length.js`
6. `test/built-ins/Date/prototype/getDate/length.js`
7. `test/built-ins/Map/prototype/delete/length.js`
8. `test/built-ins/Math/random/length.js`
9. `test/built-ins/Date/prototype/getUTCHours/length.js`
10. `test/built-ins/Promise/prototype/catch/length.js`
11. `test/built-ins/Iterator/prototype/map/length.js`
12. `test/built-ins/SharedArrayBuffer/prototype/slice/descriptor.js`
13. `test/built-ins/DataView/prototype/setUint8/length.js`
14. `test/built-ins/JSON/parse/length.js`
15. `test/built-ins/Reflect/ownKeys/length.js`
16. `test/built-ins/Object/values/function-length.js`
17. `test/built-ins/Number/isInteger/length.js`

The containment fix extends the existing post-test canary, not the eager
cleanup hot path. It snapshots available modern intrinsic roots plus the
`name`/`length` descriptors of function-valued data/accessor children. Any
parent method or child metadata drift recycles that fork before the next pool
job. Clean workers remain live; there is no global realm rebuild per test.
The 932-path evidence quarantine is unchanged.

## Scope

1. Derive a sorted manifest from artifacts `8426392963` and `8429653584` using
   the existing `scripts/test262-canary-diff.ts` parser. Include both pass flips
   and different-non-pass noise because either can enter a future
   pass→regression or compile-time transition depending on which canary side
   was promoted. Eligibility is the exact union; record the exact intersection
   separately.
2. In `scripts/diff-test262.ts`, exclude only those exact paths from host-lane
   fine regression arithmetic and compile-time blocker arithmetic.
3. Keep raw and quarantined transitions visible under labels distinct from the
   workflow-parsed authoritative labels. List every quarantined transition in
   the report artifact.
4. Leave standalone strict. The existing standalone invocation is identified by
   `--exclude-leaky-baseline-regressions`; it must never load or apply the host
   quarantine.
5. Leave oracle/version checks, baseline files, hard-error checks, trap-category
   ratchets, vacuity handling, and global thresholds unchanged.

## Gate invariants

- The first `Compile timeouts (pass → compile_timeout): N` line is the
  host directional-growth count because the base-main workflow parses its
  first match. It is computed as `max(0, forward - reverse)` over stable
  pass↔compile_timeout transitions. Both stable directional components and
  their raw and quarantined counterparts use distinct labels. Standalone
  retains the original forward-only count.
- The first `Aggregate compile time (shared N tests)` line is computed over the
  unquarantined shared host set. Raw and quarantined aggregate measurements use
  distinct labels.
- Host improvements on quarantined paths are removed from the fine gate's ratio
  denominator as well as its regressions. Noise therefore cannot either block a
  change or mask a stable-path regression.
- Trap growth continues to evaluate the complete, unfiltered baseline and
  candidate maps. A quarantined path that newly traps still trips #3189.
- A catastrophic or one-way regression on any path outside the exact manifest
  retains the existing behavior.

## Acceptance criteria

- [x] The committed manifest has exactly 932 union entries and 109 intersection
      entries. It records all 726 pass-flip and 315 different-non-pass
      observations with both runs' SHA/artifact provenance.
- [x] A bidirectional host sample using canary-known paths passes and is fully
      reported as quarantined noise.
- [x] An equal stable-path one-way regression fails.
- [x] A canary-known path still fails under the standalone invocation.
- [x] An arbitrary path cannot opt into the quarantine.
- [x] Equal stable host pass↔compile_timeout churn parses as zero in the
      unchanged #1942 workflow shell, while 26 one-way stable timeouts still
      fail its threshold. Quarantined reverse churn cannot offset stable
      forward growth, and standalone remains forward-only.
- [x] Focused tests, typecheck, Biome, Prettier, and issue validation pass.
- [x] No workflow threshold, baseline content, oracle version, or global trap
      override changes.

## Refresh and removal procedure

The quarantine is evidence-bound, not a permanent allowance:

1. Collect at least two independent canaries. Within each canary, run the same
   current `main` SHA twice with the same pool, corpus, oracle, and runner image;
   require every shard and both merged JSONLs.
2. Generate the first selected canary with
   `scripts/test262-canary-diff.ts --write-host-quarantine`, then add the second
   with `--extend-host-quarantine`, recording each run ID, full compiler SHA,
   and artifact ID. The generator refuses incomplete reports and non-pool-4
   provenance.
3. Review union and intersection separately. Union additions require a status
   change in a complete same-SHA A/B canary; the intersection identifies paths
   reproduced in every selected canary. Never add a path from a
   baseline-versus-PR comparison.
4. Keep a bounded evidence window of the latest two complete aligned canaries:
   regenerate the first file without `--extend`, then extend it with the second.
   This removes an old path only after it is stable in both replacement
   canaries rather than retaining an append-only allowance forever.
5. Remove the quarantine entirely once two consecutive complete aligned
   canaries report zero status changes.

## Implementation notes

The manifest stores every canary's observed statuses and transition kind per
path. One complete same-SHA A/B status change is direct nondeterminism evidence,
so the exact union is eligible; independent canaries sparsely sample scheduler
noise, so requiring intersection would incorrectly relabel directly observed
noise as stable. The intersection remains explicit repeat-confirmation.

Loading is fail-closed: malformed or duplicate provenance, non-pool-4 data,
unsourced/duplicate observations, inconsistent transition kinds, or per-run and
aggregate count mismatches abort the diff rather than silently widening or
emptying the quarantine. `diff-test262.ts` applies the resulting set only after
oracle/path-scope validation and only to host gate accounting; the original
maps remain intact for status totals and the trap ratchet.

The host compile-time count uses the net direction across the same status
boundary after quarantine is applied independently to both directions. This is
metric symmetry, not path excusal: no new path becomes eligible, one-way
pass→compile_timeout growth is unchanged, and the existing threshold remains 25. A compiler change can therefore still fail by pushing stable passes over
the timeout boundary without reverse movement, while runner-load churn no
longer fails merely because the report previously counted only its forward
half. Raw forward/reverse transitions, stable forward/reverse transitions, and
raw/stable/quarantined timeout populations remain auditable. The standalone
lane never enables this host-only interpretation.

## Implementation summary

- Extended `scripts/test262-canary-diff.ts` with auditable
  `--write-host-quarantine` and `--extend-host-quarantine` modes. They refuse
  incomplete canaries, require pool size 4 plus full run/SHA/artifact
  provenance, and validate the merged result before writing it.
- Generated `scripts/test262-host-noise-quarantine.json` directly from artifacts
  `8426392963` and `8429653584`. A clean two-step regeneration produces a
  byte-identical file.
- `scripts/diff-test262.ts` validates the manifest fail-closed and applies it
  only when the existing standalone marker flag is absent. Host regressions,
  improvements, timeout counts, and aggregate compile time all use the stable
  subset; raw and quarantined values remain under distinct labels, and every
  observed quarantined transition is listed even under `--quiet`, marked as
  intersection or union-only evidence.
- The first workflow-parsed timeout line is the authoritative host stable-path
  directional-growth value; the aggregate line remains the authoritative
  stable-path value. The legacy timeout label is retained so the existing
  base-main shell self-validates the change. No workflow YAML or threshold
  changed.
- The #3189 trap ratchet still receives the full baseline/candidate maps. A
  focused test proves a canary-listed path that newly enters `oob` remains a
  hard failure.

## Real-data validation and residual signal

Applying the two-canary union read-only to held #3287 retry run `29641967485`
produced two auditable snapshots because the baselines repository advanced
during validation.

Against requested replay baseline commit
`cb3dd33bed7364cbfc1637f752510776f5ccfc44` (Git blob
`72bf55808688cf2698f943fc103c2bf0ff358c2c`, SHA-256
`a2cc8c0a691d2880cd14dac68031e35dbeb0c67a1b15908265ee87d0fcd2bc9e`):

- 190 observed transitions on the exact union: 79 regressions, 67 improvements,
  and 44 different-non-pass changes, all fully listed. Of these, 30 are on the
  repeat-confirmed intersection and 160 are union-only.
- pass→compile_timeout: raw 92 → stable 55 (37 quarantined). The second canary
  directly explains 17 of the first canary's 72 residual timeout paths.
- compile_timeout→pass: raw 97 → stable 72 (25 quarantined). The host
  directional count is therefore `max(0, 55 - 72) = 0`, below the unchanged 25
  threshold.
- Total compile_timeout population fell 289→274 (−15) raw and 234→205 (−29)
  outside the canary quarantine. The quarantined population moved 55→69 (+14),
  which remains visible but cannot affect either directional component.
- non-timeout pass regressions: raw 60 → stable 18 (42 quarantined). The second
  canary directly explains 17 of the first canary's 35 residual paths.
- improvements: raw 174 → stable 107 (67 quarantined).
- aggregate compile time: raw −1.9%; stable subset −2.2%; quarantined subset
  +3.8%.
- trap populations held or improved (`null_deref 164→163`, `illegal_cast
80→80`, `oob 49→49`, `unreachable 55→55`).

Baselines `main` then advanced to commit
`e1b05313ecd2cfd23cbc0b55f8925c6335b119f6` from the second-canary compiler
SHA, with JSONL Git blob `09e0e754d6c0e5d7faf781b4d874c6d7576b2d0d`
and SHA-256
`a7dfdb9b70b38ab270df8bd0faa7ae0a57b996a2839e2382662a0072f6e72f4b`.
Replaying the same held #3287 candidate against that exact current tip produced:

- 19 stable non-timeout regressions and 98 stable improvements, so the
  unchanged fine ratio still fails at 19.4%.
- pass→compile_timeout: raw 98, quarantined 37, stable 61;
  compile_timeout→pass: raw 97, quarantined 34, stable 63. Directional growth
  remains `max(0, 61 - 63) = 0`.
- Total compile_timeout population fell 277→274 (−3) raw and 209→205 (−4)
  outside quarantine. Stable aggregate compile time improved 5.2%.
- Trap populations remained `null_deref 164→163`, `illegal_cast 80→80`, `oob
49→49`, and `unreachable 55→55`.

The historical #3287 retry passes the symmetric timeout guard under both
baseline snapshots but fails the unchanged 10% fine ratio under both (18/107 =
16.8% requested snapshot; 19/98 = 19.4% current tip). Every residual path is
outside both exact same-SHA evidence sets, so this issue deliberately does not
waive it. Broadening the manifest from a PR-versus-baseline diff would violate
the stable-path and provenance invariants. #3287 remains held at its exact head
and was not modified or requeued.

### Post-containment #3287 replay projection

All 17 paths above were rerun through the unmodified original harness on Node
25 with a pool-size-1 unified worker. Primary and strict both passed for every
path (34/34 variants), and every destructive variant produced its exact realm
drift recycle reason. The immutable run `29641967485` artifact was then
replayed with only those 17 independently verified `fail` rows projected to
`pass`; no timeout, quarantine, baseline, or other candidate row was changed.

Against the requested `cb3dd33b` baseline, the unchanged diff now reports:

- 1 stable non-timeout regression versus 107 stable improvements (0.9%, below
  the unchanged 10% limit);
- stable pass→compile_timeout 55 and compile_timeout→pass 72, for directional
  growth 0 (below the unchanged 25 limit);
- stable aggregate compile time −2.2%; and
- unchanged/improved trap populations.

The sole requested-baseline regression is
`Object/defineProperty/15.2.3.6-3-179.js`. It is a deterministic strict host-set
exception false positive, not cross-test contamination; current main already
contains the same failing baseline row. Follow-up #3434 owns that semantics.

Against baseline tip `e1b05313`, a deliberately conservative projection of the
same exact 17 repairs reports 5 stable non-timeout regressions versus 101
improvements (5.0%), stable timeout directions 61/63 (growth 0), and aggregate
compile time −5.2%. Both unchanged host gates therefore pass even without
projecting any additional current-baseline metadata rows.

## Test results

- `pnpm exec vitest run tests/issue-3426.test.ts`: 11/11 passed, including a
  union-only sample, an intersection sample, unsourced-observation rejection,
  and execution of the unchanged #1942 shell for balanced and one-way timeout
  churn.
- Node 25 pool-size-1 original-harness canary suite: 6/6 passed, covering
  `Math.random.length`, `AsyncDisposableStack.prototype.defer`,
  `SharedArrayBuffer.prototype.slice`, `String.prototype.concat.length` and
  `.name`, plus a clean-worker no-recycle control.
- Full 17-path metadata replay: 17/17 files and 34/34 primary/strict variants
  passed; the temporary replay file was removed after validation.
- Related gate suites: #1943, #2178, #2890, #3004, #3189, and #3303 passed.
  `tests/issue-1897.test.ts` has two pre-existing stale failures on current main:
  wording already changed in `enable-branch-protection.sh`, and a fixture that
  expects a 1:1 regression ratio to pass despite the existing #1943 10% gate.
- `pnpm run typecheck`: passed.
- Focused Biome lint: passed.
- Focused Prettier check: passed.
- `pnpm run check:issues`: passed (0 issue-file normalizations).
- `pnpm run check:issue-ids:against-main`: passed.
- `pnpm run check:issue-spec-coverage`: passed.
- Full Test262 was not run locally; the required merge-group matrix is the
  authoritative validation and the baseline was not refreshed.
