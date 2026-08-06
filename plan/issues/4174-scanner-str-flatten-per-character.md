---
id: 4174
title: "perf: the scanner re-flattens the source string PER CHARACTER — `__str_flatten` is 3.7% of the standalone acorn parse, called from `skipSpace`/`fullCharCodeAt`; likely the cheapest slice the profile found"
status: ready
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
goal: performance
related: [4157, 3926, 4173]
origin: "2026-08-06 post-campaign CPU profile (#4157, PR #4143) — one of two measured buckets with no owning issue"
---

# #4174 — per-character `__str_flatten` in the scanner

## Problem (measured, not estimated)

The 2026-08-06 post-campaign profile (full table in
`plan/issues/4157-close-the-acorn-node-performance-gap.md`) attributes
**3.7% of total self-time** to `__str_flatten`, and the caller attribution
shows it entered **once per scanned character** from the tokenizer's
`skipSpace` and `fullCharCodeAt` paths.

That shape is the bug: a 226 KB source string is flattened (rope/concat form
normalized into a contiguous array) on EVERY `charCodeAt`-style access, when
one flatten at scanner entry — or a flat-fast-path check — should make the
per-character cost a bounds-checked array read. The profiler called this
"likely the cheapest slice found," and no issue owned it before this one.

## Direction (verify against source before implementing)

- Find the `charCodeAt`/code-unit-read lowering that calls `__str_flatten`
  (native-strings runtime; grep `__str_flatten` callers in `src/codegen/`).
- Likely fixes, in ascending ambition: (a) an `is-already-flat` fast path
  that skips the call when the rope depth is 0 (if the check is not already
  there, or is there but behind the call boundary so the call cost is paid
  anyway — the profile suggests the CALL is the cost); (b) inline the flat
  check + direct array read at the read site; (c) flatten once at a
  well-defined boundary (e.g. `String(input)` at parser construction already
  produces flat — if so, find what re-introduces rope-ness).
- Note the #3753 lesson from this same program: measure WHERE the reads
  route before assuming the fix moved them.

## Acceptance criteria

- [ ] `__str_flatten` self-time drops from 3.7% on the profile driver
      (`scripts/profile-buckets.mjs`), or the issue records why not.
- [ ] `standaloneDynamic` A/B (3 pairs, std reported) per #4157 rules.
- [ ] String semantics pinned: the string-method and template equivalence
      suites green before/after; no new host imports; canaries unchanged.

## Dupe check

Distinct from #3926 (property lookup) and #4166 (equality) — same profile,
different helper. The string-runtime issues around `__str_toLowerCase`
(#4106-era analysis) touched adjacent code but not the flatten-per-character
pattern.
