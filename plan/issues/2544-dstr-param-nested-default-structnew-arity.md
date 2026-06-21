---
id: 2544
renumbered_from: 2512
title: "nested destructuring-param default object emits struct.new one operand short of the field-unified type — invalid Wasm (24 test262)"
status: done
assignee: ttraenkler/sen-1
completed: 2026-06-19
sprint: 64
created: 2026-06-19
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: destructuring
goal: core-semantics
related: [2158, 2009, 1224, 1451, 1543, 2545]
test262_bucket: dstr-param-default-shape
test262_count: 24
origin: "2026-06-19 jsonl scout (sd5, originally filed as #2503 which collided with the ToPrimitive issue); re-filed under a free id by sen-1."
---

# #2544 — destructuring-param nested-default object: short struct.new (invalid Wasm)

> Re-filed from the colliding `#2503` (that number is already
> `2503-standalone-toprimitive-operator-receiver-residual.md` on main). This is
> the invalid-Wasm/arity half. The destructured-VALUE-FLOW half is #2545.

## Problem

```ts
class C {
  method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: undefined, z: 7 } }) {
    return z;
  }
}
new C().method();   // wasm: invalid binary — C_method struct.new arity
```

24 test262 `compile_error`s (12 `language/statements/class/dstr/*`, 12
`language/expressions/class/dstr/*` — `meth-…-dflt-obj-ptrn-prop-obj` /
`async-(private-)gen-meth-…`). Validator:

```
invalid Wasm binary: not enough arguments on the stack for struct.new (need 3, got 2)
```

## Root cause (WAT-confirmed, sen-1)

**NOT a `$shape` coverage gap** — the colliding structs here carry no `$shape`
field. It is the field-pad hazard of a struct-type **field unification**, the
same bug CLASS as #2158 but for a different patch.

The destructuring-param nested-pattern default object materializes its default
into a **detached `if.then` buffer** swapped onto `fctx.body` by a plain
JS-local swap (not `pushBody`, so absent from `fctx.savedBodies`). That buffer is
registered in `ctx.liveBodies` for the late-import-shift coverage window (#2158).
When a LATER same-shape object literal grows the anon struct's field set (the
inner `{x:4,y:5,z:6}` default appends `y` to the 2-field `{x,z}` shape),
`patchStructNewForAddedField` (`src/codegen/expressions/late-imports.ts`)
retro-pads every existing `struct.new` of that type with the new field's
default — but it walked ONLY `mod.functions[].body` + `fctx.body` +
`fctx.savedBodies`, **never `ctx.liveBodies`**. So the earlier `struct.new` in
the orphaned buffer stayed one operand short of the grown 3-field type → invalid
Wasm.

## Fix

Add a `ctx.liveBodies` traversal to `patchStructNewForAddedField`, mirroring the
late-import-shift walk that already covers these detached buffers (#2158). One
contained change in `src/codegen/expressions/late-imports.ts`.

## Acceptance criteria

- The repro compiles to VALID Wasm (no `struct.new` arity error).
- `static` + `async-gen` + `private` method variants with nested object-pattern
  defaults compile to valid Wasm.
- The 24 `C_method`/`C___priv_method struct.new` arity compile_errors clear.
- No regression in existing destructuring-param-default / class-method suites.

Note: these tests flip `compile_error` → **fail** (assertion), NOT → pass — the
destructured-VALUE-FLOW is a separate pre-existing bug, tracked as **#2545**.
This issue closes the invalid-Wasm CE half (a real robustness + bucket-clearing
improvement; net-0 in the pass-gate).

## Result (2026-06-19, sen-1) — DONE

Implemented the `ctx.liveBodies` traversal. Verified: the repro + static/gen
variants compile to valid Wasm; no regression in
`basic-destructuring`/`destructuring-extended`/`destructuring-initializer` +
`issue-2158` suites; `tsc --noEmit` clean. Value-flow carved to #2545.
