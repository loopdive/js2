---
id: 7232
title: "`+` leftovers: BigInt mixing, wasi `Symbol.toPrimitive`/Date, a module `let` written inside `valueOf`"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: operators
goal: correctness
related: [7223, 7214]
---

# #7232 — what the #7223 `+` fix leaves

Found by the PR #7049 (#7223) round-2 review; all the same on main and head:

- BigInt: `1n + 1` does not throw TypeError, and `1n + 2n` is not `3n`.
- wasi: `Symbol.toPrimitive` is not honoured, and `new Date(0) + 1` is wrong.
- A module-level `let` written inside a `valueOf` called by `+` reads back
  wrong afterwards, even with plain legacy `+`.

## Plan

1. Reproduce each on 3 lanes against node; split by cause.
2. Fix BigInt in the shared `+` path (`emitAnyAddFromExternTemps`), the wasi
   ToPrimitive gaps, and the module-slot write-back.
3. Tests against node.
