---
id: 2032
title: "computed-key object destructuring const { [k]: v } = obj silently binds 0 — ComputedPropertyName never evaluated in struct fast path"
status: done
sprint: 61
created: 2026-06-11
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring
goal: core-semantics
related: [1971, 1372]
origin: "2026-06-10 spec-conformance sweep (iterators agent): verified on main"
---

# #2032 — fieldIdx -1 → binding silently skipped

## Problem

```ts
const k = "dyn";
const { [k]: dynVal } = { dyn: 6 };
"" + dynVal   // wasm: "0"   node: "6"
```

## Root cause

`src/codegen/destructuring-params.ts:730` — `const propName =
(element.propertyName ?? element.name) as ts.Identifier`; a
`ComputedPropertyName` has no `.text` matching any struct field,
`fieldIdx === -1` → binding silently skipped, local stays
zero-initialized. No computed-key evaluation path exists in the struct
fast path.

## Fix direction

Detect ComputedPropertyName: evaluate the key expression, then route
through the dynamic property read (`__extern_get`-style) instead of the
struct field index — or at minimum fail compile loudly instead of binding
0.

## Acceptance criteria

- Repro binds 6; static-key destructuring unchanged
- Key expression side effects evaluated exactly once

## Dupe check

#1971 item 1 covers computed keys in object *literals* (creation side);
#1372 is IR params. Read side new.
