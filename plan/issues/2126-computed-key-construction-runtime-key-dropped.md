---
id: 2126
title: "object-literal construction with a runtime computed key drops the property and never evaluates the key expression"
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
related: [140, 1837, 2032]
renumbered_from: "residual of #140 (done) — surfaced by #1971 re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2126 — computed-key object construction: runtime key dropped, key side-effect skipped

## Problem

Building an object literal whose `[key]` is not a statically-resolvable string
literal drops the property entirely, and the key expression's side effects are
never evaluated.

```ts
// runtime key not statically known → property dropped
const ks = ["p", "q"];
let k = ks[1];
const o: any = { [k]: 5 };
o.q                       // wasm: NaN      node: 5

// key expression side effect never runs
let calls = 0;
const key = (): string => { calls++; return "x"; };
const o2: any = { [key()]: 1 };
calls                     // wasm: 0        node: 1
```

A statically-resolvable computed key DOES work today
(`let k = "dyn"; ({ [k]: 42 }).dyn === 42`) — the compiler constant-folds `k`
to `"dyn"` and lays out a static struct field. The bug is the fallback: when
the key cannot be folded to a compile-time string, the property and the key
expression are both silently discarded.

This is the **construction** side. The destructuring **read** side
(`const { [k]: v } = obj`) is tracked separately by #2032.

## Root cause (pointer)

Object-literal lowering lays out a static struct from compile-time-known
property names. A `ComputedPropertyName` that doesn't fold to a literal has no
static field slot, and there is no runtime `__define_prop` fallback emitted —
so both the field write and the key-expression evaluation drop out. See
object-literal construction in `src/codegen/object-ops.ts` and the
ComputedPropertyName handling path (grep `ComputedPropertyName`).

## Acceptance criteria

- `const ks=["p","q"]; let k=ks[1]; const o:any={[k]:5}; o.q` → `5`
- `let calls=0; const key=()=>{calls++;return "x"}; ({[key()]:1}); calls` → `1`
- Statically-resolvable computed keys keep working (no regression on
  `{[literalVar]: v}`)
- An equivalence test under `tests/` covering both shapes

## Notes

Verified on main `c19a2e9c1` via `.tmp/triage.mts` / `.tmp/triage2.mts`
(branch `po-1971-triage`). JS-host mode, default options.
