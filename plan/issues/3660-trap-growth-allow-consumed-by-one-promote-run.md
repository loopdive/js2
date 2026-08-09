---
id: 3660
title: "trap-growth-allow is consumed by exactly ONE promote run — an unrelated failure of that run re-creates the wedge"
status: ready
created: 2026-07-26
priority: medium
horizon: m
feasibility: medium
area: ci
goal: ci-hardening
sprint: current
related: [3644, 3639, 3634, 3370, 3189]
---

# #3660 — the allowance is single-shot, so recovery is not self-healing

## Residual left open by #3644 / PR #3639

#3639 fixes the deadlock where a declared `trap-growth-allow` never reached the
post-merge promote job. That is the right fix and it prevents the wedge. **It does
not make recovery self-healing**, and that gap should be recorded rather than
assumed away.

## The residual

A change-scoped allowance is resolved from **the merge commit's change-set**, so it
is available to **exactly one promote run** — the one for the merge that introduced
it. If that specific run fails for **any unrelated reason** (a push race to the
baselines repo, an artifact 403, a runner failure, a cancelled run), the
declaration is gone from every later change-set. Subsequent pushes carry no
declaration, the trap category is still elevated on main, and the promote refuses
identically. **That is byte-for-byte the original wedge**, and clearing it again
needs the blanket `BASELINE_TRAP_GROWTH_ALLOW` repo-variable valve.

This matters because promote failures are exactly the class that already happens
for unrelated reasons — see #3634, where the promote job failed on **six
consecutive** pushes from a push race.

## Second, independent residual (completeness)

`evaluateTrapReclassification`'s completeness condition is **stricter than the
ceiling**: it fails if **any** newly-trapping file in a growing category is
unnamed, and `newlyTrapping[cat]` can exceed the net delta. So `count: 1` does not
guarantee the promote succeeds if the merged state moves any *other* file into a
trap category.

## Options

1. **Persist the granted ceiling alongside the baseline** so it survives a failed
   run and is re-applied on retry, rather than living only in the change-set.
2. **Detect the specific state** (baseline trap count < main's, with a matching
   previously-declared allowance) and re-honour it rather than refusing.
3. At minimum: **alert loudly** when a promote refuses on a trap category, naming
   the declaration that would have covered it — today the failure is silent and
   took ~9h to notice (#3634).

## Shape rule to preserve

Post-merge, an allowance is honoured only when the declaration carries a nested
`tests:` list (`named-verified`). A bare `count:` + `reason:` with no oracle bump
stays `inert` and grants zero. Future PRs declaring trap growth **must** include
`tests:` or they wedge promote regardless of the count.
