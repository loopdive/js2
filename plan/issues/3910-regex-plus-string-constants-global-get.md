---
id: 3910
title: "A module combining a regex literal with string constants mis-resolves a global.get in `run`"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: regexp
goal: performance
sprint: Backlog
horizon: m
es_edition: multi
related: [3900, 3909]
---

# #3910 — regex literal + string constants mis-resolves `global.get` in `run`

## Status: open — pre-existing, surfaced during #3900

## Problem

A module containing both a regex literal and string constants mis-resolves a
`global.get` inside the exported `run` function. The wrong global index is
read, so `run` operates on an unrelated value.

Both regex lowering and the string constant pool allocate module globals. If
one of them appends globals after the other has already captured indices — or
if the two use separate index spaces that are later merged — the reference
goes stale. That is the same *shape* as the `addUnionImports` index-shifting
hazard documented in `CLAUDE.md` for function indices, but on the global index
space.

## Scope

1. Build the minimal repro (a regex literal plus at least one string constant,
   exercised from `run`) and capture the wrong-index symptom precisely — the
   expected vs. actual global, not just "wrong result".
2. Determine the ordering: which pass allocates globals, which captures
   indices, and whether anything appends after capture.
3. Check whether the string-constant pool and the regex globals share an index
   space, and whether a shift is applied to one but not the other.

## Acceptance criteria

1. Minimal repro committed as a regression test.
2. Root cause identified and fixed, with the ordering/index mechanism written
   down.
3. A check for other consumers of global indices that could go stale under the
   same append-after-capture pattern.

## Notes

Found by `issue-3900-case-convert` while probing case conversion. It verified
the failure **reproduces identically on the parent commit**, so it is
pre-existing. Reported rather than fixed — correctly out of scope there.

Filed separately from #3909 (the `__str_trimStart` multi-feature validation
failure) because the two have different symptoms and different index spaces,
but they surfaced together and may share a root cause. Whoever picks up one
should read the other.
