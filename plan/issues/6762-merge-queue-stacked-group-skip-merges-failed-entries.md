---
id: 6762
title: "CI: an artifact-only PR on top of failed merge groups skips test262, goes green, and merges the failed entries beneath it"
status: done
completed: 2026-09-29
created: 2026-09-29
updated: 2026-09-29
priority: high
horizon: s
goal: ci-hardening
task_type: bug
area: ci
sprint: current
requested_by: ttraenkler/claude-lead
related: [6760, 6736, 6735, 3914, 3431]
---

# Failed merge groups reach `main` under an artifact-only PR

## Symptom

On 2026-09-29, PRs whose merge-group `Test262 Sharded` run **failed** still
landed on `main`:

| failed group(s) | merged under | top group's test262 run |
| --- | --- | --- |
| #6299 | #6302 (npm-compat refresh) | shards skipped, green |
| #6301, #6307, #6306 | #6309 (npm-compat refresh) | shards skipped, green |
| #6285, #6314, #6308 | #6315 (npm-compat refresh) | shards skipped, green |

#6299 and #6301 each broke a completed-edition (ES5) row, so `main` failed the
per-edition ratchet for hours and every source PR queued behind them failed.

## Cause

GitHub merges every queue entry *underneath* a merge group that passes,
including entries whose own group failed. The top group decides.

The `detect test262-relevant changes` job classified `merge_group.base_sha ..
head_sha`. For a **stacked** group, `base_sha` is the head of the entry ahead
of it, not `main`, so the diff held only the top PR's own files. An npm-compat
artifact refresh touches no test262-relevant path, so every shard was skipped,
the required checks passed, and the whole stack merged.

## Fix

The detect step now also resolves the base branch tip
(`merge_group.base_ref`). When it differs from `base_sha` (a stacked group),
it diffs that tip against `head_sha` and classifies the **union**, and the
version-only manifest filter compares against the tip too. An unresolvable tip
or a failing stack diff fails safe (all lanes run). A group built directly on
`main` behaves exactly as before.

`tests/test262-per-lane-gating.test.ts` runs the real step body against a
stubbed `git`: an artifact-only entry stacked on a compiler change now runs
both lanes (it skipped before), the same entry built on `main` and a stack
that is docs-only all the way down still skip, and both new fail-safe paths
run everything.

## Not covered

Other `merge_group` workflows with their own path filters (for example the
`changes` job in `ci.yml` that gates `equivalence-gate`) may classify a
stacked group the same way. They do not carry the conformance ratchet, so
they are left for a follow-up.
