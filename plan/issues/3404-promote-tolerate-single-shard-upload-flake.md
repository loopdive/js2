---
id: 3404
title: "Baseline promote is blocked by a single test262 shard artifact-upload flake — tolerate ≥N-1 shards or retry the upload"
status: done
completed: 2026-07-24
sprint: 76
created: 2026-07-18
priority: medium
feasibility: medium
horizon: s
# task_type: ci — this is a GitHub Actions workflow-resilience fix with no
# compiler/runtime repro (the fix is pure workflow YAML). It is exempt from the
# #2093 issue→probe coverage gate by design ("Infra/tooling/docs/process issues
# are exempt — they have no runtime repro"); the earlier `bug` value was a
# misclassification for a shard artifact-upload retry.
task_type: ci
area: ci, infra
goal: infrastructure
lane: A
related: [3307, 3381, 2097]
origin: "2026-07-18: the standalone-heal refresh-baseline run (#3307's first real run) FAILED because ONE of 114 shards hit `Failed to CreateArtifact: Unable to make request: ETIMEDOUT` on the Upload step — a transient GitHub infra flake, not a test failure. The whole promote was blocked; a targeted `gh run rerun --failed` cleared it."
---

# #3404 — baseline promote must tolerate a single shard artifact-upload flake

## Problem

`refresh-baseline.yml` (and by the same pattern `test262-sharded.yml`'s
promote path) fans out to a large shard matrix — now **114 shards** since
#3381 added the standalone lane (host + standalone). The `merge-and-promote`
job `needs:` the shard job, so **any single shard failure aborts the whole
promote** — including a purely transient GitHub Actions
`Failed to CreateArtifact: … ETIMEDOUT` on the artifact **upload** step (the
test itself passed; only the upload flaked).

Observed 2026-07-18: the first real standalone-aware refresh (the one healing
the stale public standalone number) FAILED on exactly this — standalone shard
49's upload timed out. A manual `gh run rerun 29618677416 --failed` re-ran that
one shard and the promote then completed. But a human had to notice and rerun;
under automation (the scheduled/anti-staleness refresh) a stray upload flake
would silently fail the promote and leave the baseline stale until the next
cycle.

At 114 shards, the probability of ≥1 upload flake per run is materially higher
than at 57, so this will recur.

## Fix options (pick the robust one, justify in PR)

1. **Retry the artifact upload** — wrap the `Upload shard artifacts` step in a
   retry (the upload is idempotent; `actions/upload-artifact` failures are
   almost always transient network). Cheapest, most targeted.
2. **Tolerate ≥N-1 shards at the merge step** — if all-but-one shard artifact
   is present, proceed with a logged warning rather than aborting, PROVIDED the
   merged report still passes the existing sanity floor (pass≥1000/total≥40000)
   and the missing shard is a small fraction. (Careful: must NOT silently
   promote an incomplete report as if complete — the total-count sanity guard
   must catch a genuinely-missing large chunk.)
3. Combination: retry upload first (option 1), fall back to N-1 tolerance
   (option 2) only if a shard is genuinely lost.

Prefer option 1 (retry) as the primary fix — it preserves report completeness.
Option 2 is a backstop and must not weaken the corrupt/incomplete-data guard.

## Acceptance criteria

- [x] A single transient shard artifact-upload flake no longer aborts the
  promote (retry succeeds, or N-1 tolerance proceeds with the sanity floor
  intact).
- [x] The corrupt/incomplete-data sanity guard (pass≥1000/total≥40000) is NOT
  weakened — a genuinely-missing large chunk still aborts.
- [x] Applies to both `refresh-baseline.yml` and `test262-sharded.yml`'s promote
  shard→merge path (same pattern in both).

## Resolution (2026-07-24)

Implemented **option 1 (retry the upload)** — the issue's preferred fix, since
it preserves report completeness. Each shard's `Upload shard artifacts` step
now carries `id:` + `continue-on-error: true`, followed by a
`Retry shard artifact upload on transient flake (#3404)` step gated on
`steps.<id>.outcome == 'failure'` with `overwrite: true`. Applied to all three
shard-upload sites:

- `test262-sharded.yml` — `test262-shard` (PR/push path) and `test262-shard-mg`
  (merge_group promote path).
- `refresh-baseline.yml` — the scheduled/emergency shard upload (the exact step
  that flaked on 2026-07-18).

**Why the sanity floor is NOT weakened.** `continue-on-error` masks attempt 1's
failure only long enough for attempt 2 to run; attempt 2 has no
`continue-on-error`, so if BOTH attempts fail the shard (and the promote that
`needs:` it) still fails. A *genuinely empty* shard (no result file) is handled
by the pre-existing `if-no-files-found: warn` — that is a step **success** with
a warning, so it never triggers the retry and produces no artifact, leaving the
merge step's `pass≥1000 / total≥40000` incomplete-data guard to catch a real
missing chunk exactly as before. There is no path where a valid-data shard
silently uploads nothing yet the job passes.

`overwrite: true` on the retry (already used on other upload-artifact steps in
these workflows) clears any partially finalized artifact from the flaked first
attempt, avoiding an "artifact already exists" error on the second try.
