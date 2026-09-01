---
id: 5230
title: "`check:issues` reports semantic generated drift but has no freshness verdict"
status: ready
sprint: current
created: 2026-08-31
updated: 2026-08-31
priority: medium
horizon: s
feasibility: easy
reasoning_effort: max
task_type: infrastructure
area: tooling, planning, ci
language_feature: n/a
goal: process
related: [1616]
requested_by: ttraenkler/codex-sol-ultra
---

# #5230 — give generated issue drift an enforceable, deterministic verdict

## Problem

The required `check:issues` step runs
`node scripts/update-issues.mjs --check`. On current upstream main it reports:

```text
update-issues — 4260 issues indexed
  would update 0 issue files
  would update plan/log/sprints/index.md: true
  would update plan/issues/backlog/index.md: true
  would update plan/issues/wont-fix/index.md: true
```

and exits **0**.

The three booleans are calculated correctly at
`scripts/update-issues.mjs:695-697` and printed at lines 699-705, but the check
failure list at lines 758-767 includes only duplicate IDs, ID mismatches,
dangling dependencies, and broken links. It never includes generated drift.
Issue-file normalization drift is even misreported: `issueFilesUpdated` is
incremented only inside `if (!CHECK && nextText !== originalText)` at lines
414-417, so check mode necessarily prints zero.

The current `--check` header calls the mode "audit only, no writes", and CI's
comments name the four structural failures. That makes this an underspecified
contract rather than evidence that every byte difference was intended to be
fatal. The quality problem is that no other required check owns freshness even
when this command positively detects meaningful drift.

## Semantic drift reproduced

Regeneration in an isolated worktree changed the planning data, not just a
date header:

- the sprint index advances beyond the committed Sprint 77 view;
- backlog summary changes from **191 ready / 45 blocked / 71 backlog** to
  **186 / 41 / 77**;
- wont-fix count changes from **55** to **58**.

The full normalization pass also changes thousands of tracked issue records,
yet check mode reports zero issue files by construction. Required CI therefore
confirms structural referential integrity while allowing its generated views
and normalized source records to drift indefinitely.

There is a second fail-open at lines 733-737: failure of `git ls-files` is
swallowed, turning the broken-link population into an empty successful scan.

## Direction

Define two explicit, separately named contracts if both are useful:

- structural integrity (duplicates, identity, dependencies, links); and
- deterministic freshness (normalization and generated artifacts).

Compute proposed issue-file changes even when writes are disabled. Stabilize
the generated date from source/revision metadata, or compare normalized content
that excludes a date-only header, before making freshness required.

## Acceptance criteria

- [ ] A pristine committed tree exits 0 without writes.
- [ ] A fixture issue that needs normalization exits non-zero and names the
      file while leaving it untouched.
- [ ] Independently perturbing each of the three generated indexes exits
      non-zero and names that path.
- [ ] Crossing a UTC date with unchanged source does not create drift.
- [ ] A simulated `git ls-files` failure is non-zero or explicitly marks the
      check degraded and non-successful.
- [ ] Required CI calls the deterministic freshness contract; the narrower
      structural audit, if retained, has a name that cannot be mistaken for it.
