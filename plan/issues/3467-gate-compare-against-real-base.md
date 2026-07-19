---
id: 3467
title: "test262 regression gate: compare each PR against its REAL merge-base commit (per-SHA cache), not a drifting promoted snapshot"
status: ready
sprint: current
priority: high
horizon: l
feasibility: medium
task_type: infrastructure
area: ci, test262, merge-queue
goal: release-pipeline
created: 2026-07-19
updated: 2026-07-19
related: [3466, 3457, 3448, 1081]
origin: "2026-07-19 stakeholder direction ('cant we just compare against the real thing') after the stale-baseline drift false-parked 6 unrelated PRs (#3318/#3273/#3361/#3362/#3370/#3398) in one window."
---

# #3467 — compare against the real merge-base, not a promoted snapshot

## Problem (the whole drift class)

The test262 regression gate diffs a PR's `merge_group` result against a
**separately-promoted baseline snapshot** (`test262-current.jsonl` in
`loopdive/js2wasm-baselines`, with a `baseline_sha` field). That snapshot is
promoted by a job that **skips on bot-authored merges (#3466)** and on
shard-skipping merges, so it goes **stale** — the `baseline_sha` becomes a
strict ancestor of the commit each PR is actually merging onto.

When the snapshot lags current main, the gate attributes **main's own drift**
(improvements + regressions that already landed) to the PR under test. On
2026-07-19 this false-parked **six unrelated PRs in one window**, all showing
the identical `+34 improvements / null_deref 164→166` delta — provably
baseline-vs-current-main drift, not any PR's diff (structural proof on #3362:
byte-identical host wasm, yet "34 host improvements"). It also let a real small
regression ride in unnoticed during the stale window. #3457 (net-aware gate)
and #3466 (auto-refresh) each *tolerate/patch* the snapshot; this issue
**removes the snapshot from the comparison** so drift is structurally
impossible.

## Design (stakeholder's "compare against the real thing")

The merge queue is **sequential**: each merged commit's result IS the next
PR's merge base. So cache every commit's results and diff each PR against its
own base.

1. **Unconditional per-SHA result cache.** In the `merge_group`/`push` shard-
   merge path, write the merged report to `runs/<sha>.{json,jsonl}` in the
   baselines repo **for every commit that runs the shards**, decoupled from the
   promote job's `if:` gate (the #3466 actor-skip). (`runs/<sha>` already exists
   for many commits, #1081 — this makes it complete + reliable.)
2. **Gate compares against the base.** Change the regression comparison to fetch
   `runs/<merge_group base_sha>.jsonl` — the REAL parent commit — as the
   baseline, instead of `test262-current.jsonl`. The diff is then purely the
   PR's effect: **zero drift**.
3. **Fallback on cache-miss.** If `runs/<base_sha>.jsonl` is absent (e.g. a base
   whose shards were skipped, or pre-rollout commits), fall back to the newest
   available ancestor's cache, else the promoted snapshot (today's behavior),
   and LOG which base was used + the commit-distance, so a miss is visible not
   silent.
4. Keep the promoted `test262-current.json` summary for the landing page
   (cosmetic), but it is no longer load-bearing for the gate.

## Why this beats the alternatives

- vs #3457 (net-aware gate): net-aware still trusts a drifting baseline and can
  mask a real regression that nets positive; compare-against-base has NO drift
  to mask.
- vs #3466 (auto-refresh snapshot): still a single global snapshot that lags
  the fast queue between refreshes; per-base has no lag by construction.
- Bulletproof variant (rejected for cost): run test262 on the base too inside
  each merge_group and self-diff (2× compute). The sequential-queue cache gets
  the same correctness at ~1× compute.

## Acceptance criteria

- [ ] Every shard-running `merge_group`/push commit writes `runs/<sha>.jsonl`
      regardless of author (no #3466-style actor skip).
- [ ] The regression gate diffs against `runs/<base_sha>.jsonl`; on a hit,
      an unrelated PR built on current main shows a ~zero delta (no drift).
- [ ] Cache-miss falls back gracefully + logs the base used and its distance.
- [ ] The 6 currently-parked false-parks pass the corrected gate once their
      bases are cached (or via the transition seed below).

## Transition / rollout

The fix PR's own `merge_group` runs against a base with no cache yet → its gate
must use the fallback (and the fix PR itself may need an admin-merge to escape
the stale snapshot — that's the ONE sanctioned bypass, for the meta-fix). After
it lands, seed `runs/<current-main-tip>.jsonl` once (from the freshest full-
shard merged report) so the already-open PRs' near-current bases resolve; from
then on the cache self-populates per merge.

## Notes

Supersedes the snapshot dependency in #3457/#3466 for gate purposes (they can
close or narrow to the landing-page summary). Real latent null_deref in the 2
timeout-unmasked tests (Function/prototype/Symbol.hasInstance/…, S13.2.2_A8_T2)
is a separate pre-existing bug — file independently.
