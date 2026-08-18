---
id: 4211
title: "baseline-summary-sync commits a NEW standalone high-water mark next to a README synced from the OLD one — main ships internally inconsistent and every open PR fails the quality gate"
status: done
completed: 2026-08-07
assignee: ttraenkler/lead
sprint: 78
created: 2026-08-07
priority: high
horizon: s
feasibility: easy
task_type: fix
area: ci
goal: dogfood
related: [1522, 3953, 2097, 4178, 1951]
origin: "2026-08-07 — third recurrence in one session (28,222→28,227, then 28,257→28,270); nine PRs parked on the same gate that morning."
---

# #4211 — the conformance-sync ordering bug

## Symptom

Every open PR fails the `quality` gate:

```
[sync-conformance] DIFFERS  README.md (standalone)
  committed: **standalone (host-free) test262 conformance**: 28,257 / 43,505 (65.0 %)
  generated: **standalone (host-free) test262 conformance**: 28,270 / 43,505 (65.0 %)
```

The mismatch is between **main's own README** and **main's own committed
artifacts** — nothing to do with the PR being tested. It clears only when some
unrelated PR happens to carry a `pnpm run sync:conformance` commit, and it comes
straight back on the next baseline bump.

Observed **three times on 2026-08-07**, and it parked nine PRs that morning
(patched then as #4178, which repaired the symptom and not the cause).

## Root cause

`sync-conformance-numbers.mjs` derives **two** numbers from **two different
files**:

| line | source |
| --- | --- |
| JS-host conformance | `benchmarks/results/test262-current.json` |
| **standalone (host-free)** | **`benchmarks/results/test262-standalone-highwater.json`** |

In `.github/workflows/baseline-summary-sync.yml` the order was:

1. copy the fresh `test262-current.json`
2. **run `sync-conformance-numbers.mjs`** ← reads the *old* high-water mark
3. **`check-standalone-highwater.mjs --update`** ← raises the mark
4. `git add` the mark **and** the README, and commit

So the commit contains a **new mark** and a README standalone line synced from
the **old** one. Not a race and not flaky — a deterministic, guaranteed
inconsistency emitted every time the mark rises.

The `promote-baseline` job in `test262-sharded.yml` carries a comment insisting
this sync "must update everything derived from it ATOMICALLY in the same
commit". That intent was right; this job's ordering silently broke it, because
the standalone half derives from an artifact that is written *later in the same
job*.

The **re-anchor / retry path** (the `for attempt in 1 2 3 4 5` loop) had the same
defect in a subtler form: it re-applies the snapshotted README — already synced
against the *original* mark — then recomputes the mark against main's freshly
fetched tip (`max(ours, main's)`), and never re-syncs.

## Fix

- **Fresh path:** move the `sync-conformance-numbers.mjs` call to *after* the
  high-water raise, so both inputs are final before the docs are written.
- **Re-anchor path:** re-run the sync after the recompute and re-stage
  `README.md ROADMAP.md CLAUDE.md plan/goals/goal-graph.md`.

`refresh-baseline.yml` already had the correct order (raise at ~447, sync at
~780) and is unchanged. `test262-sharded.yml`'s promote job takes the mark from
an artifact that is already final when it syncs, and is unchanged.

## Why this was worth chasing rather than patching again

The per-PR repair is one line and takes a minute, which is exactly why it kept
being the chosen response. But the cost is not the minute:

- it blocks **every** open PR simultaneously, so it scales with queue depth;
- the failure names the *PR's* `quality` job, so each lane diagnoses it from
  scratch as though it were their own regression;
- and it recurs on every baseline bump, which is several times a day.

## Verification

`baseline-summary-sync.yml` parses (`yaml.safe_load`), and both `sync` calls now
follow their corresponding `check-standalone-highwater` call — verified by line
order: raise 224 → sync 237, raise 333 → sync 343.

The real proof is behavioural and arrives on the next high-water rise: main
should stay self-consistent and no PR should need a hand-carried sync commit.
If one does, this fix is incomplete and there is a third writer.
