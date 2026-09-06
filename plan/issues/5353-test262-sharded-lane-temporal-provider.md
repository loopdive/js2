---
id: 5353
title: "Wire the SHARDED test262 CI lane to the compile-once Temporal provider so the published conformance number includes Temporal"
status: done
completed: 2026-09-05
assignee: ttraenkler/dev-5353
sprint: current
priority: medium
horizon: m
goal: dogfood
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-05
---

# #5353 — Temporal provider in the sharded CI lane

## Problem

#5248 (PR #5375) wired the IN-PROCESS test262 runner to the provider; the
sampled Temporal bucket went 81 → 262 pass. It deliberately left the SHARDED
CI lane (`scripts/test262-worker.mjs`, `test262-sharded.yml`) unwired, so the
published number (`benchmarks/results/test262-current.json`, ~35,497 today)
does not include a single Temporal gain, and no merge-group regression gate
sees Temporal rows. Two blockers were named:
1. the compiler bundle the shards run does not re-export
   `buildTemporalProvider`;
2. the cold provider build (~52–65 s) exceeds the vitest fork pool's 30 s
   kill, so a SHARD cannot build it — the shard PARENT must pre-warm the cache.

## Implementation Plan (Fable, 2026-09-05)

1. **Bundle export.** Add `buildTemporalProvider` (and whatever
   `scripts/test262-import-object.mjs`'s `linkedModules` path needs) to the
   compiler bundle's public surface; confirm `dist/` carries it.
2. **Pre-warm in the shard parent.** In `test262-sharded.yml` (and the local
   `test:262` path), build the provider ONCE before the fork pool starts —
   `JS2WASM_TEMPORAL_CACHE` pointed at a workspace dir — so every shard hits
   `cacheHit=true` (~1 s). Cache the artifact across CI runs keyed on
   compiler ABI + polyfill source (the existing content-addressed key).
3. **Worker wiring.** `scripts/test262-worker.mjs` passes `linkedModules` to
   `instantiateTest262Module` under the same path-OR-`features:` gate the
   in-process runner uses; default ON in CI, `JS2WASM_TEST262_TEMPORAL=0`
   opt-out kept.
4. **Baseline validator parity.** `scripts/validate-test262-baseline.ts`
   currently defaults the provider OFF to avoid phantom drift; once the
   sharded baseline is produced WITH the provider, flip its default to match
   (same PR, or the validator strands PRs UNSTABLE — #3878/#3904).
5. **Land order + measurement.** This PR's merge group will show the Temporal
   bucket's flips against the current baseline: expect large gains and the
   10 wrong-reason-pass regressions #5375 triaged. Cite that triage; do NOT
   add an accepted-regressions mechanism. Report the new published number.


## What was built (2026-09-05)

| Piece | Where |
| --- | --- |
| The ONE gate + pre-warm stamp contract, shared by every lane | `scripts/test262-temporal.mjs` |
| Parent-side provider build (the thing a fork may never do) | `scripts/prewarm-temporal-provider.mjs` |
| Provider published to the sharded lane | `scripts/compiler-bundle-entry.ts` |
| Linked-provider lifecycle published to the worker's OWN runtime copy | `scripts/runtime-bundle-entry.ts` (new), `package.json` `build:runtime-bundle` |
| Worker wiring (gate double-check, compile route, instantiate) | `scripts/test262-worker.mjs` |
| Per-row decision + transport | `tests/test262-shared.ts`, `scripts/compiler-pool.ts` |
| Caller-supplied linked runtime at the ONE instantiate seam | `scripts/test262-import-object.mjs` |
| Provider job + artifact + per-shard cache dir | `.github/workflows/test262-sharded.yml` |
| Local `pnpm run test:262` pre-warm | `scripts/run-test262-vitest.sh` |
| Baseline-derived validator default | `scripts/validate-test262-baseline.ts` |
| Guards | `tests/issue-5353-sharded-temporal-lane.test.ts`, `tests/issue-5248-…test.ts` |

### The second bundle entry is a CORRECTNESS fix, not packaging

The obvious reading of blocker 1 is "add two re-exports to the compiler bundle".
That is only half. `instantiateLinkedProviders` calls
`registerLinkedProviderModule`, which writes into `src/runtime.ts`'s
**module-level** #5225 cross-module decoder registry — and the reads that
consult that registry happen inside the import object the lane built. The worker
holds **two** bundled copies of `src/runtime.ts`: one inside
`compiler-bundle.mjs` (`src/index.ts` imports the runtime) and one in
`runtime-bundle.mjs`, which is where its `buildImports` comes from. Registering
a Temporal provider in the compiler's copy while decoding through the runtime's
copy leaves the reader's registry empty, and that does **not** throw: it silently
answers a cross-module struct field with the reader's `ref.test`-miss default,
`0`, for exactly the field names the polyfill reuses everywhere (`month`, `day`).

So the linked lifecycle is published from a new `scripts/runtime-bundle-entry.ts`
and the worker passes its own copy's helpers to `instantiateTest262Module` as
`linkedRuntime`. `src/runtime.ts` deliberately does NOT import
`linked-provider-runtime.ts` itself — that is a cycle, and it would drag the
provider-manifest/rec-group decoder into every browser consumer of the runtime.

### A fork must never build the provider — measured, not assumed

| | this box |
| --- | --- |
| cold build (empty cache dir) | **41,641 ms** |
| warm read, per fork | **1,063 ms** |
| artifact | 2,028,477 B, cache dir 2.2 MB |
| fork kill | 30,000 ms (`pool.runTest(…, 30_000)`) |

The cold build is 39 % over the kill, so a fork that attempted it would not be
slow — it would time out, be retried, and burn the same 42 s again in the next
fork, for every Temporal row in the shard. `prewarm-temporal-provider.mjs`
therefore builds it in the PARENT and writes `prewarm.json` carrying the
provider's content-addressed key; the worker refuses to call
`buildTemporalProvider` at all unless that key matches the one it would ask for.
A missing or mismatched stamp costs the **pre-#5353 behaviour** (rows run
unlinked, announced once on stderr), never a timeout storm. Verified: with an
empty cache dir, 3 Temporal rows completed in 10.8 s unlinked and no build was
attempted.

The pre-warm STEP fails hard (exit 1) rather than degrading, because a shard
that silently ran unlinked would post ~6,600 Temporal rows as regressions
against a provider-linked baseline — a loud but thoroughly misleading signal
that costs a merge-queue cycle to diagnose.

### Host lane only

`src/temporal-provider.ts` is `--target gc` with the JS host adapter, and the
linker's deferred provider export does not exist for WASI. Linking it under
`--target standalone` would trip the worker's own #2961 guard ("standalone
target emitted host imports") and convert honest standalone failures into
`compile_error`s **against the #1897 floor**. `tests/test262-shared.ts` gates on
`IS_HOST_LANE`; the worker double-checks `target === undefined` rather than
trusting the message.

### Pool stderr was a black hole

`CompilerPool` forked with `stdio: ["pipe","pipe","pipe","ipc"]` and never read
fd 2, so every line a fork wrote there was discarded: the #2928 E7 runtime-eval
tier announcement (written specifically to make provenance recoverable from a
run log), the `FATAL: … — recycling` lines, the realm-canary drift summary. The
Temporal provider's linked/NOT-linked line would have joined them. stderr is now
inherited; stdout stays piped (that is test output, captured by the console
proxy).

## Measured — through the sharded worker path, on this box

A 2-fork `CompilerPool` running the real `scripts/test262-worker.mjs`, same row
list both sides, `JS2WASM_TEST262_TEMPORAL=0` for the base.

| slice | rows | base pass | after pass | `Temporal is not defined` | gains | regressions |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/prototype/add` | 12 | 4 | **7** | 5 → **0** | 3 | 0 |
| `Temporal/PlainTime/prototype` | 40 | 8 | **19** | 20 → **0** | 11 | **0** |
| `built-ins/Date/prototype/setDate` (control) | 8 | 8 | 8 | 0 → 0 | 0 | 0 |

Cost, same slices: median row 1,235 → 1,436 ms (+201 ms), total wall 72.5 s →
94.6 s over 40 rows including the one-time ~1 s provider read in each of the two
forks. Extrapolating to a merge_group host shard: ~6,600 Temporal rows spread by
`assignBalancedChunk` over 66 shards ≈ 100 rows each ≈ **+20-60 s per shard**
against a 40-min timeout and a measured 408 s mean. The shard-weight map
(`tests/test262-slow-tests.json`) still carries UNLINKED timings for these rows,
so the bin-packing will be slightly off until it is refreshed; the headroom
absorbs it.

## What only CI can show

* **The published number.** `benchmarks/results/test262-current.json` moves only
  when `promote-baseline` runs on a push to main; nothing local can produce it.
* **The bucket-wide delta and the 10 wrong-reason-pass regressions #5375
  triaged.** The slices here are 52 rows of a ~6,640-row bucket, drawn for
  diagnosis, not proportionality — 0 regressions across them is not a claim that
  the bucket has none. Expect the ten #5248 triaged (7 × `ZonedDateTime` methods,
  `PlainYearMonth.until`, non-ISO `yearOfWeek`, `PlainTime.toLocaleString`), each
  a pass that depended on `Temporal` being ABSENT, with the mechanism probed in
  that issue. **No accepted-regressions mechanism is added, and none should be.**
* **Per-shard wall time and the absence of timeouts** under the real 66-shard
  matrix with 4-fork pools.
* **The `merge_group` regression diff itself** — the #3467 per-SHA gate runs on
  the merged state, and this is the first PR whose Temporal rows it can see.

## Validator parity — self-correcting, NOT a pinned flip

`scripts/validate-test262-baseline.ts` sampled the in-process lane against a
sharded-lane baseline with the provider pinned OFF (#5248). The correct default
flips **one merge after this PR lands** — when the first provider-linked
baseline is promoted — so a constant is wrong on one side of that promotion
whichever value it holds. Being wrong is expensive:
`test262-baseline-validate` is NON-required, and a red one drives
`mergeStateStatus` to `UNSTABLE`, which `auto-enqueue` skips silently and
indefinitely (#3878/#3904).

So the default is now **read off the baseline**, which carries the evidence: an
unlinked baseline contains rows whose error is literally `Temporal is not
defined`; a linked one contains none. The validator counts them and matches.
This is correct on both sides of the promotion with no follow-up commit, and it
re-corrects by itself if the shards ever stop linking. `JS2WASM_TEST262_TEMPORAL`
still overrides explicitly. Cost when it resolves to ON: one cold ~42 s provider
build in the validator job, and only when a sampled row is a Temporal row
(~1.8 % of passes, 50 samples).

## Not done here, with bounds

* **The shard-weight map is not refreshed.** `tests/test262-slow-tests.json`
  still times Temporal rows unlinked, so `assignBalancedChunk` under-weights
  ~6,600 rows by ~0.2-2 s each. Bound: a per-shard imbalance of tens of seconds
  against 408 s mean / 40 min timeout. The map is refreshed from a full run, so
  it self-corrects on the next refresh.
* **Standalone stays unlinked.** Bound: the entire standalone lane reports
  `Temporal is not defined` exactly as before; the gap is the provider's own
  WASI startup-lifecycle limitation (`src/package-linker.ts`), not this wiring.
* **`temporalNotDefined` is verified on 52 rows, not on the bucket.** Bound: the
  merged report is the only thing that can say 0 corpus-wide, and it is
  acceptance criterion 1.
* **The 10 known regressions are inherited, not re-triaged.** Bound: #5248/PR
  #5375 probed each mechanism; nothing here changes their cause, only the lane
  that can see them.
* **`tests/issue-4162.test.ts` has 2 failures in this worktree**, both
  `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` — a
  missing local artifact, unrelated to this change (the cache dir contains no
  `quickjs-artifact-*` at all). CI builds it in its own job.

## Acceptance criteria

1. Merge-group shards run Temporal rows with the provider; `Temporal is not
   defined` = 0 in the merged report. — **wiring done and measured on 52 rows
   through the real worker (52 → 0); the corpus-wide 0 is a merge_group fact
   this PR cannot produce locally.**
2. Published conformance number moves; the delta is stated with the #5375
   triage cited for the known 10. — **deferred to the promotion run by
   construction: only `promote-baseline` on a push to main writes
   `test262-current.json`. The #5375 triage is cited above and in the PR body;
   no accepted-regressions mechanism was added.**
3. Per-shard cost measured (instantiate ms) and stated; no shard timeouts. —
   **✅ measured: +201 ms median per Temporal row, 1,063 ms one-time provider
   read per fork, ≈ +20-60 s per 66-shard host cell against a 408 s mean and a
   40-min cap. Timeout absence at full matrix scale is a CI fact.**

## Notes

- Filed from #5248's "Not done" bounds (PR #5375). Lane A (CI/infra).
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.
