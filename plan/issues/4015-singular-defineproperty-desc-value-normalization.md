---
id: 4015
title: "The singular __defineProperty_desc still has the undefined->null `value` bug fixed in the plural — needs its own measurement first"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-gap
related: []
---

# The singular __defineProperty_desc still has the undefined->null `value` bug fixed in the plural — needs its own measurement first

## Problem

`__defineProperty_desc` (the **singular** form) still carries the
`undefined → null` `value` normalisation bug that was fixed in the **plural**
path under #3991: `getField` normalises `undefined → null` for the absent
get/set halves (#2106 S1), which is correct there but **wrong on `value`** —
and `typeof null === "object"`, so the wrong value is also the wrong type.

## ⚠ Do NOT just port the fix — measure first

This was **deliberately left untouched** by the agent that fixed the plural form,
for a specific reason: **files may currently be passing for the wrong reason
here too.** In the plural path, `15.2.3.7-5-b-122` was passing *because* the bug
produced `undefined` — exactly what it asserts — and correcting the path turned
it red until the underlying normalisation defect was fixed properly.

So the required order is:

1. **Enumerate the complete at-risk population** for the singular path (trigger
   shape: singular `Object.defineProperty` with a descriptor whose `value` is
   absent or `undefined`). Enumerate over all official files — **do not sample**;
   the plural-path instance was 1 file in 634.
2. Identify which of those currently **pass because of the bug**.
3. Then fix, and verify the gains you are protecting still pass — not only that
   the previously-failing files now pass.

Good small follow-up, but it is a measurement task before it is a fix task.

Found by `L-descriptor` 2026-08-01. Unowned.
