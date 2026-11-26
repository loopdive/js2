---
id: 7500
title: "Prepared path crashes on `export class C {}`: alias targets unplanned binding"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
goal: backend-agnostic-ir
related: [7488, 7354]
---

# Prepared path crashes on `export class C {}`

## Problem

On the Prepared whole-program path (`wholeProgram: {kind: "prepared-program-required", version: 1}`), an exported
class declaration without heritage makes `compile()` throw instead of returning a result:

```
ProgramAbiInvariantError: alias ir-binding:v1:export:ir-source%3Av1%3A…%3Aentry%3Atest.js:C:… targets unplanned
binding ir-binding:v1:callable:ir-unit%3Av1%…
```

The path's rule is JavaScript's answer or a named refusal. An invariant thrown out of `compile()` is neither: it is a
crash. Found by the plan review of #7488 (PRV-7488), 2026-11-26.

## Repro (PR 7440 head `3d70c9c8`, main `c3b7be66` + #7446; standalone, `fileName: "test.js"`)

| Program | Prepared |
| --- | --- |
| `export class C {}` | **crash** (ProgramAbiInvariantError, above) |
| `export class C {} var n = 1;` | **crash** (same) |

(Under a Module goal the program is valid; a Script goal rejects `export`. Either way the answer is a result, not a
thrown invariant.)

## Acceptance criteria

- `export class C {}` either compiles with JavaScript's semantics or is refused by name at compile time (select
  stage); `compile()` never throws an invariant for it.
- Pin tests for the plain exported class, with and without other top-level code.
- The ordinary pipeline's output is unchanged.

## Notes

- The export alias points at the class's callable binding, which the Prepared producer never plans because it has no
  body producer for the class (its constructor is a root `class-implicit-constructor` support unit). Look first at
  where export aliases are planned against callable units in the Prepared ABI planning, and refuse there when the
  target has no producer.
