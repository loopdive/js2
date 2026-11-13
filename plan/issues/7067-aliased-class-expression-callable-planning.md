---
id: 7067
title: "codegen (legacy lane): a class that extends a NAMED class expression bound to a variable fails to compile — `const Alias = class Named extends A {}; class B extends Alias {}` stops with `inherited class callable Alias_v is not exact child physical key Named_v` in program-abi-class-callable-planning.ts (found by the #7000 alias review)"
status: ready
sprint: current
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: classes, class-expressions, inheritance
goal: core-semantics
related: [7000]
---
# Aliased named class expression breaks class-callable planning

Found by the owner's review of PR #6699 (#7000). The IR scan was fixed; the program fails to compile on every lane for this legacy-side reason.

## Repro

```ts
class A { v(): number { return 11; } }
const Alias = class Named extends A {};
class B extends Alias { v(): number { return 22; } }
function callV(a: A): number { return a.v(); }
export function test(): number { return callV(new B()); }   // node 22; compile error on every lane
```

## Root cause

`src/codegen/program-abi-class-callable-planning.ts` keys inherited class callables by the class expression's own name (`Named_v`) in one place and by its binding (`Alias_v`) in another; the exact-child physical-key check then fails. Same shape as the IR bug fixed in `src/ir/class-overrides.ts` (`classBindingNames`): a named class expression has two names and both must map to one physical key.

## Implementation Plan

1. Give the planning a single canonical key per class declaration node (not per name); resolve both the internal name and the bound variable to it.
2. Tests: the repro, a chain through two aliases, and an anonymous class expression bound to a `const`, in `tests/equivalence/issue-7067-aliased-class-expression.test.ts`.


> Filed from the 2026-10-15 compiler audit follow-ups (surfaced by the #6991–#7001 implementation PRs). Under `plan/method/ir-only-development-freeze.md` a direct-AST semantic fix needs a specific user disposition; IR/shared-runtime work does not.
