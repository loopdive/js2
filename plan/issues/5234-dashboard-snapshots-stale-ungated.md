---
id: 5234
title: "Checked-in dashboard issue snapshots are thousands of records stale and no required check notices"
status: ready
sprint: current
created: 2026-08-31
updated: 2026-08-31
priority: medium
horizon: m
feasibility: medium
reasoning_effort: max
task_type: infrastructure
area: dashboard, ci, planning
language_feature: n/a
goal: process
related: [1616, 1656]
requested_by: ttraenkler/codex-sol-ultra
---

# #5234 — make dashboard snapshots deterministic and enforce their ownership

## Problem

The tracked `website/dashboard/data/issues.json` contains **2,157** entries:

```text
43 backlog / 26 blocked / 179 ready / 23 in-progress / 0 review / 1886 done
```

Running the current generator from the same upstream source produces **4,263**
entries:

```text
78 backlog / 52 blocked / 610 ready / 177 in-progress / 49 review / 3297 done
```

The gross drift is **+2,106 records**. Three fresh records are non-issue
phantoms owned by reopened #1616, so even after excluding them the checked-in
snapshot is more than two thousand canonical records behind.

The generator is part of `scripts/build-planning-artifacts.mjs`. CI runs it
only in a push-only step inside the `quality` job at
`.github/workflows/ci.yml:599-606`, then does not compare the worktree or fail.
The commit-back block at lines 608-625 is disabled and still names obsolete
paths. `docs/ci-policy.md` repeats those obsolete paths and describes
enforcement that is not active.

Public Pages is partly protected because `scripts/run-pages-build.mjs`
regenerates before deployment. The stale tracked file still affects clones,
offline use, reviews, and any consumer that reads repository snapshots rather
than the Pages build.

## Controls

The generator comparison is not universally noisy: regenerated `runs.json`
was byte-identical at 137 entries. `sprints.json`, `issues.json`, and `data.js`
changed. This makes ownership/determinism a per-artifact problem that can be
tested, not a reason to leave every snapshot unenforced.

## Direction

Choose one explicit model:

1. Track deterministic snapshots and add a required temp-output comparison;
   source changes make it red until a reviewed regeneration lands.
2. Stop tracking generated dashboard payloads, make every local/Pages consumer
   generate them, and document that source files—not stale JSON—are canonical.

Do not retain tracked outputs with neither a freshness gate nor a declared
deploy-only status. Coordinate the canonical issue predicate with #1616 so the
new check does not bank phantom records.

## Acceptance criteria

- [ ] The repository declares whether each dashboard payload is tracked source
      or generated-only output.
- [ ] For tracked outputs, a source issue add/status/remove makes a required
      check fail and regeneration restores green.
- [ ] Volatile timestamps are deterministic or normalized for comparison.
- [ ] Local/offline dashboard and Pages consume the same canonical payload.
- [ ] Documentation names current `website/dashboard/...` paths and does not
      cite the disabled commit-back step as enforcement.
- [ ] After #1616, dashboard issue identities equal the canonical issue scanner
      exactly.
