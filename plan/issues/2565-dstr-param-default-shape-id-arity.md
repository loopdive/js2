---
id: 2565
title: "nested destructuring-param default object emits struct.new one operand short of the $shape-bearing type — invalid Wasm (24 test262)"
status: done
sprint: 64
created: 2026-06-19
updated: 2026-06-21
completed: 2026-06-21
resolved_by: 2564
assignee: ttraenkler/sd3
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: destructuring
goal: core-semantics
related: [2009, 1224, 1451, 1543, 2564]
test262_bucket: dstr-param-default-shape
test262_count: 24
origin: "2026-06-19 jsonl scout (sd5): 24 compile_errors, verified on current main"
---

## Resolution (2026-06-21, sd3) — FIXED BY #2564, no separate code change

Re-measured the full bucket on `origin/main` AFTER #2564 (PR #1803) landed. **All
24 named files PASS** (verified exact set: 12 `language/statements/class/dstr/` +
12 `language/expressions/class/dstr/` `*-dflt-obj-ptrn-prop-obj.js` — meth /
static / gen / async-gen / private variants). The issue's own repro snippet now
compiles to valid Wasm and returns 8. A wider sweep of all 1920 class-dstr
default-param files shows 0 INVALID in the `dflt-obj-ptrn-prop-obj` bucket.

**The root-cause hypothesis in this issue was a misdiagnosis.** It was NOT a
`$shape`-arity gap in `__ext_dparam_nested` / `patchStructNewWithShapeId`
coverage. The `not enough arguments on the stack for struct.new` symptom and
#2564's `type error in fallthru[0]` were two faces of the **same** bug: the
shared-`blockType` double-remap in `emitVirtualMethodDispatchByTag` +
`eliminateDeadImports` (see #2564). The malformed `if` block-type desynced the
WasmGC type table during dead-import renumbering, and in these
destructuring-param-default class methods that desync surfaced downstream as a
`struct.new` operand-count mismatch. Fixing the shared block-type (give each
cascade `if` its own `blockType`, and guard the block-type object in
`remapTypeIdxInBody`) cleared both symptom families at once. No additional
shape-id-coverage change was needed.

### Separate, pre-existing bug spun out (NOT this bucket)

Two negative tests — `class/dstr/meth-dflt-obj-ptrn-list-err.js` and
`meth-static-dflt-obj-ptrn-list-err.js` (statements + expressions) — still emit
invalid Wasm, but with a DIFFERENT error
(`C_method: not enough arguments on the stack for call (need 1, got 0)`) and a
DIFFERENT shape: a default param whose initializer **calls a throwing function**
(`method({ a, b = thrower(), c = ++initCount } = {})`), not a nested object
pattern. They were INVALID on main BEFORE #2564 too (pre-existing) and are out of
this bucket (`obj-ptrn-list-err`, not `obj-ptrn-prop-obj`). A
missing-call-argument bug in the param-default throwing-initializer
materialization path, unrelated to the `$shape` machinery — left for a
follow-up issue.

# #2565 — destructuring-param default object literal misses the `$shape` operand

## Problem

```ts
const C = class {
  static method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, z: 7 } }) {
    return x + z;
  }
};
C.method();   // wasm: invalid binary — C_method struct.new arity
```

24 test262 `compile_error`s (12 `language/statements/class/dstr/*`, 12
`language/expressions/class/dstr/*` — `meth-...-dflt-obj-ptrn-prop-obj` /
`async-(private-)gen-meth-...`). The validator error:

```
invalid Wasm binary: Compiling function #N:"C_method" failed:
not enough arguments on the stack for struct.new (need 3, got 2)
```

## Root cause

This is the **#2009 PR-1b `$shape`-arity hazard recurring in the
destructuring-param-default construction path.** After
`resolveSameShapeFieldNameCollisions` (index.ts) appends a hidden trailing
`$shape: i32` field to colliding anon object-literal structs (3 fields:
`f64 f64 i32`), every `struct.new <typeIdx>` for that type must push the
shape-id operand. `patchStructNewWithShapeId` retro-patches the struct.new sites
in compiled bodies — but the **default-object materialization for a destructuring
parameter** (the `__ext_dparam_nested_*` codegen) emits its `struct.new` outside
the patched set, so the outer default object (`{ w: {...} }`) lands one operand
short of the 3-field `$shape`-bearing type.

WAT (the inner default IS correct, the outer is short):

```
f64.const 1   f64.const 7   i32.const 0   struct.new 11   extern.convert_any
                                                         struct.new   ; ← outer: 2 ops for a 3-field type
```

`has $shape field: true` confirmed; only the nested destructuring-param-default
`struct.new` is unpatched.

## Fix direction

Ensure the destructuring-param default object construction (the
`__ext_dparam_nested` / class-method default-param materialization) is covered by
the `$shape` shape-id stamping — either route it through the same
`patchStructNewWithShapeId` post-pass (walk its emitted Instr stream) or push the
`i32.const <shapeId>` operand at the construction site when the target struct has
a `$shape` field. Mirror the IR-path fix from #2009 PR-1b
(`IrObjectStructLowering.shapeId` → `object.new` final operand).

**Likely senior-dev / #2009 owner** — same `$shape` machinery; coordinate so
this construction path is added to the shape-id coverage set rather than
patched independently.

## Acceptance criteria

- The repro above compiles to valid Wasm and returns the correct value.
- `static` + `async-gen` + `private` method variants with nested object-pattern
  defaults compile to valid Wasm.
- The 24 `C_method`/`C___priv_method struct.new` arity compile_errors clear.
- No regression in existing destructuring-param-default / class-method suites.

## Dupe check

Related but distinct: #1224 (class-method dstr param defaults — semantics),
#1451 (object-method param destructuring defaults — spec gap), #1543
(async-gen-meth dstr default illegal cast). None covers the `$shape`-arity
struct.new mismatch introduced by the #2009 collision-resolution pass. New.
