---
id: 4296
title: "codegen: reuse saved optional-call receivers for dynamic property chains"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: optional-chaining, getters, dynamic-dispatch
goal: correctness
related: [4292]
assignee: ""
---

# codegen: reuse saved optional-call receivers for dynamic property chains

## Problem

`compileOptionalCallExpression` already evaluates the receiver once and saves
it in a Wasm local for the nullish test. Its generic dynamic method fallback,
however, accepts only an AST expression and compiles that expression again.
Treating a property chain as syntactically side-effect-free is unsound because
`box.value?.at(-1)` may invoke a getter: the experimental #4292 delegation made
the correct string call but read the getter twice (`21` instead of Node's `11`).
Restricting #4292 to identifiers preserves evaluate-once but leaves the prior
missing dynamic property-chain method call (`10`).

Teach the receiver-method ladder to consume the already-saved receiver local,
or extract a stack/local-based dynamic method helper. Preserve nullish
short-circuiting, argument non-evaluation on the short branch, and exact
evaluate-once behavior.

## Acceptance criteria

- [ ] A getter-backed `box.value?.at(-1)` returns the native-string result and
      increments the getter counter exactly once (`11`).
- [ ] A nullish receiver does not evaluate call arguments.
- [ ] Identifier receivers retain #4292 behavior without another AST read.
- [ ] Existing optional-call and getter-call suites pass.
