---
id: 4531
title: "prettier: AstPath.getValue traps 'illegal cast' on the heterogeneous stack array — 4 of 7 upstream failures"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays, classes
goal: npm-library-support
related: [3995, 4289, 3979]
files:
  - tests/dogfood/prettier-upstream-suite.mjs
---

# prettier: mixed string/number/object `stack` array element reads trap

## Problem

Prettier's pinned upstream slice: **1/8 Wasm** (8/8 Node), 2026-08-16 on
`a9b20d4c`, matching the npm-compat card. Four failures are one trap:

```text
RuntimeError: illegal cast
    at AstPath_getValue (wasm-function[68])
```

in `AstPath#call() / #callParent() / #each() / #map()`. Upstream `AstPath`
keeps `this.stack = [node, key1, child1, key2, child2, …]` — an array
interleaving **objects, strings, and numbers** — and `getValue()` reads
`this.stack[this.stack.length - 1]`. The compiled element read casts to one
element shape and traps on the mixed carrier. This is the class-field
variant of the mixed-array-literal family (#3979 mixed array literal calls,
#4289 heterogeneous object-array carrier): here the array is a **class
field** mutated by `push`/`splice` across element types.

The other three failures are Error-subclass `.name` (#4532).

## Reproduction

```bash
node --import tsx tests/dogfood/prettier-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Reduce**: class with `stack: any[]` field seeded `[obj]`, methods that
   `push(str, num, obj)` and read `this.stack[i]` returning it through the
   host bridge. Expect the illegal cast at the read. `.tmp/`, then
   `tests/issue-4531.test.ts`.
2. **Root cause**: the field's array carrier was specialized (probably to the
   seed element's struct type) while writes admit any element. Either the
   declaration-site inference must widen a class-field array that receives
   heterogeneous `push` args (preferred — matches how #4289 handled the
   literal case; check `src/codegen/declarations/object-shape-widening.ts`
   and the array-element-typing pass `src/codegen/array-element-typing.ts`),
   or the element read must cast through the generic any-carrier when the
   element type is not provable.
3. **Check overlap before implementing**: #4289 / #4290 landed carriers for
   heterogeneous arrays in object/class contexts — read their tests first;
   this may be a small extension of an existing pass, not a new one.
4. **Validation gates**: reduction test; prettier harness 1 → ≥5 (the 4
   AstPath tests; record exact); equivalence + #4289/#3979 tests green.

## Acceptance criteria

- [ ] `AstPath` reduction passes: mixed push + indexed read round-trips all
      three element kinds.
- [ ] Prettier upstream ≥ 5/8 (remaining 3 tracked by #4532).
