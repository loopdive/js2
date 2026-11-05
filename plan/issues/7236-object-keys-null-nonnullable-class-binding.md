---
id: 7236
title: "Object.keys on a null value in a non-nullable class binding returns static keys instead of throwing"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: correctness
related: [7216, 7222]
---

# #7236: `Object.keys(x!)` / `Object.keys(x as A)` on a null value

Left by #7216 (PR #7051). Its row "null receiver throws" was dropped in round 4.

For a receiver whose static type is a subclassed class and not nullable (`x!`,
`x as A`, `h.a!`), a value that is really null now gets base's compile-time key
list. Node throws a TypeError. Head equals base, so this is not a regression,
but it is wrong.

The same null branch also handles a failed cast (`JSON.parse(s) as A`). Today
the two are indistinguishable, because the guarded cast collapses a
non-matching object to null (#7222). Once #7222 keeps "non-matching object"
distinct from null:
- a real null → TypeError;
- a non-matching object → runtime enumeration of the real object (node's
  answer). The four base-pinned rows in
  `tests/equivalence/issue-7216-object-keys-subclass.test.ts` then change on
  purpose.

Also: `x!.hasOwnProperty("a")` with `x` null returns `false` (base `true`, node
throws), because `__hasOwnProperty` has no null-receiver guard.

**Depends on:** #7222.
