---
id: 3467
title: "test262 regression gate: compare each PR against its REAL merge-base commit (per-SHA cache), not a drifting promoted snapshot"
status: done
completed: 2026-07-23
sprint: 75
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

## Implementation notes (what & why)

**Root cause found (#3466 mechanism).** On a queue merge, main fast-forwards
via a `github-actions[bot]` push. On that bot push the ENTIRE `test262-sharded`
workflow is gated off — `changes`, `test262-shard`, `merge-report`,
`mg-artifact-probe` and `promote-baseline` all carry
`github.actor != 'github-actions[bot]'`. So the landed commit (which IS the
`base_sha` of the next queued PR's `merge_group`) got **no** `runs/<sha>` cache
entry, and the promoted `test262-current.jsonl` snapshot never refreshed on bot
merges → the gate diffed a lagging snapshot → main's own drift was attributed to
innocent PRs (the 6 false-parks).

**Write side — new `write-run-cache-bot` job** (`test262-sharded.yml`). Runs
ONLY on `push` + `github.actor == 'github-actions[bot]'` (the exact case
`promote-baseline` skips). It reuses the `test262-group-<github.sha>` artifact
the just-landed `merge_group` already produced (`github.sha` == that group's
`head_sha` after the FF), heals poison rows for parity with `promote-baseline`,
builds the summary, and writes ONLY `runs/<github.sha>.{json,jsonl}` to the
baselines repo. It deliberately does **not** promote `test262-current` and does
**not** commit to the main repo — so it adds zero queue-rebuild cost (the reason
`promote-baseline` is bot-gated, #1951). A doc-only/no-shards merge (no group
artifact) cleanly no-ops. On non-bot push / `workflow_dispatch` this job is
skipped and `promote-baseline`'s own `write-run-cache` call still populates
`runs/<sha>` → no double-write, no baselines-push race.

*Why a separate job, not relaxing `promote-baseline`'s gate:* the deploy-key push
lives behind the `baseline-promote` Environment (branch-restricted to `main`),
which a bot push to main satisfies; a `merge_group` ref would NOT satisfy it, so
the write cannot live in `merge-report`. And `promote-baseline` bundles the
snapshot promotion + main-repo summary commit we intentionally keep bot-skipped.

**Read side — `runs/<base_sha>` with ancestor-walk** (the #1081 "Load cached
baseline for merge-base" step + `scripts/resolve-merge-base-baseline.mjs`). For
`merge_group` the base is now `github.event.merge_group.base_sha` (the queue's
exact parent) instead of `git merge-base origin/main HEAD`; `pull_request` keeps
today's `git merge-base`. The step builds an ORDERED candidate list — exact base
first, then up to 25 nearest-first ancestors — and the resolver
(`resolveFromCandidates`) walks to the nearest cached, version-compatible entry,
emitting `resolved_sha` + `distance` so a cold base is logged as a warning, never
silent. Total miss → the promoted snapshot (today's behavior). The existing
#1956 predecessor-group artifact path still runs last and can override (it's a
fresher form of the same base isolation for multi-entry queues).

**Preserved as separate gates:** the #3189 trap-growth ratchet, the #1897
standalone floor, and the #1668 stale-baseline broken-pipeline detector are
untouched — this change only alters WHAT baseline the host regression diff uses.
The promoted `test262-current.json` summary write stays for the landing page,
now non-load-bearing for the gate.

**Transition / this PR needs an admin-merge.** The fix PR's own `merge_group`
runs against a base with no `runs/<base_sha>` yet → its gate exercises the
ancestor-walk → promoted-snapshot fallback (logged, non-fatal). Because that
snapshot is exactly the stale one this issue removes, escaping it needs the ONE
sanctioned admin-merge from the lead. After it lands, the lead seeds
`runs/<current-main-tip>.jsonl` once from the freshest full-shard merged report;
from then the cache self-populates per queue merge.

**Tests:** `tests/issue-3467.test.ts` covers `resolveFromCandidates` — exact-base
HIT (distance 0), cold-base ancestor-walk (nearest wins, distance reported),
version-mismatch skip-and-continue, total MISS fallback, and blank-slot
filtering. `tests/issue-1081.test.ts` (existing `evaluateCacheEntry` /
`buildRunSummary` unit tests) still passes.

## Follow-up fix — write side silently skipped (write-run-cache-bot)

After the first PR landed (618f89d35), the READ side worked (gate HIT the
seeded base at distance 2, null_deref flat), but the WRITE side never populated
new `runs/<sha>` entries, so the cache never converged to distance-0 and
near-threshold net-positive PRs kept parking on residual drift.

**Diagnosis (run 29682548248, the push for main tip 60e81a65b):**
1. **Wrong actor.** A merge-queue merge lands as a `push` whose
   `github.actor` is **`github-merge-queue[bot]`**, NOT `github-actions[bot]`.
   The job's `if: … actor == 'github-actions[bot]'` never matched → the job
   showed `skipped`. (Proof the actor isn't github-actions[bot]: the
   regression-gate job, gated `actor != github-actions[bot]`, RAN on that push.)
   #3466's premise that queue merges are github-actions[bot] was wrong.
2. **The environment would have skipped it anyway.** `promote-baseline` is ALSO
   `skipped` on these pushes — not by its `if:`/`needs` (both pass) but by its
   `environment: baseline-promote` deployment gate (empty steps; every
   non-environment job on the same run ran). Since the write job carried the
   same `environment:`, fixing only the actor would still have skipped it.
3. **The artifact resolves fine.** `github.sha` on the merge-queue push EQUALS
   the merge_group head (the queue fast-forwards main), so
   `test262-group-${github.sha}` is present (probe HIT) — hypothesis that the
   merge-commit SHA ≠ the tested group's SHA was false.

**Fix:** gate the job on `github.actor == 'github-merge-queue[bot]'` and REMOVE
`environment: baseline-promote`. The baselines-repo push uses
`BASELINE_DEPLOY_KEY`, which is a **repo-level** secret (only `MAIN_DEPLOY_KEY`
is environment-scoped), so no environment is needed — and dropping it avoids the
deployment-gate skip. The job never pushes to the main repo, so it never needed
`MAIN_DEPLOY_KEY`. No double-write with promote-baseline (disjoint push
populations; idempotency guard covers overlap).
