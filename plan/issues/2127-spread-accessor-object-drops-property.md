---
id: 2127
title: "object spread of an accessor-bearing source drops the property — getter never fires, value is null"
status: ready
sprint: 61
created: 2026-06-12
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [492, 1112, 1239]
renumbered_from: "residual of #492/#1112 (done) — surfaced by #1971 re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2127 — spread copies struct fields, skips accessor-defined own properties

## Problem

`{ ...src }` where `src` has a getter (or setter) drops that property: the
getter is never invoked and the spread result has no value for it.

```ts
const src = { get a(): number { return 7; } };
const o: any = { ...src };
o.a                       // wasm: null     node: 7
```

Spread of a plain data-property source is correct:
`{ ...{ a: 7 } }.a === 7`. The bug is accessor-defined own properties
specifically — per spec, `CopyDataProperties` does a `[[Get]]` on each own
enumerable key, which must invoke the getter and copy the resulting value as a
plain data property on the target.

## Root cause (pointer)

Object spread lowering appears to copy the source struct's data fields by
field index and never materialises accessor properties (which live in the
accessor sidecar / `classAccessorGet` registry, not as struct fields). The
getter call needs to be emitted at spread time and its result written as a
data property on the target. See object-literal spread handling in
`src/codegen/object-ops.ts` and accessor registration around
`compileObjectDefineProperty` / `classAccessorGet`.

## Acceptance criteria

- `const src = { get a(){ return 7; } }; ({ ...src }).a` → `7`
- Getter side effects fire exactly once during the spread
- Setter-only source property: spread reads via `[[Get]]` → `undefined`
  data property (matches node)
- Data-property spread unchanged (no regression)
- An equivalence test under `tests/`

## Notes

Verified on main `c19a2e9c1` via `.tmp/triage.mts` (branch `po-1971-triage`).
JS-host mode, default options.
