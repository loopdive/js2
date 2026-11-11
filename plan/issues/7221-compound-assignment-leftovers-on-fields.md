---
id: 7221
title: "Compound assignment on fields: remaining wrong results after #7214"
status: ready
sprint: Backlog
created: 2026-11-01
updated: 2026-11-01
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: operators
goal: correctness
related: [7214]
---

# #7221 — compound ops on fields, what #7214 left

#7214 (PR #7025) fixes `+=` on string fields. Its implementation probe
(compound operators × field types × receivers, 3 lanes) found these, all the
same on main:

- `-=` / `*=` on a string field: illegal cast (node: `NaN`).
- `+=` on a `number | string` union field: `NaN` or a trap.
- `&&=` on a `string | undefined` field gives `null`.
- Arithmetic compound ops on a boolean field give the wrong value.
- `+=` on an `any`-typed static field produces an invalid module.
- `+=` writes through `Object.freeze` (node throws TypeError in strict code);
  numeric `+=` does the same.

## Plan

1. Reproduce each against node on gc, standalone and wasi; split if causes
   differ.
2. Fix in `src/codegen/expressions/operator-assignment.ts` and the static-field
   path, reusing binary-operator lowering for the value.
3. One test row per bullet.
