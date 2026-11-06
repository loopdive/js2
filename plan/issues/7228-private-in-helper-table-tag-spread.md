---
id: 7228
title: "`#x in` jump table grows with the class-tag spread, not the subclass count"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: performance
area: codegen
language_feature: classes
goal: performance
related: [7202]
---

# #7228 — bound the #7202 helper by tag spread

Found by the PR #7048 (#7202) review. The per-class `#x in` helper dispatches
with a `br_table` over `__tag - minTag`, so its size follows the spread of
tags, not the number of subclasses: `class C`, then 400 unrelated classes,
then `class D extends C` with one site costs +453 B on gc and standalone and
+1,005 B on wasi. The 256 cap only limits the subclass count.

## Plan

1. Fall back to the inline chain (or a sorted `if` ladder) when the tag spread
   is much larger than the subclass count.
2. Measure the bytes for that layout and for the #7202 table.
