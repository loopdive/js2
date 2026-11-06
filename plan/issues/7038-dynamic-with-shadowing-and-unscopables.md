---
id: 7038
title: "with: nested dynamic scopes resolve the outer object, a call-expression target misses names, and @@unscopables is ignored (issue-2663, issue-2663-unscopables red)"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: with
goal: core-semantics
parent: 7014
related: [2663, 7029]
---

# #7038 — dynamic `with` (§9.1.1.2 Object Environment Record) residue

## Evidence (upstream/main 0727e2985b)

- `tests/issue-2663.test.ts` 3 red: nested `with`, inner object shadows outer for
  a shared name → reads outer (1 vs 2); write to the shared name lands on the
  outer (92 vs 19); a `with` target produced by a call expression →
  `ReferenceError: z is not defined`.
- `tests/issue-2663-unscopables.test.ts` 4 red: a false-valued / empty /
  non-object `@@unscopables` must NOT block (object property wins), and
  `@@unscopables` blocks only the named property — all read the outer binding
  or throw `ReferenceError: y is not defined`.

## Plan

1. Probe each shape on host and standalone; confirm the HasBinding order
   (innermost object first, then @@unscopables check per §9.1.1.2.1 steps 4–8).
2. Fix the dynamic-with lookup chain in `src/codegen/with-scope.ts` (innermost
   first; `@@unscopables` consulted only when it is an object and the named entry
   is truthy); materialise a call-expression target once into a temp.
3. Scoped test262 `language/statements/with` base vs fix, both lanes.

## Acceptance criteria

- [ ] both files green
- [ ] no test262 regression in `language/statements/with`
