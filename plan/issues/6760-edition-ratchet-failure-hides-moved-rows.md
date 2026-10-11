---
id: 6760
title: "CI: a per-edition ratchet failure skips the #1897 guard, so a merge-queue park never names the moved standalone rows"
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
related: [6461, 2097, 1897, 6736]
---

# A ratchet failure hides which standalone rows moved

## Symptom

On 2026-09-29 every source PR's merge group failed `merge shard reports` with
the same two lines: ES5 (a completed edition) lost one row, and the standalone
host-free pass count fell 54 below its high-water mark. Nothing in the run named
the other ~53 rows.

## Cause

The per-edition conformance ratchet step (added with the completed-edition rule
in #6290) failed at its own position. Every later step without `always()` was
skipped, including the #1897 standalone regression guard, the only step that
prints which standalone rows moved. #6461 had already fixed exactly this for the
#2097 high-water floor by deferring its failure; the ratchet step was added
after it and did not follow the pattern.

## Fix

The ratchet step now carries `id: edition_ratchet` and `continue-on-error:
true`. A new step, "Fail on per-edition ratchet breach (deferred, #6760)",
re-raises its outcome with `always()` after the #1668 and #1897 guards have
run. The ratchet stays exactly as strict: the required check still fails on a
breach, one step later.

`tests/issue-6760-edition-ratchet-deferred-failure.test.ts` pins both halves
and the guard between them, like the #6461 test does for the floor.
