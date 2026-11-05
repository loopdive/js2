---
id: 7252
title: "IR: a script var holding instances of one class binds to legacy's class-struct slot"
status: in-progress
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7132, 3523, 2949, 7128, 7240, 7243]
assignee: "ttraenkler/c-lead"
# 2026-11-05 (#7252): the class-instance arm beside its siblings, plus the
# class-shape parameter threaded to the module-binding storage resolver. The
# admission and storage logic live in the two new modules; what remains in
# each god-file is the arm, the plumbing and one ref.as_non_null.
loc-budget-allow:
  - src/ir/module-bindings.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
  - src/codegen/index.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
---

# IR: a script var holding instances of one class binds to legacy's class-struct slot

## Problem

`ir_only_pass` (standalone test262 passes with zero legacy units, harness
included) is flat at 1088/48232. A blocked-by-one census of the
harness-wrapped ledger (stride 40, standalone, 2026-11-05) ranks
`vardecl-module-storage-unrepresentable` as the top lever. Its rows are a
top-level script `var` whose value is:

- an object literal: 256 first-refusal rows;
- an array literal: 140;
- `new X()`: 92;
- a function: 39.

None of these has an IR module-binding value kind. This issue takes only the
`new X()` slice, and only where `X` is a top-level class with an IR class
shape. Legacy keeps that binding in a `(ref null $X)` slot, which the IR can
read as a `class` value with no dynamic carrier. Object/array literals
(#7128, #2949) and functions are out of scope.

## Measured (2026-11-05, origin/main e73e190c)

Probe `.tmp/probe7252.mts`, `JS2WASM_IR_SHAPE_DIAG=1`, `scriptGoal: true`.

| Variant | Legacy `__mod_c` slot | IR first refusal (base) |
| --- | --- | --- |
| `var c = new C(); c.m()` | `(mut (ref null $C))` | `vardecl-module-storage-unrepresentable` |
| `let c: C = new C()` | `(mut (ref null $C))` | same; survey arm `no-value-kind` |
| `const c = new C()` | `(mut (ref null $C))` | same; `no-value-kind` |
| `var c = new D()` (D extends C) | `(mut (ref null $D))` | same |
| `var c: C = new C(); c = new D()` | `(mut (ref null $C))` | same |
| read in a function / a class method | `(mut (ref null $C))` | same (first refusal is the declaration) |
| `var c: C \| null = new C(); c = null` | `(mut (ref null $C))` | same |

Why each refuses:

- **Script `var`.** `scriptVarHome` (`src/codegen/index.ts`) names only the
  externref, native-string, f64 and i32 slots. A `ref_null` slot of any other
  struct returns `undefined`, so `directTopLevelDeclaration` reports the
  binding as not direct, and the selector refuses the declaration.
- **`let` / `const`.** The binding is direct, but no value-kind arm matches a
  class type, so the arm is `no-value-kind`.

How legacy reads the slot: `c.m()` compiles to
`global.get $__mod_c; ref.as_non_null` and then the inlined method body. A
`null` slot therefore traps at a receiver use on base already.

What the resolver needs to return: a value kind whose storage is exactly
`(ref null $C)` and whose IR type is `{ kind: "class", shape }` of C. A read is
then `global.get` plus the same `ref.as_non_null` legacy emits. The IR's
`class` type is a non-null `(ref $C)`, so the IR may only read the slot where
it is provably written.

## Implementation Plan

Target structure:

- **New module `src/ir/module-binding-class-instance.ts`.** It holds the
  admission, the write predicate and the use-site rule. It is a leaf: it does
  not import `module-bindings.ts`.
- **`src/ir/module-binding-value-kinds.ts`.**
  - New kind `class-instance { classDeclaration }`.
  - New script home `class-instance`.
- **`src/codegen/index.ts` `scriptVarHome`.** A `ref_null` slot whose type
  index is the struct legacy allocated for a user class (`ctx.classSet` /
  `ctx.structMap`) is the `class-instance` home. The slot is read back, never
  re-derived.
- **`src/ir/module-bindings.ts`.**
  - `scriptVarReferenceKind` gains the `class-instance` arm, next to the
    `string` arm.
  - `writeValueMatches` gains the write arm.
  - `inspectDirectBinding` applies the use-site rule (arm
    `class-instance-use-site`).
- **`src/ir/integration.ts` `resolveModuleBindingGlobal`.**
  - The `class-instance` arm resolves the projected shape and the class's
    struct.
  - The struct lookup reuses `exactClassStructTypeIdx`, now shared with
    `ClassResolver.resolve` instead of duplicated there.
  - A slot of another struct, or a class with no projected shape, demotes
    the unit; it never raises an invariant.
- **`src/ir/lower-generic.ts`.** A `class`-typed `global.get` emits
  `ref.as_non_null`, the refinement legacy emits.
- **`src/ir/select.ts`.** A class-instance binding is not counted as a scalar
  module binding, so `c.m()` reaches the existing class-instance method arm.

Admission (every condition is needed for "the IR never reads `null`"):

1. Script-goal `var` only, whose `scriptVarHome` is `class-instance`. This
   inherits the existing stand-downs: runtime eval in the shared realm, sloppy
   implicit globals / top-level `this.p`, and `var` merged with a function.
2. The initializer is `new X(...)`, where `X` is a top-level class
   declaration of the same source. The checker's declared type is exactly
   `X`, not a union and not a base class.
3. Every write anywhere in the source is `new X(...)` of the same class. This
   covers the initializer, `=`, a `var` redeclaration, and a write inside a
   nested function, enumerated with the shared `identifierWritesOf`.
   - Any other write refuses the whole binding: `null`, another class, `+=`,
     for-of, destructuring.
   - So does any `with` statement in the source.
4. Use-site rule: an IR use is the declaration itself, or a top-level use
   that runs after the declaration statement. It must sit outside every
   function and class body, and must not be the operand of `typeof` or
   `delete`.
   - Any other use refuses at its site; that unit stays legacy and reads the
     same slot.
   - `dynamicUsesAreMoveOnly` is untouched, and no read joins inputs.

Out of scope:

- `let`/`const` class bindings. They are measured above, but direct eval can
  write a script lexical that is outside `scriptVarHome`'s eval stand-down.
- A nullable or reassigned-to-subclass binding.
- Reads inside functions and methods.

Code-quality criterion:

- One concern per new unit.
- The new value-kind arm sits beside its siblings (`string` home arm,
  `dynamic` demote arm).
- No duplicated struct lookup: `exactClassStructTypeIdx` is the one lookup.
- No changes to the Shepherd's getter-callable files or to `type-coercion.ts`.

Acceptance:

- Wrapped ledger A/B (`--wrapped --stride 40 --target standalone --jobs 2`):
  - `vardecl-module-storage-unrepresentable` and
    `expr-module-storage-unrepresentable` rows fall;
  - module-init IR units rise;
  - 0 invariants, and `compileOk` is not lower.
- Raw ledger: byte-identical apart from timing.
- Typed corpus byte-identical on 3 lanes, or every diff explained.
- Standalone test262 A/B over the route-changed files plus a 300-file sample:
  no pass→fail.
- `tests/equivalence/issue-7252-module-binding-class-instance.test.ts`: IR
  route via `trackIrOutcomes`, values against node and base, 3 lanes.
