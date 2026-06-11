---
id: 2007
title: "array operand in string concatenation traps 'illegal cast' — '+' never routes vecs through ToPrimitive/join"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1969, 1997, 1988]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2007 — struct-ref concat path can't handle WasmGC vec refs

## Problem

```ts
const arr = [1, 2];
"a=" + arr   // wasm: RuntimeError: illegal cast   node: "a=1,2"
```

## Root cause

`src/codegen/string-ops.ts:1503-1508` — struct-ref operands route through
`coerceType(..., externref, "string")`, but the ToPrimitive dispatch path
doesn't handle WasmGC array/$Vec refs (unguarded `ref.cast` in
`src/codegen/type-coercion.ts`), so arrays never reach
Array.prototype.toString/join.

## Fix direction

Detect vec refs in the concat coercion and emit the join path (ties into
#1997 array toString and #1996 host bridge vec recognition).

## Acceptance criteria

- Repro returns "a=1,2"; nested arrays follow join semantics

## Dupe check

#1090/#1806 cover "cannot convert object to primitive" for plain structs;
#1969 is concat-the-method, not `+`. New.
