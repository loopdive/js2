---
id: 7218
title: "Twin-layout check is recomputed per arm (compile time grows ~cubically with many classes)"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7199]
---

# #7218 — cache the twin answer

Found by the PR #7017 (#7199) review. `hasLayoutTwin` /
`mayShareCanonicalLayout` (`src/codegen/class-arm-tag-guard.ts`) is recomputed
for every arm. On a generated chain of near-twin classes the output is
unchanged but standalone compile time grows fast: 300 classes 5.4–6.3 s →
9.0–9.8 s, 600 classes 14.7 s → 43.8 s. Realistic programs show no
difference.

Also from the review: the last branch of the type comparison treats every
unknown type kind as a function type and should answer "maybe"; and a
comment should say why keeping failed pairs in the visited set is safe.

## Plan

1. Cache the twin answer per struct type index for the duration of a
   compile (and the pairwise comparison result).
2. Fix the unknown-kind branch; add the comment.
3. Output must stay byte-identical; measure the 300/600-class chains before
   and after.
