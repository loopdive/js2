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

## Results (2026-11-06)

Measured on head 6e5202fd against base e73e190c. Both are `git archive`
snapshots run side by side.

| Check | Base | Head |
| --- | --- | --- |
| Wrapped ledger: `vardecl-module-storage-unrepresentable` rows | 409 | 405 |
| Wrapped ledger: `expr-module-storage-unrepresentable` rows | 0 | 0 |
| Wrapped ledger: module-init units with an IR body | 27 | 28 |
| Wrapped ledger: compileOk (of 1296 files) | 1118 | 1118 |
| Wrapped ledger: invariants | 0 | 0 |
| Raw ledger | — | identical apart from timing and commit |
| Typed corpus (50 files × gc/standalone/wasi) | — | 150/150 byte-identical (44 compile fails, the same on both) |
| Probe set (56 cases × 3 lanes) | 0 IR | 66 IR, 0 verdict differences |

Of the four rows that move, three now stop at a later, unrelated refusal
(`Promise`, a private-reference argument, `helper-internal`). The fourth
becomes a fully IR module-init.

The census lever is smaller than its 92 `new X()` rows suggested. Most of
those `X` are not in-file classes with a projected shape, or the test reads
the binding inside a function, which the use-site rule keeps legacy.

Equivalence test: 66/66 pass on gc, standalone and wasi.
- 15 IR cases agree with node and legacy.
- 11 refused cases stay legacy and agree with legacy: a `null` write, `+=`,
  a for-in head, destructuring, `with`, a declaration inside a block,
  `typeof`, a read in a function, a subclass write in a function, a
  base-class annotation, a read before the declaration.

## Adversarial review (fresh-context agent, 2026-11-06)

Correctness verdict: no severe hole found.
- A null-slot read is unreachable. The declaration must be a direct
  source-file statement, and uses are refused in functions, classes and the
  declaration's own statement.
- Writes are scanned by symbol across the whole file.
- `eval`, `this.c` and implicit globals are excluded by `scriptVarHome`.

Quality findings, and what was done with each:
1. *`ref.as_non_null` is keyed on the IR type, not on the storage.*
   Rebutted: the `class` IR type is by definition the non-null `(ref $C)`
   (`lower-generic` `class` → `ref`), and every module-storage global is
   `ref null`. So "class-typed `global.get` ⇒ refine" is the carrier
   invariant. A storage-keyed rule would need a new resolver query used by
   this one site. No earlier `global.get` produces a `class` type (checked:
   TDZ, static private fields, function-object caches, receiver globals).
2. *Sixth copy of `with` detection.* Fixed for this change:
   `hasDynamicScope` moved from `fnctor-local-bindings.ts` to
   `src/shared/binding-writes.ts`, cached, and is now used by both. The new
   module also refuses on a direct `eval`. The remaining copies (in
   `fnctor-string-producers`, `fnctor-module-consts`,
   `heterogeneous-module-bindings` and `select.ts`) are a follow-up; see
   Follow-ups.
3. *`stripParensUpward` duplicates `outermostParenthesized`.* Fixed:
   `outermostParenthesized` moved from `select.ts` to
   `src/shared/binding-writes.ts`, and both callers use it.
4. *The `scriptVarHome` class check is a second struct lookup.* Rebutted:
   it classifies the slot that the allocator wrote, by reading it back.
   `resolveModuleBindingGlobal` then checks that slot against
   `exactClassStructTypeIdx`, and a disagreement demotes. The spread copies
   one name set per script `var` per compile.
5. *Widened parameter types.* Kept: the callers pass the resolver's
   `IrModuleBindingDeclaration`, and the narrowing happens once, inside.

## Follow-ups

- Fold the remaining `with`-statement scans (listed in finding 2) into
  `hasDynamicScope`. No id was allocated: `claim-issue --allocate` refused
  because the open-PR scan was degraded.
- `let` / `const` class-instance bindings (`no-value-kind`). This needs an
  eval stand-down for script lexicals.
