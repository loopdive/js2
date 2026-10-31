---
id: 7202
title: "`#x in v` own-brand guard costs one ref.eq pair per subclass (linear bytes and time)"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: classes
goal: performance
related: [7160]
---

# #7202 — make the #7160 singleton exclusion constant-cost

Found by the PR #7003 review (#7160), finding 1. To reject the constructor
and prototype singletons, `emitOwnPrivateBrandPredicate`
(`src/codegen/binary-ops-in.ts`) compares the receiver with `ref.eq` against
the class-object and prototype globals of the declaring class **and every
subclass**. Each `#x in` site therefore grows with the number of descendants:

- A class with 10 subclasses costs +600 B per site (+720 B on wasi).
- On gc, a hot loop of 3M checks on the true path is about 5× slower
  (30–40 ms → 190–220 ms), because every arm is evaluated.

## Plan

1. Pick the receiver's own class by its `__tag` (already read by the brand
   test) and compare against only that class's two globals. The alternative
   is to move the chain into one shared helper function per declaring class.
2. Keep the output identical on the #7160 test file
   (`tests/equivalence/issue-7160-private-in-constructor.test.ts`). Measure
   bytes and time for 1, 3 and 10 subclasses.
